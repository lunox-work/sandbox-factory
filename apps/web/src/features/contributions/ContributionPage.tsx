/**
 * An invited contributor's pages, under no workspace: the versions they
 * were invited to (`/contributions`) and one of them (`/contributions/:vid`)
 * with what they need to do the work and hand it in. The task in its
 * public names (title, summary, size), the project's download and its
 * commands, the submission area (`FolderUpload`) and their own
 * submissions with each verdict: passed; overfit, with the failing
 * scenarios' keys and never a hidden test; incomplete; refused, with each
 * file's reason; or not graded, with "Grade again", which spends no retry.
 * One first submission and one retry, as the API keeps them, said plainly.
 * The list page also holds the person's tokens for an editor or agent
 * (`ContributorTokens`).
 */

import { ApiError } from "@sandbox-factory/client";
import type {
  ContributionDto,
  ContributionSubmissionDto,
} from "@sandbox-factory/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronRight,
  CircleX,
  Download,
  Loader2,
  RotateCcw,
} from "lucide-react";
import { useEffect, useState } from "react";

import { LoadingLine, RetryableError } from "@/components/Message";
import { Page, PageHeader } from "@/components/Page";
import { RuledSection } from "@/components/ReadSection";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import {
  clients,
  queryKeys,
  useContributionsQuery,
  useUserId,
} from "../../data/query";
import { dateTime } from "../../lib/format";
import { contributionPath, isPlainLeftClick } from "../../routes";
import { ContributorTokens } from "./ContributorTokens";
import { FolderUpload } from "./FolderUpload";

/** How often a list with a submission still being graded is read again. */
const GRADING_POLL_MS = 5_000;

const ERROR_REASONS: Record<
  NonNullable<ContributionSubmissionDto["errorCode"]>,
  string
> = {
  grading_failed: "Grading failed on the platform's side.",
  grading_timed_out: "Grading ran out of time.",
  grading_interrupted: "Grading was interrupted.",
};

/** What a submission's row says of where it stands. */
export function verdictLabel(submission: ContributionSubmissionDto): string {
  if (submission.status === "queued") return "Queued";
  if (submission.status === "running") return "Grading";
  if (submission.status === "errored") return "Not graded";
  switch (submission.verdict) {
    case "passed":
      return "Passed";
    case "overfit":
      return "Overfit";
    case "incomplete":
      return "Incomplete";
    case "refused":
      return "Refused";
    default:
      return submission.status === "passed" ? "Passed" : "Failed";
  }
}

/**
 * What the contributor may do next, by the API's rule: one first
 * submission, then one retry of it if it did not pass, while the version
 * takes submissions.
 */
export type NextStep =
  | { readonly kind: "submit" }
  | { readonly kind: "retry"; readonly of: ContributionSubmissionDto }
  | { readonly kind: "grading" }
  | { readonly kind: "passed" }
  | { readonly kind: "regrade" }
  | { readonly kind: "spent" }
  | { readonly kind: "closed" };

export function nextStep(
  open: boolean,
  submissions: readonly ContributionSubmissionDto[],
): NextStep {
  const first = submissions.find((item) => item.retryOf === null);
  const retry =
    first === undefined
      ? undefined
      : submissions.find((item) => item.retryOf === first.id);
  const latest = retry ?? first;
  if (latest?.status === "passed") return { kind: "passed" };
  if (latest?.status === "queued" || latest?.status === "running")
    return { kind: "grading" };
  if (latest?.status === "errored") return { kind: "regrade" };
  if (!open) return { kind: "closed" };
  if (first === undefined) return { kind: "submit" };
  return retry === undefined ? { kind: "retry", of: first } : { kind: "spent" };
}

