import type { AnalysisRunStore } from "@sandbox-factory/db";
export interface EnqueueDependencies {
  runs: Pick<AnalysisRunStore, "enqueue">;
  removeObject: (key: string) => Promise<void>;
  /** Interactive calls can wake immediately; background sweeps collect wake-ups. */
  onQueued?: () => void;
}
/** Capacity remains an explicit caller policy; this shares only queue coordination. */
export async function enqueueAnalysis(
  deps: EnqueueDependencies,
  owner: string,
  snapshotId: string,
  input: Parameters<AnalysisRunStore["enqueue"]>[2],
) {
  const result = await deps.runs.enqueue(owner, snapshotId, input);
  if (!result.ok) return result;
  if (result.obsoleteLogKey !== undefined)
    await deps.removeObject(result.obsoleteLogKey).catch(() => {});
  if (result.run.status === "queued") deps.onQueued?.();
  return result;
}
