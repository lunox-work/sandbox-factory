import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { AnalysisRunStore, ClaimedAnalysisRun } from "@sandbox-factory/db";

/**
 * How long a polling worker waits between empty claims when nothing wakes
 * it. The queue's notifications wake it at once; this is for one missed.
 */
export const IDLE_POLL_MS = 5_000;

export async function workerLoop(options: {
  runs: Pick<AnalysisRunStore, "claimNext">;
  mode: "once" | "poll";
  signal: AbortSignal;
  execute: (run: ClaimedAnalysisRun) => Promise<void>;
  wait?: () => Promise<void>;
  /**
   * In `poll` mode, how long the loop may go without a run before it
   * returns, so a worker launched for a burst stays warm for the next one
   * and then goes. Unset, it polls until stopped.
   */
  idleExitMs?: number;
  now?: () => number;
}): Promise<void> {
  const now = options.now ?? Date.now;
  let lastRun = now();
  while (!options.signal.aborted) {
    const run = await options.runs.claimNext(randomUUID(), new Date());
    if (run !== null) {
      await options.execute(run);
      lastRun = now();
    } else if (options.mode === "once") return;
    else if (
      options.idleExitMs !== undefined &&
      now() - lastRun >= options.idleExitMs
    )
      return;
    else
      await (
        options.wait ??
        (() => delay(IDLE_POLL_MS, undefined, { signal: options.signal }))
      )().catch((error: unknown) => {
        if (!options.signal.aborted) throw error;
      });
  }
}

/**
 * The poll's wait, cut short by `wake`: the worker listens for the queue's
 * notifications and wakes on each. A wake while the loop is busy is kept,
 * so a run queued between an empty claim and the wait is not slept past.
 */
export function wakeableWait(intervalMs: number, signal: AbortSignal) {
  let woken = false;
  let cut: AbortController | undefined;
  return {
    wake(): void {
      woken = true;
      cut?.abort();
    },
    async wait(): Promise<void> {
      if (!woken) {
        cut = new AbortController();
        await delay(intervalMs, undefined, {
          signal: AbortSignal.any([signal, cut.signal]),
        }).catch((error: unknown) => {
          // Woken is a wait that ended early; stopped is the loop's to see.
          if (signal.aborted || cut?.signal.aborted !== true) throw error;
        });
        cut = undefined;
      }
      woken = false;
    },
  };
}
