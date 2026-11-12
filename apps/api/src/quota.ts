/**
 * The answer a new model run meets once its workspace's monthly tokens are
 * spent: 429 `quota_exceeded`, with what was used, the limit, when the count
 * resets (the first instant of next month, UTC) and a `Retry-After` until
 * then. A 429 frees an `Idempotency-Key`, so the same request may be sent
 * again after the reset. The stores decide it (`TokenQuota` in
 * `model-usage.ts`); every route that starts such a run answers it here.
 */

import type { QuotaExceeded } from "@sandbox-factory/db";
import type { Context } from "hono";

export const QUOTA_EXCEEDED_STATUS = 429;

/** `MONTHLY_MODEL_TOKENS_PER_ORG` when unset. */
export const MONTHLY_MODEL_TOKENS_DEFAULT = 10_000_000;

type Refusal = Pick<QuotaExceeded, "used" | "limit" | "resetsAt">;

const count = (tokens: number) => tokens.toLocaleString("en-US");

/** The refusal's body: the API's `{ error, code }` with its figures. */
export function quotaExceededBody(refusal: Refusal) {
  const resetsAt = refusal.resetsAt.toISOString();
  return {
    error: `This workspace has reached its monthly model-token limit (${count(refusal.used)} of ${count(refusal.limit)} tokens). Runs that call a model are refused until it resets at ${resetsAt}, the start of next month (UTC).`,
    code: "quota_exceeded" as const,
    used: refusal.used,
    limit: refusal.limit,
    resetsAt,
  };
}

/**
 * `Retry-After` from a refusal body's `resetsAt`, in whole seconds and at
 * least one. A body without one sets nothing.
 */
export function setRetryAfter(c: Context, body: object, now = new Date()) {
  const resetsAt = "resetsAt" in body ? body.resetsAt : undefined;
  if (typeof resetsAt !== "string") return;
  const seconds = Math.ceil((Date.parse(resetsAt) - now.getTime()) / 1000);
  c.header("Retry-After", String(Math.max(1, seconds)));
}

/** The 429 a route answers a refused run with. */
export function quotaExceededResponse(c: Context, refusal: Refusal) {
  const body = quotaExceededBody(refusal);
  setRetryAfter(c, body);
  return c.json(body, QUOTA_EXCEEDED_STATUS);
}
