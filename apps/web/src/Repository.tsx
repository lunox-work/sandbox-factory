/**
 * One registered repository, as a page of its own: `/o/:slug/repositories/:id`.
 *
 * Stacked blocks, top to bottom: what the repository is, the snapshot the
 * rest of the page is about, the stack detected in it, the context
 * builders and where each stands on that snapshot, the result of the run
 * that is selected, and every run there has been. The builders are the
 * page's reason to exist: each reads a snapshot on its own and describes
 * it for people and agents, and this is where they are started and read.
 *
 * Slices, scope suggestions and fake data are no longer made here — a
 * bounty makes them — but their runs are still in the history, so their
 * read-only views stay for the run that is selected.
 *
 * Roles come from the API, which checks them again on every write; hiding
 * a control the API would refuse is courtesy, not security. Only an owner
 * or admin starts runs or reads logs; any member opens artifacts.
 */

import type { AnalysisRunDto, GithubRepoDto } from "@sandbox-factory/shared";
import {
  abstractionsSummarySchema,
  dataModelSummarySchema,
  deepwikiSummarySchema,
  dependencyCruiserSummarySchema,
  fixtureSetSchema,
  graphifySummarySchema,
  scopeProposalSchema,
  sliceBoundarySummarySchema,
} from "@sandbox-factory/shared";
import {
  ExternalLink,
  FolderGit2,
  Lock,
  ScrollText,
  Trash2,
} from "lucide-react";
import {
  CONTEXT_BUILDERS,
  rankAtLeast,
  type ContextBuilder,
} from "sandbox-factory";
import { useEffect, useMemo, useState } from "react";

import { Combobox } from "@/components/Combobox";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ErrorBanner, LoadingLine } from "@/components/Message";
import { StackChips } from "@/components/StackPicker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { clients } from "./data/query";
import {
  FixtureSetView,
  ScopeProposalView,
} from "./features/analysis/AgentViews";
import { AbstractionsResult } from "./features/analysis/AbstractionsResult";
import { Block, StatusBadge } from "./features/analysis/Blocks";
import { BuilderCard } from "./features/analysis/BuilderCard";
import { DataModelResult } from "./features/analysis/DataModelResult";
import { DeepwikiResult } from "./features/analysis/DeepwikiResult";
import { DependencyResult } from "./features/analysis/DependencyResult";
import { GraphifyResult } from "./features/analysis/GraphifyResult";
import { SliceBoundary } from "./features/analysis/SliceBoundary";
import { summaryOf } from "./features/analysis/artifacts";
import {
  errorLabels,
  errorMessage,
  runDuration,
  runLabel,
  shortSha,
} from "./features/analysis/labels";
import { useAnalysisResources } from "./features/analysis/queries";
import { REMOVE_REPOSITORY_WARNING } from "./Github";
import { isPlainLeftClick, pathForScreen } from "./routes";
import { useGithubRepos } from "./useGithub";

/** Roles that may start runs, read logs and remove, matching the API's floor. */
function canManage(role: string): boolean {
  return rankAtLeast(role, "admin");
}

const PAGE_CLASS =
  "mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-10 sm:px-6 sm:py-14";

/**
 * Where each builder's card sits in a six-column grid: the three that
 * describe a snapshot for people share the first row, and the two that
 * read Graphify's map for the pipeline share the second, each half wide.
 * Two columns below `lg`, where the last card takes a row of its own.
 */
const BUILDER_SPANS: Record<ContextBuilder, string> = {
  graphify: "lg:col-span-2",
  dependency_cruiser: "lg:col-span-2",
  deepwiki: "lg:col-span-2",
  abstractions: "lg:col-span-3",
  data_model: "sm:col-span-2 lg:col-span-3",
};

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
          <ErrorBanner className="mt-0">{repos.error}</ErrorBanner>
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
    />
  );
}

