import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";
import { useObservation, terminalRun } from "../../data/observe";
import { clients, queryKeys, useUserId } from "../../data/query";
export function useAnalysisResources(
  owner: string,
  repoId: string,
  selected: string | null,
) {
  const userId = useUserId();
  const cache = useQueryClient();
  const snapshots = useQuery({
    queryKey: queryKeys.resource(userId, owner, "snapshots", repoId),
    queryFn: ({ signal }) => clients.analysis.snapshots(owner, repoId, signal),
  });
  const history = useObservation({
    owner,
    resource: "analysis-history",
    id: repoId,
    read: (id, signal) => clients.analysis.runs(owner, id, signal),
    terminal: (runs) => runs.every(terminalRun),
    interval: 2000,
  });
  const run = useObservation({
    owner,
    resource: "analysis-run",
    id: selected,
    read: (id, signal) => clients.analysis.run(owner, id, signal),
    terminal: terminalRun,
    interval: 2000,
  });
  const artifacts = useQuery({
    queryKey: queryKeys.resource(userId, owner, "analysis-artifacts", selected),
    enabled: selected !== null,
    queryFn: ({ signal }) =>
      clients.analysis.artifacts(owner, selected ?? "", signal),
  });
  useEffect(() => {
    if (run.data === undefined || !terminalRun(run.data)) return;
    void cache.invalidateQueries({
      queryKey: queryKeys.resource(
        userId,
        owner,
        "analysis-artifacts",
        run.data.id,
      ),
    });
  }, [cache, userId, owner, run.data]);
  const refresh = useCallback(() => {
    void cache.invalidateQueries({
      queryKey: queryKeys.resource(userId, owner, "analysis-history", repoId),
    });
  }, [cache, userId, owner, repoId]);
  const retry = () => {
    void snapshots.refetch();
    void history.refetch();
    if (selected !== null) void run.refetch();
  };
  const runs = history.data ?? [];
  return {
    snapshots,
    runs:
      run.data === undefined
        ? runs
        : [run.data, ...runs.filter((row) => row.id !== run.data.id)].sort(
            (a, b) =>
              Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
              b.id.localeCompare(a.id),
          ),
    artifacts,
    error: snapshots.error ?? history.error ?? run.error ?? artifacts.error,
    loading: snapshots.isPending || history.isPending,
    refresh,
    retry,
  };
}
