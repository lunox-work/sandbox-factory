/**
 * A sandbox with no repository has its versions generated: an agent writes
 * a starter from the bounty's title, description and tech stack, and the
 * worker builds it and checks its baseline, as it would a sliced version.
 * A linked one has its versions sliced: cut from the slice its bounty's
 * sizing took of the approved spec in its repository, then built the same
 * way.
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
  SandboxSliceDto,
  SandboxVersionDto,
} from "@sandbox-factory/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, RefreshCw, Scissors, Sparkles } from "lucide-react";
import { RunActivity } from "@/components/RunActivity";
import { useEffect, useRef, useState, type ReactNode } from "react";

import {
  isPublicationLive,
  SANDBOX_BUILD_RUN_VERSION,
  SLICE_PUBLISHED_REASON,
} from "sandbox-factory";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { DisabledReason } from "@/components/DisabledReason";
import { RetryableError } from "@/components/Message";
import { RuledSection } from "@/components/ReadSection";
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
import { NoVersion, StepVersionCard } from "./BountySteps";

/** How often a generation in progress is asked about. */
export const GENERATION_POLL_MS = 3_000;
/** How long a ready slice's version is waited for before it is left to a click. */
const CUT_WAIT_MS = 30_000;

/** Why a generation or a build stopped, as its run's error code says it. */
function failureOf(run: AnalysisRunDto, sliced: boolean): string {
  if (sliced)
    switch (run.errorCode) {
      case "evaluation_failed":
        return "The worker could not check it; it needs an evaluation provider.";
      case "tool_failed":
        return "The build stopped on an error.";
      case "tool_timeout":
        return "It took longer than its deadline.";
      case "worker_lost":
        return "The worker stopped while building it.";
      default:
        return run.errorCode === null
          ? "It stopped without saying why."
          : `It stopped (${run.errorCode}).`;
    }
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

/**
 * What a finished run's artifacts say: whether it built, and what it holds,
 * as a starter counts it or else as the build does.
 */
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
    hiddenTests: count(set?.["hiddenTests"]) ?? count(build?.["privateTests"]),
    files: count(set?.["files"]) ?? count(build?.["files"]),
  };
}

/** A slice its sizing is still working on. */
const SLICE_UNDER_WAY: readonly SandboxSliceDto["status"][] = [
  "queued",
  "scoping",
  "slicing",
];
const sliceUnderWay = (slice: SandboxSliceDto) =>
  SLICE_UNDER_WAY.includes(slice.status);

/** What a slice under way is doing, in one line. */
function sliceActivity(slice: SandboxSliceDto): string {
  if (slice.status === "queued") return "Waiting for room to start the slice";
  if (slice.status === "scoping")
    return "The scope agent is picking the files the task needs";
  return "Cutting the slice from the repository";
}

