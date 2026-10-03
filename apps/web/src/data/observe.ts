import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { queryKeys, useUserId } from "./query";

/** Query requests never overlap. Errors stop tracking until an explicit retry. */
export function useObservation<T>(input: {
  owner: string;
  resource: string;
  id: string | null | undefined;
  read: (id: string, signal: AbortSignal) => Promise<T>;
  terminal: (value: T) => boolean;
  interval: number;
  startDelay?: number;
}) {
  const userId = useUserId();
  const [readyId, setReadyId] = useState<string | null | undefined>(null);
  useEffect(() => {
    if (input.startDelay === undefined || input.id == null) return;
    const timer = setTimeout(() => setReadyId(input.id), input.startDelay);
    return () => clearTimeout(timer);
  }, [input.id, input.startDelay]);
  const query = useQuery({
    queryKey: queryKeys.resource(userId, input.owner, input.resource, input.id),
    enabled:
      input.id != null &&
      (input.startDelay === undefined || readyId === input.id),
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
        : input.interval,
  });
  return query;
}
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
}): Promise<T> {
  let value = input.initial;
  while (!input.terminal(value)) {
    await observationDelay(input.interval, input.signal);
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
