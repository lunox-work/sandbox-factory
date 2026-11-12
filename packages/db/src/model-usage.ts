/**
 * The model-token ledger, and the monthly quota it backs. See
 * `schema/developer.ts`.
 *
 * **Recording is the truth.** Every model reply the platform pays for writes
 * one row, from where the reply comes back: a worker agent's turn
 * (`apps/worker/src/agent/metered.ts`) and each attempt of a sizing call in
 * the API (`BountyExecutor`). Input, output and cache tokens all count.
 *
 * **Admission is the guard.** The stores that start a run which calls a
 * model, `AnalysisRunStore.enqueue` for `MODEL_TOOLS` and
 * `BountyRunStore.create`, refuse a new run once the workspace's tokens this
 * calendar month (UTC) have reached its limit, when they were made with a
 * `TokenQuota`. A run already admitted is never cut off mid-run: it records
 * what it spends and may finish past the limit, and the next run is the one
 * refused. Two runs admitted at once may both start; the guard is not a
 * reservation.
 */

import { and, eq, gte, sql, type AnyColumn } from "drizzle-orm";
import type { AnalysisTool } from "sandbox-factory";

import type { Database } from "./errors.js";
import { generateId } from "./mapping.js";
import { modelUsage } from "./schema.js";

/**
 * The analysis tools whose runs may call a model: the agents, and a build,
 * which writes hidden tests and pseudonyms with one when its draft has
 * none. Every other tool is deterministic and is never refused for tokens.
 */
export const MODEL_TOOLS: ReadonlySet<AnalysisTool> = new Set<AnalysisTool>([
  "scope",
  "fixtures",
  "sandbox_build",
  "sandbox_starter",
]);

export interface ModelTokens {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export const NO_MODEL_TOKENS: ModelTokens = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

/** What the quota counts: every token the provider reported, of any kind. */
export function totalTokens(tokens: ModelTokens): number {
  return (
    tokens.inputTokens +
    tokens.outputTokens +
    tokens.cacheReadTokens +
    tokens.cacheWriteTokens
  );
}

export interface NewModelUsage extends ModelTokens {
  /** `analysis`: an `analysis_run`'s agent turn; `sizing`: a `bounty_run`'s call. */
  readonly runFamily: "analysis" | "sizing";
  readonly runId: string;
  /** The analysis run's tool, or the structured call's tool name. */
  readonly kind: string;
  /** The model that answered. */
  readonly model: string;
}

export interface ModelUsageStore {
  /** One reply's tokens. A reply that reported none writes nothing. */
  record(organizationId: string, entry: NewModelUsage): Promise<void>;
}

/**
 * The calendar month (UTC) `now` falls in: the quota's window, from its
 * first instant to the first instant of the next, when the count resets.
 */
export function quotaMonth(now: Date): { from: Date; resetsAt: Date } {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return {
    from: new Date(Date.UTC(year, month, 1)),
    resetsAt: new Date(Date.UTC(year, month + 1, 1)),
  };
}

/** A store's admission rule: how many tokens a workspace may spend a month. */
export interface TokenQuota {
  readonly monthlyLimit: number;
  readonly now?: () => Date;
}

/** A run refused because the workspace's month is spent. */
export interface QuotaExceeded {
  readonly ok: false;
  readonly reason: "quota_exceeded";
  readonly used: number;
  readonly limit: number;
  readonly resetsAt: Date;
}

const summed = (column: AnyColumn) =>
  sql<number>`coalesce(sum(${column}), 0)`.mapWith(Number);

/** The workspace's tokens recorded since `since`, by kind. */
export async function modelTokensSince(
  db: Pick<Database, "select">,
  organizationId: string,
  since: Date,
): Promise<ModelTokens> {
  const rows = await db
    .select({
      inputTokens: summed(modelUsage.inputTokens),
      outputTokens: summed(modelUsage.outputTokens),
      cacheReadTokens: summed(modelUsage.cacheReadTokens),
      cacheWriteTokens: summed(modelUsage.cacheWriteTokens),
    })
    .from(modelUsage)
    .where(
      and(
        eq(modelUsage.organizationId, organizationId),
        gte(modelUsage.at, since),
      ),
    );
  return rows[0] ?? NO_MODEL_TOKENS;
}

/**
 * The refusal a new model run meets, or null while the workspace's month
 * has tokens left. Read in the caller's transaction where it has one.
 */
export async function quotaExceeded(
  db: Pick<Database, "select">,
  organizationId: string,
  quota: TokenQuota,
): Promise<QuotaExceeded | null> {
  const month = quotaMonth((quota.now ?? (() => new Date()))());
  const used = totalTokens(
    await modelTokensSince(db, organizationId, month.from),
  );
  return used < quota.monthlyLimit
    ? null
    : {
        ok: false,
        reason: "quota_exceeded",
        used,
        limit: quota.monthlyLimit,
        resetsAt: month.resetsAt,
      };
}

export function createModelUsageStore(db: Database): ModelUsageStore {
  return {
    async record(organizationId, entry) {
      if (totalTokens(entry) === 0) return;
      await db.insert(modelUsage).values({
        id: generateId("mtk"),
        organizationId,
        runFamily: entry.runFamily,
        runId: entry.runId,
        kind: entry.kind,
        model: entry.model,
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        cacheReadTokens: entry.cacheReadTokens,
        cacheWriteTokens: entry.cacheWriteTokens,
      });
    },
  };
}
