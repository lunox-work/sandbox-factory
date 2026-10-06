import type { ArtifactDto } from "@sandbox-factory/shared";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useObservation, terminalRun } from "../../data/observe";
import { clients, queryKeys, useUserId } from "../../data/query";
/**
 * A repository's snapshots and runs, the runs watched until all finish;
 * the snapshots too while `watchSnapshots`, as when a pull is landing.
 */
export function useAnalysisResources(
  owner: string,
  repoId: string,
  { watchSnapshots = false }: { watchSnapshots?: boolean } = {},
) {
  const userId = useUserId();
  const cache = useQueryClient();
  const snapshots = useQuery({
    queryKey: queryKeys.resource(userId, owner, "snapshots", repoId),
    queryFn: ({ signal }) => clients.analysis.snapshots(owner, repoId, signal),
    refetchInterval: watchSnapshots ? 2000 : false,
  });
  const history = useObservation({
    owner,
    resource: "analysis-history",
    id: repoId,
    read: (id, signal) => clients.analysis.runs(owner, id, signal),
    terminal: (runs) => runs.every(terminalRun),
    interval: 2000,
  });
  const refresh = useCallback(() => {
    void cache.invalidateQueries({
      queryKey: queryKeys.resource(userId, owner, "analysis-history", repoId),
    });
  }, [cache, userId, owner, repoId]);
  const retry = () => {
    void snapshots.refetch();
    void history.refetch();
  };
  return {
    snapshots,
    runs: history.data ?? [],
    error: snapshots.error ?? history.error,
    loading: snapshots.isPending || history.isPending,
    refresh,
    retry,
  };
}

/** A repository's branches, each at its head, read from GitHub. */
export function useRepoBranches(owner: string, repoId: string) {
  const userId = useUserId();
  return useQuery({
    queryKey: queryKeys.resource(userId, owner, "branches", repoId),
    queryFn: ({ signal }) => clients.analysis.branches(owner, repoId, signal),
    // A branch moves without telling this page; a minute old is fresh
    // enough to choose by, and a pull reads the head itself.
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

/**
 * The artifacts of each of `runIds`, keyed as the selected run's are, so a
 * run read for one is not read again for the other. A run not yet read is
 * missing from the map.
 */
export function useRunArtifacts(
  owner: string,
  runIds: readonly string[],
): ReadonlyMap<string, readonly ArtifactDto[]> {
  const userId = useUserId();
  return useQueries({
    queries: runIds.map((id) => ({
      queryKey: queryKeys.resource(userId, owner, "analysis-artifacts", id),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        clients.analysis.artifacts(owner, id, signal),
    })),
    combine: (results) =>
      new Map(
        results.flatMap(({ data }, index) => {
          const id = runIds[index];
          return data === undefined || id === undefined ? [] : [[id, data]];
        }),
      ),
  });
}
