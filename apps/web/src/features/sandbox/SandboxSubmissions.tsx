/**
 * A version's submissions: each verdict with its counts and the failing
 * scenarios' keys, never a hidden test. A passing one on a version sliced
 * from a repository is merged back from here, as a pull request on the
 * commit the version was cut at: a person's act, which no token can take.
 * One whose carry back to the repository's names failed its grading run's
 * check stays passed, says so, and offers no merge.
 * One whose grading could not run says why and is graded again from here
 * with the same files, which spends no retry. An invited contributor's
 * submission names them.
 * Whether a merge would be refused is read first (`mergeBackStatus`): the
 * button is disabled with the reason, and a GitHub App that has not
 * accepted the permissions merge-back needs links to where an admin
 * accepts them. Read again when the person comes back to the tab.
 * A pull request can also be opened to merge when the repository's CI
 * passes, which needs the App to read checks and statuses; once open, its
 * row says where its CI and the pull request stand, read back by the
 * platform, and is read again while either may still move.
 * A version with no repository (generated or uploaded) has nothing to
 * merge into: a pass offers its changed files as a `.zip` instead.
 */

import { ApiError } from "@sandbox-factory/client";
import type { SubmissionDto } from "@sandbox-factory/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, GitMerge, GitPullRequest, RotateCcw } from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { clients, queryKeys, useUserId } from "../../data/query";
import { dateTime } from "../../lib/format";

/** How often a list with a submission still being graded is read again. */
const GRADING_POLL_MS = 10_000;
/** How often a list with an open pull request whose CI may move is read again. */
const CI_POLL_MS = 30_000;

type Merge = NonNullable<SubmissionDto["merge"]>;

/** Where an opened pull request stands, as its row says it. */
export function mergeLabel(merge: Merge): string {
  if (merge.pullRequestState === "merged")
    return merge.mergedCommitSha === null
      ? "Merged"
      : `Merged as ${merge.mergedCommitSha.slice(0, 7)}`;
  if (merge.pullRequestState === "closed") return "Closed without merging";
  const summary = merge.ci.summary;
  const ci = {
    pending:
      summary === null || summary.total === 0
        ? "CI not started"
        : `CI running (${summary.passed}/${summary.total} passed)`,
    passing: `CI passing${summary === null ? "" : ` (${summary.passed}/${summary.total})`}`,
    failing: `CI failing${
      summary === null || summary.failing.length === 0
        ? ""
        : `: ${summary.failing.join(", ")}`
    }`,
    none: "No CI checks reported",
    unknown: "CI not readable: the GitHub App needs checks and statuses read",
  }[merge.ci.state];
  return merge.when === "ci_passes" &&
    merge.ci.state !== "failing" &&
    merge.ci.state !== "unknown"
    ? `${ci} · merges when CI passes`
    : ci;
}

/** Whether an open pull request's row may still change: read it again. */
const moving = (merge: Merge | null) =>
  merge !== null &&
  merge.pullRequestState === "open" &&
  (merge.when === "ci_passes" || merge.ci.state === "pending");

const VERDICT_LABELS: Record<NonNullable<SubmissionDto["verdict"]>, string> = {
  passed: "Passed",
  overfit: "Overfit",
  incomplete: "Incomplete",
  refused: "Refused",
};

/** Why grading could not run, as an errored submission's row says it. */
const ERROR_REASONS: Record<NonNullable<SubmissionDto["errorCode"]>, string> = {
  grading_failed: "Grading failed on the platform's side.",
  grading_timed_out: "Grading ran out of time.",
  grading_interrupted: "Grading was interrupted.",
};

/** What a submission's row says of where it stands. */
export function submissionLabel(submission: SubmissionDto): string {
  if (submission.status === "queued") return "Queued";
  if (submission.status === "running") return "Grading";
  if (submission.status === "errored") return "Could not run";
  return submission.verdict === null
    ? submission.status === "passed"
      ? "Passed"
      : "Failed"
    : VERDICT_LABELS[submission.verdict];
}

