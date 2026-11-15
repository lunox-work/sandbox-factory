/**
 * The evaluation provider, metered for one run: each job the run creates
 * writes its seconds to the evaluator ledger (`evaluator-usage.ts` in
 * packages/db) against the run's workspace and the run when it is torn
 * down. Every job a run starts goes through the provider its adapter is
 * handed (a build's baselines, the hidden-tests and reference agents'
 * candidates, a calibration's rerun, a starter's runs, a grading run's
 * jobs and its reversed check, an import's), so wrapping it once per
 * claimed run records them all.
 *
 * A job is timed from the moment it exists to the end of its teardown,
 * not while it waits for one of the worker's job slots (`limitJobs`), and
 * billed whole seconds, rounded up. Recording is the truth the monthly
 * evaluator cap counts; the cap itself is admission, checked when a run is
 * queued: nothing here stops a job.
 */

import type { EvaluatorUsageStore } from "@sandbox-factory/db";
import { billedSeconds } from "@sandbox-factory/db";
import type { EvaluationProvider } from "sandbox-factory";

import type { MeteredRun } from "../agent/metered.js";

export function meteredProvider(
  provider: EvaluationProvider,
  run: MeteredRun,
  ledger: Pick<EvaluatorUsageStore, "record">,
  /** Told of a ledger write that failed; the job's work is kept. */
  onError: (code: string, error: unknown) => void,
  now: () => number = () => performance.now(),
): EvaluationProvider {
  return {
    name: provider.name,
    async create(spec) {
      const job = await provider.create(spec);
      const started = now();
      let recorded = false;
      const record = async () => {
        if (recorded) return;
        recorded = true;
        // A write that fails costs the run nothing: the job ran either way.
        await ledger
          .record(run.organizationId, {
            runId: run.id,
            kind: run.tool,
            provider: job.environment.provider,
            seconds: billedSeconds(now() - started),
          })
          .catch((error: unknown) =>
            onError("evaluator_usage_record_failed", error),
          );
      };
      const egressCut = job.egressCut?.bind(job);
      return {
        id: job.id,
        environment: job.environment,
        stage: (files) => job.stage(files),
        exec: (command) => job.exec(command),
        read: (path) => job.read(path),
        seal: (paths) => job.seal(paths),
        ...(egressCut === undefined ? {} : { egressCut }),
        async destroy() {
          try {
            await job.destroy();
          } finally {
            await record();
          }
        },
      };
    },
  };
}

/** The provider for one run; null stays null (no provider on this worker). */
export function meteredEvaluation(
  provider: EvaluationProvider | null,
  run: MeteredRun,
  ledger: Pick<EvaluatorUsageStore, "record">,
  onError: (code: string, error: unknown) => void,
): EvaluationProvider | null {
  return provider === null
    ? null
    : meteredProvider(provider, run, ledger, onError);
}
