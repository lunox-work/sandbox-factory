/**
 * A sandbox with no repository has its versions generated: an agent writes
 * a starter from the bounty's title, description and tech stack, and the
 * worker builds it and checks its baseline, as it would a sliced version.
 *
 * This is the bounty's slice: its versions, one chosen at a time in a
 * header over the card, as a bounty's proposal has its version, with the
 * way to publish it; what is known about it; the way to browse its files
 * and the way to generate another. A version's run is private provenance,
 * so a member sees the version alone.
 */

import { ApiError } from "@sandbox-factory/client";
import type {
  AnalysisRunDto,
  ArtifactDto,
  BountySandboxSummaryDto,
  SandboxVersionDto,
} from "@sandbox-factory/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, RefreshCw, Sparkles } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { isPublicationLive } from "sandbox-factory";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { DisabledReason } from "@/components/DisabledReason";
import { RetryableError } from "@/components/Message";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

import { terminalRun, useObservation } from "../../data/observe";
import { clients, queryKeys, useUserId } from "../../data/query";
import { dateTime } from "../../lib/format";
import { sandboxFilesPath } from "../../routes";
import { LunoxMark } from "@/components/LunoxMark";

import { PublishMenu } from "./PublishMenu";
import { SandboxCard } from "./SandboxCard";

/** How often a generation in progress is asked about. */
export const GENERATION_POLL_MS = 3_000;

/** Why a generation stopped, as its run's error code says it. */
function failureOf(run: AnalysisRunDto): string {
  switch (run.errorCode) {
    case "agent_unavailable":
      return "The worker has no agent model configured.";
    case "evaluation_failed":
      return "The worker could not build it; it needs an evaluation provider.";
    case "agent_incomplete":
      return "The agent ran out of budget before it finished a starter.";
    case "tool_failed":
      return "The version changed while it was being written.";
    case "tool_timeout":
      return "It took longer than its deadline.";
    case "worker_lost":
      return "The worker stopped while writing it.";
    default:
      return run.errorCode === null
        ? "It stopped without saying why."
        : `It stopped (${run.errorCode}).`;
  }
}

/** What a finished run's artifacts say: its starter, and whether it built. */
function outcomeOf(artifacts: readonly ArtifactDto[]): {
  ready: boolean;
  reasons: string[];
  hiddenTests: number | null;
  files: number | null;
} {
  const build = artifacts.find((item) => item.kind === "build_manifest")?.meta;
  const set = artifacts.find((item) => item.kind === "starter_set")?.meta;
  const baseline = build?.["baseline"] as { reasons?: unknown } | null;
  const reasons = Array.isArray(baseline?.reasons)
    ? baseline.reasons.filter(
        (item): item is string => typeof item === "string",
      )
    : [];
  const count = (value: unknown) => (typeof value === "number" ? value : null);
  return {
    ready: build?.["ready"] === true,
    reasons,
    hiddenTests: count(set?.["hiddenTests"]),
    files: count(set?.["files"]),
  };
}

/** Where a version stands, in a word, with why when it went wrong. */
type Standing = {
  label: string;
  tone: "ok" | "bad" | "busy" | "muted";
  note: string | null;
};

const TONE_DOT: Record<Standing["tone"], string> = {
  ok: "bg-emerald-500",
  bad: "bg-destructive",
  busy: "bg-amber-500 animate-pulse",
  muted: "bg-muted-foreground/50",
};

function createdOn(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
}

