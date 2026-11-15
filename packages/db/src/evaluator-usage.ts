/**
 * The evaluator ledger, and the monthly cap it backs. See
 * `schema/developer.ts`.
 *
 * **Recording is the truth.** Every evaluation job a worker run creates
 * writes one row when it is torn down, with the seconds it was alive
 * (`apps/worker/src/evaluation/metered.ts`): a build's baselines, the
 * hidden-tests and reference agents' candidates, a calibration's rerun, a
 * grading run's jobs and its reversed check, an import's. A job is billed
 * whole seconds, rounded up, as the hosted sandbox bills it.
 *
 * **Admission is the guard.** `AnalysisRunStore.enqueue`, made with an
 * `EvaluatorQuota`, refuses a new run of an `EVALUATOR_TOOLS` tool once the
 * workspace's seconds this calendar month (UTC) have reached the cap, as
 * the token quota refuses a model run (`model-usage.ts`): a run already
 * admitted finishes, and the next is the one refused.
 */

import { and, eq, gte, sql } from "drizzle-orm";
import type { AnalysisTool } from "sandbox-factory";

import type { Database } from "./errors.js";
import { generateId } from "./mapping.js";
import { quotaMonth, type QuotaExceeded } from "./model-usage.js";
import { evaluatorUsage } from "./schema.js";

/** The analysis tools whose runs create evaluation jobs. */
export const EVALUATOR_TOOLS: ReadonlySet<AnalysisTool> = new Set<AnalysisTool>(
  ["sandbox_build", "sandbox_starter", "submission_grade", "sandbox_import"],
);

export interface NewEvaluatorUsage {
  /** The analysis run the job belongs to. */
  readonly runId: string;
  /** The run's tool. */
  readonly kind: string;
  readonly provider: string;
  /** Whole seconds the job was alive, rounded up. */
  readonly seconds: number;
}

export interface EvaluatorUsageStore {
  /** One job's seconds. */
  record(organizationId: string, entry: NewEvaluatorUsage): Promise<void>;
}

/** A job's billed seconds from its life in milliseconds: rounded up, at least one. */
export function billedSeconds(milliseconds: number): number {
  return Math.max(1, Math.ceil(milliseconds / 1000));
}

/** A store's admission rule: how many evaluator seconds a workspace may use a month. */
export interface EvaluatorQuota {
  readonly monthlySeconds: number;
  readonly now?: () => Date;
}

/** The workspace's evaluator use since `since`: seconds and jobs, by kind. */
export interface EvaluatorUse {
  readonly seconds: number;
  readonly jobs: number;
  readonly byKind: readonly {
    readonly kind: string;
    readonly seconds: number;
    readonly jobs: number;
  }[];
}

export const NO_EVALUATOR_USE: EvaluatorUse = {
  seconds: 0,
  jobs: 0,
  byKind: [],
};

/** The workspace's evaluator seconds recorded since `since`. */
export async function evaluatorSecondsSince(
  db: Pick<Database, "select">,
  organizationId: string,
  since: Date,
): Promise<number> {
  const rows = await db
    .select({
      seconds: sql<number>`coalesce(sum(${evaluatorUsage.seconds}), 0)`.mapWith(
        Number,
      ),
    })
    .from(evaluatorUsage)
    .where(
      and(
        eq(evaluatorUsage.organizationId, organizationId),
        gte(evaluatorUsage.at, since),
      ),
    );
  return rows[0]?.seconds ?? 0;
}

/** The workspace's evaluator use since `since`, by run kind. */
export async function evaluatorUseSince(
  db: Pick<Database, "select">,
  organizationId: string,
  since: Date,
): Promise<EvaluatorUse> {
  const rows = await db
    .select({
      kind: evaluatorUsage.kind,
      seconds: sql<number>`coalesce(sum(${evaluatorUsage.seconds}), 0)`.mapWith(
        Number,
      ),
      jobs: sql<number>`count(*)::int`.mapWith(Number),
    })
    .from(evaluatorUsage)
    .where(
      and(
        eq(evaluatorUsage.organizationId, organizationId),
        gte(evaluatorUsage.at, since),
      ),
    )
    .groupBy(evaluatorUsage.kind);
  const byKind = [...rows].sort((a, b) => a.kind.localeCompare(b.kind));
  return {
    seconds: byKind.reduce((sum, row) => sum + row.seconds, 0),
    jobs: byKind.reduce((sum, row) => sum + row.jobs, 0),
    byKind,
  };
}

/**
 * The refusal a new evaluator run meets, or null while the workspace's
 * month has seconds left. Read in the caller's transaction.
 */
export async function evaluatorQuotaExceeded(
  db: Pick<Database, "select">,
  organizationId: string,
  quota: EvaluatorQuota,
): Promise<QuotaExceeded | null> {
  const month = quotaMonth((quota.now ?? (() => new Date()))());
  const used = await evaluatorSecondsSince(db, organizationId, month.from);
  return used < quota.monthlySeconds
    ? null
    : {
        ok: false,
        reason: "quota_exceeded",
        kind: "evaluator_seconds",
        used,
        limit: quota.monthlySeconds,
        resetsAt: month.resetsAt,
      };
}

export function createEvaluatorUsageStore(db: Database): EvaluatorUsageStore {
  return {
    async record(organizationId, entry) {
      await db.insert(evaluatorUsage).values({
        id: generateId("evu"),
        organizationId,
        runId: entry.runId,
        kind: entry.kind,
        provider: entry.provider,
        seconds: Math.max(0, Math.round(entry.seconds)),
      });
    },
  };
}
