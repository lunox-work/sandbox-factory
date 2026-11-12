/**
 * How a delivery is signed, Stripe's way: `Lunox-Signature: t=<unix
 * seconds>,v1=<hex>`, the hex being HMAC-SHA256 of `${t}.${body}` under the
 * endpoint's secret. The timestamp is inside the MAC, so a receiver that
 * refuses old ones cannot be replayed a captured delivery later.
 *
 * The secret is `whsec_` and 40 base62 characters, shown once on create
 * and on rotation, stored encrypted (`packages/db/src/webhooks.ts`).
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { WEBHOOK_SECRET_PREFIX } from "@sandbox-factory/shared";

import { randomBase62 } from "../api-tokens/secret.js";

export const SIGNATURE_HEADER = "Lunox-Signature";
export const EVENT_ID_HEADER = "Lunox-Event-Id";
export const EVENT_TYPE_HEADER = "Lunox-Event-Type";
/** How old a signature `verifySignature` accepts by default. */
export const SIGNATURE_TOLERANCE_S = 300;

export function generateWebhookSecret(
  random: (size: number) => Uint8Array = randomBytes,
): string {
  return `${WEBHOOK_SECRET_PREFIX}${randomBase62(40, random)}`;
}

function mac(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${body}`, "utf8")
    .digest("hex");
}

/** The `Lunox-Signature` value for `body` sent at `timestamp` (seconds). */
export function signatureHeader(
  secret: string,
  timestamp: number,
  body: string,
): string {
  return `t=${timestamp},v1=${mac(secret, timestamp, body)}`;
}

/**
 * What a receiver checks: the header names a `t` within `toleranceS` of
 * `nowS` and a `v1` that is the MAC of the body under `secret`. Here for
 * the tests and as the reference a receiver's code follows.
 */
export function verifySignature(
  secret: string,
  header: string,
  body: string,
  nowS: number,
  toleranceS = SIGNATURE_TOLERANCE_S,
): boolean {
  const fields = new Map(
    header.split(",").map((part) => {
      const [key = "", ...rest] = part.trim().split("=");
      return [key, rest.join("=")] as const;
    }),
  );
  const timestamp = Number(fields.get("t"));
  const given = fields.get("v1") ?? "";
  if (!Number.isInteger(timestamp) || Math.abs(nowS - timestamp) > toleranceS)
    return false;
  const expected = Buffer.from(mac(secret, timestamp, body), "hex");
  const actual = Buffer.from(given, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