/** Where a version stands, in a word, with why when it went wrong. */
type Standing = {
  label: string;
  tone: "ok" | "bad" | "busy" | "muted";
  note: string | null;
  /** The agent is at work: its steps are shown in place of a note. */
  working?: boolean;
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
  flat = false,
  context = null,
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
   * Why generating and publishing are refused for now, such as a bounty
   * whose scope or price is not approved; null when they are not.
   * Unpublishing is the way back, and is never refused.
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
  /**
   * Its version and what it holds, with no card around them: a panel lays
   * them out in its own section, which names what a slice is.
   */
  flat?: boolean;
  /**
   * The context its version was made with, across the foot of the
   * version's card; a flat one has no card to carry it.
   */
  context?: ReactNode;
  /** Under its versions, such as the way to link a repository. */
  children?: ReactNode;
}) {
  const sandboxId = sandbox.id;
  const userId = useUserId();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  // Asking for a slice, or cutting a version from it.
  const [slicing, setSlicing] = useState(false);
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
  /*
    A slice seen under way here and now ready: the API cuts the version
    asked for from it and builds it, a moment after. The newest version id
    then, read again until another is newest or a while has passed.
  */
  const [awaitingCut, setAwaitingCut] = useState<string | null>(null);
  const versions = useQuery({
    queryKey: versionsKey,
    queryFn: ({ signal }) =>
      clients.sandbox.sandboxVersions(organizationId, sandboxId, signal),
    refetchInterval: awaitingCut === null ? false : GENERATION_POLL_MS,
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
  // A generated version's run writes and builds it; a sliced one's builds it.
  const sliced = source.data?.source?.origin === "slice";
  const runId =
    source.data?.source == null
      ? null
      : sliced
        ? source.data.source.buildRunId
        : source.data.source.starterRunId;
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

  /*
    A linked sandbox's next slice: its sizing's, followed while the scope
    agent picks it and it is cut, with the agent's steps as it works. Owners
    and admins only, as the runs behind it are private.
  */
  const slices = !canGenerate && canManage && !readOnly;
  const sliceKey = queryKeys.resource(
    userId,
    organizationId,
    "sandbox-slice",
    sandboxId,
  );
  const slice = useObservation({
    owner: organizationId,
    resource: "sandbox-slice",
    id: slices ? sandboxId : null,
    read: (id, signal) =>
      clients.sandbox.sandboxSlice(organizationId, id, signal),
    terminal: (value) => !sliceUnderWay(value),
    interval: GENERATION_POLL_MS,
  });
  const sliceWatched = useRef(false);
  if (slice.data !== undefined && sliceUnderWay(slice.data))
    sliceWatched.current = true;
  const sliceSettled =
    slice.data !== undefined && !sliceUnderWay(slice.data)
      ? slice.data.status
      : null;
  useEffect(() => {
    if (sliceSettled === null || !sliceWatched.current) return;
    sliceWatched.current = false;
    if (sliceSettled === "ready") setAwaitingCut(latest?.id ?? "");
    void queryClient.invalidateQueries({ queryKey: versionsKey });
    // On the slice settling only: `latest` is read then, not followed, and
    // the key is a new array each render.
  }, [sliceSettled, queryClient]);
  useEffect(() => {
    if (awaitingCut === null) return;
    if ((latest?.id ?? "") !== awaitingCut) {
      setAwaitingCut(null);
      setChosenId(null);
      changed.current?.();
      return;
    }
    const timer = setTimeout(() => setAwaitingCut(null), CUT_WAIT_MS);
    return () => clearTimeout(timer);
  }, [awaitingCut, latest?.id]);
  const scopeRun = useObservation({
    owner: organizationId,
    resource: "analysis-run",
    id: slice.data?.status === "scoping" ? slice.data.scopeRunId : null,
    read: (id, signal) => clients.analysis.run(organizationId, id, signal),
    terminal: terminalRun,
    interval: GENERATION_POLL_MS,
  });

  /*
    Slicing asks for the sizing's slice while there is none, and once it is
    ready, cuts a draft from it and builds it. A draft whose scope has
    blockers is cut without a build, for them to be read.
  */
  async function sliceVersion() {
    setSlicing(true);
    setError(null);
    try {
      const answer = await clients.sandbox.sliceSandboxVersion(
        organizationId,
        sandboxId,
      );
      queryClient.setQueryData(sliceKey, answer.slice);
      if (answer.version !== null) {
        queryClient.setQueryData(
          queryKeys.resource(
            userId,
            organizationId,
            "sandbox-version",
            answer.version.id,
          ),
          { version: answer.version, source: answer.source ?? undefined },
        );
        // The new version is the one to follow.
        setChosenId(null);
        await queryClient.invalidateQueries({ queryKey: versionsKey });
        onChanged?.();
      }
      // Read again, so a slice now under way is followed.
      await queryClient.invalidateQueries({ queryKey: sliceKey });
    } catch (failure) {
      setError(
        failure instanceof ApiError
          ? failure.message
          : "Could not reach the server.",
      );
      void queryClient.invalidateQueries({ queryKey: sliceKey });
    } finally {
      setSlicing(false);
    }
  }

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
  const priceVersion = source.data?.source?.proposalVersion ?? null;
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
    else if (runId === null) {
      // A sliced draft is built once its scope has no blockers.
      const blockers = source.data?.source?.scope.blockers ?? [];
      standing =
        blockers.length > 0
          ? {
              label: "Blocked",
              tone: "bad",
              note: blockers
                .slice(0, 3)
                .map((item) => item.detail)
                .join(" "),
            }
          : { label: "Draft", tone: "muted", note: null };
    } else if (run.data === undefined || generating)
      standing = {
        label: sliced ? "Building" : "Generating",
        tone: "busy",
        note: null,
        working: true,
      };
    else if (run.data.status === "failed")
      standing = {
        label: "Failed",
        tone: "bad",
        note: failureOf(run.data, sliced),
      };
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
        {/* A page's version card says it already. */}
        {flat && "No version yet."}
        {!readOnly && canGenerate && generationBlocked !== null && (
          <> {generationBlocked}</>
        )}
        {!readOnly &&
          canGenerate &&
          generationBlocked === null &&
          (canManage
            ? " Generate one: an agent writes a starter from the bounty's title, description and tech stack, then it is built and checked."
            : " An owner or admin can generate one from the bounty.")}
        {!readOnly &&
          !canGenerate &&
          (!canManage
            ? " An owner or admin can slice one from its repository."
            : generationBlocked !== null
              ? ` ${generationBlocked}`
              : slice.data === undefined || sliceUnderWay(slice.data)
                ? null
                : slice.data.status === "ready"
                  ? " Its sizing's slice is ready: slice a version from it, and it is built and checked."
                  : slice.data.status === "none"
                    ? " Slice one: the scope agent picks the files the task needs from its repository, they are cut down to the task, then built and checked."
                    : ` ${slice.data.reason ?? "It cannot be sliced yet."}`)}
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
        {flat ? (
          // A row each, on the columns of the panel's details above.
          <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-4 gap-y-0.5 text-sm">
            {facts.map(({ term, value }) => (
              <div key={term} className="contents">
                <dt className="text-muted-foreground flex h-8 items-center">
                  {term}
                </dt>
                <dd className="flex min-h-8 min-w-0 items-center tabular-nums">
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
            {facts.map(({ term, value }) => (
              <div key={term} className="flex min-w-0 flex-col gap-0.5">
                <dt className="text-muted-foreground text-xs">{term}</dt>
                <dd className="text-sm font-medium tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
        )}
        {standing?.working === true && (
          <RunActivity
            state={run.data?.status === "queued" ? "breathing" : "working"}
            progress={run.data?.progress}
            since={run.data?.startedAt}
            expected={sliced ? undefined : "usually 2–4 min"}
          >
            {run.data?.status === "queued"
              ? sliced
                ? "Waiting for room to start the build"
                : "Waiting for room to start the agent"
              : sliced
                ? "Building the slice and checking its baseline"
                : "The agent is writing the starter and its tests, then building and checking it"}
          </RunActivity>
        )}
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
    <span className="text-subheading">Version {selected.version}</span>
  );
  const versionLine = selected !== null && (
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
            Published <time dateTime={approvedAt}>{dateTime(approvedAt)}</time>
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
        {priceVersion !== null ? (
          <span>· Price v{priceVersion}</span>
        ) : (
          source.data?.source != null && <span>· Price pending</span>
        )}
      </span>
    </span>
  );
  const publishAction =
    selected !== null &&
    publishes &&
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
          generationBlocked !== null
            ? generationBlocked
            : !publishable
              ? "Only a version whose build passed can be published."
              : !fromApproved
                ? "This version was not built from an approved price."
                : null
        }
        busy={publishing}
        onPublish={(until) => void publish(until)}
      />
    ));

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

  /*
    A linked sandbox's versions are sliced, by an owner or admin. Held while
    its publication is live, as the API holds it, while its sizing's slice
    is under way or cannot be had, and while the latest
    draft is still the one its slice was cut into and built by the current
    builder: slicing again would only build it again, so the reason says how
    a new slice is had. A draft an older builder built is built again.
  */
  const sliceState = slice.data;
  const latestFromSlice =
    latest !== null &&
    selected?.id === latest.id &&
    latest.frozenAt === null &&
    sliceState?.sliceRunId != null &&
    source.data?.source?.sliceRunId === sliceState.sliceRunId &&
    run.data?.status !== "failed" &&
    (run.data === undefined ||
      run.data.toolVersion === SANDBOX_BUILD_RUN_VERSION) &&
    (source.data.source.buildRunId !== null ||
      source.data.source.scope.blockers.length > 0);
  const sliceHeld =
    generationBlocked ??
    // Contributors work in what it publishes.
    (live
      ? SLICE_PUBLISHED_REASON
      : sliceState === undefined
        ? slice.isError
          ? "Its slice could not be read."
          : "Reading its slice…"
        : sliceUnderWay(sliceState)
          ? "Its sizing is still cutting the slice."
          : sliceState.status === "failed" ||
              sliceState.status === "unavailable"
            ? (sliceState.reason ?? "It cannot be sliced yet.")
            : latestFromSlice
              ? "The latest version is already cut from this slice. Price it again to cut a new one."
              : null);
  const sliceBusy = slicing || generating;
  const sliceButton = slices && !versions.isPending && !versions.isError && (
    <DisabledReason reason={sliceBusy ? null : sliceHeld}>
      <Button
        type="button"
        variant={latest === null ? "default" : "outline"}
        disabled={sliceBusy || sliceHeld !== null}
        onClick={() => void sliceVersion()}
      >
        {latest === null ? <Scissors /> : <RefreshCw />}
        {slicing ? "Slicing…" : latest === null ? "Slice" : "Slice again"}
      </Button>
    </DisabledReason>
  );
  const makeButton = canGenerate ? generateButton : sliceButton;

  // A slice its sizing is still cutting, with the scope agent's steps.
  const sliceProgress = sliceState !== undefined &&
    sliceUnderWay(sliceState) && (
      <RunActivity
        state={sliceState.status === "queued" ? "breathing" : "working"}
        progress={scopeRun.data?.progress}
        since={scopeRun.data?.startedAt}
      >
        {sliceActivity(sliceState)}
      </RunActivity>
    );

  // On a page, the first version is the version card's one action.
  const firstOnCard = !flat && latest === null;
  const rowGenerate = !firstOnCard && makeButton;
  const content = (
    <div className="flex flex-col gap-4" data-testid="sandbox-generation">
      {body}
      {sliceProgress}
      {(openButton || rowGenerate) && (
        <div className="flex flex-wrap items-center gap-2">
          {openButton}
          {rowGenerate}
        </div>
      )}
      {children}
      {error !== null && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
    </div>
  );

  // A panel's section names what a slice is; its version heads it.
  if (flat)
    return (
      <div className="flex flex-col gap-3">
        {versionLine !== false && (
          <div className="flex items-center justify-between gap-3">
            {versionLine}
            {publishAction}
          </div>
        )}
        {content}
      </div>
    );

  /*
    A page's sandbox, laid out as its scope is: its version's card, the one
    card on the tab, then the slice in a ruled section of its own.
  */
  return (
    <>
      <StepVersionCard
        step="sandbox"
        tile={selected === null ? "—" : `v${selected.version}`}
        approved={published}
        action={selected === null ? firstOnCard && makeButton : publishAction}
        context={context}
      >
        {selected !== null ? (
          versionLine
        ) : (
          <NoVersion
            title={
              versions.isPending ? "Reading its versions…" : "No version yet"
            }
          />
        )}
      </StepVersionCard>
      <RuledSection title="Slice">
        <p className="text-muted-foreground text-sm">
          {canGenerate
            ? "The task as a runnable project, written from the bounty. Only your workspace can see it; each generation is kept as a version."
            : "Sliced from your repository, down to the task. Only your workspace can see it; each generation is kept as a version."}
        </p>
        {content}
      </RuledSection>
    </>
  );
}
