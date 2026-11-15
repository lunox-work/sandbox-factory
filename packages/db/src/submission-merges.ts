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
 *
 * An opened one is then followed while its pull request is open: its
 * head's CI (`recordCi`) and whether it was merged or closed
 * (`recordPullRequest`), by GitHub's deliveries and the CI sweep
 * (`apps/api/src/github/merge-ci.ts`). Both writes take only a row whose
 * pull request is still open, so a late read never reopens a merged one
 * and only the first to see it merged is told so.
 */

import { and, asc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";

import type { Database } from "./errors.js";
import { generateId } from "./mapping.js";
import { submissionMerge } from "./schema.js";
import type { MergeCiSummaryRecord, SubmissionMergeRow } from "./schema.js";

export type MergeWhen = "open" | "ci_passes";
export type MergeCiState =
  "pending" | "passing" | "failing" | "none" | "unknown";

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
  /** Null for one opened before CI read-back: not followed. */
  readonly repoId: string | null;
  readonly mergeWhen: MergeWhen;
  readonly pullRequestState: "open" | "merged" | "closed";
  readonly ciState: MergeCiState;
  readonly ciSummary: MergeCiSummaryRecord | null;
  readonly ciHeadSha: string | null;
  readonly ciCheckedAt: string | null;
  readonly mergedCommitSha: string | null;
  readonly mergedAt: string | null;
  readonly mergeError: string | null;
}

/** What a request claims before it asks GitHub for anything. */
export interface NewSubmissionMergeClaim {
  readonly submissionId: string;
  readonly repositoryFullName: string;
  readonly branch: string;
  readonly openedBy: string;
  readonly repoId: string | null;
  readonly mergeWhen: MergeWhen;
}

/** A CI read of an open pull request's head. */
export interface MergeCiRead {
  readonly ciState: MergeCiState;
  readonly ciSummary: MergeCiSummaryRecord | null;
  readonly ciHeadSha: string | null;
  readonly ciCheckedAt: Date;
  /** Why GitHub refused the platform's merge; null clears it, absent keeps it. */
  readonly mergeError?: string | null;
}

/** An open pull request found merged or closed. */
export interface MergeEnded {
  readonly pullRequestState: "merged" | "closed";
  readonly mergedCommitSha: string | null;
  readonly mergedAt: Date | null;
  readonly checkedAt: Date;
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
  /**
   * Asks an opened merge-back whose pull request is still open to be
   * merged when CI passes (or not); null when there is no such row.
   */
  setMergeWhen(
    organizationId: string,
    submissionId: string,
    mergeWhen: MergeWhen,
  ): Promise<StoredSubmissionMerge | null>;
  /** The repository's merge-backs whose pull request is open: a delivery's. */
  openForRepo(
    organizationId: string,
    repoId: string,
  ): Promise<StoredSubmissionMerge[]>;
  /**
   * Every organization's open, followed merge-backs opened since
   * `openedSince` whose CI was last read before `readBefore` (or never),
   * least recently read first: the sweep's.
   */
  dueForCi(
    readBefore: Date,
    openedSince: Date,
    limit: number,
  ): Promise<
    { readonly organizationId: string; readonly merge: StoredSubmissionMerge }[]
  >;
  /** Records a CI read; null when the pull request is no longer open. */
  recordCi(
    organizationId: string,
    submissionId: string,
    read: MergeCiRead,
  ): Promise<StoredSubmissionMerge | null>;
  /**
   * Records an open pull request merged or closed; null when it was no
   * longer open, so whoever saw it first is the one that reports it.
   */
  recordPullRequest(
    organizationId: string,
    submissionId: string,
    ended: MergeEnded,
  ): Promise<StoredSubmissionMerge | null>;
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
        repoId: row.repoId,
        mergeWhen: row.mergeWhen,
        pullRequestState: row.pullRequestState,
        ciState: row.ciState,
        ciSummary: row.ciSummary ?? null,
        ciHeadSha: row.ciHeadSha,
        ciCheckedAt: row.ciCheckedAt?.toISOString() ?? null,
        mergedCommitSha: row.mergedCommitSha,
        mergedAt: row.mergedAt?.toISOString() ?? null,
        mergeError: row.mergeError,
      };

/** Opened rows whose pull request is still open: the ones followed. */
const followed = and(
  eq(submissionMerge.status, "opened"),
  eq(submissionMerge.pullRequestState, "open"),
);

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
            repoId: input.repoId,
            mergeWhen: input.mergeWhen,
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
        .set({
          status: "opened",
          claimedAt: null,
          ...opened,
          // CI is read on the commit it was opened with until a read says
          // the head moved.
          ciHeadSha: opened.commitSha,
        })
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
    async setMergeWhen(owner, submissionId, mergeWhen) {
      const [updated] = (await db
        .update(submissionMerge)
        .set({ mergeWhen })
        .where(and(ofSubmission(owner, submissionId), followed))
        .returning()) as SubmissionMergeRow[];
      return updated === undefined ? null : openedOf(updated);
    },
    async openForRepo(owner, repoId) {
      const rows = (await db
        .select()
        .from(submissionMerge)
        .where(
          and(
            eq(submissionMerge.organizationId, owner),
            eq(submissionMerge.repoId, repoId),
            followed,
          ),
        )) as SubmissionMergeRow[];
      return rows.flatMap((found) => openedOf(found) ?? []);
    },
    async dueForCi(readBefore, openedSince, limit) {
      const rows = (await db
        .select()
        .from(submissionMerge)
        .where(
          and(
            followed,
            sql`${submissionMerge.repoId} IS NOT NULL`,
            gte(submissionMerge.createdAt, openedSince),
            or(
              isNull(submissionMerge.ciCheckedAt),
              lt(submissionMerge.ciCheckedAt, readBefore),
            ),
          ),
        )
        .orderBy(
          sql`${submissionMerge.ciCheckedAt} ASC NULLS FIRST`,
          asc(submissionMerge.id),
        )
        .limit(limit)) as SubmissionMergeRow[];
      return rows.flatMap((found) => {
        const merge = openedOf(found);
        return merge === null
          ? []
          : [{ organizationId: found.organizationId, merge }];
      });
    },
    async recordCi(owner, submissionId, read) {
      const [updated] = (await db
        .update(submissionMerge)
        .set({
          ciState: read.ciState,
          ciSummary: read.ciSummary,
          ciHeadSha: read.ciHeadSha,
          ciCheckedAt: read.ciCheckedAt,
          ...(read.mergeError === undefined
            ? {}
            : { mergeError: read.mergeError }),
        })
        .where(and(ofSubmission(owner, submissionId), followed))
        .returning()) as SubmissionMergeRow[];
      return updated === undefined ? null : openedOf(updated);
    },
    async recordPullRequest(owner, submissionId, ended) {
      const [updated] = (await db
        .update(submissionMerge)
        .set({
          pullRequestState: ended.pullRequestState,
          mergedCommitSha: ended.mergedCommitSha,
          mergedAt: ended.mergedAt,
          ciCheckedAt: ended.checkedAt,
        })
        .where(and(ofSubmission(owner, submissionId), followed))
        .returning()) as SubmissionMergeRow[];
      return updated === undefined ? null : openedOf(updated);
    },
  };
}
