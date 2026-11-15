/**
 * The answers a new run meets once a workspace's month is spent, or a
 * contributor's grading is braked, and the defaults they are measured by.
 *
 * `quota_exceeded` (429): the month's model tokens (`kind: "model_tokens"`)
 * or evaluator seconds (`kind: "evaluator_seconds"`) are spent, with what
 * was used, the limit, when the count resets (the first instant of next
 * month, UTC) and a `Retry-After` until then. `rate_limited` (429): an
 * invited contributor's grading attempt past a daily brake, with a
 * `Retry-After` until the rolling day's oldest attempt leaves it. A 429
 * frees an `Idempotency-Key`, so the same request may be sent again later.
 * The stores decide both (`TokenQuota` in `model-usage.ts`,
 * `EvaluatorQuota` in `evaluator-usage.ts`, `GradingBrakes` in
 * `grading-attempts.ts`); every route that starts such a run answers here.
 */

import type { GradingRateLimited, QuotaExceeded } from "@sandbox-factory/db";
import type { Context } from "hono";

export const QUOTA_EXCEEDED_STATUS = 429;

/**
 * `MONTHLY_MODEL_TOKENS_PER_ORG` when unset: 60M tokens (input, output and
 * cache tokens alike; cache reads dominate, as every agent turn resends the
 * conversation).
 *
 * Measured against the worker's per-agent budget (`AGENT_TOKEN_BUDGET`, 4M
 * a run, 40 turns): a sliced sandbox is a scope run (one agent) and a build
 * that may write fixtures, pseudonyms, hidden tests and a reference (four
 * more), so 20M if every agent spent its whole budget, and about 5-8M as
 * agents usually finish, within a third of theirs; a starter is two agents
 * (starter and reference), 8M at most. The flow harness records one
 * ledger row per agent turn (`e2e/flow`), about 20 turns a sliced build
 * across its agents. At 10M, the old default, a workspace got one or two
 * sandboxes a month; 60M is eight to twelve typical ones, and three even if
 * every agent ran to its cap. Sizing calls are a rounding error beside it.
 */
export const MONTHLY_MODEL_TOKENS_DEFAULT = 60_000_000;

/**
 * The fewest tokens left this month a new model run may start on
 * (`TokenQuota.startFloor`): enough for a few agent turns. A run is never
 * refused because its declared budget would not fit, which would refuse
 * almost every run long before the month is spent; only one starting on
 * so little it could not get anywhere.
 */
export const MODEL_TOKENS_START_FLOOR = 250_000;

/**
 * `MONTHLY_EVALUATOR_SECONDS_PER_ORG` when unset: 100 hours of evaluation
 * jobs a month. A build is about ten to fifteen jobs (baselines, the
 * hidden-tests and reference agents' candidates, a calibration's rerun) of
 * one to two minutes; a grading run two to four; so roughly fifty builds
 * and five hundred gradings, generous for one workspace, while a runaway
 * loop stops within the month rather than on the invoice.
 */
export const MONTHLY_EVALUATOR_SECONDS_DEFAULT = 360_000;

/**
 * An invited contributor's grading attempts per assignment in a rolling
 * day: first submission, retry and regrades alike (dry runs never queue a
 * run). A contributor has one submission and one retry, so this bounds
 * regrades of errored ones, the only attempts left to repeat.
 */
export const GRADING_ATTEMPTS_PER_ASSIGNMENT_DAY = 10;

/**
 * `CONTRIBUTOR_GRADING_RUNS_PER_ORG_DAY` when unset: all of a workspace's
 * contributors' grading attempts in a rolling day.
 */
export const CONTRIBUTOR_GRADING_RUNS_PER_ORG_DAY_DEFAULT = 200;

type Refusal = Pick<QuotaExceeded, "used" | "limit" | "resetsAt"> &
  Partial<Pick<QuotaExceeded, "kind">>;

const count = (value: number) => value.toLocaleString("en-US");

/** The refusal's body: the API's `{ error, code }` with its figures. */
export function quotaExceededBody(refusal: Refusal) {
  const resetsAt = refusal.resetsAt.toISOString();
  const kind = refusal.kind ?? "model_tokens";
  return {
    error:
      kind === "evaluator_seconds"
        ? `This workspace has used its monthly evaluator time (${count(refusal.used)} of ${count(refusal.limit)} seconds). Builds, imports and grading are refused until it resets at ${resetsAt}, the start of next month (UTC).`
        : `This workspace has reached its monthly model-token limit (${count(refusal.used)} of ${count(refusal.limit)} tokens). Runs that call a model are refused until it resets at ${resetsAt}, the start of next month (UTC).`,
    code: "quota_exceeded" as const,
    kind,
    used: refusal.used,
    limit: refusal.limit,
    resetsAt,
  };
}

/**
 * The app's clock (`AppOptions.now`), which `createApp` puts on every
 * request's context as `clock`; the wall clock on an app mounted without.
 */
function nowOf(c: Context): Date {
  const clock: unknown = c.get("clock");
  return typeof clock === "function" ? (clock as () => Date)() : new Date();
}

/**
 * `Retry-After` from a refusal body's `resetsAt` or `retryAt`, in whole
 * seconds and at least one, measured by the app's clock. A body without
 * either sets nothing.
 */
export function setRetryAfter(c: Context, body: object, now = nowOf(c)) {
  const at =
    "resetsAt" in body
      ? body.resetsAt
      : "retryAt" in body
        ? body.retryAt
        : undefined;
  if (typeof at !== "string") return;
  const seconds = Math.ceil((Date.parse(at) - now.getTime()) / 1000);
  c.header("Retry-After", String(Math.max(1, seconds)));
}

/** The 429 a route answers a refused run with. */
export function quotaExceededResponse(c: Context, refusal: Refusal) {
  const body = quotaExceededBody(refusal);
  setRetryAfter(c, body);
  return c.json(body, QUOTA_EXCEEDED_STATUS);
}

/** A braked grading attempt's body: which brake, its limit, and when to try again. */
export function rateLimitedBody(refusal: GradingRateLimited) {
  return {
    error:
      refusal.scope === "assignment"
        ? `This assignment has had ${count(refusal.limit)} grading attempts in the last 24 hours. The submission is kept: send it again after ${refusal.retryAt.toISOString()}.`
        : `This workspace's contributors have had ${count(refusal.limit)} grading attempts in the last 24 hours. The submission is kept: send it again after ${refusal.retryAt.toISOString()}.`,
    code: "rate_limited" as const,
    scope: refusal.scope,
    limit: refusal.limit,
    retryAt: refusal.retryAt.toISOString(),
    retryable: true as const,
  };
}

/** The 429 a braked grading attempt is answered with. */
export function rateLimitedResponse(c: Context, refusal: GradingRateLimited) {
  const body = rateLimitedBody(refusal);
  setRetryAfter(c, body);
  return c.json(body, QUOTA_EXCEEDED_STATUS);
}
