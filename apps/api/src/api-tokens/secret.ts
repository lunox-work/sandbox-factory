/**
 * A workspace API token's secret: `lnx_` and 40 base62 characters drawn
 * from the platform's CSPRNG (about 238 bits), so it double-click selects
 * whole and a secret scanner can match the prefix.
 *
 * Only its SHA-256 is stored. A fast hash is right here, unlike a
 * password: the secret is random and long, so there is nothing for a
 * slow hash to protect against guessing.
 */

import { createHash, randomBytes } from "node:crypto";

import { API_TOKEN_PREFIX } from "sandbox-factory";

const ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const SECRET_LENGTH = 40;
/** Characters of the random part kept for display. */
const DISPLAY_LENGTH = 8;
/** The largest multiple of 62 a byte reaches; above it would bias. */
const UNBIASED_LIMIT = 248;

/** `length` base62 characters from `random`, without modulo bias. */
export function randomBase62(
  length: number,
  random: (size: number) => Uint8Array = randomBytes,
): string {
  let body = "";
  while (body.length < length) {
    for (const byte of random(length)) {
      if (byte >= UNBIASED_LIMIT) continue;
      body += ALPHABET.charAt(byte % ALPHABET.length);
      if (body.length === length) break;
    }
  }
  return body;
}

export function generateSecret(
  random: (size: number) => Uint8Array = randomBytes,
): string {
  return `${API_TOKEN_PREFIX}${randomBase62(SECRET_LENGTH, random)}`;
}

/** The stored form: hex SHA-256 of the whole secret, prefix included. */
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** What a list shows to tell tokens apart: `lnx_` and eight characters. */
export function displayPrefix(secret: string): string {
  return secret.slice(0, API_TOKEN_PREFIX.length + DISPLAY_LENGTH);
}

/**
 * The secret in an `Authorization: Bearer lnx_…` header, or undefined for
 * any other header, which is then a session's to answer.
 */
export function bearerApiToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header);
  const value = match?.[1];
  return value?.startsWith(API_TOKEN_PREFIX) === true ? value : undefined;
}
