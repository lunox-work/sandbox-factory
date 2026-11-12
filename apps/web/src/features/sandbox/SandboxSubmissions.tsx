/**
 * A version's submissions: each verdict with its counts and the failing
 * scenarios' keys, never a hidden test. A passing one on a version sliced
 * from a repository is merged back from here, as a pull request on the
 * commit the version was cut at: a person's act, which no token can take.
 */

import { ApiError } from "@sandbox-factory/client";
import type { SubmissionDto } from "@sandbox-factory/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { GitPullRequest } from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { clients, queryKeys, useUserId } from "../../data/query";
import { dateTime } from "../../lib/format";

/** How often a list with a submission still being graded is read again. */
const GRADING_POLL_MS = 10_000;

const VERDICT_LABELS: Record<NonNullable<SubmissionDto["verdict"]>, string> = {
  passed: "Passed",
  overfit: "Overfit",
  incomplete: "Incomplete",
  refused: "Refused",
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
  /** Whether the version was sliced from a repository and the caller may merge. */
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
    refetchInterval: (query) =>
      (query.state.data ?? []).some(
        (item) => item.status === "queued" || item.status === "running",
      )
        ? GRADING_POLL_MS
        : false,
  });
  const [merging, setMerging] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function merge(submissionId: string) {
    setMerging(submissionId);
    setError(null);
    try {
      await clients.sandbox.mergeSubmission(organizationId, submissionId);
      await queryClient.invalidateQueries({ queryKey: key });
    } catch (failure) {
      setError(
        failure instanceof ApiError
          ? failure.message
          : "Could not reach the server.",
      );
    } finally {
      setMerging(null);
    }
  }

  const list = submissions.data ?? [];
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
        No submissions yet. Published versions take them over the API and MCP.
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
              <span className="text-muted-foreground text-xs">
                {item.public !== null && item.hidden !== null
                  ? `Public ${item.public.passed}/${item.public.total} · Hidden ${item.hidden.passed}/${item.hidden.total}`
                  : dateTime(item.createdAt)}
                {item.failedScenarios.length > 0 &&
                  ` · Failing scenarios ${item.failedScenarios.join(", ")}`}
              </span>
              {item.refused.map((refusal) => (
                <span
                  key={`${refusal.path}:${refusal.reason}`}
                  className="text-muted-foreground text-xs"
                >
                  {refusal.path}: {refusal.reason}
                </span>
              ))}
            </div>
            {item.merge !== null ? (
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
            ) : (
              canMerge &&
              item.verdict === "passed" && (
                <Button
                  size="sm"
                  disabled={merging !== null}
                  onClick={() => void merge(item.id)}
                >
                  <GitPullRequest />
                  {merging === item.id ? "Opening…" : "Open pull request"}
                </Button>
              )
            )}
          </li>
        ))}
      </ul>
      {error !== null && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
    </div>
  );
}
