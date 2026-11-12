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

/**
 * duediligence's verdicts (`duediligence/api` `verdict`): `refused` when the
 * submission changed what it may not, `incomplete` when a public test
 * fails, `overfit` when the public suite passes and a hidden test does not,
 * `passed` when both pass. (`regressed` needs an existing suite, which a
 * sandbox has none of.)
 */
export const SUBMISSION_VERDICTS = [
  "passed",
  "overfit",
  "incomplete",
  "refused",
] as const;
export type SubmissionVerdict = (typeof SUBMISSION_VERDICTS)[number];

/** What a finished run found: the public suite and the hidden one. */
export interface SubmissionResult {
  readonly public: SuiteCount;
  readonly hidden: SuiteCount;
  /** Absent on a result recorded before verdicts. */
  readonly verdict?: SubmissionVerdict;
  /**
   * The spec scenarios (`s1`, `s2`…) a failing hidden test is keyed to, by
   * its file name: what a contributor may be told, never which test or why.
   */
  readonly failedScenarios?: readonly string[];
  /** What a refused submission changed that it may not, with why. */
  readonly refused?: readonly {
    readonly path: string;
    readonly reason: string;
  }[];
}

/**
 * Whether a finished run passed: every test in both suites, and at least
 * one hidden test, since a hidden suite that ran nothing proves nothing.
 */
export function submissionVerdict(
  result: SubmissionResult,
): "passed" | "failed" {
  const whole = (suite: SuiteCount) => suite.passed === suite.total;
  // A verdict other than a pass fails a run its counts would pass: one
  // refused after its tests, when it could not be carried back.
  if (result.verdict !== undefined && result.verdict !== "passed")
    return "failed";
  return result.hidden.total > 0 && whole(result.hidden) && whole(result.public)
    ? "passed"
    : "failed";
}

/**
 * How a submission's files are stored (the object its `patchKey` names):
 * canonical JSON, `{ "files": [{ "path", "text" }] }` sorted by path, so the
 * same files are the same bytes and the same `patchSha256`.
 */
export function submittedFilesText(
  files: readonly { readonly path: string; readonly text: string }[],
): string {
  const sorted = [...files]
    .map(({ path, text }) => ({ path, text }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return JSON.stringify({ files: sorted });
}

/** The files `submittedFilesText` wrote; null for anything else. */
export function parseSubmittedFiles(
  text: string,
): { readonly path: string; readonly text: string }[] | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const files = (value as { files?: unknown } | null)?.files;
  if (!Array.isArray(files)) return null;
  const out: { path: string; text: string }[] = [];
  for (const file of files) {
    const { path, text: body } = (file ?? {}) as {
      path?: unknown;
      text?: unknown;
    };
    if (typeof path !== "string" || typeof body !== "string") return null;
    out.push({ path, text: body });
  }
  return out;
}
