import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { AnalysisRunStore, ClaimedAnalysisRun } from "@sandbox-factory/db";
import { RUN_SLOTS, WORKER_SLOTS, slotOf, toolsOfSlot } from "sandbox-factory";
import type { AnalysisTool, RunSlot } from "sandbox-factory";

/**
 * How long a polling worker waits between empty claims when nothing wakes
 * it. The queue's notifications wake it at once; this is for one missed.
 */
export const IDLE_POLL_MS = 5_000;

/**
 * Claims runs into the worker's slots (`WORKER_SLOTS`) and runs each claim
 * as soon as it is made, beside those already running: a scope queued while
 * a sandbox build waits on its model starts at once, rather than after it.
 * Each run keeps its own lease and heartbeat (`executeRun`). Once every
 * slot of a kind is busy, only runs of the other kinds are claimed.
 */
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
   * same time, in its slot. Null, or absent, for a run that runs alone.
   */
  beside?: (
    run: ClaimedAnalysisRun,
  ) => { snapshotId: string; tools: readonly AnalysisTool[] } | null;
  /**
   * The wait between empty claims. `cancel` ends it early without counting
   * as a wake: the loop moves on because a run of its own ended.
   */
  wait?: (cancel?: AbortSignal) => Promise<void>;
  /**
   * In `poll` mode, how long the loop may go without a run before it
   * returns, so a worker launched for a burst stays warm for the next one
   * and then goes. Unset, it polls until stopped.
   */
  idleExitMs?: number;
  /** How many claims of each slot run at once; `WORKER_SLOTS` by default. */
  slots?: Readonly<Record<RunSlot, number>>;
  now?: () => number;
}): Promise<void> {
  const now = options.now ?? Date.now;
  const slots = options.slots ?? WORKER_SLOTS;
  const busy: Record<RunSlot, number> = { agent: 0, build: 0 };
  const active = new Set<Promise<void>>();
  let failure: { error: unknown } | undefined;
  let lastRun = now();
  /** Runs ended so far, so a claim can tell a slot freed while it was out. */
  let ended = 0;
  const wait = async (cancel: AbortSignal) => {
    try {
      await (options.wait?.(cancel) ??
        delay(IDLE_POLL_MS, undefined, {
          signal: AbortSignal.any([options.signal, cancel]),
        }));
    } catch (error) {
      if (!options.signal.aborted && !cancel.aborted) throw error;
    }
  };
  try {
    while (!options.signal.aborted) {
      if (failure !== undefined) throw failure.error;
      const endedBefore = ended;
      const free = RUN_SLOTS.filter((slot) => busy[slot] < slots[slot]);
      const run =
        free.length === 0
          ? null
          : await options.runs.claimNext(
              randomUUID(),
              new Date(),
              // Unfiltered while every slot is free, as a worker of one
              // slot each would claim.
              free.length === RUN_SLOTS.length
                ? undefined
                : free.flatMap(toolsOfSlot),
            );
      if (run !== null) {
        const slot = slotOf(run.tool);
        busy[slot] += 1;
        const together = [run, ...(await claimBeside(options, run))];
        const work: Promise<void> = Promise.all(
          together.map((each) => options.execute(each)),
        )
          .then(
            () => {},
            (error: unknown) => {
              failure ??= { error };
            },
          )
          .finally(() => {
            busy[slot] -= 1;
            ended += 1;
            active.delete(work);
            lastRun = now();
          });
        active.add(work);
        continue;
      }
      // A run ended while the claim was out, freeing a slot it did not ask
      // for: asked again at once, not after a wait the end's wake was spent
      // on.
      if (ended !== endedBefore) continue;
      if (active.size > 0) {
        // A slot frees when a run ends; a wake may bring a run for one
        // that is free already.
        const cancel = new AbortController();
        await Promise.race([
          ...active,
          ...(free.length === 0 ? [] : [wait(cancel.signal)]),
        ]).finally(() => cancel.abort());
        continue;
      }
      if (options.mode === "once") return;
      if (
        options.idleExitMs !== undefined &&
        now() - lastRun >= options.idleExitMs
      )
        return;
      await wait(new AbortController().signal);
    }
  } finally {
    // Stopped claiming: what is running finishes, or is cut by its own
    // shutdown signal.
    await Promise.allSettled([...active]);
  }
  if (failure !== undefined) throw failure.error;
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
 * so a run queued between an empty claim and the wait is not slept past. A
 * wait the caller cancels keeps it too: the caller did not see it.
 */
export function wakeableWait(intervalMs: number, signal: AbortSignal) {
  let woken = false;
  const cuts = new Set<AbortController>();
  return {
    wake(): void {
      woken = true;
      for (const cut of cuts) cut.abort();
    },
    async wait(cancel?: AbortSignal): Promise<void> {
      if (!woken) {
        const cut = new AbortController();
        cuts.add(cut);
        try {
          await delay(intervalMs, undefined, {
            signal: AbortSignal.any([
              signal,
              cut.signal,
              ...(cancel === undefined ? [] : [cancel]),
            ]),
          });
        } catch (error) {
          // Woken is a wait that ended early; stopped or cancelled is the
          // caller's to see.
          if (signal.aborted || !cut.signal.aborted) throw error;
        } finally {
          cuts.delete(cut);
        }
      }
      woken = false;
    },
  };
}
