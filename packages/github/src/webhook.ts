/**
 * Webhook signature verification.
 *
 * GitHub signs every delivery with HMAC-SHA256 of the **raw body** under the
 * App's webhook secret and sends it as `X-Hub-Signature-256: sha256=<hex>`.
 * The route must verify before it parses: a body re-serialised from parsed
 * JSON does not reproduce GitHub's bytes, so the signature would never match
 * — and parsing an unauthenticated body is work a stranger should not be able
 * to make us do.
 *
 * Pure: no clock, no I/O. A delivery's freshness is not checked because
 * GitHub sends no timestamp to check; a replayed delivery is harmless here
 * because every handler is idempotent.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

const PREFIX = "sha256=";

/**
 * Whether `header` is GitHub's signature of `rawBody` under `secret`.
 *
 * False, never a throw, for a missing or malformed header, so the route has
 * one branch for every way a delivery can fail to authenticate. Compared in
 * constant time, so a forger learns nothing from how long it took.
 */
export function verifySignature(
  secret: string,
  rawBody: string | Uint8Array,
  header: string | null | undefined,
): boolean {
  if (secret === "" || header === null || header === undefined) return false;
  if (!header.startsWith(PREFIX)) return false;

  const hex = header.slice(PREFIX.length);
  if (!/^[0-9a-f]{64}$/i.test(hex)) return false;

  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const received = Buffer.from(hex, "hex");
  return (
    received.length === expected.length && timingSafeEqual(received, expected)
  );
}
