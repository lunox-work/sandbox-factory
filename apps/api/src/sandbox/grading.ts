/**
 * Queueing a submission's grading run, shared by the sandbox routes and the
 * CI judge.
 *
 * The run is cached by its parameters, which name the submission, so asking
 * again finds the run already queued, running or ended instead of making a
 * second. That is what makes a submission recoverable: one whose first
 * enqueue was refused at the active-run limit is queued by the same request
 * sent again, and an errored one's run is queued again in place, the store
 * moving the submission back to `queued` in the same transaction.
 */

import type {
  AnalysisRunStore,
  EnqueueAnalysisResult,
  StoredSubmission,
} from "@sandbox-factory/db";
import type { Context } from "hono";
import type { SubmissionGradeParams } from "sandbox-factory";

/** How long a client refused at the active-run limit is told to wait. */
export const RUN_LIMIT_RETRY_SECONDS = 60;

/** A submission's grading parameters; `repository` for the CI judge's files. */
export function gradeParams(
  submission: Pick<StoredSubmission, "id" | "sandboxVersionId" | "patchSha256">,
  names?: "repository",
): SubmissionGradeParams {
  return {
    deadlineMinutes: 60,
    grader: "submission",
    submissionId: submission.id,
    sandboxVersionId: submission.sandboxVersionId,
    patchSha256: submission.patchSha256,
    ...(names === undefined ? {} : { names }),
  };
}

export function enqueueGrade(
  runs: Pick<AnalysisRunStore, "enqueue">,
  owner: string,
  snapshotId: string | null,
  params: SubmissionGradeParams,
  requestedBy: string | null,
  maxActive: number,
): Promise<EnqueueAnalysisResult> {
  return runs.enqueue(owner, snapshotId, {
    tool: "submission_grade",
    params,
    requestedBy,
    maxActive,
  });
}

/**
 * The 409 a refused grading enqueue answers. At the active-run limit the
 * submission is kept and the refusal is temporary: `retryable` and
 * `Retry-After` tell the client to send the same files again, which queues
 * it. Anything else (the version's snapshot is gone) is not.
 */
export function gradeRefused(
  c: Context,
  refused: Exclude<EnqueueAnalysisResult, { ok: true }>,
) {
  if (refused.reason === "run_limit") {
    c.header("Retry-After", String(RUN_LIMIT_RETRY_SECONDS));
    return c.json(
      {
        error:
          "The active analysis limit has been reached. The submission is kept: send the same files again to queue it.",
        code: "run_limit",
        retryable: true,
      },
      409,
    );
  }
  return c.json(
    {
      error: "The submission cannot be graded on this version.",
      code: "not_gradable",
    },
    409,
  );
}
