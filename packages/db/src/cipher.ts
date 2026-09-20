/**
 * Encryption for stored third-party tokens.
 *
 * Only `jira_connection` uses this today, and the reason it exists at all is
 * that a Jira refresh token is a live credential against a client's data:
 * with refresh-token rotation, a leaked row works until the next refresh, and
 * once write-back is enabled (M7) it can edit their tickets. That is worth
 * more than a row of Better Auth's `account` table, which holds identity
 * tokens for this app's own sign-in — which is why those stay plaintext and
 * these do not.
 *
 * **What this defends against, and what it does not.** It defends against the
 * realistic leak: a database dump, a read replica, a backup, a row in a log
 * or an error report. It does not defend against someone who already runs
 * code in the API task, because that process holds the key in memory by
 * construction. KMS envelope encryption would move the key out of the
 * process, at the cost of a network call per refresh; it was considered and
 * deliberately not adopted (see decision 3 of the 2026-09-18 plan).
 *
 * AES-256-GCM: authenticated, so a tampered ciphertext fails to decrypt
 * rather than yielding a plausible wrong token.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/** GCM's standard nonce length. 96 bits is what the mode is specified for. */
const IV_BYTES = 12;
/** GCM's authentication tag. */
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/** The prefix on every ciphertext, naming the scheme so it can be changed. */
const SCHEME = "v1";

export class TokenCipherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenCipherError";
  }
}

export interface TokenCipher {
  /** Encrypts a token. Returns `v1:<base64>`; null in, null out. */
  encrypt(plaintext: string | null): string | null;
  /**
   * Decrypts a token written by `encrypt`. Null in, null out.
   *
   * Throws `TokenCipherError` on a value this key cannot authenticate — a
   * wrong key, a truncated column, or a tampered row. The caller treats that
   * as "reconnect Jira", never as an empty token.
   */
  decrypt(ciphertext: string | null): string | null;
  /**
   * Which key encrypted a value, stored beside it in `key_id`.
   *
   * Rotation is then a re-encrypt of the rows whose `key_id` is stale, rather
   * than a migration: both keys can be readable at once, so no row is
   * unreadable mid-rotation.
   */
  readonly keyId: string;
}

/**
 * Builds a cipher from a base64 32-byte key, as `TOKEN_ENCRYPTION_KEY` holds.
 *
 * Generate one with `openssl rand -base64 32`, exactly as `BETTER_AUTH_SECRET`
 * is generated.
 */
export function createTokenCipher(
  key: string,
  options: { keyId?: string } = {},
): TokenCipher {
  const material = decodeKey(key);
  // Defaults to a fingerprint of the key itself, so two deployments with
  // different keys cannot silently agree on the same id, and the id leaks
  // nothing: it is derived but not reversible in any useful way.
  const keyId = options.keyId ?? fingerprint(material);

  return {
    keyId,

    encrypt(plaintext: string | null): string | null {
      if (plaintext === null) {
        return null;
      }
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", material, iv);
      const body = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
      ]);
      // iv | tag | ciphertext, so the parts are found by fixed offsets.
      const packed = Buffer.concat([iv, cipher.getAuthTag(), body]);
      return `${SCHEME}:${packed.toString("base64")}`;
    },

    decrypt(ciphertext: string | null): string | null {
      if (ciphertext === null) {
        return null;
      }

      const separator = ciphertext.indexOf(":");
      const scheme = separator === -1 ? "" : ciphertext.slice(0, separator);
      if (scheme !== SCHEME) {
        // Includes the case of a plaintext token left by an older row: it is
        // reported rather than returned, because handing back a value that was
        // never encrypted would hide exactly the bug this guards.
        throw new TokenCipherError(
          `Unrecognised token encoding; expected ${SCHEME}.`,
        );
      }

      const packed = Buffer.from(ciphertext.slice(separator + 1), "base64");
      // `<` not `<=`: an empty token is a legitimate value, and it encrypts to
      // exactly the header with a zero-length body.
      if (packed.length < IV_BYTES + TAG_BYTES) {
        throw new TokenCipherError("Encrypted token is truncated.");
      }

      const iv = packed.subarray(0, IV_BYTES);
      const tag = packed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
      const body = packed.subarray(IV_BYTES + TAG_BYTES);

      const decipher = createDecipheriv("aes-256-gcm", material, iv);
      decipher.setAuthTag(tag);
      try {
        return Buffer.concat([
          decipher.update(body),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        // GCM authentication failed: wrong key, or the row was altered.
        throw new TokenCipherError(
          "Encrypted token could not be authenticated; the key may have changed.",
        );
      }
    },
  };
}

function decodeKey(key: string): Buffer {
  const material = Buffer.from(key, "base64");
  if (material.length !== KEY_BYTES) {
    // Fail at construction, on boot, rather than at the first sign-in: a
    // 31-byte key is a typo, and discovering it when a user connects Jira is
    // far worse than refusing to start.
    throw new TokenCipherError(
      `TOKEN_ENCRYPTION_KEY must be ${KEY_BYTES} bytes, base64 encoded; got ${material.length}.`,
    );
  }
  return material;
}

/** A short, stable id for a key. Not a secret, and not reversible to one. */
function fingerprint(material: Buffer): string {
  // A single AES block under the key itself, over a fixed input: deterministic
  // for a given key, and it reveals no more than a hash would.
  const cipher = createCipheriv(
    "aes-256-gcm",
    material,
    Buffer.alloc(IV_BYTES),
  );
  const block = Buffer.concat([
    cipher.update(Buffer.alloc(16)),
    cipher.final(),
  ]);
  return block.subarray(0, 6).toString("hex");
}

/** Constant-time equality, for comparing key ids without leaking timing. */
export function sameKeyId(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
