import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { nextRunChange, useRunChanges } from "./events";
import { queryKeys, useUserId } from "./query";

/**
 * How often a view the push channel speaks for reads again on its own:
 * only for a change lost to a reconnect, so seldom.
 */
export const PUSHED_INTERVAL_MS = 15_000;

/**
 * Query requests never overlap. Errors stop tracking until an explicit retry.
 *
 * With `topics`, the push channel's changes to them (`events.ts`) read it
 * again at once, and while the channel is open the `interval` gives way to
 * `PUSHED_INTERVAL_MS`. No topics, or none yet, and the interval stands.
 */
export function useObservation<T>(input: {
  owner: string;
  resource: string;
  id: string | null | undefined;
  read: (id: string, signal: AbortSignal) => Promise<T>;
  terminal: (value: T) => boolean;
  interval: number;
  startDelay?: number;
  /** What a change to it is announced as, while it is not terminal. */
  topics?: (id: string, value: T | undefined) => readonly string[];
}) {
  const userId = useUserId();
  const [readyId, setReadyId] = useState<string | null | undefined>(null);
  const [pushed, setPushed] = useState(false);
  useEffect(() => {
    if (input.startDelay === undefined || input.id == null) return;
    const timer = setTimeout(() => setReadyId(input.id), input.startDelay);
    return () => clearTimeout(timer);
  }, [input.id, input.startDelay]);
  const enabled =
    input.id != null &&
    (input.startDelay === undefined || readyId === input.id);
  const query = useQuery({
    queryKey: queryKeys.resource(userId, input.owner, input.resource, input.id),
    enabled,
    queryFn: ({ signal }) => {
      if (input.id == null) throw new Error("No observation selected.");
      return input.read(input.id, signal);
    },
    staleTime: 0,
    retry: false,
    refetchInterval: (query) =>
      query.state.error !== null ||
      (query.state.data !== undefined && input.terminal(query.state.data))
        ? false
        : pushed
          ? Math.max(input.interval, PUSHED_INTERVAL_MS)
          : input.interval,
  });
  const settled =
    query.error !== null ||
    (query.data !== undefined && input.terminal(query.data));
  // Once its first read says it is still going: one that has already
  // ended opens no stream.
  const topics =
    !enabled ||
    settled ||
    query.data === undefined ||
    input.id == null ||
    input.topics === undefined
      ? []
      : input.topics(input.id, query.data);
  const open = useRunChanges(input.owner, topics, () => {
    void query.refetch();
  });
  const speaksFor = open && topics.length > 0;
  useEffect(() => setPushed(speaksFor), [speaksFor]);
  return query;
}
/** The topic an analysis run's changes are announced as. */
export const analysisTopic = (runId: string) => `analysis:${runId}`;
/** The topic a bounty run's changes are announced as. */
export const bountyRunTopic = (runId: string) => `bounty:${runId}`;
/** The topic a proposal's profiles' changes are announced as. */
export const profileTopic = (proposalId: string) => `profile:${proposalId}`;
export const terminalRun = (run: { status: string }) =>
  !["queued", "running"].includes(run.status);

/** The same non-overlapping lifecycle for an imperative action waiting for a result. */
export async function observeUntil<T>(input: {
  initial: T;
  read: (id: string) => Promise<T>;
  id: (value: T) => string;
  terminal: (value: T) => boolean;
  interval: number;
  signal?: AbortSignal;
  /**
   * The workspace and topic its changes are pushed as: each wait then
   * ends as soon as one is, or at the interval, whichever is first.
   */
  pushed?: { owner: string; topic: (value: T) => string };
}): Promise<T> {
  let value = input.initial;
  while (!input.terminal(value)) {
    const next =
      input.pushed === undefined
        ? null
        : nextRunChange(input.pushed.owner, input.pushed.topic(value));
    try {
      await Promise.race([
        observationDelay(input.interval, input.signal),
        ...(next === null ? [] : [next.changed]),
      ]);
    } finally {
      next?.stop();
    }
    value = await input.read(input.id(value));
  }
  return value;
}
export function observationDelay(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
