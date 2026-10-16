/**
 * Where a run's time goes, kept as it works and written once when it ends
 * (`analysis_run.timing`), so the waits a person sees can be split into the
 * work behind them.
 *
 * Durations only, never what was read or run: a turn is two numbers and a
 * baseline step is its name, how long it took and whether it passed.
 */

import {
  ANALYSIS_TIMING_BASELINES_MAX,
  ANALYSIS_TIMING_TURNS_MAX,
  type AnalysisBaselineStepTiming,
  type AnalysisTiming,
  type AnalysisTimingStage,
  type AnalysisTurnTiming,
  type BaselineStep,
} from "sandbox-factory";

/** What a tool is given to say where its own time went. */
export interface RunTiming {
  /** One agent turn: its model call, then its tool calls. */
  turn(timing: AnalysisTurnTiming): void;
  /** One baseline, by its steps. */
  baseline(steps: readonly BaselineStep[]): void;
}
export interface TimingRecorder extends RunTiming {
  /** Adds to a stage; a stage timed twice is the sum of both. */
  stage(name: AnalysisTimingStage, ms: number): void;
  /** Times `work` as a stage, whether it resolves or throws. */
  time<T>(name: AnalysisTimingStage, work: () => Promise<T>): Promise<T>;
  value(): AnalysisTiming;
}

export function timingRecorder(
  clock: () => number = () => performance.now(),
): TimingRecorder {
  const stages: Partial<Record<AnalysisTimingStage, number>> = {};
  const turns: AnalysisTurnTiming[] = [];
  const baselines: AnalysisBaselineStepTiming[][] = [];
  const stage = (name: AnalysisTimingStage, ms: number) => {
    stages[name] = Math.round((stages[name] ?? 0) + Math.max(0, ms));
  };
  return {
    stage,
    async time(name, work) {
      const started = clock();
      try {
        return await work();
      } finally {
        stage(name, clock() - started);
      }
    },
    turn(timing) {
      if (turns.length < ANALYSIS_TIMING_TURNS_MAX)
        turns.push({
          modelMs: Math.round(timing.modelMs),
          toolMs: Math.round(timing.toolMs),
        });
    },
    baseline(steps) {
      if (baselines.length < ANALYSIS_TIMING_BASELINES_MAX)
        baselines.push(
          steps.map((step) => ({
            name: step.name,
            durationMs: Math.round(step.durationMs ?? 0),
            ok: step.ok,
          })),
        );
    },
    value: () => ({
      stages: { ...stages },
      ...(turns.length === 0 ? {} : { turns: [...turns] }),
      ...(baselines.length === 0 ? {} : { baselines: [...baselines] }),
    }),
  };
}
