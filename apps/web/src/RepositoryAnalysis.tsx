import { GithubAnalysisClient, ApiError } from "@sandbox-factory/client";
import type {
  AnalysisRunDto,
  ArtifactDto,
  GithubRepoDto,
  RepoSnapshotDto,
} from "@sandbox-factory/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { PeekPanel } from "@/components/PeekPanel";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ErrorBanner, LoadingLine } from "@/components/Message";
const errorMessage = (error: unknown) =>
  error instanceof ApiError
    ? error.message
    : "Analysis could not be loaded. Try again.";
const errorLabels: Record<string, string> = {
  too_large: "This repository exceeds the source size limit.",
  too_many_files: "This repository has too many files.",
  source_unavailable:
    "The source commit could not be read. Check the GitHub connection.",
  tool_failed: "Graphify could not complete this analysis.",
  tool_timeout: "Analysis exceeded its time limit.",
  upload_failed: "Artifacts could not be saved.",
  worker_lost: "The worker stopped responding.",
  cancelled: "Analysis was interrupted.",
};
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
  const existing = runs.find((r) => r.snapshotId === snapshotId);
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
                    onChange={(event) => setSnapshotId(event.target.value)}
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
                      Graphify ·{" "}
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
