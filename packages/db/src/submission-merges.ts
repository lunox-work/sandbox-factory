/**
 * Merge-backs (`submissionMerge`), organization-scoped: the pull request a
 * passing submission was carried back to its repository as. One per
 * submission, guarded by the unique key on `submission_id`, not by any
 * process: the API runs as several tasks.
 *
 * A request first claims the row (`pending`, `claimed_at` now), then asks
 * GitHub, then records what GitHub opened (`opened`). A second click while
 * the first is out finds the claim and is told so; a click after a failed
 * or abandoned attempt (released, or its claim older than the lease)
 * claims it again and resumes. Only `opened` rows are read back as merges.
 */

import { and, eq, inArray, isNull, lt, or } from "drizzle-orm";

import type { Database } from "./errors.js";
import { generateId } from "./mapping.js";
import { submissionMerge } from "./schema.js";
import type { SubmissionMergeRow } from "./schema.js";

/**
 * How long a claim stands before another request may take it over: longer
 * than a merge-back's handful of GitHub calls (10 s each at most), short
 * enough that a task that died mid-way does not block the button for long.
 */
export const MERGE_CLAIM_LEASE_MS = 5 * 60_000;

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

/** What a request claims before it asks GitHub for anything. */
export interface NewSubmissionMergeClaim {
  readonly submissionId: string;
  readonly repositoryFullName: string;
  readonly branch: string;
  readonly openedBy: string;
}

/** What GitHub opened, recorded on the claim. */
export interface OpenedSubmissionMerge {
  readonly commitSha: string;
  readonly pullRequestNumber: number;
  readonly pullRequestUrl: string;
}

/**
 * - `claimed`: this request opens it, and finishes or releases the claim.
 * - `opened`: it was opened already; here it is.
 * - `busy`: another request holds a live claim and is opening it now.
 */
export type SubmissionMergeClaim =
  | { readonly status: "claimed" }
  | { readonly status: "opened"; readonly merge: StoredSubmissionMerge }
  | { readonly status: "busy" };

export interface SubmissionMergeStore {
  /** The submission's opened merge-back, or null when none was opened. */
  get(
    organizationId: string,
    submissionId: string,
  ): Promise<StoredSubmissionMerge | null>;
  /** Opened merge-backs of these submissions, for a list. */
  list(
    organizationId: string,
    submissionIds: readonly string[],
  ): Promise<StoredSubmissionMerge[]>;
  /** Claims the submission's merge-back for this request; see the file comment. */
  claim(
    organizationId: string,
    input: NewSubmissionMergeClaim,
  ): Promise<SubmissionMergeClaim>;
  /** Records the pull request on the claim; the one recorded first wins. */
  finish(
    organizationId: string,
    submissionId: string,
    opened: OpenedSubmissionMerge,
  ): Promise<StoredSubmissionMerge>;
  /** Gives a claim up after a failure, so a retry resumes at once. */
  release(organizationId: string, submissionId: string): Promise<void>;
}

/** An opened row as a merge; null for a pending one. */
const openedOf = (row: SubmissionMergeRow): StoredSubmissionMerge | null =>
  row.status !== "opened" ||
  row.commitSha === null ||
  row.pullRequestNumber === null ||
  row.pullRequestUrl === null
    ? null
    : {
        id: row.id,
        submissionId: row.submissionId,
        repositoryFullName: row.repositoryFullName,
        branch: row.branch,
        commitSha: row.commitSha,
        pullRequestNumber: row.pullRequestNumber,
        pullRequestUrl: row.pullRequestUrl,
        openedBy: row.openedBy,
        createdAt: row.createdAt.toISOString(),
      };

export function createSubmissionMergeStore(
  db: Database,
  options: { readonly now?: () => number } = {},
): SubmissionMergeStore {
  const now = options.now ?? Date.now;
  const ofSubmission = (owner: string, submissionId: string) =>
    and(
      eq(submissionMerge.organizationId, owner),
      eq(submissionMerge.submissionId, submissionId),
    );
  const row = async (owner: string, submissionId: string) => {
    const [found] = (await db
      .select()
      .from(submissionMerge)
      .where(ofSubmission(owner, submissionId))
      .limit(1)) as SubmissionMergeRow[];
    return found;
  };
  const get: SubmissionMergeStore["get"] = async (owner, submissionId) => {
    const found = await row(owner, submissionId);
    return found === undefined ? null : openedOf(found);
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
            eq(submissionMerge.status, "opened"),
          ),
        )) as SubmissionMergeRow[];
      return rows.flatMap((found) => openedOf(found) ?? []);
    },
    async claim(owner, input) {
      const at = new Date(now());
      // One statement: Postgres serialises two inserts on the unique key,
      // and the conflict branch takes over only a pending row whose claim
      // was released or has lapsed. Anything else returns no row.
      const [claimed] = (await db
        .insert(submissionMerge)
        .values({
          id: generateId("smg"),
          organizationId: owner,
          ...input,
          status: "pending",
          claimedAt: at,
        })
        .onConflictDoUpdate({
          target: submissionMerge.submissionId,
          set: {
            claimedAt: at,
            repositoryFullName: input.repositoryFullName,
            branch: input.branch,
            openedBy: input.openedBy,
          },
          setWhere: and(
            eq(submissionMerge.organizationId, owner),
            eq(submissionMerge.status, "pending"),
            or(
              isNull(submissionMerge.claimedAt),
              lt(
                submissionMerge.claimedAt,
                new Date(at.getTime() - MERGE_CLAIM_LEASE_MS),
              ),
            ),
          ),
        })
        .returning()) as SubmissionMergeRow[];
      if (claimed !== undefined) return { status: "claimed" };
      const found = await row(owner, input.submissionId);
      if (found === undefined)
        throw new Error("Merge-back claim returned no row.");
      const merge = openedOf(found);
      return merge === null ? { status: "busy" } : { status: "opened", merge };
    },
    async finish(owner, submissionId, opened) {
      const [updated] = (await db
        .update(submissionMerge)
        .set({ status: "opened", claimedAt: null, ...opened })
        .where(
          and(
            ofSubmission(owner, submissionId),
            eq(submissionMerge.status, "pending"),
          ),
        )
        .returning()) as SubmissionMergeRow[];
      const merge =
        updated === undefined
          ? await get(owner, submissionId)
          : openedOf(updated);
      if (merge === null) throw new Error("Merge-back finish found no row.");
      return merge;
    },
    async release(owner, submissionId) {
      await db
        .update(submissionMerge)
        .set({ claimedAt: null })
        .where(
          and(
            ofSubmission(owner, submissionId),
            eq(submissionMerge.status, "pending"),
          ),
        );
    },
  };
}
