/**
 * A workspace's usage. Its runs are counted from the rows they already
 * write, so nothing can drift from what happened; its model tokens are
 * summed from the ledger every model reply writes (`model-usage.ts`), its
 * evaluator seconds from the one every evaluation job writes
 * (`evaluator-usage.ts`), its grading attempts from the rows queueing a
 * grading run writes (`grading-attempts.ts`), and its uploads from the
 * import runs an uploaded folder queues.
 */

import { and, eq, gte, sql } from "drizzle-orm";

import type { Database } from "./errors.js";
import { evaluatorUseSince, type EvaluatorUse } from "./evaluator-usage.js";
import { gradingAttemptsSince } from "./grading-attempts.js";
import { modelTokensSince, type ModelTokens } from "./model-usage.js";
import { analysisRun, bountyRun } from "./schema.js";

export interface RunCount {
  /** `sizing`: bounty runs; `analysis`: repository and sandbox runs. */
  readonly family: "sizing" | "analysis";
  /** A sizing run's kind, or an analysis run's tool. */
  readonly kind: string;
  readonly status: string;
  readonly count: number;
}

export interface UsageStore {
  /** Runs the organization started since `since`, by family, kind and state. */
  runCounts(organizationId: string, since: Date): Promise<RunCount[]>;
  /** The model tokens the organization's runs recorded since `since`. */
  modelTokens(organizationId: string, since: Date): Promise<ModelTokens>;
  /** The evaluator seconds and jobs its runs recorded since `since`, by kind. */
  evaluator(organizationId: string, since: Date): Promise<EvaluatorUse>;
  /**
   * Grading attempts queued since `since` (`contributor`: those invited
   * contributors made), and folders uploaded (import runs queued).
   */
  submissionsAndUploads(
    organizationId: string,
    since: Date,
  ): Promise<{
    readonly gradingAttempts: number;
    readonly contributorGradingAttempts: number;
    readonly uploads: number;
  }>;
}

export function createUsageStore(db: Database): UsageStore {
  return {
    modelTokens: (owner, since) => modelTokensSince(db, owner, since),
    evaluator: (owner, since) => evaluatorUseSince(db, owner, since),
    async submissionsAndUploads(owner, since) {
      const [grading, uploads] = await Promise.all([
        gradingAttemptsSince(db, owner, since),
        db
          .select({ count: sql<number>`count(*)::int`.mapWith(Number) })
          .from(analysisRun)
          .where(
            and(
              eq(analysisRun.organizationId, owner),
              eq(analysisRun.tool, "sandbox_import"),
              gte(analysisRun.createdAt, since),
            ),
          ),
      ]);
      return {
        gradingAttempts: grading.attempts,
        contributorGradingAttempts: grading.contributor,
        uploads: uploads[0]?.count ?? 0,
      };
    },
    async runCounts(owner, since) {
      const count = sql<number>`count(*)::int`;
      const [sizing, analysis] = await Promise.all([
        db
          .select({ kind: bountyRun.kind, status: bountyRun.status, count })
          .from(bountyRun)
          .where(
            and(
              eq(bountyRun.organizationId, owner),
              gte(bountyRun.createdAt, since),
            ),
          )
          .groupBy(bountyRun.kind, bountyRun.status),
        db
          .select({ kind: analysisRun.tool, status: analysisRun.status, count })
          .from(analysisRun)
          .where(
            and(
              eq(analysisRun.organizationId, owner),
              gte(analysisRun.createdAt, since),
            ),
          )
          .groupBy(analysisRun.tool, analysisRun.status),
      ]);
      const ordered = (
        rows: { kind: string; status: string; count: number }[],
      ) =>
        [...rows].sort(
          (a, b) =>
            a.kind.localeCompare(b.kind) || a.status.localeCompare(b.status),
        );
      return [
        ...ordered(sizing).map((row) => ({
          family: "sizing" as const,
          ...row,
        })),
        ...ordered(analysis).map((row) => ({
          family: "analysis" as const,
          ...row,
        })),
      ];
    },
  };
}
