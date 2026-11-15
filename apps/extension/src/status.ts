/**
 * A submission as the status bar and the log say it: grading, its verdict,
 * or errored with "Grade again". Read from the contributor's own
 * submission (`ContributionSubmissionDto`): counts, the verdict and the
 * failing scenarios' keys, never a hidden test.
 */

import type {
  ContributionSubmissionDto,
  FolderPreviewDto,
} from "@sandbox-factory/shared";

import type { StatusView } from "./host.js";

/** Whether grading is over: a verdict, a failure, or an error to grade again. */
export const isSettled = (submission: ContributionSubmissionDto) =>
  submission.status === "passed" ||
  submission.status === "failed" ||
  submission.status === "errored";

function counts(submission: ContributionSubmissionDto): string {
  const parts: string[] = [];
  if (submission.public !== null)
    parts.push(`public ${submission.public.passed}/${submission.public.total}`);
  if (submission.hidden !== null)
    parts.push(`hidden ${submission.hidden.passed}/${submission.hidden.total}`);
  return parts.join(" · ");
}

/** One line for a person: the verdict and its counts. */
export function describeSubmission(
  submission: ContributionSubmissionDto,
): string {
  const kind = submission.retryOf === null ? "Submission" : "Retry";
  const tally = counts(submission);
  const suffix = tally === "" ? "" : ` (${tally})`;
  if (!isSettled(submission)) return `${kind} ${submission.id}: grading…`;
  if (submission.status === "errored")
    return `${kind} ${submission.id}: could not be graded${submission.errorCode === null ? "" : ` (${submission.errorCode})`}. Grade it again; that spends no retry.`;
  switch (submission.verdict) {
    case "passed":
      return `${kind} ${submission.id}: passed${suffix}.`;
    case "overfit":
      return `${kind} ${submission.id}: overfit${suffix}: the public tests pass, hidden tests fail for ${scenarios(submission)}.`;
    case "incomplete":
      return `${kind} ${submission.id}: incomplete${suffix}: a public test fails.`;
    case "refused":
      return `${kind} ${submission.id}: refused: ${submission.refused.map((each) => `${each.path} (${each.reason})`).join("; ")}.`;
    default:
      return `${kind} ${submission.id}: ${submission.status}${suffix}.`;
  }
}

const scenarios = (submission: ContributionSubmissionDto) =>
  submission.failedScenarios.length === 0
    ? "a scenario"
    : submission.failedScenarios.join(", ");

/** The status bar item for a submission. */
export function statusOf(submission: ContributionSubmissionDto): StatusView {
  const tooltip = describeSubmission(submission);
  if (!isSettled(submission))
    return {
      text: "$(sync~spin) Lunox: grading…",
      tooltip,
      command: "refreshStatus",
    };
  if (submission.status === "errored")
    return {
      text: "$(error) Lunox: errored — Grade again",
      tooltip,
      command: "gradeAgain",
    };
  const text =
    submission.verdict === "passed"
      ? "$(pass) Lunox: passed"
      : submission.verdict === "overfit"
        ? `$(warning) Lunox: overfit: ${submission.failedScenarios.join(", ") || "hidden tests"}`
        : submission.verdict === "incomplete"
          ? "$(warning) Lunox: incomplete"
          : submission.verdict === "refused"
            ? "$(circle-slash) Lunox: refused"
            : `$(info) Lunox: ${submission.status}`;
  return { text, tooltip, command: "showSubmission" };
}

/** The dry run's answer, as lines for the log. */
export function previewLines(preview: FolderPreviewDto): string[] {
  const lines: string[] = [];
  lines.push(
    preview.files.length === 0
      ? "Nothing to submit: no task file differs from the version."
      : `To be submitted (${preview.files.length}):`,
  );
  for (const file of preview.files)
    lines.push(`  ${file.change}: ${file.path}`);
  if (preview.ignored.length > 0) {
    lines.push(`Left out, never submitted (${preview.ignored.length}):`);
    for (const path of preview.ignored) lines.push(`  ${path}`);
  }
  if (preview.skipped > 0)
    lines.push(`Skipped unread: ${preview.skipped} build output file(s).`);
  if (preview.missing.length > 0)
    lines.push(
      `Not in the folder, the version's text stands: ${preview.missing.join(", ")}`,
    );
  if (preview.refused.length > 0) {
    lines.push(`Refused (${preview.refused.length}): fix these first.`);
    for (const each of preview.refused)
      lines.push(`  ${each.path}: ${each.reason}`);
  }
  return lines;
}
