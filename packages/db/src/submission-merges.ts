/**
 * Merge-backs (`submissionMerge`), organization-scoped: the pull request a
 * passing submission was carried back to its repository as. One per
 * submission; recording a second keeps the first.
 */

import { and, eq, inArray } from "drizzle-orm";

import type { Database } from "./errors.js";
import { generateId } from "./mapping.js";
import { submissionMerge } from "./schema.js";
import type { SubmissionMergeRow } from "./schema.js";

export interface StoredSubmissionMerge {
  readonly id: string;
  readonly submissionId: string;
  readonly repositoryFullName: string;
  readonly branch: string;
  readonly commitSha: string;
  readonly pullRequestNumber: number;
  readonly pullRequestUrl: string;
  readonly openedBy: string | null;
  readonly createdAt: string;
}

export interface NewSubmissionMerge {
  readonly submissionId: string;
  readonly repositoryFullName: string;
  readonly branch: string;
  readonly commitSha: string;
  readonly pullRequestNumber: number;
  readonly pullRequestUrl: string;
  readonly openedBy: string;
}

export interface SubmissionMergeStore {
  /** The submission's merge-back, or null when none was opened. */
  get(
    organizationId: string,
    submissionId: string,
  ): Promise<StoredSubmissionMerge | null>;
  /** Merge-backs of these submissions, for a list. */
  list(
    organizationId: string,
    submissionIds: readonly string[],
  ): Promise<StoredSubmissionMerge[]>;
  /** Records an opened pull request; the one already there when there is one. */
  record(
    organizationId: string,
    input: NewSubmissionMerge,
  ): Promise<StoredSubmissionMerge>;
}

const toStored = (row: SubmissionMergeRow): StoredSubmissionMerge => ({
  id: row.id,
  submissionId: row.submissionId,
  repositoryFullName: row.repositoryFullName,
  branch: row.branch,
  commitSha: row.commitSha,
  pullRequestNumber: row.pullRequestNumber,
  pullRequestUrl: row.pullRequestUrl,
  openedBy: row.openedBy,
  createdAt: row.createdAt.toISOString(),
});

export function createSubmissionMergeStore(db: Database): SubmissionMergeStore {
  const get: SubmissionMergeStore["get"] = async (owner, submissionId) => {
    const [row] = (await db
      .select()
      .from(submissionMerge)
      .where(
        and(
          eq(submissionMerge.organizationId, owner),
          eq(submissionMerge.submissionId, submissionId),
        ),
      )
      .limit(1)) as SubmissionMergeRow[];
    return row === undefined ? null : toStored(row);
  };
  return {
    get,
    async list(owner, submissionIds) {
      if (submissionIds.length === 0) return [];
      const rows = (await db
        .select()
        .from(submissionMerge)
        .where(
          and(
            eq(submissionMerge.organizationId, owner),
            inArray(submissionMerge.submissionId, [...submissionIds]),
          ),
        )) as SubmissionMergeRow[];
      return rows.map(toStored);
    },
    async record(owner, input) {
      const [row] = (await db
        .insert(submissionMerge)
        .values({ id: generateId("smg"), organizationId: owner, ...input })
        .onConflictDoNothing({ target: submissionMerge.submissionId })
        .returning()) as SubmissionMergeRow[];
      if (row !== undefined) return toStored(row);
      const found = await get(owner, input.submissionId);
      if (found === null) throw new Error("Merge-back insert returned no row.");
      return found;
    },
  };
}
