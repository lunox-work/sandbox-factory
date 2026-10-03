import { GithubAnalysisClient, ApiError } from "@sandbox-factory/client";
import type {
  AnalysisRunDto,
  ArtifactDto,
  GithubRepoDto,
  RepoSnapshotDto,
} from "@sandbox-factory/shared";
import {
  SLICE_BUDGET_LIMITS,
  fixtureSetSchema,
  scopeProposalSchema,
  sliceBoundarySummarySchema,
} from "@sandbox-factory/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { PeekPanel } from "@/components/PeekPanel";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ErrorBanner, LoadingLine } from "@/components/Message";
import {
  AgentProposalPicker,
  FixtureSetView,
  ScopeProposalView,
} from "./ScopeAgent";
import { SliceBoundary, SliceEntryPicker } from "./SliceBuilder";

/** A typed budget value, held inside the bounds the API accepts. */
function clamp(
  value: string,
  bounds: { readonly min: number; readonly max: number },
): number {
  const number = Math.trunc(Number(value));
  if (!Number.isFinite(number) || value.trim() === "") return bounds.min;
  return Math.min(bounds.max, Math.max(bounds.min, number));
}
const errorMessage = (error: unknown) =>
  error instanceof ApiError
    ? error.message
    : "Analysis could not be loaded. Try again.";
