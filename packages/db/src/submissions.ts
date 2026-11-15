/**
 * Submissions: contributors' attempts at a sandbox version, owner-scoped.
 *
 * A submission is the protected sandbox of a bounty: a patch applied to the
 * version it was made against and run with the hidden tests. Only a frozen
 * version takes one, since a draft can still change under it. The same
 * patch against the same version is the same submission, so a retried
 * upload finds the one it already made.
 *
 * Status moves `queued`, `running` once a worker takes its grading run
 * (`runningSubmission`, in the claim's transaction), then `passed`,
 * `failed` or `errored`, each written by the run store in the transaction
 * that ends the grading run (`settleSubmission`, `erroredSubmissions`
 * below): a verdict commits with
 * the run's artifacts, its merge patch among them, or not at all. A failed
 * or errored submission takes one retry (`retry`), a new submission that
 * names it in `retryOf`; the contributor is told only the first one's
 * scenario keys. An errored one never ran to a verdict, so it is also
 * graded again with its own files (`reopenSubmission`, when its run is
 * queued again), which spends no retry. An invited contributor
 * (`assignmentId`) makes one first submission per assignment, and only they
 * retry it; a workspace's own owners and admins make any number. The same
 * files from the same person are the same submission, never another
 * person's. A verdict is never computed here;
 * `submissionVerdict` in core decides it from the counts, so the rule is
 * the same wherever it is read.
 */

import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  submissionVerdict,
  type SubmissionError,
  type SubmissionResult,
  type SubmissionStatus,
} from "sandbox-factory";

import {
  isUniqueViolation,
  type Database,
  type QueryExecutor,
} from "./errors.js";
import { generateId } from "./mapping.js";
import { sandbox, sandboxVersion, submission } from "./schema.js";
import type { SubmissionRow } from "./schema.js";

