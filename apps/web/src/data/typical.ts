import { useQuery } from "@tanstack/react-query";

import { clients, queryKeys, useUserId } from "./query";

/**
 * What a stage usually takes in this workspace, from what it has measured
 * (phase 0's `flow_wait_sample`, its last 30 days): said beside the stage's
 * clock. A flow measured fewer than `TYPICAL_MIN_SAMPLES` times says
 * nothing yet; the caller's own words, if any, stand in.
 */
export const TYPICAL_MIN_SAMPLES = 3;

/** The median of each of `flows` with enough samples, in seconds. */
export function useTypicalWaits(
  owner: string,
  flows: readonly string[],
): ReadonlyMap<string, number> {
  const userId = useUserId();
  const asked = [...new Set(flows)].sort();
  const query = useQuery({
    queryKey: queryKeys.resource(userId, owner, "flows-typical", ...asked),
    enabled: owner !== "" && asked.length > 0,
    queryFn: ({ signal }) => clients.runs.typicalWaits(owner, asked, signal),
    // A median of a month moves slowly; a failed read says nothing.
    staleTime: 10 * 60_000,
  });
  return new Map(
    Object.entries(query.data ?? {}).flatMap(([flow, { p50, samples }]) =>
      samples >= TYPICAL_MIN_SAMPLES ? [[flow, p50] as const] : [],
    ),
  );
}

/** "usually ~40 s", "usually ~3 min"; `fallback` for none. */
export function usually(
  seconds: number | undefined,
  fallback?: string,
): string | undefined {
  if (seconds === undefined) return fallback;
  if (seconds < 60)
    return `usually ~${Math.max(5, Math.round(seconds / 5) * 5)} s`;
  return `usually ~${Math.round(seconds / 60)} min`;
}