const errorLabels: Record<string, string> = {
  too_large: "This repository exceeds the source size limit.",
  too_many_files: "This repository has too many files.",
  source_unavailable:
    "The source commit could not be read. Check the GitHub connection.",
  graph_unavailable:
    "The structure analysis this slice needs did not succeed. Retry it, then slice again.",
  tool_failed: "The analysis tool could not complete this run.",
  tool_timeout: "Analysis exceeded its time limit.",
  upload_failed: "Artifacts could not be saved.",
  worker_lost: "The worker stopped responding.",
  cancelled: "Analysis was interrupted.",
  slice_unavailable: "The slice this run builds on is gone or changed.",
  evaluation_failed: "The evaluation job could not run.",
  agent_unavailable: "No agent model is configured on the worker.",
  agent_incomplete:
    "The agent stopped without an answer it could check. Try again.",
};
/** What a run in the history is, in the panel's words. */
function runLabel(run: AnalysisRunDto): string {
  switch (run.tool) {
    case "slice":
      return `Slice (${run.params.entryPoints.length} entry ${run.params.entryPoints.length === 1 ? "point" : "points"})`;
    case "scope":
      return "Scope suggestion";
    case "fixtures":
      return "Fake data";
    case "sandbox_build":
      return "Sandbox build";
    case "graphify":
      return "Graphify";
  }
}
export function RepositoryAnalysis({
  organizationId,
  repo,
  manageable,
  onClose,
}: {
  organizationId: string;
  repo: GithubRepoDto;
  manageable: boolean;
  onClose: () => void;
}) {
  const client = useMemo(() => new GithubAnalysisClient({ baseUrl: "" }), []);
  const [snapshots, setSnapshots] = useState<RepoSnapshotDto[]>([]);
  const [runs, setRuns] = useState<AnalysisRunDto[]>([]);
  const [snapshotId, setSnapshotId] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [artifacts, setArtifacts] = useState<ArtifactDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [artifactLoading, setArtifactLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [slicing, setSlicing] = useState(false);
  const [entryPoints, setEntryPoints] = useState<string[]>([]);
  const [budget, setBudget] = useState({ maxFiles: 40, maxDepth: 3 });
  const [includeInferred, setIncludeInferred] = useState(false);
  // Which agent's ticket picker is open, if any.
  const [agent, setAgent] = useState<"scope" | "fixtures" | null>(null);
  const selectedRef = useRef(selected);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const [snapshotResult, runResult] = await Promise.all([
          client.snapshots(organizationId, repo.id),
          client.runs(organizationId, repo.id),
        ]);
        if (!active) return;
        setSnapshots(snapshotResult);
        setRuns((current) => [
          ...runResult,
          ...current.filter(
            (run) =>
              run.id === selectedRef.current &&
              !runResult.some((item) => item.id === run.id),
          ),
        ]);
        setError(null);
        setSnapshotId(
          (current) =>
            current ||
            snapshotResult.find((s) => s.commitSha === repo.headSha)?.id ||
            snapshotResult[0]?.id ||
            "",
        );
        setSelected((current) => current ?? runResult[0]?.id ?? null);
        if (
          runResult.some((r) => r.status === "queued" || r.status === "running")
        )
          timer = setTimeout(() => {
            void load();
          }, 2000);
      } catch (error) {
        if (active) setError(errorMessage(error));
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [client, organizationId, repo.id, repo.headSha, refresh]);
  const selectedRun = runs.find((r) => r.id === selected);
  // An idempotent enqueue can return an active run older than the history page.
  useEffect(() => {
    if (
      selected === null ||
      (selectedRun !== undefined &&
        selectedRun.status !== "queued" &&
        selectedRun.status !== "running")
    )
      return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const run = await client.run(organizationId, selected);
        if (!active) return;
        setRuns((current) =>
          [run, ...current.filter((item) => item.id !== run.id)].sort(
            (a, b) =>
              Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
              b.id.localeCompare(a.id),
          ),
        );
        if (run.status === "queued" || run.status === "running")
          timer = setTimeout(() => {
            void load();
          }, 2000);
      } catch (error) {
        if (active) setError(errorMessage(error));
      }
    };
    void load();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [client, organizationId, selected, selectedRun?.status]);
  useEffect(() => {
    let active = true;
    setArtifacts([]);
    if (selected === null) return;
    setArtifactLoading(true);
    void client
      .artifacts(organizationId, selected)
      .then((result) => {
        if (active) setArtifacts(result);
      })
      .catch((error) => {
        if (active) setError(errorMessage(error));
      })
      .finally(() => {
        if (active) setArtifactLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, organizationId, selected, selectedRun?.status]);
  const current = snapshots.find((s) => s.id === snapshotId);
  const existing = runs.find(
    (r) => r.snapshotId === snapshotId && r.tool === "graphify",
  );
  const busy = existing?.status === "queued" || existing?.status === "running";
  const exhausted =
    existing?.status === "failed" && existing.attempt >= existing.maxAttempts;
  async function start() {
    setPending(true);
    setError(null);
    try {
      const result = await client.enqueue(organizationId, repo.id, {
        tool: "graphify",
        snapshotId,
      });
      setSelected(result.id);
      setRefresh((r) => r + 1);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setPending(false);
    }
  }
  async function slice() {
    setPending(true);
    setError(null);
    try {
      const result = await client.enqueueSlice(organizationId, repo.id, {
        snapshotId,
        entryPoints,
        budget,
        includeInferred,
      });
      setSelected(result.run.id);
      setSlicing(false);
      setRefresh((r) => r + 1);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setPending(false);
    }
  }
  async function suggest(proposalId: string) {
    setPending(true);
    setError(null);
    try {
      const result = await client.enqueueScope(organizationId, repo.id, {
        proposalId,
        snapshotId,
      });
      setSelected(result.run.id);
      setAgent(null);
      setRefresh((r) => r + 1);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setPending(false);
    }
  }
  async function writeFixtures(sliceRunId: string, proposalId: string) {
    setPending(true);
    setError(null);
    try {
      const run = await client.enqueueFixtures(organizationId, sliceRunId, {
        proposalId,
      });
      setSelected(run.id);
      setAgent(null);
      setRefresh((r) => r + 1);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setPending(false);
    }
  }
  const scopeProposal = useMemo(() => {
    const found = artifacts.find((a) => a.kind === "scope_proposal");
    if (found === undefined || found.meta === null) return null;
    const parsed = scopeProposalSchema.safeParse(found.meta);
    return parsed.success ? parsed.data : null;
  }, [artifacts]);
  const fixtureSet = useMemo(() => {
    const found = artifacts.find((a) => a.kind === "fixture_set");
    if (found === undefined || found.meta === null) return null;
    const parsed = fixtureSetSchema.safeParse(found.meta);
    return parsed.success ? parsed.data : null;
  }, [artifacts]);
  /** Hands a scope proposal to the picker, for a person to review and slice. */
  function applyScope(snapshot: string) {
    if (scopeProposal === null) return;
    setSnapshotId(snapshot);
    setEntryPoints(
      [...new Set(scopeProposal.entryPoints.map((entry) => entry.path))].sort(),
    );
    setBudget(scopeProposal.budget);
    setIncludeInferred(scopeProposal.includeInferred);
    setAgent(null);
    setSlicing(true);
  }
  const boundary = useMemo(() => {
    const contract = artifacts.find((a) => a.kind === "boundary_contract");
    if (contract === undefined || contract.meta === null) return null;
    const parsed = sliceBoundarySummarySchema.safeParse(contract.meta);
    return parsed.success ? parsed.data : null;
  }, [artifacts]);
  async function openArtifact(artifactId?: string) {
    const tab = window.open("about:blank", "_blank");
    if (tab !== null) tab.opener = null;
    try {
      const result =
        artifactId === undefined
          ? await client.logUrl(organizationId, selected!)
          : await client.artifactUrl(organizationId, artifactId);
      if (tab === null) {
        setError("Allow pop-ups to open this artifact, then try again.");
        return;
      }
      tab.location.href = result;
    } catch (error) {
      tab?.close();
      setError(errorMessage(error));
    }
  }
  return (
    <PeekPanel
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={repo.fullName}
      description="Repository snapshots and Graphify analysis"
    >
      <div className="space-y-6">
        {error !== null && <ErrorBanner>{error}</ErrorBanner>}
        {loading ? (
          <LoadingLine />
        ) : error !== null && snapshots.length === 0 ? null : (
          <section className="space-y-3">
            <h2 className="text-sm font-semibold">Source snapshot</h2>
            {snapshots.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                A source snapshot will appear after the repository syncs.
              </p>
            ) : (
              <>
                <label className="text-sm">
                  Commit{" "}
                  <select
                    aria-label="Source snapshot"
                    className="bg-background ml-2 rounded border p-2 font-mono text-xs"
                    value={snapshotId}
                    onChange={(event) => {
                      // Entry points name files of one snapshot.
                      setSnapshotId(event.target.value);
                      setEntryPoints([]);
                    }}
                  >
                    {snapshots.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.commitSha.slice(0, 7)} ·{" "}
                        {new Date(s.createdAt).toLocaleString()}
                      </option>
                    ))}
                  </select>
                </label>
                {current !== undefined && (
                  <p className="text-muted-foreground text-xs">
                    {current.fileCount.toLocaleString()} files ·{" "}
                    {(current.totalBytes / 1024).toFixed(1)} KiB
                    {current.treeTruncated ? " · Tree listing truncated" : ""}
                  </p>
                )}
                {manageable && (
                  <Button
                    size="sm"
                    onClick={() => {
                      void start();
                    }}
                    disabled={pending || busy || exhausted || snapshotId === ""}
                  >
                    {pending
                      ? "Starting…"
                      : busy
                        ? "Analysis in progress"
                        : exhausted
                          ? "Retry limit reached"
                          : existing?.status === "succeeded"
                            ? "View existing analysis"
                            : "Analyse now"}
                  </Button>
                )}
              </>
            )}
            <p className="text-muted-foreground text-xs">
              Graphify maps code structure and dependencies. Wiki pages describe
              the detected structure.
            </p>
          </section>
        )}
        {manageable && snapshotId !== "" && (
          <section className="space-y-3">
            <h2 className="text-sm font-semibold">Slice</h2>
            <p className="text-muted-foreground text-xs">
              Pick the files a task starts from. The slice reaches outward
              through imports inside a budget, stubs what it needs from outside,
              and lists what outside code needs from it. It waits for the
              structure analysis of the same commit.
            </p>
            {slicing ? (
              <>
                <SliceEntryPicker
                  client={client}
                  organizationId={organizationId}
                  snapshotId={snapshotId}
                  selected={entryPoints}
                  onChange={setEntryPoints}
                />
                <div className="flex flex-wrap items-end gap-3">
                  <label className="text-xs">
                    Max files
                    <Input
                      type="number"
                      min={SLICE_BUDGET_LIMITS.maxFiles.min}
                      max={SLICE_BUDGET_LIMITS.maxFiles.max}
                      className="mt-1 w-24"
                      value={budget.maxFiles}
                      onChange={(event) =>
                        setBudget((b) => ({
                          ...b,
                          maxFiles: clamp(
                            event.target.value,
                            SLICE_BUDGET_LIMITS.maxFiles,
                          ),
                        }))
                      }
                    />
                  </label>
                  <label className="text-xs">
                    Max depth
                    <Input
                      type="number"
                      min={SLICE_BUDGET_LIMITS.maxDepth.min}
                      max={SLICE_BUDGET_LIMITS.maxDepth.max}
                      className="mt-1 w-24"
                      value={budget.maxDepth}
                      onChange={(event) =>
                        setBudget((b) => ({
                          ...b,
                          maxDepth: clamp(
                            event.target.value,
                            SLICE_BUDGET_LIMITS.maxDepth,
                          ),
                        }))
                      }
                    />
                  </label>
                  {includeInferred && (
                    <span className="text-muted-foreground text-xs">
                      Follows inferred relations
                    </span>
                  )}
                  <Button
                    size="sm"
                    disabled={pending || entryPoints.length === 0}
                    onClick={() => {
                      void slice();
                    }}
                  >
                    {pending ? "Starting…" : "Slice now"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setSlicing(false)}
                  >
                    Cancel
                  </Button>
                </div>
              </>
            ) : agent === "scope" ? (
              <AgentProposalPicker
                client={client}
                organizationId={organizationId}
                repoId={repo.id}
                action="Suggest scope"
                pending={pending}
                onStart={(proposalId) => {
                  void suggest(proposalId);
                }}
                onCancel={() => setAgent(null)}
              />
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setIncludeInferred(false);
                    setSlicing(true);
                  }}
                >
                  Choose entry points
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setAgent("scope")}
                >
                  Suggest with agent
                </Button>
              </div>
            )}
            {!slicing && agent === "scope" && (
              <p className="text-muted-foreground text-xs">
                An agent reads this commit&rsquo;s source with the
                ticket&rsquo;s spec and proposes entry points that cut at the
                code&rsquo;s seams. Nothing is sliced until you review the
                proposal and slice it.
              </p>
            )}
          </section>
        )}
        <section className="space-y-3">
          <h2 className="text-sm font-semibold">Run history</h2>
          {!loading && error === null && runs.length === 0 && (
            <p className="text-muted-foreground text-sm">
              No analysis runs yet.
            </p>
          )}
          <ul className="space-y-2">
            {runs.map((run) => (
              <li key={run.id}>
                <button
                  className={`w-full rounded border p-3 text-left ${selected === run.id ? "bg-muted" : ""}`}
                  onClick={() => setSelected(run.id)}
                  aria-pressed={selected === run.id}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="text-sm">
                      {runLabel(run)} ·{" "}
                      {snapshots
                        .find((s) => s.id === run.snapshotId)
                        ?.commitSha.slice(0, 7) ?? "Snapshot"}
                    </span>
                    <Badge variant="outline">{run.status}</Badge>
                  </span>
                  <span className="text-muted-foreground mt-1 block text-xs">
                    Attempt {run.attempt + 1} ·{" "}
                    {new Date(run.createdAt).toLocaleString()}
                    {run.startedAt !== null && run.finishedAt !== null
                      ? ` · ${Math.max(0, Math.round((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000))}s`
                      : ""}
                  </span>
                  {run.errorCode !== null && (
                    <span className="mt-2 block text-xs">
                      {errorLabels[run.errorCode]} ({run.errorCode})
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </section>
        {selectedRun !== undefined && boundary !== null && (
          <section className="space-y-3">
            <h2 className="text-sm font-semibold">Boundary</h2>
            <SliceBoundary
              summary={boundary}
              artifacts={artifacts}
              onOpen={(id) => {
                void openArtifact(id);
              }}
            />
          </section>
        )}
        {selectedRun?.tool === "slice" &&
          selectedRun.status === "succeeded" &&
          manageable && (
            <section className="space-y-3">
              <h2 className="text-sm font-semibold">Fake data</h2>
              <p className="text-muted-foreground text-xs">
                An agent writes believable behaviour for this slice&rsquo;s
                mocked calls and a walkthrough that <code>npm run dev</code>{" "}
                runs, type-checked against the stubs.
              </p>
              {agent === "fixtures" ? (
                <AgentProposalPicker
                  client={client}
                  organizationId={organizationId}
                  repoId={repo.id}
                  action="Write fake data"
                  pending={pending}
                  onStart={(proposalId) => {
                    void writeFixtures(selectedRun.id, proposalId);
                  }}
                  onCancel={() => setAgent(null)}
                />
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setAgent("fixtures")}
                >
                  Write fake data
                </Button>
              )}
            </section>
          )}
        {selectedRun !== undefined && scopeProposal !== null && (
          <section className="space-y-3">
            <h2 className="text-sm font-semibold">Scope suggestion</h2>
            <ScopeProposalView
              proposal={scopeProposal}
              manageable={manageable}
              onUse={() => applyScope(selectedRun.snapshotId)}
            />
          </section>
        )}
        {selectedRun !== undefined && fixtureSet !== null && (
          <section className="space-y-3">
            <h2 className="text-sm font-semibold">Fake data</h2>
            <FixtureSetView set={fixtureSet} />
          </section>
        )}
        {selectedRun !== undefined && (
          <section className="space-y-3">
            <h2 className="text-sm font-semibold">Artifacts</h2>
            {artifactLoading ? (
              <LoadingLine />
            ) : artifacts.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                {selectedRun.status === "succeeded"
                  ? "No artifacts are available."
                  : "Artifacts appear when analysis succeeds."}
              </p>
            ) : (
              <ul className="divide-y">
                {artifacts.map((a) => (
                  <li className="py-3" key={a.id}>
                    <Button
                      variant="link"
                      className="h-auto p-0"
                      onClick={() => {
                        void openArtifact(a.id);
                      }}
                    >
                      {a.path}
                    </Button>
                    <p className="text-muted-foreground mt-1 text-xs">
                      {(a.sizeBytes / 1024).toFixed(1)} KiB · SHA-256{" "}
                      <span className="break-all font-mono" title={a.sha256}>
                        {a.sha256}
                      </span>
                    </p>
                  </li>
                ))}
              </ul>
            )}
            {manageable && selectedRun.status !== "queued" && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  void openArtifact();
                }}
              >
                Open run log
              </Button>
            )}
          </section>
        )}
      </div>
    </PeekPanel>
  );
}
