/**
 * A submission: one contributor's attempt at a published sandbox version.
 *
 * A bounty has three sandboxes. The private one is the company's own cut
 * of the task, with the source it came from and the hidden tests; the
 * public one is its aliased copy that contributors work in; a submission
 * is the protected one, where a contributor's patch is applied to the
 * version it was made against and run against the public and hidden tests
 * together. A bounty has one sandbox and that sandbox any number of
 * submissions, each pinned to the version it was judged by, so a later
 * version never changes what an earlier verdict was measured against.
 *
 * Only counts leave a run. Hidden test names and output are as private as
 * the tests, so a result says how many passed and never which.
 */

export const SUBMISSION_STATUSES = [
  "queued",
  "running",
  "passed",
  "failed",
  "errored",
] as const;
export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];

/** How many of one suite's tests passed, out of how many ran. */
export interface SuiteCount {
  readonly passed: number;
  readonly total: number;
}

/** What a finished run found: the public suite and the hidden one. */
export interface SubmissionResult {
  readonly public: SuiteCount;
  readonly hidden: SuiteCount;
}

/**
 * Whether a finished run passed: every test in both suites, and at least
 * one hidden test, since a hidden suite that ran nothing proves nothing.
 */
export function submissionVerdict(
  result: SubmissionResult,
): "passed" | "failed" {
  const whole = (suite: SuiteCount) => suite.passed === suite.total;
  return result.hidden.total > 0 && whole(result.hidden) && whole(result.public)
    ? "passed"
    : "failed";
}
