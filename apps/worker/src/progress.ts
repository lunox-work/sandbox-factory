/**
 * What a running agent has done so far, kept as it works and written to its
 * run, so a page following the run shows its steps rather than a spinner.
 *
 * Writes never queue up behind one another: while one is out, the steps
 * that arrive are held, and the next write carries all of them. A write
 * that fails is let go; the next step tries again, and the run's outcome is
 * what counts.
 */

import {
  ANALYSIS_PROGRESS_STEPS_MAX,
  ANALYSIS_PROGRESS_TEXT_MAX,
  type AnalysisProgress,
  type AnalysisProgressStep,
} from "sandbox-factory";

export interface ProgressRecorder {
  /** Records one step, and writes it when no write is out. */
  step(text: string): void;
  /** Resolves once every step recorded so far has been written, or tried. */
  settled(): Promise<void>;
}

export function progressRecorder(
  write: (progress: AnalysisProgress) => Promise<boolean>,
  now: () => Date = () => new Date(),
): ProgressRecorder {
  let count = 0;
  let steps: readonly AnalysisProgressStep[] = [];
  let writing: Promise<void> | null = null;
  let dirty = false;

  const flush = (): Promise<void> => {
    if (writing !== null) {
      dirty = true;
      return writing;
    }
    writing = (async () => {
      do {
        dirty = false;
        const progress = { count, steps };
        await Promise.resolve()
          .then(() => write(progress))
          .catch(() => false);
      } while (dirty);
      writing = null;
    })();
    return writing;
  };

  return {
    step(text) {
      const line = text.replace(/\s+/g, " ").trim();
      if (line === "") return;
      count += 1;
      steps = [
        ...steps,
        {
          at: now().toISOString(),
          text:
            line.length > ANALYSIS_PROGRESS_TEXT_MAX
              ? `${line.slice(0, ANALYSIS_PROGRESS_TEXT_MAX - 1)}…`
              : line,
        },
      ].slice(-ANALYSIS_PROGRESS_STEPS_MAX);
      void flush();
    },
    settled: () => writing ?? Promise.resolve(),
  };
}