/** `/contributions`: every version the person was invited to. */
export function ContributionsPage({
  onOpen,
}: {
  onOpen: (versionId: string) => void;
}) {
  const contributions = useContributionsQuery();
  return (
    <Page width="narrow" className="flex flex-col gap-8">
      <PageHeader
        title="Contributions"
        description="Tasks you were invited to work on. Each is a project you download, run on your own machine and hand back as a folder."
      />
      {contributions.isPending ? (
        <LoadingLine>Loading your contributions…</LoadingLine>
      ) : contributions.isError ? (
        <RetryableError onRetry={() => void contributions.refetch()}>
          Your contributions could not be read.
        </RetryableError>
      ) : contributions.data.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No invites yet. When a workspace invites you, open the link it sent
          you and the task appears here.
        </p>
      ) : (
        <ul className="divide-border flex flex-col divide-y rounded-lg border">
          {contributions.data.map((item) => (
            <li key={item.versionId}>
              <a
                href={contributionPath(item.versionId)}
                onClick={(event) => {
                  if (isPlainLeftClick(event)) {
                    event.preventDefault();
                    onOpen(item.versionId);
                  }
                }}
                className="hover:bg-accent/50 flex items-center gap-4 px-4 py-3 transition-colors first:rounded-t-lg last:rounded-b-lg"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {item.title ?? "Untitled task"}
                  </p>
                  <p className="text-muted-foreground mt-0.5 truncate text-xs">
                    Version {item.version}
                    {item.complexity !== null && ` · Size ${item.complexity}`}
                    {" · "}
                    {openLine(item)}
                  </p>
                </div>
                <OpenBadge open={item.open} />
                <ChevronRight
                  className="text-muted-foreground size-4 shrink-0"
                  aria-hidden="true"
                />
              </a>
            </li>
          ))}
        </ul>
      )}
      {contributions.isSuccess && contributions.data.length > 0 && (
        <ContributorTokens />
      )}
    </Page>
  );
}

function openLine(item: ContributionDto): string {
  if (!item.open) return "No longer takes submissions";
  return item.closesAt === null
    ? "Takes submissions"
    : `Open until ${dateTime(item.closesAt)}`;
}

function OpenBadge({ open }: { open: boolean }) {
  return (
    <Badge variant={open ? "default" : "outline"} className="shrink-0">
      {open ? "Open" : "Closed"}
    </Badge>
  );
}

