import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { AnalysisRunStore, ClaimedAnalysisRun } from "@sandbox-factory/db";

export async function workerLoop(options: {
  runs: Pick<AnalysisRunStore, "claimNext">;
  mode: "once" | "poll";
  signal: AbortSignal;
  execute: (run: ClaimedAnalysisRun) => Promise<void>;
  wait?: () => Promise<void>;
}): Promise<void> {
  while (!options.signal.aborted) {
    const run = await options.runs.claimNext(randomUUID(), new Date());
    if (run !== null) await options.execute(run);
    else if (options.mode === "once") return;
    else
      await (
        options.wait ??
        (() => delay(5_000, undefined, { signal: options.signal }))
      )().catch((error: unknown) => {
        if (!options.signal.aborted) throw error;
      });
  }
}
