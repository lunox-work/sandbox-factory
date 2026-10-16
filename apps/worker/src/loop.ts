import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { AnalysisRunStore, ClaimedAnalysisRun } from "@sandbox-factory/db";
import type { AnalysisTool } from "sandbox-factory";

/**
 * How long a polling worker waits between empty claims when nothing wakes
 * it. The queue's notifications wake it at once; this is for one missed.
 */
export const IDLE_POLL_MS = 5_000;

export async function workerLoop(options: {
  /** `claimBeside` is read only with `beside`. */
  runs: Pick<AnalysisRunStore, "claimNext"> &
    Partial<Pick<AnalysisRunStore, "claimBeside">>;
  mode: "once" | "poll";
  signal: AbortSignal;
  execute: (run: ClaimedAnalysisRun) => Promise<void>;
  /**
   * The runs a claimed run may share its claim with: other tools on its
   * snapshot that read the one checkout, claimed beside it and run at the
   * same time. Null, or absent, for a run that runs alone.
   */
  beside?: (
    run: ClaimedAnalysisRun,
  ) => { snapshotId: string; tools: readonly AnalysisTool[] } | null;
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
      const together = [run, ...(await claimBeside(options, run))];
      await Promise.all(together.map((each) => options.execute(each)));
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
 * The runs claimed beside `run`, one per tool `beside` names at most: each
 * claimed as the queue would hand it out, so one still waiting on another
 * run stays queued.
 */
async function claimBeside(
  options: Parameters<typeof workerLoop>[0],
  run: ClaimedAnalysisRun,
): Promise<ClaimedAnalysisRun[]> {
  const beside = options.beside?.(run) ?? null;
  const claim = options.runs.claimBeside;
  if (beside === null || claim === undefined) return [];
  const claimed: ClaimedAnalysisRun[] = [];
  let tools = beside.tools.filter((tool) => tool !== run.tool);
  while (tools.length > 0 && !options.signal.aborted) {
    const next = await claim(randomUUID(), new Date(), {
      snapshotId: beside.snapshotId,
      tools,
    });
    if (next === null) break;
    claimed.push(next);
    tools = tools.filter((tool) => tool !== next.tool);
  }
  return claimed;
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