/** `/contributions/:vid`: one task, its project and its submissions. */
export function ContributionPage({
  versionId,
  onTitle,
}: {
  versionId: string;
  /** Reports the task's title up, for the trail. */
  onTitle?: (title: string | undefined) => void;
}) {
  const userId = useUserId();
  const queryClient = useQueryClient();
  const contributionKey = [...queryKeys.me(userId, "contribution"), versionId];
  const submissionsKey = [
    ...queryKeys.me(userId, "contribution-submissions"),
    versionId,
  ];
  const contribution = useQuery({
    queryKey: contributionKey,
    queryFn: ({ signal }) =>
      clients.contributions.contribution(versionId, signal),
  });
  const title = contribution.data?.title ?? undefined;
  useEffect(() => onTitle?.(title), [onTitle, title]);
  const submissions = useQuery({
    queryKey: submissionsKey,
    queryFn: ({ signal }) =>
      clients.contributions.contributionSubmissions(versionId, signal),
    refetchInterval: (query) =>
      (query.state.data ?? []).some(
        (item) => item.status === "queued" || item.status === "running",
      )
        ? GRADING_POLL_MS
        : false,
  });
  const [regrading, setRegrading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (contribution.isPending)
    return (
      <Page width="narrow">
        <LoadingLine>Loading the task…</LoadingLine>
      </Page>
    );
  if (contribution.isError)
    return (
      <Page width="narrow">
        {contribution.error instanceof ApiError &&
        contribution.error.isNotFound ? (
          <div className="flex flex-col gap-1">
            <h1 className="text-title">Task unavailable</h1>
            <p className="text-muted-foreground text-sm">
              You have no access to it. The invite may have been revoked, or the
              link is mistyped.
            </p>
          </div>
        ) : (
          <RetryableError onRetry={() => void contribution.refetch()}>
            The task could not be read.
          </RetryableError>
        )}
      </Page>
    );

  const task = contribution.data;
  const list = submissions.data ?? [];
  const next = nextStep(task.open, list);
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: submissionsKey });

  async function regrade(submissionId: string) {
    setRegrading(submissionId);
    setError(null);
    try {
      await clients.contributions.regradeContribution(versionId, submissionId);
      await refresh();
    } catch (failure) {
      setError(
        failure instanceof ApiError
          ? failure.message
          : "Could not reach the server.",
      );
    } finally {
      setRegrading(null);
    }
  }

  return (
    <Page width="narrow" className="flex flex-col gap-10">
      <PageHeader
        kicker={
          <span className="flex flex-wrap items-center gap-2">
            <span>
              Version {task.version}
              {task.complexity !== null && ` · Size ${task.complexity}`}
            </span>
            <OpenBadge open={task.open} />
          </span>
        }
        title={task.title ?? "Untitled task"}
        description={task.specSummary ?? undefined}
        actions={<DownloadButton versionId={versionId} />}
        // On a phone the download goes under the title, which keeps the
        // column's width.
        className="max-sm:flex-col"
      />

      <RuledSection title="Run it">
        <p className="text-muted-foreground text-sm text-pretty">
          Unzip the project and open the folder in your editor.{" "}
          <code className="text-foreground font-mono text-xs">TASK.md</code>{" "}
          holds the scenarios and the rules; nothing needs an account or a
          network service.
          {task.nodeRange !== null && ` Needs Node ${task.nodeRange}.`}
        </p>
        {task.commands !== null && (
          <dl className="bg-muted/40 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 rounded-lg border px-4 py-3 text-sm">
            {(
              [
                ["Install", task.commands.install],
                ["Test", task.commands.test],
                ["Build", task.commands.build],
                ["Walkthrough", task.commands.dev],
              ] as const
            ).map(([label, command]) => (
              <div key={label} className="contents">
                <dt className="text-muted-foreground">{label}</dt>
                <dd>
                  <code className="font-mono text-[13px]">{command}</code>
                </dd>
              </div>
            ))}
          </dl>
        )}
        {task.editablePaths.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <p className="text-sm font-medium">The files you change</p>
            <ul className="text-muted-foreground flex flex-col gap-0.5 text-xs">
              {task.editablePaths.map((path) => (
                <li key={path}>
                  <code className="font-mono">{path}</code>
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground text-xs">
              New TypeScript files beside them are taken too. Everything else is
              the version&apos;s.
            </p>
          </div>
        )}
      </RuledSection>

      <RuledSection title="Submit">
        <p className="text-muted-foreground text-sm text-pretty">
          Zip the project folder, or pick it, and upload it here. You get one
          submission and, if it does not pass, one retry. When grading fails on
          our side, grading it again uses the same files and keeps your retry.
        </p>
        <SubmitArea
          next={next}
          versionId={versionId}
          onSubmitted={() => void refresh()}
        />
      </RuledSection>

      <RuledSection title="Your submissions">
        {submissions.isPending ? (
          <LoadingLine>Reading your submissions…</LoadingLine>
        ) : submissions.isError ? (
          <RetryableError onRetry={() => void submissions.refetch()}>
            Your submissions could not be read.
          </RetryableError>
        ) : list.length === 0 ? (
          <p className="text-muted-foreground text-sm">None yet.</p>
        ) : (
          <ul
            className="divide-border flex flex-col divide-y"
            data-testid="contribution-submissions"
          >
            {list.map((item) => (
              <SubmissionRow
                key={item.id}
                item={item}
                regrading={regrading}
                onRegrade={(id) => void regrade(id)}
              />
            ))}
          </ul>
        )}
        {error !== null && (
          <p role="alert" className="text-destructive text-xs">
            {error}
          </p>
        )}
      </RuledSection>
    </Page>
  );
}

function SubmitArea({
  next,
  versionId,
  onSubmitted,
}: {
  next: NextStep;
  versionId: string;
  onSubmitted: () => void;
}) {
  const note = (text: string) => (
    <p className="bg-muted/30 rounded-lg border px-4 py-3 text-sm">{text}</p>
  );
  switch (next.kind) {
    case "submit":
      return <FolderUpload versionId={versionId} onSubmitted={onSubmitted} />;
    case "retry":
      return (
        <div className="flex flex-col gap-3">
          <p className="text-sm">
            Your submission did not pass. You have one retry left: upload the
            folder with your changes.
          </p>
          <FolderUpload
            versionId={versionId}
            retryOf={next.of.id}
            onSubmitted={onSubmitted}
          />
        </div>
      );
    case "grading":
      return note(
        "Your latest submission is being graded. This page updates when it has a verdict.",
      );
    case "passed":
      return note("Your submission passed. There is nothing more to submit.");
    case "regrade":
      return note(
        "Your latest submission could not be graded. Grade it again below; that keeps your retry.",
      );
    case "spent":
      return note("You have used your submission and its retry.");
    case "closed":
      return note("This version no longer takes submissions.");
  }
}

function SubmissionRow({
  item,
  regrading,
  onRegrade,
}: {
  item: ContributionSubmissionDto;
  regrading: string | null;
  onRegrade: (id: string) => void;
}) {
  const passed = item.verdict === "passed" && item.status === "passed";
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 py-3">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            variant={passed ? "default" : "outline"}
            className={cn(
              item.verdict === "refused" &&
                "border-destructive/30 text-destructive",
            )}
          >
            {verdictLabel(item)}
          </Badge>
          <span className="text-sm">
            {item.retryOf === null ? "Submission" : "Retry"}
          </span>
          <span className="text-muted-foreground text-xs">
            {dateTime(item.createdAt)}
          </span>
        </div>
        {item.public !== null && item.hidden !== null && (
          <span className="text-muted-foreground text-xs">
            Public tests {item.public.passed}/{item.public.total} · Hidden tests{" "}
            {item.hidden.passed}/{item.hidden.total}
          </span>
        )}
        {item.verdict === "overfit" && (
          <span className="text-xs">
            The public tests pass; hidden tests fail for{" "}
            {item.failedScenarios.length === 1 ? "scenario" : "scenarios"}{" "}
            {item.failedScenarios.map((key, index) => (
              <span key={key}>
                {index > 0 && ", "}
                <code className="font-mono">{key}</code>
              </span>
            ))}
            . Check them against TASK.md.
          </span>
        )}
        {item.verdict === "incomplete" && (
          <span className="text-xs">
            A public test fails. Run the tests locally to see which.
          </span>
        )}
        {item.refused.length > 0 && (
          <ul className="flex flex-col gap-0.5 text-xs">
            {item.refused.map((refusal) => (
              <li key={`${refusal.path}:${refusal.reason}`}>
                <code className="font-mono">{refusal.path}</code>{" "}
                <span className="text-muted-foreground">{refusal.reason}</span>
              </li>
            ))}
          </ul>
        )}
        {item.status === "errored" && (
          <span className="text-muted-foreground text-xs">
            {item.errorCode === null
              ? "Grading could not run."
              : ERROR_REASONS[item.errorCode]}{" "}
            Grading it again uses the same files and keeps your retry.
          </span>
        )}
      </div>
      {item.status === "errored" && (
        <Button
          size="sm"
          variant="outline"
          disabled={regrading !== null}
          onClick={() => onRegrade(item.id)}
        >
          <RotateCcw />
          {regrading === item.id ? "Queueing…" : "Grade again"}
        </Button>
      )}
    </li>
  );
}

/** Saves the project as the `.zip` the API names. */
function DownloadButton({ versionId }: { versionId: string }) {
  const [state, setState] = useState<"idle" | "saving" | "failed">("idle");
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setState("saving");
    setError(null);
    try {
      const { blob, filename } =
        await clients.contributions.contributionArchive(versionId);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      setState("idle");
    } catch (failure) {
      setError(
        failure instanceof ApiError
          ? failure.message
          : "The project could not be downloaded.",
      );
      setState("failed");
    }
  };
  const Icon =
    state === "saving" ? Loader2 : state === "failed" ? CircleX : Download;
  return (
    <div className="flex flex-col items-start gap-1 sm:items-end">
      <Button
        type="button"
        variant="outline"
        disabled={state === "saving"}
        onClick={() => void save()}
      >
        <Icon className={cn(state === "saving" && "animate-spin")} />
        {state === "saving" ? "Downloading…" : "Download project"}
      </Button>
      {error !== null && (
        <span role="alert" className="text-destructive max-w-60 text-xs">
          {error}
        </span>
      )}
    </div>
  );
}
