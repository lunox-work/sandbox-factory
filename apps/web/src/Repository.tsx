/**
 * One registered repository, as a page of its own: `/o/:slug/repositories/:id`.
 *
 * Stacked blocks, top to bottom: what the repository is, the snapshot the
 * rest of the page is about, the stack detected in it, the context
 * builders and where each stands on that snapshot, with every run there
 * has been folded into their footer. The builders are the page's reason to exist: each reads a
 * snapshot on its own and describes it for people and agents. They are
 * started here, all at once; what they wrote is read in the context viewer, and a
 * run's log in the logs dialog, so the page itself stays a summary.
 *
 * Roles come from the API, which checks them again on every write; hiding
 * a control the API would refuse is courtesy, not security. Only an owner
 * or admin starts runs or reads logs; any member opens artifacts.
 */

import type {
  AnalysisRunDto,
  ArtifactDto,
  GithubRepoDto,
} from "@sandbox-factory/shared";
import {
  abstractionsSummarySchema,
  dataModelSummarySchema,
  deepwikiSummarySchema,
  dependencyCruiserSummarySchema,
  graphifySummarySchema,
} from "@sandbox-factory/shared";
import {
  ChevronDown,
  ExternalLink,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
  FolderOpen,
  Hammer,
  Lock,
  Trash2,
} from "lucide-react";
import {
  CONTEXT_BUILDERS,
  rankAtLeast,
  readsGraph,
  type ContextBuilder,
} from "sandbox-factory";
import { useEffect, useRef, useState } from "react";

import { Combobox } from "@/components/Combobox";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ErrorBanner, LoadingLine, RetryableError } from "@/components/Message";
import { StackChips } from "@/components/StackPicker";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { clients } from "./data/query";
import { BLOCK_ACTION, Block, FLUSH_LIST } from "./features/analysis/Blocks";
import { BuilderRow, needsBuild } from "./features/analysis/BuilderRow";
import {
  ContextViewer,
  type ContextBuild,
} from "./features/analysis/ContextViewer";
import { RunHistory } from "./features/analysis/RunHistory";
import { RunLogs } from "./features/analysis/RunLogs";
import { summaryOf } from "./features/analysis/artifacts";
import { errorMessage, shortSha } from "./features/analysis/labels";
import { sizeLabel } from "./features/sandbox/file-tree";
import {
  useAnalysisResources,
  useRepoBranches,
  useRunArtifacts,
} from "./features/analysis/queries";
import { REMOVE_REPOSITORY_WARNING } from "./Github";
import { isPlainLeftClick, pathForScreen } from "./routes";
import { useGithubRepos } from "./useGithub";

/** Roles that may start runs, read logs and remove, matching the API's floor. */
function canManage(role: string): boolean {
  return rankAtLeast(role, "admin");
}

/** How long a pull's snapshot is watched for before the page stops asking. */
const PULL_WAIT_MS = 120_000;
/** How often a repository still syncing is read again. */
const SYNC_POLL_MS = 5_000;
/** How long "Up to date" stands in for the pull button's label. */
const UP_TO_DATE_MS = 2_500;

const PAGE_CLASS =
  "mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-10 sm:px-6 sm:py-14";