function RepositoryView({
  organizationId,
  repo,
  manageable,
  onRemove,
  onRemoved,
}: {
  organizationId: string;
  repo: GithubRepoDto;
  manageable: boolean;
  onRemove: () => Promise<{ ok: true } | { ok: false; error: string }>;
  onRemoved: () => void;
}) {
  const client = clients.analysis;
  const [snapshotId, setSnapshotId] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The builder whose run was just asked for, until the API answers. */
  const [pending, setPending] = useState<ContextBuilder | null>(null);
  const [removing, setRemoving] = useState(false);
  const resources = useAnalysisResources(organizationId, repo.id, selected);
  const snapshots = resources.snapshots.data ?? [];
  const runs = resources.runs;
  const artifacts = resources.artifacts.data ?? [];
  const loading = resources.loading;
  const artifactLoading = selected !== null && resources.artifacts.isPending;
  const selectedRun = runs.find((run) => run.id === selected);

  // The snapshot at the head, or the newest, until one is chosen; the
  // newest run, until one is selected.
  useEffect(() => {
    if (snapshots.length > 0)
      setSnapshotId(
        (current) =>
          current ||
          snapshots.find((s) => s.commitSha === repo.headSha)?.id ||
          snapshots[0]?.id ||
          "",
      );
    if (runs.length > 0)
      setSelected((current) => current ?? runs[0]?.id ?? null);
  }, [resources.snapshots.data, resources.runs, repo.headSha]);

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
    runs.find((run) => run.snapshotId === snapshotId && run.tool === builder);

  async function build(builder: ContextBuilder) {
    setPending(builder);
    setError(null);
    try {
      const result = await client.enqueue(organizationId, repo.id, {
        tool: builder,
        snapshotId,
      });
      setSelected(result.id);
      resources.refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(null);
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
        setError("Allow pop-ups to open this artifact, then try again.");
        return;
      }
      tab.location.href = url;
    } catch (cause) {
      tab?.close();
      setError(errorMessage(cause));
    }
  }
  const open = (artifactId: string) => {
    void openArtifact({ artifactId });
  };

  const graphify = useMemo(
    () => summaryOf(artifacts, ["graph_json"], graphifySummarySchema),
    [artifacts],
  );
  const dependency = useMemo(
    () =>
      summaryOf(
        artifacts,
        ["manifest", "dependency_graph"],
        dependencyCruiserSummarySchema,
      ),
    [artifacts],
  );
  const deepwiki = useMemo(
    () =>
      summaryOf(
        artifacts,
        ["wiki_structure", "manifest"],
        deepwikiSummarySchema,
      ),
    [artifacts],
  );
  const abstractions = useMemo(
    () =>
      summaryOf(
        artifacts,
        ["manifest", "abstraction_index"],
        abstractionsSummarySchema,
      ),
    [artifacts],
  );
  const dataModel = useMemo(
    () =>
      summaryOf(artifacts, ["manifest", "data_model"], dataModelSummarySchema),
    [artifacts],
  );
  const boundary = useMemo(
    () =>
      summaryOf(artifacts, ["boundary_contract"], sliceBoundarySummarySchema),
    [artifacts],
  );
  const scopeProposal = useMemo(
    () => summaryOf(artifacts, ["scope_proposal"], scopeProposalSchema),
    [artifacts],
  );
  const fixtureSet = useMemo(
    () => summaryOf(artifacts, ["fixture_set"], fixtureSetSchema),
    [artifacts],
  );

  /**
   * The figures a builder's card shows, known only for the selected run:
   * they come from its artifacts, which are read for that run alone.
   */
  function figuresFor(
    builder: ContextBuilder,
    run: AnalysisRunDto | undefined,
  ) {
    if (run === undefined || run.id !== selected || run.status !== "succeeded")
      return undefined;
    switch (builder) {
      case "graphify":
        return graphify === null
          ? undefined
          : [
              { label: "nodes", value: graphify.nodes },
              { label: "edges", value: graphify.edges },
              { label: "unresolved", value: graphify.unresolved },
            ];
      case "dependency_cruiser":
        return dependency === null
          ? undefined
          : [
              { label: "modules", value: dependency.counts.modules },
              { label: "dependencies", value: dependency.counts.dependencies },
              { label: "cycles", value: dependency.counts.circular },
            ];
      case "deepwiki":
        return deepwiki === null
          ? undefined
          : [{ label: "pages", value: deepwiki.pages.length }];
      case "abstractions":
        return abstractions === null
          ? undefined
          : [
              { label: "modules", value: abstractions.counts.modules },
              { label: "exports", value: abstractions.counts.exports },
              { label: "typed", value: abstractions.coverage.typed },
            ];
      case "data_model":
        return dataModel === null
          ? undefined
          : [
              { label: "entities", value: dataModel.counts.entities },
              { label: "relations", value: dataModel.counts.relations },
              { label: "accessors", value: dataModel.counts.accessors },
            ];
    }
  }

  const result =
    selectedRun === undefined ? null : (
      <>
        {selectedRun.tool === "graphify" &&
          selectedRun.status === "succeeded" && (
            <GraphifyResult artifacts={artifacts} onOpen={open} />
          )}
        {selectedRun.tool === "dependency_cruiser" && dependency !== null && (
          <DependencyResult
            summary={dependency}
            artifacts={artifacts}
            onOpen={open}
          />
        )}
        {selectedRun.tool === "deepwiki" && deepwiki !== null && (
          <DeepwikiResult
            summary={deepwiki}
            artifacts={artifacts}
            onOpen={open}
          />
        )}
        {selectedRun.tool === "abstractions" && abstractions !== null && (
          <AbstractionsResult
            summary={abstractions}
            artifacts={artifacts}
            onOpen={open}
          />
        )}
        {selectedRun.tool === "data_model" && dataModel !== null && (
          <DataModelResult
            summary={dataModel}
            artifacts={artifacts}
            onOpen={open}
          />
        )}
        {boundary !== null && (
          <SliceBoundary
            summary={boundary}
            artifacts={artifacts}
            onOpen={open}
          />
        )}
        {scopeProposal !== null && (
          <ScopeProposalView proposal={scopeProposal} />
        )}
        {fixtureSet !== null && <FixtureSetView set={fixtureSet} />}
      </>
    );

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
      {(error ?? trackingError) !== null && (
        <ErrorBanner className="mt-0 flex flex-wrap items-center gap-3">
          <span>{error ?? trackingError}</span>
          <button
            type="button"
            className="underline underline-offset-2"
            onClick={resources.retry}
          >
            Try again
          </button>
        </ErrorBanner>
      )}

      <Block
        title="Snapshot"
        description="The commit the builders below read. A snapshot is taken as the default branch moves."
      >
        {loading ? (
          <LoadingLine />
        ) : snapshots.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            A source snapshot will appear after the repository syncs.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              Commit
              <Combobox
                label="Source snapshot"
                searchPlaceholder="Search by commit or date…"
                className="w-auto max-w-full font-mono"
                options={snapshots.map((s) => ({
                  value: s.id,
                  label: `${shortSha(s.commitSha)} · ${new Date(s.createdAt).toLocaleString()}`,
                  keywords: [s.commitSha],
                }))}
                value={snapshotId}
                onValueChange={setSnapshotId}
              />
            </div>
            {current !== undefined && (
              <p className="text-muted-foreground text-xs">
                {current.fileCount.toLocaleString()} files ·{" "}
                {(current.totalBytes / 1024).toFixed(1)} KiB
                {current.treeTruncated ? " · Tree listing truncated" : ""}
              </p>
            )}
          </div>
        )}
      </Block>

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
        description="Each reads the chosen snapshot on its own and describes it for people and agents. A build on a snapshot is kept, so asking again shows the one there is."
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
          {CONTEXT_BUILDERS.map((builder) => {
            const run = builderRun(builder);
            return (
              <BuilderCard
                key={builder}
                className={BUILDER_SPANS[builder]}
                builder={builder}
                run={run}
                manageable={manageable}
                pending={pending === builder}
                disabled={pending !== null || snapshotId === ""}
                figures={figuresFor(builder, run)}
                onBuild={() => {
                  void build(builder);
                }}
                onView={() => {
                  if (run !== undefined) setSelected(run.id);
                }}
              />
            );
          })}
        </div>
      </Block>

      {selectedRun !== undefined && (
        <Block
          title={
            <>
              <span>{runLabel(selectedRun)}</span>
              <StatusBadge status={selectedRun.status} />
            </>
          }
          description={
            <>
              Attempt {selectedRun.attempt + 1} of {selectedRun.maxAttempts} ·{" "}
              {new Date(selectedRun.createdAt).toLocaleString()}
              {runDuration(selectedRun) === null
                ? ""
                : ` · ${runDuration(selectedRun)}`}
              {" · "}
              <span className="font-mono">{commitOf(selectedRun)}</span>
            </>
          }
          aside={
            manageable &&
            selectedRun.status !== "queued" && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  void openArtifact({ runId: selectedRun.id });
                }}
              >
                <ScrollText />
                Open run log
              </Button>
            )
          }
        >
          {selectedRun.errorCode !== null && (
            <p className="text-destructive text-sm">
              {errorLabels[selectedRun.errorCode]}{" "}
              <span className="text-muted-foreground">
                ({selectedRun.errorCode})
              </span>
            </p>
          )}
          {artifactLoading ? <LoadingLine /> : result}
          <div className="flex flex-col gap-2">
            <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              Artifacts
            </h3>
            {artifactLoading ? null : artifacts.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                {selectedRun.status === "succeeded"
                  ? "No artifacts are available."
                  : "Artifacts appear when the run succeeds."}
              </p>
            ) : (
              <ul className="divide-y">
                {artifacts.map((artifact) => (
                  <li
                    className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-2"
                    key={artifact.id}
                  >
                    <Button
                      variant="link"
                      className="h-auto p-0 font-mono text-xs"
                      onClick={() => open(artifact.id)}
                    >
                      {artifact.path}
                    </Button>
                    <span className="text-muted-foreground text-xs">
                      {(artifact.sizeBytes / 1024).toFixed(1)} KiB · SHA-256{" "}
                      <span className="font-mono" title={artifact.sha256}>
                        {artifact.sha256.slice(0, 12)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Block>
      )}

      <Block
        title="Run history"
        description="Every run on this repository, newest first. Select one to read it above."
      >
        {loading ? (
          <LoadingLine />
        ) : runs.length === 0 ? (
          error === null && trackingError === null ? (
            <p className="text-muted-foreground text-sm">No runs yet.</p>
          ) : null
        ) : (
          <ul className="flex flex-col gap-2">
            {runs.map((run) => (
              <li key={run.id}>
                <button
                  type="button"
                  className={`hover:bg-muted/60 focus-visible:ring-ring/50 flex w-full flex-col gap-1 rounded-[6px] border p-3 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none ${
                    selected === run.id
                      ? "bg-muted/60 border-foreground/20"
                      : ""
                  }`}
                  onClick={() => setSelected(run.id)}
                  aria-pressed={selected === run.id}
                >
                  <span className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-2 text-sm">
                      <span className="font-medium">{runLabel(run)}</span>
                      <span className="text-muted-foreground font-mono text-xs">
                        {commitOf(run)}
                      </span>
                    </span>
                    <StatusBadge status={run.status} />
                  </span>
                  <span className="text-muted-foreground text-xs">
                    Attempt {run.attempt + 1} ·{" "}
                    {new Date(run.createdAt).toLocaleString()}
                    {runDuration(run) === null ? "" : ` · ${runDuration(run)}`}
                  </span>
                  {run.errorCode !== null && (
                    <span className="text-destructive text-xs">
                      {errorLabels[run.errorCode]}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Block>

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
