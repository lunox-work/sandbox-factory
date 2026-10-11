/**
 * A repository's first build, run where it was registered. A bounty's
 * scope reads a repository only at a commit it was built at, so a
 * repository is not set up until its first snapshot has every context
 * builder run on it (`snapshotBuilt` in core). Registering takes the
 * snapshot in the background; this waits for it, starts "Build all" on it,
 * and follows the runs until the snapshot is built or its map fails. A
 * build no worker takes up, or one that runs past its time, lets the
 * dialog go too: it goes on on the server, and its page shows how far.
 *
 * One repository builds at a time, in the order asked: a set is admitted
 * against the organization's active-run cap whole, so a second set started
 * beside the first would be refused, and is waited for instead.
 */

import { ApiError } from "@sandbox-factory/client";
import type { AnalysisRunDto } from "@sandbox-factory/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CONTEXT_BUILDERS,
  snapshotBuilt,
  type ContextBuilder,
} from "sandbox-factory";

import { clients } from "../../data/query";
import { observationDelay } from "../../data/observe";
import { errorLabels } from "./labels";

/** How often the snapshot, and then the runs, are asked about. */
const SNAPSHOT_POLL_MS = 2_000;
const RUN_POLL_MS = 3_000;
/** How often a set the run cap refused is offered again. */
const CAP_RETRY_MS = 5_000;
/** How long registering's snapshot is waited for before giving up. */
const SNAPSHOT_WAIT_MS = 3 * 60_000;
/** How long a build may sit with no builder started, as with no worker. */
const START_WAIT_MS = 5 * 60_000;
/** How long a build is followed in all before the dialog lets go. */
const BUILD_WAIT_MS = 30 * 60_000;

export type RepositoryBuild =
  | { readonly phase: "waiting" }
  | { readonly phase: "reading" }
  | {
      readonly phase: "building" | "built";
      readonly commitSha: string;
      /** Each builder's newest run on the snapshot, once there is one. */
      readonly runs: Partial<Record<ContextBuilder, AnalysisRunDto>>;
      /** Another set holds the run cap; this one is offered again. */
      readonly held: boolean;
    }
  | { readonly phase: "failed"; readonly error: string };

/** Whether a build still holds the dialog open. */
export const buildBusy = (build: RepositoryBuild | undefined) =>
  build !== undefined && build.phase !== "built" && build.phase !== "failed";

function newestByBuilder(
  runs: readonly AnalysisRunDto[],
): Partial<Record<ContextBuilder, AnalysisRunDto>> {
  const found: Partial<Record<ContextBuilder, AnalysisRunDto>> = {};
  // Newest first, so the first of each is the one that counts now.
  for (const run of runs) {
    const tool = CONTEXT_BUILDERS.find((builder) => builder === run.tool);
    if (tool !== undefined && found[tool] === undefined) found[tool] = run;
  }
  return found;
}

/** Thrown to end a build with what to tell the person. */
class BuildFailure extends Error {}

async function buildRepository(
  organizationId: string,
  repoId: string,
  signal: AbortSignal,
  report: (build: RepositoryBuild) => void,
): Promise<void> {
  report({ phase: "reading" });
  const deadline = Date.now() + SNAPSHOT_WAIT_MS;
  let snapshot: { id: string; commitSha: string } | undefined;
  for (;;) {
    [snapshot] = await clients.analysis.snapshots(
      organizationId,
      repoId,
      signal,
    );
    if (snapshot !== undefined) break;
    if (Date.now() > deadline)
      throw new BuildFailure(
        "Its file list has not been read yet. Build it from its page once it has.",
      );
    await observationDelay(SNAPSHOT_POLL_MS, signal);
  }
  const { id: snapshotId, commitSha } = snapshot;
  let held = false;
  for (;;) {
    try {
      await clients.analysis.buildAll(organizationId, repoId, { snapshotId });
      break;
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "run_limit")
        throw error;
      held = true;
      report({ phase: "building", commitSha, runs: {}, held });
      await observationDelay(CAP_RETRY_MS, signal);
    }
  }
  const admitted = Date.now();
  for (;;) {
    const runs = await clients.analysis.runs(
      organizationId,
      repoId,
      signal,
      snapshotId,
    );
    const newest = newestByBuilder(runs);
    // Every run, as the server reads them: an earlier map that succeeded
    // still counts when a later one did not.
    if (snapshotBuilt(runs)) {
      report({ phase: "built", commitSha, runs: newest, held: false });
      return;
    }
    const graph = newest.graphify;
    if (
      graph?.status === "failed" &&
      !runs.some((run) => run.tool === "graphify" && run.status === "succeeded")
    )
      throw new BuildFailure(
        graph.errorCode === null
          ? "Its map could not be built."
          : errorLabels[graph.errorCode],
      );
    const waited = Date.now() - admitted;
    if (
      waited > START_WAIT_MS &&
      Object.values(newest).every((run) => run.status === "queued")
    )
      throw new BuildFailure(
        "No builder has started it yet. It stays queued; its page shows when it runs.",
      );
    if (waited > BUILD_WAIT_MS)
      throw new BuildFailure(
        "It is taking a while. It goes on building; its page shows how far it has got.",
      );
    report({ phase: "building", commitSha, runs: newest, held: false });
    await observationDelay(RUN_POLL_MS, signal);
  }
}

/**
 * Builds asked for in one place, by repository id, until it unmounts.
 * `start` queues a repository; one already asked for is not asked again,
 * until `retry`.
 */
export function useRepositoryBuilds(organizationId: string) {
  const [builds, setBuilds] = useState<ReadonlyMap<string, RepositoryBuild>>(
    () => new Map(),
  );
  const queue = useRef<string[]>([]);
  const asked = useRef(new Set<string>());
  const running = useRef(false);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    const own = new AbortController();
    controller.current = own;
    return () => own.abort();
  }, []);

  const report = useCallback((repoId: string, build: RepositoryBuild) => {
    setBuilds((current) => new Map(current).set(repoId, build));
  }, []);

  const drain = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      for (let next = queue.current.shift(); next !== undefined;) {
        const repoId = next;
        const signal = controller.current?.signal;
        if (signal === undefined || signal.aborted) return;
        try {
          await buildRepository(organizationId, repoId, signal, (build) =>
            report(repoId, build),
          );
        } catch (error) {
          if (signal.aborted) return;
          report(repoId, {
            phase: "failed",
            error:
              error instanceof BuildFailure || error instanceof ApiError
                ? error.message
                : "Could not reach the server.",
          });
        }
        next = queue.current.shift();
      }
    } finally {
      running.current = false;
    }
  }, [organizationId, report]);

  const start = useCallback(
    (repoId: string) => {
      if (asked.current.has(repoId)) return;
      asked.current.add(repoId);
      queue.current.push(repoId);
      report(repoId, { phase: "waiting" });
      void drain();
    },
    [drain, report],
  );

  /** Asks again for a build that failed. */
  const retry = useCallback(
    (repoId: string) => {
      asked.current.delete(repoId);
      start(repoId);
    },
    [start],
  );

  return { builds, start, retry };
}