export function RepositoryPage({
  organizationId,
  organizationSlug,
  repoId,
  role,
  onName,
  onRemoved,
}: {
  organizationId: string;
  organizationSlug: string;
  repoId: string;
  role: string;
  /**
   * Reports the repository's name up to the shell, which renders the trail
   * above this page and has no other way to learn it. Called with undefined
   * while the list is still arriving, and on leaving.
   */
  onName: (name: string | undefined) => void;
  /** Called once the repository is no longer registered here. */
  onRemoved: () => void;
}) {
  const repos = useGithubRepos(organizationId);
  const repo = repos.repos.find((candidate) => candidate.id === repoId);
  const name = repo?.fullName;
  useEffect(() => {
    onName(name);
    return () => onName(undefined);
  }, [name, onName]);

  if (repo === undefined) {
    return (
      <main className={PAGE_CLASS}>
        {repos.loading ? (
          <LoadingLine />
        ) : repos.error !== null ? (
          <RetryableError onRetry={() => void repos.refresh()}>
            {repos.error}
          </RetryableError>
        ) : (
          <div className="flex flex-col items-start gap-3">
            <div>
              <h1 className="text-xl font-semibold">Repository unavailable</h1>
              <p className="text-muted-foreground mt-1 text-sm">
                It may have been removed from this workspace.
              </p>
            </div>
            <a
              href={pathForScreen(
                "org-settings",
                organizationSlug,
                undefined,
                undefined,
                "github",
              )}
              className="text-primary rounded-sm text-sm font-medium hover:underline"
              onClick={(event) => {
                if (isPlainLeftClick(event)) {
                  event.preventDefault();
                  onRemoved();
                }
              }}
            >
              View the registered repositories
            </a>
          </div>
        )}
      </main>
    );
  }

  return (
    <RepositoryView
      organizationId={organizationId}
      repo={repo}
      manageable={canManage(role)}
      onRemove={() => repos.remove(repo.id)}
      onRemoved={onRemoved}
      onHeadMoved={() => void repos.refresh()}
    />
  );
}

