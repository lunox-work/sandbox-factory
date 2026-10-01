/**
 * The App's own credential: a short-lived RS256 JWT signed with its private
 * key.
 *
 * It authenticates **as the App**, which is good for exactly one thing here:
 * minting installation tokens (`installation-tokens.ts`). Every call that
 * reads a client's repositories uses one of those instead, never this.
 *
 * `node:crypto` rather than a JWT library: the token is three base64url
 * segments and one signature, and the only claims GitHub reads are `iat`,
 * `exp` and `iss`.
 */

import { createPrivateKey, createSign, type KeyObject } from "node:crypto";

/**
 * GitHub refuses an `exp` more than ten minutes out. Nine leaves room for a
 * clock that runs a little fast here.
 */
const LIFETIME_SECONDS = 9 * 60;

/**
 * Backdated so a clock that runs a little slow here does not produce a token
 * GitHub sees as issued in the future, which it refuses. GitHub's own
 * guidance is sixty seconds.
 */
const BACKDATE_SECONDS = 60;

export interface AppJwtOptions {
  /** The App's numeric id, as GitHub shows it on the App's settings page. */
  appId: string;
  /** The private key, as `readPrivateKey` returns it. */
  privateKey: KeyObject;
  /** Milliseconds since the epoch. Injectable for tests. */
  now?: number;
}

/** A JWT GitHub accepts as the App for the next nine minutes. */
export function appJwt({
  appId,
  privateKey,
  now = Date.now(),
}: AppJwtOptions): string {
  const issuedAt = Math.floor(now / 1000) - BACKDATE_SECONDS;
  const header = encode({ alg: "RS256", typ: "JWT" });
  const payload = encode({
    iat: issuedAt,
    exp: issuedAt + BACKDATE_SECONDS + LIFETIME_SECONDS,
    iss: appId,
  });
  const signature = createSign("RSA-SHA256")
    .update(`${header}.${payload}`)
    .sign(privateKey, "base64url");
  return `${header}.${payload}.${signature}`;
}

/**
 * The App's private key, from configuration.
 *
 * Accepts the PEM itself or **base64 of the PEM**, which is how it is stored:
 * an environment value cannot carry the PEM's newlines through an ECS task
 * definition cleanly, and a key mangled on the way in fails only when the
 * first token is minted. Parsing here, once, at startup, moves that failure
 * to boot.
 *
 * A PEM pasted into a `.env` file often arrives with its newlines written as
 * the two characters `\n`, which no PEM parser reads; those are turned back
 * into newlines first.
 *
 * Throws on anything that is not an RSA private key, with a message that
 * names the setting rather than echoing the value.
 */
export function readPrivateKey(value: string): KeyObject {
  const raw = value.trimStart().startsWith("-----BEGIN");
  const pem = raw
    ? value.replaceAll("\\n", "\n")
    : Buffer.from(value, "base64").toString("utf8");
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new Error(
      raw
        ? "The GitHub App private key starts like a PEM but cannot be read. " +
            "Store it as base64 of the downloaded .pem file instead."
        : "The GitHub App private key is neither base64 of a PEM private key " +
            "nor a PEM itself.",
    );
  }
  if (key.asymmetricKeyType !== "rsa") {
    throw new Error("The GitHub App private key must be an RSA key.");
  }
  return key;
}

function encode(value: object): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
