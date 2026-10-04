/**
 * Submissions: contributors' attempts at a sandbox version, owner-scoped.
 *
 * A submission is the protected sandbox of a bounty: a patch applied to the
 * version it was made against and run with the hidden tests. Only a frozen
 * version takes one, since a draft can still change under it. The same
 * patch against the same version is the same submission, so a retried
 * upload finds the one it already made.
 *
 * Status moves one way: `queued`, `running`, then `passed`, `failed` or
 * `errored`. A verdict is never computed here; `submissionVerdict` in core
 * decides it from the counts, so the rule is the same wherever it is read.
 */

import { and, desc, eq, inArray } from "drizzle-orm";
import {
  submissionVerdict,
  type SubmissionResult,
  type SubmissionStatus,
} from "sandbox-factory";

import { isUniqueViolation, type Database } from "./errors.js";
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
  readonly runId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NewSubmission {
  readonly sandboxVersionId: string;
  readonly submittedBy: string;
  readonly patchKey: string;
  readonly patchSha256: string;
}

export type CreateSubmissionResult =
  | {
      readonly ok: true;
      readonly submission: StoredSubmission;
      /** False when this patch was already submitted against the version. */
      readonly created: boolean;
    }
  | { readonly ok: false; readonly reason: "not-found" | "not_frozen" };

/** How a run ended: with counts, or without being able to run at all. */
export type SubmissionOutcome = SubmissionResult | "errored";

export interface SubmissionStore {
  create(
    organizationId: string,
    input: NewSubmission,
  ): Promise<CreateSubmissionResult>;
  /** A version's submissions, newest first. */
  list(
    organizationId: string,
    sandboxVersionId: string,
  ): Promise<StoredSubmission[]>;
  /** `queued` to `running`, naming the run. False from any other status. */
  start(
    organizationId: string,
    submissionId: string,
    runId: string,
  ): Promise<boolean>;
  /** `running` to its verdict, or to `errored`. Null when not running. */
  finish(
    organizationId: string,
    submissionId: string,
    outcome: SubmissionOutcome,
    now?: Date,
  ): Promise<StoredSubmission | null>;
}

const toSubmission = (row: SubmissionRow): StoredSubmission => ({
  id: row.id,
  sandboxVersionId: row.sandboxVersionId,
  submittedBy: row.submittedBy,
  patchSha256: row.patchSha256,
  status: row.status,
  result: row.result,
  runId: row.runId,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

export function createSubmissionStore(db: Database): SubmissionStore {
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
          ),
        )
        .limit(1)) as SubmissionRow[]
    )[0];
  /** Moves a submission on only from the statuses it may leave. */
  const advance = async (
    owner: string,
    id: string,
    from: readonly SubmissionStatus[],
    values: Partial<SubmissionRow>,
  ) =>
    (
      (await db
        .update(submission)
        .set(values)
        .where(
          and(
            eq(submission.organizationId, owner),
            eq(submission.id, id),
            inArray(submission.status, [...from]),
          ),
        )
        .returning()) as SubmissionRow[]
    )[0];

  return {
    async create(owner, input) {
      const version = await versionOf(owner, input.sandboxVersionId);
      if (version === undefined) return { ok: false, reason: "not-found" };
      if (version.frozenAt === null) return { ok: false, reason: "not_frozen" };
      const found = await existing(owner, input);
      if (found !== undefined)
        return { ok: true, submission: toSubmission(found), created: false };
      try {
        const rows = (await db
          .insert(submission)
          .values({
            id: generateId("sbm"),
            organizationId: owner,
            sandboxVersionId: input.sandboxVersionId,
            submittedBy: input.submittedBy,
            patchKey: input.patchKey,
            patchSha256: input.patchSha256,
          })
          .returning()) as SubmissionRow[];
        const row = rows[0];
        if (row === undefined)
          throw new Error("Submission insert returned no row.");
        return { ok: true, submission: toSubmission(row), created: true };
      } catch (error) {
        // The same upload twice at once: the second finds the first's row.
        if (!isUniqueViolation(error)) throw error;
        const raced = await existing(owner, input);
        if (raced === undefined) throw error;
        return { ok: true, submission: toSubmission(raced), created: false };
      }
    },

    async list(owner, versionId) {
      const rows = (await db
        .select()
        .from(submission)
        .where(
          and(
            eq(submission.organizationId, owner),
            eq(submission.sandboxVersionId, versionId),
          ),
        )
        .orderBy(
          desc(submission.createdAt),
          desc(submission.id),
        )) as SubmissionRow[];
      return rows.map(toSubmission);
    },

    async start(owner, id, runId) {
      const row = await advance(owner, id, ["queued"], {
        status: "running",
        runId,
        updatedAt: new Date(),
      });
      return row !== undefined;
    },

    async finish(owner, id, outcome, now = new Date()) {
      const row = await advance(
        owner,
        id,
        ["running"],
        outcome === "errored"
          ? { status: "errored", updatedAt: now }
          : {
              status: submissionVerdict(outcome),
              result: outcome,
              updatedAt: now,
            },
      );
      return row === undefined ? null : toSubmission(row);
    },
  };
}