function RepositoryView({
  organizationId,
  repo,
  manageable,
  onRemove,
  onRemoved,
  onHeadMoved,
}: {
  organizationId: string;
  repo: GithubRepoDto;
  manageable: boolean;
  onRemove: () => Promise<{ ok: true } | { ok: false; error: string }>;
  onRemoved: () => void;
  /** A pull of the default branch may have moved the repository's head. */
  onHeadMoved: () => void;
}) {
  const client = clients.analysis;
  const [snapshotId, setSnapshotId] = useState("");
  const [branch, setBranch] = useState(repo.defaultBranch);
  /** A pull whose snapshot is still being taken, until it lands. */
  const [awaiting, setAwaiting] = useState<{
    commitSha: string;
    since: number;
  } | null>(null);
  const [pulling, setPulling] = useState(false);
  /** A pull's commit whose snapshot did not land within the wait. */
  const [lagging, setLagging] = useState<string | null>(null);
  const [upToDate, setUpToDate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** A file or log that would not open; said where it was asked for. */
  const [openError, setOpenError] = useState<string | null>(null);
  /** "Build all" was asked for, until the API answers. */
  const [building, setBuilding] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [viewing, setViewing] = useState(false);
  /** The run the logs dialog is open on; null while it is closed. */
  const [logsOn, setLogsOn] = useState<string | null>(null);
  const resources = useAnalysisResources(organizationId, repo.id, {
    watchSnapshots: awaiting !== null,
    snapshotId,
  });
  const snapshots = resources.snapshots.data ?? [];
  const runs = resources.runs;
  // The builds on the chosen snapshot, from its own read rather than the
  // repository's bounded history.
  const snapshotRuns = resources.snapshotRuns;
  const loading = resources.loading;
  const branchList = useRepoBranches(organizationId, repo.id);
  const branches = branchList.data?.branches ?? [];
  /** The commit the chosen branch is at, as last read. */
  const branchHead =
    branches.find((each) => each.name === branch)?.headSha ??
    (branch === repo.defaultBranch ? repo.headSha : null);
  // A commit is snapshotted once, under the branch it was first taken
  // from; a branch also shows the snapshot of the commit it is at now.
  const onBranch = snapshots.filter(
    (s) => s.ref === `refs/heads/${branch}` || s.commitSha === branchHead,
  );
  const onBranchIds = onBranch.map((s) => s.id).join(" ");

  // The branch's head, or its newest, until one of its own is chosen.
  useEffect(() => {
    setSnapshotId((current) =>
      onBranch.some((s) => s.id === current)
        ? current
        : (onBranch.find((s) => s.commitSha === branchHead)?.id ??
          onBranch[0]?.id ??
          ""),
    );
  }, [onBranchIds, branchHead]);

  // A pull's snapshot is chosen once it lands; past the wait, the page
  // stops asking, and the list shows it whenever it is read again.
  useEffect(() => {
    if (awaiting === null) return;
    const landed = resources.snapshots.data?.find(
      (s) => s.commitSha === awaiting.commitSha,
    );
    if (landed !== undefined) {
      setSnapshotId(landed.id);
      setAwaiting(null);
      return;
    }
    // Past the wait it says so, and the repository is read again: a
    // snapshot that failed leaves its reason on the repository.
    const timer = setTimeout(
      () => {
        setAwaiting(null);
        setLagging(awaiting.commitSha);
        onHeadMoved();
      },
      Math.max(0, awaiting.since + PULL_WAIT_MS - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [awaiting, resources.snapshots.data]);

  /*
    A repository just registered syncs in the background: its stack and its
    first snapshot arrive a little later. Read again until both have, so the
    page does not say "Reading…" until a reload; never while a read has
    failed, which waits for "Try again", nor for a repository whose own sync
    failed or is gone, which no reading again will change.
  */
  const syncing =
    !loading &&
    resources.error === null &&
    repo.syncStatus !== "error" &&
    repo.syncStatus !== "gone" &&
    (repo.stack === null || snapshots.length === 0);
  // Held, not depended on: both are new each render, which would restart
  // the timer before it ever fired.
  const readAgain = useRef(() => {});
  readAgain.current = () => {
    onHeadMoved();
    void resources.snapshots.refetch();
  };
  useEffect(() => {
    if (!syncing) return;
    const timer = setInterval(() => readAgain.current(), SYNC_POLL_MS);
    return () => clearInterval(timer);
  }, [syncing]);

  useEffect(() => {
    if (!upToDate) return;
    const timer = setTimeout(() => setUpToDate(false), UP_TO_DATE_MS);
    return () => clearTimeout(timer);
  }, [upToDate]);

  const branchRef = useRef(branch);
  branchRef.current = branch;

  function chooseBranch(name: string) {
    setBranch(name);
    setLagging(null);
    setAwaiting(null);
    setUpToDate(false);
  }

  /** Reads the branch's head and snapshots it, unless it was taken already. */
  async function pull() {
    setPulling(true);
    setUpToDate(false);
    setError(null);
    setLagging(null);
    const asked = branch;
    try {
      const pulled = await client.pullSnapshot(organizationId, repo.id, asked);
      // Answered for a branch no longer chosen: its snapshot is not this
      // one's to select. (The picker is held while pulling; this is the
      // guard for an answer that arrives anyway.)
      if (branchRef.current !== asked) return;
      if (branch === repo.defaultBranch) onHeadMoved();
      if (pulled.snapshot === null) {
        void branchList.refetch();
        setAwaiting({ commitSha: pulled.commitSha, since: Date.now() });
      } else {
        await Promise.all([
          branchList.refetch(),
          resources.snapshots.refetch(),
        ]);
        setUpToDate(pulled.snapshot.id === snapshotId);
        setSnapshotId(pulled.snapshot.id);
      }
    } catch (cause) {
      setError(errorMessage(cause, "Could not pull the branch. Try again."));
    } finally {
      setPulling(false);
    }
  }

  const trackingError =
    resources.error === null ? null : errorMessage(resources.error);
  const current = snapshots.find((s) => s.id === snapshotId);

  /** The commit a run read, short, or a stand-in while the list arrives. */
  function commitOf(run: AnalysisRunDto): string {
    if (run.snapshotId === null) return "No snapshot";
    const commit = snapshots.find((s) => s.id === run.snapshotId)?.commitSha;
    return commit === undefined ? "Snapshot" : shortSha(commit);
  }

  /** This builder's run on the chosen snapshot, when there is one. */
  const builderRun = (builder: ContextBuilder) =>
    snapshotRuns.find(
      (run) => run.snapshotId === snapshotId && run.tool === builder,
    );
  /** Each builder's succeeded run on the chosen snapshot: what "View" opens. */
  const built = CONTEXT_BUILDERS.flatMap((builder) => {
    const run = snapshotRuns.find(
      (each) =>
        each.snapshotId === snapshotId &&
        each.tool === builder &&
        each.status === "succeeded",
    );
    return run === undefined ? [] : [{ builder, run }];
  });
  const builtArtifacts = useRunArtifacts(
    organizationId,
    built.map(({ run }) => run.id),
  );
  const builds: ContextBuild[] = built.map((build) => ({
    ...build,
    artifacts: builtArtifacts.artifacts.get(build.run.id),
    failed: builtArtifacts.failed.has(build.run.id),
  }));

  /*
    What "Build all" would start. The builders that read graphify's map
    have nothing to read while its run is out of retries, so the API skips
    them; they are not counted here either.
  */
  const graphRun = builderRun("graphify");
  const graphStuck =
    graphRun?.status === "failed" && !needsBuild("graphify", graphRun);
  const toBuild = CONTEXT_BUILDERS.filter(
    (builder) =>
      needsBuild(builder, builderRun(builder)) &&
      !(readsGraph(builder) && graphStuck),
  );

  /**
   * Every builder on the chosen snapshot, as one request: the API admits
   * the set against the organization's active-run cap once, where one
   * request a builder would be refused partway.
   */
  async function buildAll() {
    setBuilding(true);
    setError(null);
    try {
      await client.buildAll(organizationId, repo.id, { snapshotId });
      // Read again before the button is given back, so the rows say their
      // runs are queued rather than "Not built" for a round trip.
      await resources.refresh();
    } catch (cause) {
      setError(errorMessage(cause, "Could not start the builds. Try again."));
    } finally {
      setBuilding(false);
    }
  }

  async function openArtifact(
    target: { artifactId: string } | { runId: string },
  ) {
    const tab = window.open("about:blank", "_blank");
    if (tab !== null) tab.opener = null;
    try {
      const url =
        "artifactId" in target
          ? await client.artifactUrl(organizationId, target.artifactId)
          : await client.logUrl(organizationId, target.runId);
      if (tab === null) {
        setOpenError("Allow pop-ups to open this file, then try again.");
        return;
      }
      tab.location.href = url;
    } catch (cause) {
      tab?.close();
      setOpenError(errorMessage(cause, "Could not open that file. Try again."));
    }
  }
  const open = (artifactId: string) => {
    void openArtifact({ artifactId });
  };
  // While a dialog is open the page's banner is behind it, so the failure
  // is said in the dialog.
  const dialogOpen = viewing || logsOn !== null;
  const dialogNotice =
    openError === null || !dialogOpen
      ? null
      : { text: openError, onDismiss: () => setOpenError(null) };

  /** The figures a builder's card shows, from its build's own artifacts. */
  function figuresFor(builder: ContextBuilder) {
    const artifacts = builds.find(
      (build) => build.builder === builder,
    )?.artifacts;
    return artifacts === undefined
      ? undefined
      : builderFigures(builder, artifacts);
  }

  return (
    <main className={PAGE_CLASS}>
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="text-muted-foreground size-5 shrink-0">
              <FolderGit2 className="size-full" />
            </span>
            <h1 className="min-w-0 truncate text-2xl font-semibold tracking-tight">
              {repo.fullName}
            </h1>
            {repo.isPrivate && (
              <Badge variant="outline" className="gap-1 rounded-[4px]">
                <Lock aria-hidden="true" />
                Private
              </Badge>
            )}
          </div>
          {manageable && (
            <Button
              variant="outline"
              className="text-destructive gap-2"
              aria-label={`Remove ${repo.fullName}`}
              onClick={() => setRemoving(true)}
            >
              <Trash2 className="size-4" />
              Remove
            </Button>
          )}
        </div>
        <p className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span>
            Branch{" "}
            <span className="text-foreground font-mono">
              {repo.defaultBranch}
            </span>
          </span>
          {repo.headSha !== null && (
            <span>
              Head{" "}
              <span className="text-foreground font-mono" title={repo.headSha}>
                {shortSha(repo.headSha)}
              </span>
            </span>
          )}
          <a
            href={`https://github.com/${repo.fullName}`}
            target="_blank"
            rel="noreferrer noopener"
            className="hover:text-foreground inline-flex items-center gap-1 underline-offset-4 hover:underline"
          >
            github.com/{repo.fullName}
            <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
          </a>
        </p>
      </header>

      {repo.syncError !== null && (
        <ErrorBanner className="mt-0">{repo.syncError}</ErrorBanner>
      )}
      {/*
        Two kinds, each with its own way out: a read that failed is read
        again; an action that failed (a pull, a build, a file) is dismissed
        and done again from where it was asked.
      */}
      {trackingError !== null && (
        <ErrorBanner className="mt-0 flex flex-wrap items-center gap-3">
          <span>{trackingError}</span>
          <button
            type="button"
            className="underline underline-offset-2"
            onClick={resources.retry}
          >
            Try again
          </button>
        </ErrorBanner>
      )}
      {(error ?? (dialogOpen ? null : openError)) !== null && (
        <ErrorBanner className="mt-0 flex flex-wrap items-center gap-3">
          <span>{error ?? openError}</span>
          <button
            type="button"
            className="underline underline-offset-2"
            onClick={() => {
              setError(null);
              setOpenError(null);
            }}
          >
            Dismiss
          </button>
        </ErrorBanner>
      )}

      <Block
        title="Snapshot"
        description={
          <>
            <span className="block">
              {loading ? (
                "Loading…"
              ) : awaiting !== null ? (
                <>
                  Taking a snapshot of{" "}
                  <span className="font-mono">
                    {shortSha(awaiting.commitSha)}
                  </span>{" "}
                  on {branch}…
                </>
              ) : current === undefined ? (
                branch === repo.defaultBranch ? (
                  "A source snapshot will appear after the repository syncs."
                ) : (
                  `No snapshot of ${branch} yet.${manageable ? " Pull it to take one." : ""}`
                )
              ) : (
                <>
                  <span className="text-foreground inline-flex max-w-full min-w-0 items-center gap-1 font-mono">
                    <GitBranch
                      aria-hidden="true"
                      className="size-3.5 shrink-0"
                    />
                    {/* A long branch name wraps rather than running off a
                        phone's edge. */}
                    <span className="min-w-0 break-all">
                      {branch}@
                      <span title={current.commitSha}>
                        {shortSha(current.commitSha)}
                      </span>
                    </span>
                  </span>{" "}
                  · {shortDate(current.createdAt)} ·{" "}
                  {current.fileCount.toLocaleString()} files ·{" "}
                  {sizeLabel(current.totalBytes)}
                  {current.treeTruncated ? " · tree listing truncated" : ""}
                </>
              )}
            </span>
            {manageable && !loading && (
              <button
                type="button"
                className="text-primary mt-1 rounded-sm text-sm font-medium hover:underline disabled:opacity-60 disabled:hover:no-underline"
                title={`Snapshot the newest commit on ${branch}, unless it was taken already.`}
                disabled={pulling || awaiting !== null}
                onClick={() => void pull()}
              >
                {pulling || awaiting !== null
                  ? "Pulling…"
                  : upToDate
                    ? "Up to date"
                    : "Pull latest"}
              </button>
            )}
            {lagging !== null && (
              <span className="text-muted-foreground mt-1 block text-sm">
                The snapshot of {shortSha(lagging)} has not landed yet. It
                appears here once it does; pull again if it does not.
              </span>
            )}
            {branchList.isError && (
              <span className="text-muted-foreground mt-1 block text-sm">
                Branches could not be read from GitHub, so only the default is
                offered.{" "}
                <button
                  type="button"
                  className="text-primary rounded-sm font-medium hover:underline"
                  onClick={() => void branchList.refetch()}
                >
                  Try again
                </button>
              </span>
            )}
          </>
        }
        aside={
          !loading && (
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Combobox
                label="Branch"
                searchPlaceholder="Search branches…"
                emptyMessage={
                  branchList.isError
                    ? "Branches could not be read from GitHub."
                    : "No matches."
                }
                align="end"
                contentClassName="w-72"
                options={(branches.length > 0
                  ? branches
                  : [
                      {
                        name: repo.defaultBranch,
                        headSha: repo.headSha ?? "",
                        isDefault: true,
                      },
                    ]
                ).map((each) => ({
                  value: each.name,
                  label: each.name,
                  keywords: [each.name],
                  detail: each.isDefault
                    ? "default"
                    : each.headSha === ""
                      ? undefined
                      : shortSha(each.headSha),
                }))}
                value={branch}
                onValueChange={chooseBranch}
                trigger={
                  <button
                    type="button"
                    role="combobox"
                    aria-label="Branch"
                    // Held while a pull is out: its snapshot is the chosen
                    // branch's, and choosing another would label it wrong.
                    disabled={pulling}
                    title={
                      branchList.data?.truncated === true
                        ? "The branch the snapshots are of. Only the first 300 branches are listed."
                        : "The branch the snapshots are of."
                    }
                    className={cn(
                      buttonVariants({ variant: "secondary", size: "sm" }),
                      BLOCK_ACTION,
                      "data-[state=open]:text-foreground max-w-56",
                    )}
                  >
                    <GitBranch aria-hidden="true" />
                    <span className="text-foreground truncate font-mono">
                      {branch}
                    </span>
                    <ChevronDown aria-hidden="true" />
                  </button>
                }
              />
              {current !== undefined && (
                <Combobox
                  label="Source snapshot"
                  searchPlaceholder="Search by commit…"
                  align="end"
                  contentClassName="w-72"
                  options={onBranch.map((s) => ({
                    value: s.id,
                    label: shortSha(s.commitSha),
                    keywords: [s.commitSha],
                    detail:
                      s.commitSha === branchHead
                        ? `${shortDate(s.createdAt)} · latest`
                        : shortDate(s.createdAt),
                  }))}
                  value={snapshotId}
                  onValueChange={setSnapshotId}
                  trigger={
                    <button
                      type="button"
                      role="combobox"
                      aria-label="Source snapshot"
                      title="The commit the builders read. The default branch is snapshotted as it moves; pull another branch to snapshot it."
                      className={cn(
                        buttonVariants({ variant: "secondary", size: "sm" }),
                        BLOCK_ACTION,
                        "data-[state=open]:text-foreground",
                      )}
                    >
                      <GitCommitHorizontal aria-hidden="true" />
                      <span className="text-foreground font-mono">
                        {shortSha(current.commitSha)}
                      </span>
                      {current.commitSha === branchHead && (
                        <span className="bg-background/60 rounded-[4px] px-1 py-px text-[10px] leading-none">
                          Latest
                        </span>
                      )}
                      <ChevronDown aria-hidden="true" />
                    </button>
                  }
                />
              )}
            </div>
          )
        }
      />

      <Block
        title="Tech stack"
        description="Detected from its languages, files and dependency manifests at the latest commit. A bounty about this repository starts with it."
        data-testid="repository-stack"
      >
        {repo.stack === null ? (
          <p className="text-muted-foreground text-sm">
            Reading the repository&rsquo;s stack&hellip;
          </p>
        ) : repo.stack.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            Nothing detected at the latest commit.
          </p>
        ) : (
          <StackChips
            inherited={[]}
            inheritedFrom={repo.fullName}
            own={repo.stack}
          />
        )}
      </Block>

      <Block
        title="Context builders"
        description="Each reads the chosen snapshot and describes it for people and agents."
        aside={
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              className={BLOCK_ACTION}
              disabled={builds.length === 0}
              title={
                builds.length === 0
                  ? "Nothing is built on this snapshot yet."
                  : undefined
              }
              onClick={() => setViewing(true)}
            >
              <FolderOpen />
              View files
            </Button>
            {manageable && (
              <Button
                size="sm"
                className="h-7 gap-1.5 rounded-[6px] px-2.5 text-xs has-[>svg]:px-2.5 [&_svg]:size-3.5"
                disabled={building || snapshotId === "" || toBuild.length === 0}
                title={
                  toBuild.length === 0 && snapshotId !== ""
                    ? "Every builder has run on this snapshot."
                    : undefined
                }
                onClick={() => {
                  void buildAll();
                }}
              >
                <Hammer />
                Build all
              </Button>
            )}
          </div>
        }
      >
        <div className={FLUSH_LIST}>
          {CONTEXT_BUILDERS.map((builder) => (
            <BuilderRow
              key={builder}
              builder={builder}
              run={builderRun(builder)}
              pending={building}
              figures={figuresFor(builder)}
              onViewLog={
                manageable
                  ? () => setLogsOn(builderRun(builder)?.id ?? null)
                  : undefined
              }
            />
          ))}
          <RunHistory
            count={runs.length}
            loading={loading}
            unavailable={trackingError !== null}
            manageable={manageable}
            onOpenLogs={() => setLogsOn(runs[0]?.id ?? null)}
          />
        </div>
      </Block>

      <ContextViewer
        owner={organizationId}
        commit={current === undefined ? undefined : shortSha(current.commitSha)}
        builds={builds}
        onRetry={builtArtifacts.retry}
        open={viewing}
        onOpenChange={setViewing}
        onOpenRaw={open}
        notice={dialogNotice}
      />

      {manageable && (
        <RunLogs
          owner={organizationId}
          repository={repo.fullName}
          runs={runs}
          commitOf={commitOf}
          openOn={logsOn}
          onClose={() => setLogsOn(null)}
          onOpenRaw={(runId) => {
            void openArtifact({ runId });
          }}
          notice={dialogNotice}
        />
      )}

      {manageable && (
        <ConfirmDialog
          open={removing}
          onOpenChange={setRemoving}
          title={`Remove ${repo.fullName}?`}
          description={REMOVE_REPOSITORY_WARNING}
          confirmLabel="Remove"
          onConfirm={async () => {
            const result = await onRemove();
            if (!result.ok) return result.error;
            onRemoved();
            return undefined;
          }}
        />
      )}
    </main>
  );
}

/** Two or three headline figures from a build's summary, once it has one. */
function builderFigures(
  builder: ContextBuilder,
  artifacts: readonly ArtifactDto[],
) {
  switch (builder) {
    case "graphify": {
      const summary = summaryOf(
        artifacts,
        ["graph_json"],
        graphifySummarySchema,
      );
      return summary === null
        ? undefined
        : [
            { label: "nodes", value: summary.nodes },
            { label: "edges", value: summary.edges },
            { label: "unresolved", value: summary.unresolved },
          ];
    }
    case "dependency_cruiser": {
      const summary = summaryOf(
        artifacts,
        ["manifest", "dependency_graph"],
        dependencyCruiserSummarySchema,
      );
      return summary === null
        ? undefined
        : [
            { label: "modules", value: summary.counts.modules },
            { label: "dependencies", value: summary.counts.dependencies },
            { label: "cycles", value: summary.counts.circular },
          ];
    }
    case "deepwiki": {
      const summary = summaryOf(
        artifacts,
        ["wiki_structure", "manifest"],
        deepwikiSummarySchema,
      );
      return summary === null
        ? undefined
        : [{ label: "pages", value: summary.pages.length }];
    }
    case "abstractions": {
      const summary = summaryOf(
        artifacts,
        ["manifest", "abstraction_index"],
        abstractionsSummarySchema,
      );
      return summary === null
        ? undefined
        : [
            { label: "modules", value: summary.counts.modules },
            { label: "exports", value: summary.counts.exports },
            { label: "typed", value: summary.coverage.typed },
          ];
    }
    case "data_model": {
      const summary = summaryOf(
        artifacts,
        ["manifest", "data_model"],
        dataModelSummarySchema,
      );
      return summary === null
        ? undefined
        : [
            { label: "entities", value: summary.counts.entities },
            { label: "relations", value: summary.counts.relations },
            { label: "accessors", value: summary.counts.accessors },
          ];
    }
  }
}

/** A time as a short date: `Oct 6, 12:55 PM`. */
function shortDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