export function SandboxGeneration({
  organizationId,
  workspace,
  sandbox,
  canManage,
  canGenerate = true,
  generationBlocked = null,
  readOnly = false,
  onChanged,
  children,
}: {
  organizationId: string;
  /** The workspace's handle, which a version's files page is addressed by. */
  workspace: string;
  /** Which version, if any, it has published. */
  sandbox: Pick<
    BountySandboxSummaryDto,
    "id" | "status" | "currentVersionId" | "expiresAt"
  >;
  canManage: boolean;
  /** Whether its versions are generated; a linked one's are sliced. */
  canGenerate?: boolean;
  /**
   * Why generating is refused for now, such as a bounty whose proposal is
   * still a draft; null when it is not.
   */
  generationBlocked?: string | null;
  /**
   * A version was generated, finished its run, or was published or
   * unpublished: what the bounty says of its sandbox, such as which bounty
   * version it stands on, has moved, so read it again.
   */
  onChanged?: () => void;
  /** Its versions alone, with no way to generate, as in a panel. */
  readOnly?: boolean;
  /** Under its versions, such as the way to link a repository. */
  children?: ReactNode;
}) {
  const sandboxId = sandbox.id;
  const userId = useUserId();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [publishing, setPublishing] = useState(false);
  // Asking whether to take the sandbox from contributors.
  const [unpublishing, setUnpublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The version being looked at; the latest until another is chosen.
  const [chosenId, setChosenId] = useState<string | null>(null);
  const versionsKey = queryKeys.resource(
    userId,
    organizationId,
    "sandbox-versions",
    sandboxId,
  );
  const versions = useQuery({
    queryKey: versionsKey,
    queryFn: ({ signal }) =>
      clients.sandbox.sandboxVersions(organizationId, sandboxId, signal),
  });
  const all = versions.data ?? [];
  const latest = all[0] ?? null;
  const selected: SandboxVersionDto | null =
    all.find((item) => item.id === chosenId) ?? latest;
  const selectedId = selected?.id ?? null;
  // The run behind a version is its provenance: owners and admins only.
  const source = useQuery({
    queryKey: queryKeys.resource(
      userId,
      organizationId,
      "sandbox-version",
      selectedId,
    ),
    enabled: canManage && selectedId !== null,
    queryFn: ({ signal }) =>
      clients.sandbox.sandboxVersion(organizationId, selectedId ?? "", signal),
  });
  const runId =
    source.data?.source?.origin === "starter"
      ? source.data.source.starterRunId
      : null;
  const run = useObservation({
    owner: organizationId,
    resource: "analysis-run",
    id: runId,
    read: (id, signal) => clients.analysis.run(organizationId, id, signal),
    terminal: terminalRun,
    interval: GENERATION_POLL_MS,
  });
  const finished = run.data?.status === "succeeded";
  const artifacts = useQuery({
    queryKey: queryKeys.resource(
      userId,
      organizationId,
      "analysis-artifacts",
      runId,
    ),
    enabled: finished && runId !== null,
    queryFn: ({ signal }) =>
      clients.analysis.artifacts(organizationId, runId ?? "", signal),
  });
  // Once its run is over, the version holds what the run settled.
  const runEnded = run.data !== undefined && terminalRun(run.data);
  // Seen running here, so its end is news to the bounty too.
  const watched = useRef(false);
  if (run.data !== undefined && !runEnded) watched.current = true;
  // Held, not depended on: the parent passes a new function every render,
  // and as a dependency it re-read the version on each one after the run
  // had ended.
  const changed = useRef(onChanged);
  changed.current = onChanged;
  useEffect(() => {
    if (!runEnded) return;
    void queryClient.invalidateQueries({
      queryKey: queryKeys.resource(
        userId,
        organizationId,
        "sandbox-version",
        selectedId,
      ),
    });
    if (watched.current) {
      watched.current = false;
      changed.current?.();
    }
  }, [runEnded, queryClient, userId, organizationId, selectedId]);

  async function generate() {
    setPending(true);
    setError(null);
    try {
      const generated = await clients.sandbox.generateSandboxVersion(
        organizationId,
        sandboxId,
      );
      queryClient.setQueryData(
        queryKeys.resource(
          userId,
          organizationId,
          "sandbox-version",
          generated.version.id,
        ),
        { version: generated.version, source: generated.source },
      );
      // The new version is the one to follow.
      setChosenId(null);
      await queryClient.invalidateQueries({ queryKey: versionsKey });
      onChanged?.();
    } catch (failure) {
      setError(
        failure instanceof ApiError
          ? failure.message
          : "Could not reach the server.",
      );
    } finally {
      setPending(false);
    }
  }

  /*
    Publishing approves and freezes the chosen version and makes it the one
    contributors get until `expiresAt`; unpublishing, with no date, takes the
    sandbox back to a draft, its versions still frozen.
  */
  async function publish(expiresAt: string | null) {
    if (selectedId === null) return;
    setPublishing(true);
    setError(null);
    try {
      if (expiresAt === null)
        await clients.sandbox.unpublishSandbox(organizationId, sandboxId);
      else {
        const published = await clients.sandbox.publishSandboxVersion(
          organizationId,
          selectedId,
          expiresAt,
        );
        queryClient.setQueryData(
          queryKeys.resource(
            userId,
            organizationId,
            "sandbox-version",
            selectedId,
          ),
          { version: published.version, source: published.source },
        );
      }
      await queryClient.invalidateQueries({ queryKey: versionsKey });
      onChanged?.();
    } catch (failure) {
      setError(
        failure instanceof ApiError
          ? failure.message
          : "Could not reach the server.",
      );
    } finally {
      setPublishing(false);
    }
  }

  const generating =
    pending || (run.data !== undefined && !terminalRun(run.data));
  // What its build wrote can be read once it has written it.
  const browsable = canManage && !pending && finished;
  // Published by an owner or admin, once its build passed and recorded so.
  const publishes = canManage && !readOnly && !versions.isPending;
  const publishable =
    source.data?.source?.harnessSha256 != null &&
    source.data.source.toolchainDigest != null;
  /*
    What it stands on is the bounty version its task was taken from, not
    the bounty now: a version taken from an approved one can be published
    whatever the bounty has done since.
  */
  const fromApproved =
    source.data?.source?.approvedTask.pricing?.status === "approved";
  const bountyVersion = source.data?.source?.proposalVersion ?? null;
  // Generated by an owner or admin, and not from a read-only view.
  const generates =
    canGenerate &&
    canManage &&
    !readOnly &&
    !versions.isPending &&
    !versions.isError;

  // The first generation is the card's one action, so it leads; after that,
  // opening what was generated does, and generating again sits beside it.
  const generateButton = generates && (
    // Said on hover and focus, as Publish says why it is held: a disabled
    // button's own title is shown by few browsers and read by no keyboard.
    <DisabledReason reason={generating ? null : generationBlocked}>
      <Button
        type="button"
        variant={latest === null ? "default" : "outline"}
        disabled={generating || generationBlocked !== null}
        onClick={() => void generate()}
      >
        {latest === null ? <Sparkles /> : <RefreshCw />}
        {generating
          ? "Generating…"
          : latest === null
            ? "Generate"
            : "Generate again"}
      </Button>
    </DisabledReason>
  );

  let standing: Standing | null = null;
  let files: number | null = null;
  let hiddenTests: number | null = null;
  if (selected !== null && canManage) {
    if (pending) standing = { label: "Starting…", tone: "busy", note: null };
    else if (source.isPending)
      standing = { label: "Reading…", tone: "muted", note: null };
    else if (runId === null)
      standing = { label: "Draft", tone: "muted", note: null };
    else if (run.data === undefined || generating)
      standing = {
        label: "Generating",
        tone: "busy",
        note: "An agent is writing the starter and its tests, then it is built and checked. This takes a few minutes.",
      };
    else if (run.data.status === "failed")
      standing = { label: "Failed", tone: "bad", note: failureOf(run.data) };
    else {
      const outcome = outcomeOf(artifacts.data ?? []);
      files = outcome.files;
      hiddenTests = outcome.hiddenTests;
      if (artifacts.isPending)
        standing = { label: "Generated", tone: "muted", note: null };
      else if (outcome.ready)
        standing = { label: "Baseline passes", tone: "ok", note: null };
      else
        standing = {
          label: "Baseline fails",
          tone: "bad",
          note:
            outcome.reasons.length === 0
              ? null
              : outcome.reasons.slice(0, 3).join(" "),
        };
    }
  }

  let body: ReactNode;
  if (versions.isPending)
    body = (
      <p className="text-muted-foreground text-sm">Reading its versions…</p>
    );
  else if (versions.isError)
    body = (
      <RetryableError onRetry={() => void versions.refetch()}>
        Its versions could not be read.
      </RetryableError>
    );
  else if (selected === null)
    body = (
      <p className="text-muted-foreground text-sm">
        No version yet.
        {!readOnly && canGenerate && generationBlocked !== null && (
          <> {generationBlocked}</>
        )}
        {!readOnly &&
          canGenerate &&
          generationBlocked === null &&
          (canManage
            ? " Generate one: an agent writes a starter from the bounty's title, description and tech stack, then it is built and checked."
            : " An owner or admin can generate one from the bounty.")}
        {/*
          Said, rather than left without an action: a linked sandbox's
          versions are sliced from its repository, which this page does
          not do.
        */}
        {!readOnly &&
          !canGenerate &&
          " Its versions are sliced from its repository; slicing is not available from this page yet."}
      </p>
    );
  else {
    const facts: { term: string; value: ReactNode }[] = [];
    if (standing !== null)
      facts.push({
        term: "Status",
        value: (
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden
              className={cn("size-2 rounded-full", TONE_DOT[standing.tone])}
            />
            {standing.label}
          </span>
        ),
      });
    if (canManage) {
      facts.push({ term: "Source files", value: files ?? "—" });
      facts.push({ term: "Hidden tests", value: hiddenTests ?? "—" });
    }
    facts.push({ term: "Created", value: createdOn(selected.createdAt) });

    body = (
      <div className="flex flex-col gap-4">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          {facts.map(({ term, value }) => (
            <div key={term} className="flex min-w-0 flex-col gap-0.5">
              <dt className="text-muted-foreground text-xs">{term}</dt>
              <dd className="text-sm font-medium tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
        {standing?.note != null && (
          <p
            className={cn(
              "text-sm",
              standing.tone === "bad"
                ? "text-destructive"
                : "text-muted-foreground",
            )}
          >
            {standing.note}
          </p>
        )}
      </div>
    );
  }

  /*
    Which version the card is about, over it as a bounty's proposal has its
    version: the version, chosen from the others when there are several,
    under it whether it is published and until when, and the decision that
    publishes it. Given the button's height so the two sit level. A
    publication past its date has lapsed: it reads as expired, and the
    version can be published again.
  */
  const live = isPublicationLive(sandbox);
  const current =
    sandbox.status === "published" && sandbox.currentVersionId === selectedId;
  const published = current && live;
  const expiresAt = sandbox.expiresAt;
  const approvedAt = source.data?.source?.approvedAt ?? null;
  const frozenAt = selected?.frozenAt ?? null;
  const versionName = selected !== null && (
    <span className="font-semibold">Version {selected.version}</span>
  );
  const versionHeader = selected !== null && (
    <div className="flex items-center justify-between gap-3">
      <span className="flex min-h-9 min-w-0 flex-col justify-center text-xs">
        {all.length > 1 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="focus-visible:ring-ring/50 -mx-1 flex w-fit items-center gap-1 rounded-sm px-1 hover:underline focus-visible:ring-[3px] focus-visible:outline-none"
                aria-label={`Version ${selected.version}, choose another`}
              >
                {versionName}
                <ChevronDown className="text-muted-foreground size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-48">
              {all.map((item) => (
                <DropdownMenuItem
                  key={item.id}
                  onSelect={() =>
                    setChosenId(item.id === latest?.id ? null : item.id)
                  }
                  className="justify-between gap-4"
                >
                  <span>Version {item.version}</span>
                  <span className="text-muted-foreground text-xs">
                    {item.id === sandbox.currentVersionId && live
                      ? "Published"
                      : item.id === latest?.id
                        ? "Latest"
                        : createdOn(item.createdAt)}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          versionName
        )}
        <span className="text-muted-foreground flex flex-wrap gap-x-1">
          {published && approvedAt !== null ? (
            <span>
              Published{" "}
              <time dateTime={approvedAt}>{dateTime(approvedAt)}</time>
              {expiresAt !== null && (
                <>
                  {" "}
                  · Expires{" "}
                  <time dateTime={expiresAt}>{dateTime(expiresAt)}</time>
                </>
              )}
            </span>
          ) : current && expiresAt !== null ? (
            <span>
              Expired <time dateTime={expiresAt}>{dateTime(expiresAt)}</time>
            </span>
          ) : frozenAt !== null ? (
            <span>
              Frozen <time dateTime={frozenAt}>{dateTime(frozenAt)}</time> · Not
              published
            </span>
          ) : (
            <span>Not published yet</span>
          )}
          {selected.id === latest?.id && <span>· Latest</span>}
          {/* What it stands on: the step before it, by version. */}
          {bountyVersion !== null ? (
            <span>· Bounty v{bountyVersion}</span>
          ) : (
            source.data?.source != null && <span>· Bounty draft</span>
          )}
        </span>
      </span>
      {publishes &&
        (published ? (
          <>
            <Button
              variant="outline"
              disabled={publishing}
              onClick={() => setUnpublishing(true)}
            >
              Unpublish
            </Button>
            <ConfirmDialog
              open={unpublishing}
              onOpenChange={setUnpublishing}
              title="Unpublish this version?"
              description="Contributors lose access to the sandbox until a version is published again. The version itself is kept."
              confirmLabel="Unpublish"
              pendingLabel="Unpublishing…"
              busy={publishing}
              onConfirm={() => publish(null)}
            />
          </>
        ) : (
          <PublishMenu
            disabledReason={
              !publishable
                ? "Only a version whose build passed can be published."
                : !fromApproved
                  ? "This version was not built from an approved bounty."
                  : null
            }
            busy={publishing}
            onPublish={(until) => void publish(until)}
          />
        ))}
    </div>
  );

  const openButton = browsable && selectedId !== null && (
    <Button asChild>
      {/* A tab of its own, so the bounty stays where it was. */}
      <a
        href={sandboxFilesPath({ workspace, versionId: selectedId })}
        target="_blank"
        rel="noopener"
      >
        <LunoxMark />
        Open Sandbox
      </a>
    </Button>
  );

  return (
    <div className="flex flex-col gap-3">
      {versionHeader}
      <SandboxCard
        icon={LunoxMark}
        // The mark in the foreground's ink: white on the dark theme.
        iconClassName="text-foreground"
        title="Slice"
        description={
          canGenerate
            ? "The task as a runnable project, written from the bounty. Only your workspace can see it; each generation is kept as a version."
            : "A slice of your repository, cut down to the task. Only your workspace can see it; each generation is kept as a version."
        }
      >
        <div className="flex flex-col gap-4" data-testid="sandbox-generation">
          {body}
          {generates && selected !== null && generationBlocked !== null && (
            <p className="text-muted-foreground text-sm">{generationBlocked}</p>
          )}
          {(openButton || generateButton) && (
            <div className="flex flex-wrap items-center gap-2">
              {openButton}
              {generateButton}
            </div>
          )}
          {children}
          {error !== null && (
            <p role="alert" className="text-destructive text-xs">
              {error}
            </p>
          )}
        </div>
      </SandboxCard>
    </div>
  );
}
