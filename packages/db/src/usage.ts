/**
 * A workspace's usage, counted from the rows its runs already write: no
 * table of its own, so nothing can drift from what happened.
 */

import { and, eq, gte, sql } from "drizzle-orm";

import type { Database } from "./errors.js";
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
}

export function createUsageStore(db: Database): UsageStore {
  return {
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
