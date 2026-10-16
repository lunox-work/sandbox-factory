import type { ArtifactDto } from "@sandbox-factory/shared";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { analysisTopic, useObservation, terminalRun } from "../../data/observe";
import type { AnalysisRunDto } from "@sandbox-factory/shared";

/** The runs of a list still going, each as its changes are pushed. */
const runningTopics = (
  _id: string,
  runs: readonly AnalysisRunDto[] | undefined,
) =>
  (runs ?? [])
    .filter((run) => !terminalRun(run))
    .map((run) => analysisTopic(run.id));
import { clients, queryKeys, useUserId } from "../../data/query";
/**
 * A repository's snapshots and runs, the runs watched until all finish;
 * the snapshots too while `watchSnapshots`, as when a pull is landing.
 */
export function useAnalysisResources(
  owner: string,
  repoId: string,
  {
    watchSnapshots = false,
    snapshotId = "",
  }: {
    watchSnapshots?: boolean;
    /** The snapshot whose builds the page shows; none while it is unknown. */
    snapshotId?: string;
  } = {},
) {
  const userId = useUserId();
  const cache = useQueryClient();
  const snapshots = useQuery({
    queryKey: queryKeys.resource(userId, owner, "snapshots", repoId),
    queryFn: ({ signal }) => clients.analysis.snapshots(owner, repoId, signal),
    // Not after a failure: errors stop tracking until a deliberate retry.
    refetchInterval: (query) =>
      watchSnapshots && query.state.error === null ? 2000 : false,
  });
  const history = useObservation({
    owner,
    resource: "analysis-history",
    id: repoId,
    read: (id, signal) => clients.analysis.runs(owner, id, signal),
    terminal: (runs) => runs.every(terminalRun),
    interval: 2000,
    topics: runningTopics,
  });
  /*
    The chosen snapshot's runs, read on their own. The history above is the
    repository's newest, a bounded page across every snapshot and tool, so
    on a busy repository a builder's run on this snapshot fell off it and
    read as never built.
  */
  const onSnapshot = useObservation({
    owner,
    resource: "analysis-snapshot-runs",
    id: snapshotId === "" ? null : `${repoId}:${snapshotId}`,
    /*
      With each builder's artifacts, kept where `useRunArtifacts` reads
      them, so the context is read in this one request rather than after
      it, a request per builder.
    */
    read: async (_id, signal) => {
      const { runs, artifacts } =
        await clients.analysis.snapshotRunsWithArtifacts(
          owner,
          repoId,
          snapshotId,
          signal,
        );
      for (const [runId, list] of Object.entries(artifacts))
        cache.setQueryData(
          queryKeys.resource(userId, owner, "analysis-artifacts", runId),
          list,
        );
      return runs;
    },
    terminal: (runs) => runs.every(terminalRun),
    interval: 2000,
    topics: runningTopics,
  });
  const refresh = useCallback(async () => {
    await Promise.all(
      ["analysis-history", "analysis-snapshot-runs"].map((resource) =>
        cache.invalidateQueries({
          queryKey: queryKeys.resource(userId, owner, resource),
        }),
      ),
    );
  }, [cache, userId, owner]);
  const retry = () => {
    void snapshots.refetch();
    void history.refetch();
    void onSnapshot.refetch();
  };
  return {
    snapshots,
    runs: history.data ?? [],
    snapshotRuns: onSnapshot.data ?? [],
    error: snapshots.error ?? history.error ?? onSnapshot.error,
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
 * missing from `artifacts`; one whose read failed is in `failed`, read again
 * by `retry` — it is not left reading forever.
 */
export function useRunArtifacts(
  owner: string,
  runIds: readonly string[],
): {
  artifacts: ReadonlyMap<string, readonly ArtifactDto[]>;
  failed: ReadonlySet<string>;
  retry: () => void;
} {
  const userId = useUserId();
  return useQueries({
    queries: runIds.map((id) => ({
      queryKey: queryKeys.resource(userId, owner, "analysis-artifacts", id),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        clients.analysis.artifacts(owner, id, signal),
    })),
    combine: (results) => ({
      artifacts: new Map(
        results.flatMap(({ data }, index) => {
          const id = runIds[index];
          return data === undefined || id === undefined ? [] : [[id, data]];
        }),
      ),
      failed: new Set(
        results.flatMap(({ isError }, index) => {
          const id = runIds[index];
          return isError && id !== undefined ? [id] : [];
        }),
      ),
      retry: () => {
        for (const result of results) if (result.isError) void result.refetch();
      },
    }),
  });
}