export function SandboxSubmissions({
  organizationId,
  versionId,
  canMerge,
}: {
  organizationId: string;
  versionId: string;
  /**
   * Whether the version was sliced from a repository and the caller may
   * merge; otherwise a pass offers its files to download.
   */
  canMerge: boolean;
}) {
  const userId = useUserId();
  const queryClient = useQueryClient();
  const key = queryKeys.resource(
    userId,
    organizationId,
    "sandbox-submissions",
    versionId,
  );
  const submissions = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      clients.sandbox.sandboxSubmissions(organizationId, versionId, signal),
    refetchInterval: (query) => {
      const listed = query.state.data ?? [];
      if (
        listed.some(
          (item) => item.status === "queued" || item.status === "running",
        )
      )
        return GRADING_POLL_MS;
      return listed.some((item) => moving(item.merge)) ? CI_POLL_MS : false;
    },
  });
  const statusKey = queryKeys.resource(
    userId,
    organizationId,
    "sandbox-merge-back",
    versionId,
  );
  const mergeStatus = useQuery({
    queryKey: statusKey,
    queryFn: ({ signal }) =>
      clients.sandbox.mergeBackStatus(organizationId, versionId, signal),
    enabled: canMerge,
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
  // Unread or unreadable, the merge itself is the check.
  const blocked =
    mergeStatus.data === undefined || mergeStatus.data.code === null
      ? null
      : mergeStatus.data;
  /** What reading CI back still needs; merging on CI is offered only without. */
  const ciMissing = mergeStatus.data?.ciMissing ?? [];
  const ciAcceptUrl = mergeStatus.data?.acceptUrl ?? null;
  const [merging, setMerging] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [regrading, setRegrading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** One act on a submission, then the list read again; a refusal says why. */
  async function act(
    submissionId: string,
    setBusy: (id: string | null) => void,
    call: () => Promise<unknown>,
  ) {
    setBusy(submissionId);
    setError(null);
    try {
      await call();
      await queryClient.invalidateQueries({ queryKey: key });
    } catch (failure) {
      setError(
        failure instanceof ApiError
          ? failure.message
          : "Could not reach the server.",
      );
    } finally {
      setBusy(null);
    }
  }
  const merge = (submissionId: string, when: "open" | "ci_passes" = "open") =>
    act(submissionId, setMerging, async () => {
      try {
        await clients.sandbox.mergeSubmission(
          organizationId,
          submissionId,
          when === "open" ? undefined : { when },
        );
      } finally {
        await queryClient.invalidateQueries({ queryKey: statusKey });
      }
    });
  /** Saves a pass's changed files as the `.zip` the API names. */
  const download = (submissionId: string) =>
    act(submissionId, setDownloading, async () => {
      const { blob, filename } = await clients.sandbox.submissionFilesArchive(
        organizationId,
        submissionId,
      );
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.append(link);
      link.click();
      link.remove();
      // After the click has handed the file to the browser.
      setTimeout(() => URL.revokeObjectURL(url), 0);
    });
  const regrade = (submissionId: string) =>
    act(submissionId, setRegrading, () =>
      clients.sandbox.regradeSubmission(organizationId, submissionId),
    );

  const list = submissions.data ?? [];
  const passing = (item: SubmissionDto) =>
    item.status !== "errored" && item.verdict === "passed";
  const mergeable = (item: SubmissionDto) =>
    canMerge &&
    item.merge === null &&
    passing(item) &&
    item.carryBack !== "failed";
  const ciTitle =
    ciMissing.length > 0
      ? `The GitHub App cannot read this repository's CI yet (missing ${ciMissing.join(", ")}).`
      : undefined;
  if (submissions.isPending)
    return (
      <p className="text-muted-foreground text-sm">Reading submissions…</p>
    );
  if (submissions.isError)
    return (
      <p role="alert" className="text-destructive text-sm">
        Its submissions could not be read.
      </p>
    );
  if (list.length === 0)
    return (
      <p className="text-muted-foreground text-sm">
        No submissions yet. Invited contributors upload theirs from their
        contribution page; the workspace submits over the API and MCP.
      </p>
    );
  return (
    <div className="flex flex-col gap-3" data-testid="sandbox-submissions">
      <ul className="divide-border flex flex-col divide-y">
        {list.map((item) => (
          <li
            key={item.id}
            className="flex flex-wrap items-center justify-between gap-3 py-2"
          >
            <div className="flex min-w-0 flex-col gap-0.5">
              <div className="flex items-center gap-2">
                <Badge
                  variant={item.verdict === "passed" ? "default" : "outline"}
                >
                  {submissionLabel(item)}
                </Badge>
                <span className="text-muted-foreground font-mono text-xs">
                  {item.id}
                </span>
                {item.retryOf !== null && (
                  <span className="text-muted-foreground text-xs">
                    retry of {item.retryOf}
                  </span>
                )}
              </div>
              {item.contributor !== null && (
                <span className="text-xs" data-testid="submission-contributor">
                  By {item.contributor.name}{" "}
                  <span className="text-muted-foreground">
                    {item.contributor.email} · invited contributor
                  </span>
                </span>
              )}
              <span className="text-muted-foreground text-xs">
                {item.public !== null && item.hidden !== null
                  ? `Public ${item.public.passed}/${item.public.total} · Hidden ${item.hidden.passed}/${item.hidden.total}`
                  : dateTime(item.createdAt)}
                {item.failedScenarios.length > 0 &&
                  ` · Failing scenarios ${item.failedScenarios.join(", ")}`}
              </span>
              {item.carryBack === "failed" && (
                <span className="text-muted-foreground text-xs">
                  Passed, but the patch did not build and pass in the
                  repository&apos;s names, so merge-back is disabled.
                </span>
              )}
              {item.status === "errored" && (
                <span className="text-muted-foreground text-xs">
                  {item.errorCode === null
                    ? "Grading could not run."
                    : ERROR_REASONS[item.errorCode]}{" "}
                  Grading it again uses the same files and keeps its retry.
                </span>
              )}
              {item.merge !== null && <MergeState merge={item.merge} />}
              {item.refused.map((refusal) => (
                <span
                  key={`${refusal.path}:${refusal.reason}`}
                  className="text-muted-foreground text-xs"
                >
                  {refusal.path}: {refusal.reason}
                </span>
              ))}
            </div>
            {item.status === "errored" ? (
              <Button
                size="sm"
                variant="outline"
                disabled={regrading !== null}
                onClick={() => void regrade(item.id)}
              >
                <RotateCcw />
                {regrading === item.id ? "Queueing…" : "Grade again"}
              </Button>
            ) : item.merge !== null ? (
              <div className="flex flex-wrap items-center gap-2">
                {item.merge.pullRequestState === "open" &&
                  item.merge.when === "open" &&
                  canMerge && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={merging !== null || ciMissing.length > 0}
                      title={ciTitle}
                      onClick={() => void merge(item.id, "ci_passes")}
                    >
                      <GitMerge />
                      {merging === item.id ? "Saving…" : "Merge when CI passes"}
                    </Button>
                  )}
                <Button asChild variant="outline" size="sm">
                  <a
                    href={item.merge.pullRequestUrl}
                    target="_blank"
                    rel="noopener"
                  >
                    <GitPullRequest />
                    Pull request #{item.merge.pullRequestNumber}
                  </a>
                </Button>
              </div>
            ) : mergeable(item) ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={merging !== null || blocked !== null}
                  title={blocked?.error ?? undefined}
                  aria-describedby={
                    blocked === null ? undefined : "merge-back-blocked"
                  }
                  onClick={() => void merge(item.id)}
                >
                  <GitPullRequest />
                  {merging === item.id ? "Opening…" : "Open pull request"}
                </Button>
                <Button
                  size="sm"
                  disabled={
                    merging !== null || blocked !== null || ciMissing.length > 0
                  }
                  title={blocked?.error ?? ciTitle}
                  aria-describedby={
                    blocked !== null
                      ? "merge-back-blocked"
                      : ciMissing.length > 0
                        ? "merge-back-ci"
                        : undefined
                  }
                  onClick={() => void merge(item.id, "ci_passes")}
                >
                  <GitMerge />
                  Open and merge when CI passes
                </Button>
              </div>
            ) : (
              !canMerge &&
              passing(item) && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={downloading !== null}
                  title="The files this submission changed, as a .zip, never a hidden test."
                  onClick={() => void download(item.id)}
                >
                  <Download />
                  {downloading === item.id
                    ? "Preparing…"
                    : "Download the passing files"}
                </Button>
              )
            )}
          </li>
        ))}
      </ul>
      {blocked !== null && list.some(mergeable) && (
        <p
          id="merge-back-blocked"
          className="text-muted-foreground text-xs"
          data-testid="merge-back-blocked"
        >
          {blocked.error}
          {blocked.missing.length > 0 &&
            ` Missing: ${blocked.missing.join(", ")}.`}
          {blocked.acceptUrl !== null && (
            <>
              {" "}
              <a
                href={blocked.acceptUrl}
                target="_blank"
                rel="noopener"
                className="text-foreground underline underline-offset-2"
              >
                Accept new permissions on GitHub
              </a>
            </>
          )}
        </p>
      )}
      {blocked === null &&
        ciMissing.length > 0 &&
        list.some(
          (item) =>
            mergeable(item) ||
            (item.merge !== null && item.merge.pullRequestState === "open"),
        ) && (
          <p
            id="merge-back-ci"
            className="text-muted-foreground text-xs"
            data-testid="merge-back-ci"
          >
            The GitHub App cannot read this repository&apos;s CI yet (missing{" "}
            {ciMissing.join(", ")}), so pull requests open without it and
            nothing merges on CI.
            {ciAcceptUrl !== null && (
              <>
                {" "}
                <a
                  href={ciAcceptUrl}
                  target="_blank"
                  rel="noopener"
                  className="text-foreground underline underline-offset-2"
                >
                  Accept new permissions on GitHub
                </a>
              </>
            )}
          </p>
        )}
      {error !== null && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
    </div>
  );
}

/** An opened pull request's state, its CI's page, and a merge GitHub refused. */
function MergeState({ merge }: { merge: Merge }) {
  const open = merge.pullRequestState === "open";
  const details = open ? (merge.ci.summary?.detailsUrl ?? null) : null;
  return (
    <>
      <span className="text-xs" data-testid="submission-merge-state">
        {mergeLabel(merge)}
        {details !== null && (
          <>
            {" "}
            <a
              href={details}
              target="_blank"
              rel="noopener"
              className="text-muted-foreground underline underline-offset-2"
            >
              details
            </a>
          </>
        )}
      </span>
      {open && merge.mergeError !== null && (
        <span className="text-muted-foreground text-xs">
          GitHub refused the merge: {merge.mergeError}
        </span>
      )}
    </>
  );
}
