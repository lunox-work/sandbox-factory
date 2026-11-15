/**
 * Grading attempts, and the brakes on a contributor's. See
 * `gradingAttempt` in `schema/developer.ts`.
 *
 * `AnalysisRunStore.enqueue` writes one row in the transaction that queues
 * a grading run (a new run, or a failed one queued again), whoever asked:
 * a workspace's owner or admin, an invited contributor, the CI judge. A
 * cached run answered as it stands writes none, and neither does a dry run,
 * which never reaches the store.
 *
 * Made with `GradingBrakes`, the store refuses (`rate_limited`) an invited
 * contributor's attempt once their assignment has had
 * `perAssignmentDaily` attempts in the last 24 hours, or the workspace's
 * contributors together have had `perOrganizationDaily`, whatever the
 * active-run limit allows: grading costs the workspace evaluator time, and
 * a contributor is not a member who answers for it. A workspace's own
 * submissions and the CI judge's are never braked here. The window rolls:
 * the refusal says when its oldest attempt leaves it.
 */

import { and, eq, gte, isNotNull, sql } from "drizzle-orm";

import type { Database } from "./errors.js";
import { generateId } from "./mapping.js";
import { gradingAttempt, submission } from "./schema.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The brakes' limits, each over the last 24 hours. */
export interface GradingBrakes {
  /** One assignment's grading attempts. */
  readonly perAssignmentDaily: number;
  /** All of a workspace's contributors' grading attempts together. */
  readonly perOrganizationDaily: number;
  readonly now?: () => Date;
}

/** An attempt refused by a brake, and when it may be made again. */
export interface GradingRateLimited {
  readonly ok: false;
  readonly reason: "rate_limited";
  readonly scope: "assignment" | "organization";
  readonly limit: number;
  readonly retryAt: Date;
}

/** The assignment a submission was made under; null for none, or no such submission. */
export async function assignmentOfSubmission(
  db: Pick<Database, "select">,
  organizationId: string,
  submissionId: string,
): Promise<string | null> {
  const rows = await db
    .select({ assignmentId: submission.assignmentId })
    .from(submission)
    .where(
      and(
        eq(submission.organizationId, organizationId),
        eq(submission.id, submissionId),
      ),
    )
    .limit(1);
  return rows[0]?.assignmentId ?? null;
}

const counted = (db: Pick<Database, "select">, where: ReturnType<typeof and>) =>
  db
    .select({
      count: sql<number>`count(*)::int`.mapWith(Number),
      oldest: sql<Date | null>`min(${gradingAttempt.at})`,
    })
    .from(gradingAttempt)
    .where(where);

/**
 * The refusal an assignment's next attempt meets, or null. Read in the
 * transaction that would queue the run, after the organization's row is
 * locked, so two attempts at once are counted one after the other.
 */
export async function gradingBrakeRefusal(
  db: Pick<Database, "select">,
  organizationId: string,
  assignmentId: string,
  brakes: GradingBrakes,
): Promise<GradingRateLimited | null> {
  const now = (brakes.now ?? (() => new Date()))();
  const since = new Date(now.getTime() - DAY_MS);
  const checks = [
    {
      scope: "assignment" as const,
      limit: brakes.perAssignmentDaily,
      where: and(
        eq(gradingAttempt.organizationId, organizationId),
        eq(gradingAttempt.assignmentId, assignmentId),
        gte(gradingAttempt.at, since),
      ),
    },
    {
      scope: "organization" as const,
      limit: brakes.perOrganizationDaily,
      where: and(
        eq(gradingAttempt.organizationId, organizationId),
        isNotNull(gradingAttempt.assignmentId),
        gte(gradingAttempt.at, since),
      ),
    },
  ];
  for (const check of checks) {
    const row = (await counted(db, check.where))[0];
    const count = row?.count ?? 0;
    if (count < check.limit) continue;
    const oldest = row?.oldest == null ? now : new Date(row.oldest);
    return {
      ok: false,
      reason: "rate_limited",
      scope: check.scope,
      limit: check.limit,
      retryAt: new Date(
        Math.max(now.getTime() + 1000, oldest.getTime() + DAY_MS),
      ),
    };
  }
  return null;
}

/** One grading run queued for a submission. */
export async function recordGradingAttempt(
  db: Pick<Database, "insert">,
  organizationId: string,
  entry: {
    readonly submissionId: string;
    readonly assignmentId: string | null;
    readonly runId: string;
  },
): Promise<void> {
  await db.insert(gradingAttempt).values({
    id: generateId("gat"),
    organizationId,
    submissionId: entry.submissionId,
    assignmentId: entry.assignmentId,
    runId: entry.runId,
  });
}

/** The workspace's grading attempts since `since`, and its contributors' share. */
export async function gradingAttemptsSince(
  db: Pick<Database, "select">,
  organizationId: string,
  since: Date,
): Promise<{ readonly attempts: number; readonly contributor: number }> {
  const rows = await db
    .select({
      attempts: sql<number>`count(*)::int`.mapWith(Number),
      contributor:
        sql<number>`count(${gradingAttempt.assignmentId})::int`.mapWith(Number),
    })
    .from(gradingAttempt)
    .where(
      and(
        eq(gradingAttempt.organizationId, organizationId),
        gte(gradingAttempt.at, since),
      ),
    );
  return {
    attempts: rows[0]?.attempts ?? 0,
    contributor: rows[0]?.contributor ?? 0,
  };
}