export interface StoredSubmission {
  readonly id: string;
  readonly sandboxVersionId: string;
  readonly submittedBy: string | null;
  readonly patchSha256: string;
  readonly status: SubmissionStatus;
  readonly result: SubmissionResult | null;
  /** Why an errored submission could not be graded; null otherwise. */
  readonly errorCode: SubmissionError | null;
  readonly runId: string | null;
  /** The submission this one retries; null for a first attempt. */
  readonly retryOf: string | null;
  /** The invited contributor's assignment it was made under, if any. */
  readonly assignmentId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NewSubmission {
  readonly sandboxVersionId: string;
  /** The person; null for a pull request the CI judge took, which has none. */
  readonly submittedBy: string | null;
  readonly patchKey: string;
  readonly patchSha256: string;
  /**
   * An invited contributor's assignment: one first submission each.
   * Absent or null for a workspace's own people and the CI judge.
   */
  readonly assignmentId?: string | null;
}

export type CreateSubmissionResult =
  | {
      readonly ok: true;
      readonly submission: StoredSubmission;
      /** False when this patch was already submitted against the version. */
      readonly created: boolean;
    }
  | { readonly ok: false; readonly reason: "not-found" | "not_frozen" }
  /** The assignment's first submission was made, with other files. */
  | {
      readonly ok: false;
      readonly reason: "already_submitted";
      readonly submissionId: string;
    };

export type RetrySubmissionResult =
  | {
      readonly ok: true;
      readonly submission: StoredSubmission;
      /** False when this retry, with these files, was already made. */
      readonly created: boolean;
      /**
       * An errored submission retried with its own files: nothing is made,
       * and it is graded again in place (its run queued again), without
       * spending its retry.
       */
      readonly regrade?: true;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "not-found"
        /** Still queued or running: there is no verdict to retry yet. */
        | "not_finished"
        | "passed"
        /** A retry is not retried. */
        | "is_retry"
        /** The submission's one retry was made, with other files. */
        | "retry_used"
        /** These files were already submitted against the version. */
        | "same_patch"
        /** An invited contributor's submission, which only they retry. */
        | "contributor_submission";
    };

export interface SubmissionStore {
  create(
    organizationId: string,
    input: NewSubmission,
  ): Promise<CreateSubmissionResult>;
  /**
   * One submission, with the key its files are stored under (never shown
   * outside the platform). Null for another workspace's or none.
   */
  get(
    organizationId: string,
    submissionId: string,
  ): Promise<(StoredSubmission & { readonly patchKey: string }) | null>;
  /**
   * A new submission against the same version that retries a failed or
   * errored one: its one retry. The same files again find the retry made.
   * An errored submission with its own files is answered `regrade`.
   */
  retry(
    organizationId: string,
    submissionId: string,
    input: Omit<NewSubmission, "sandboxVersionId">,
  ): Promise<RetrySubmissionResult>;
  /** A version's submissions, newest first; `submittedBy`'s alone when given. */
  list(
    organizationId: string,
    sandboxVersionId: string,
    filter?: { readonly submittedBy?: string },
  ): Promise<StoredSubmission[]>;
}

/** A submission still waiting for its grading run: no verdict, no error. */
const WAITING: readonly SubmissionStatus[] = ["queued", "running"];

/**
 * The verdict a committed grading run found, written inside the run's
 * fenced commit (`AnalysisRunStore.finish`), so it lands with the run's
 * artifacts or not at all. Only a submission still waiting takes it.
 */
export async function settleSubmission(
  tx: QueryExecutor,
  owner: string,
  graded: { readonly id: string; readonly runId: string },
  result: SubmissionResult,
  now: Date,
): Promise<boolean> {
  const rows = await tx
    .update(submission)
    .set({
      status: submissionVerdict(result),
      result,
      errorCode: null,
      runId: graded.runId,
      updatedAt: now,
    })
    .where(
      and(
        eq(submission.organizationId, owner),
        eq(submission.id, graded.id),
        inArray(submission.status, [...WAITING]),
      ),
    )
    .returning({ id: submission.id });
  return rows.length > 0;
}

/**
 * Submissions whose grading run has ended without a verdict, `errored`
 * with the fixed reason given, inside the transaction that ended the run.
 * Only those still waiting move.
 */
export async function erroredSubmissions(
  tx: QueryExecutor,
  owner: string,
  ended: readonly {
    readonly submissionId: string;
    readonly runId: string;
    readonly errorCode: SubmissionError;
  }[],
  now: Date,
): Promise<void> {
  for (const { submissionId, runId, errorCode } of ended)
    await tx
      .update(submission)
      .set({ status: "errored", errorCode, runId, updatedAt: now })
      .where(
        and(
          eq(submission.organizationId, owner),
          eq(submission.id, submissionId),
          inArray(submission.status, [...WAITING]),
        ),
      );
}

/**
 * A queued submission `running`, inside the transaction in which a worker
 * claims its grading run: the web shows it as being graded from then on.
 * A run claimed again after a lost lease finds it running already.
 */
export async function runningSubmission(
  tx: QueryExecutor,
  owner: string,
  submissionId: string,
  now: Date,
): Promise<void> {
  await tx
    .update(submission)
    .set({ status: "running", updatedAt: now })
    .where(
      and(
        eq(submission.organizationId, owner),
        eq(submission.id, submissionId),
        eq(submission.status, "queued"),
      ),
    );
}

/**
 * An errored submission waiting again, inside the transaction that queues
 * its grading run again: the two move together, so a submission never
 * waits on a run that is not queued.
 */
export async function reopenSubmission(
  tx: QueryExecutor,
  owner: string,
  submissionId: string,
  now: Date,
): Promise<void> {
  await tx
    .update(submission)
    .set({ status: "queued", errorCode: null, updatedAt: now })
    .where(
      and(
        eq(submission.organizationId, owner),
        eq(submission.id, submissionId),
        eq(submission.status, "errored"),
      ),
    );
}

const toSubmission = (row: SubmissionRow): StoredSubmission => ({
  id: row.id,
  sandboxVersionId: row.sandboxVersionId,
  submittedBy: row.submittedBy,
  patchSha256: row.patchSha256,
  status: row.status,
  result: row.result,
  errorCode: row.errorCode ?? null,
  runId: row.runId,
  retryOf: row.retryOf ?? null,
  assignmentId: row.assignmentId ?? null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

/** A stored submission without the key its files are under. */
const withoutKey = ({
  patchKey: _patchKey,
  ...stored
}: StoredSubmission & { readonly patchKey: string }): StoredSubmission =>
  stored;

export function createSubmissionStore(db: Database): SubmissionStore {
  const get: SubmissionStore["get"] = async (owner, id) => {
    const [row] = (await db
      .select()
      .from(submission)
      .where(and(eq(submission.organizationId, owner), eq(submission.id, id)))
      .limit(1)) as SubmissionRow[];
    return row === undefined
      ? null
      : { ...toSubmission(row), patchKey: row.patchKey };
  };
  /** The owner's version, if it exists, and whether it is frozen. */
  const versionOf = async (owner: string, versionId: string) =>
    (
      await db
        .select({ frozenAt: sandboxVersion.frozenAt })
        .from(sandboxVersion)
        .innerJoin(sandbox, eq(sandbox.id, sandboxVersion.sandboxId))
        .where(
          and(
            eq(sandbox.organizationId, owner),
            eq(sandboxVersion.id, versionId),
          ),
        )
        .limit(1)
    )[0];
  const existing = async (owner: string, input: NewSubmission) =>
    (
      (await db
        .select()
        .from(submission)
        .where(
          and(
            eq(submission.organizationId, owner),
            eq(submission.sandboxVersionId, input.sandboxVersionId),
            eq(submission.patchSha256, input.patchSha256),
            input.submittedBy === null
              ? isNull(submission.submittedBy)
              : eq(submission.submittedBy, input.submittedBy),
          ),
        )
        .limit(1)) as SubmissionRow[]
    )[0];
  /** An assignment's first submission, which it makes once. */
  const firstOf = async (owner: string, assignmentId: string) =>
    (
      await db
        .select({ id: submission.id })
        .from(submission)
        .where(
          and(
            eq(submission.organizationId, owner),
            eq(submission.assignmentId, assignmentId),
            isNull(submission.retryOf),
          ),
        )
        .limit(1)
    )[0];
  const assignmentId = (input: { readonly assignmentId?: string | null }) =>
    input.assignmentId ?? null;
  return {
    get,
    async create(owner, input) {
      const version = await versionOf(owner, input.sandboxVersionId);
      if (version === undefined) return { ok: false, reason: "not-found" };
      if (version.frozenAt === null) return { ok: false, reason: "not_frozen" };
      const found = await existing(owner, input);
      if (found !== undefined)
        return { ok: true, submission: toSubmission(found), created: false };
      const assigned = assignmentId(input);
      const madeAlready = async () => {
        const first =
          assigned === null ? undefined : await firstOf(owner, assigned);
        return first === undefined
          ? undefined
          : ({
              ok: false,
              reason: "already_submitted",
              submissionId: first.id,
            } as const);
      };
      const refused = await madeAlready();
      if (refused !== undefined) return refused;
      try {
        const rows = (await db
          .insert(submission)
          .values({
            id: generateId("sbm"),
            organizationId: owner,
            sandboxVersionId: input.sandboxVersionId,
            submittedBy: input.submittedBy,
            assignmentId: assigned,
            patchKey: input.patchKey,
            patchSha256: input.patchSha256,
          })
          .returning()) as SubmissionRow[];
        const row = rows[0];
        if (row === undefined)
          throw new Error("Submission insert returned no row.");
        return { ok: true, submission: toSubmission(row), created: true };
      } catch (error) {
        // The same upload twice at once: the second finds the first's row;
        // two first submissions under one assignment, the other's refusal.
        if (!isUniqueViolation(error)) throw error;
        const raced = await existing(owner, input);
        if (raced !== undefined)
          return { ok: true, submission: toSubmission(raced), created: false };
        const lost = await madeAlready();
        if (lost === undefined) throw error;
        return lost;
      }
    },

    async retry(owner, id, input) {
      const original = await get(owner, id);
      if (original === null) return { ok: false, reason: "not-found" };
      // An error is the platform's, not the contributor's: the same files
      // are graded again, and the retry (or a retry's own error) is kept.
      if (
        original.status === "errored" &&
        input.patchSha256 === original.patchSha256
      )
        return {
          ok: true,
          submission: withoutKey(original),
          created: false,
          regrade: true,
        };
      // An invited contributor's retry is theirs to spend.
      if (
        original.assignmentId !== null &&
        original.submittedBy !== input.submittedBy
      )
        return { ok: false, reason: "contributor_submission" };
      if (original.retryOf !== null) return { ok: false, reason: "is_retry" };
      if (original.status === "passed") return { ok: false, reason: "passed" };
      if (original.status === "queued" || original.status === "running")
        return { ok: false, reason: "not_finished" };
      const retryOf = async () =>
        (
          (await db
            .select()
            .from(submission)
            .where(
              and(
                eq(submission.organizationId, owner),
                eq(submission.retryOf, id),
              ),
            )
            .limit(1)) as SubmissionRow[]
        )[0];
      const made = (found: SubmissionRow): RetrySubmissionResult =>
        found.patchSha256 === input.patchSha256
          ? { ok: true, submission: toSubmission(found), created: false }
          : { ok: false, reason: "retry_used" };
      const found = await retryOf();
      if (found !== undefined) return made(found);
      if (input.patchSha256 === original.patchSha256)
        return { ok: false, reason: "same_patch" };
      try {
        const rows = (await db
          .insert(submission)
          .values({
            id: generateId("sbm"),
            organizationId: owner,
            sandboxVersionId: original.sandboxVersionId,
            submittedBy: input.submittedBy,
            assignmentId: assignmentId(input),
            patchKey: input.patchKey,
            patchSha256: input.patchSha256,
            retryOf: id,
          })
          .returning()) as SubmissionRow[];
        const row = rows[0];
        if (row === undefined)
          throw new Error("Submission insert returned no row.");
        return { ok: true, submission: toSubmission(row), created: true };
      } catch (error) {
        // Two retries at once, or files another submission already holds.
        if (!isUniqueViolation(error)) throw error;
        const raced = await retryOf();
        return raced === undefined
          ? { ok: false, reason: "same_patch" }
          : made(raced);
      }
    },

    async list(owner, versionId, filter = {}) {
      const rows = (await db
        .select()
        .from(submission)
        .where(
          and(
            eq(submission.organizationId, owner),
            eq(submission.sandboxVersionId, versionId),
            filter.submittedBy === undefined
              ? undefined
              : eq(submission.submittedBy, filter.submittedBy),
          ),
        )
        .orderBy(
          desc(submission.createdAt),
          desc(submission.id),
        )) as SubmissionRow[];
      return rows.map(toSubmission);
    },
  };
}
