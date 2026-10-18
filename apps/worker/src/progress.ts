/**
 * What a running tool has done so far, kept as it works and written to its
 * run, so a page following the run shows its steps, or a builder's bar,
 * rather than a spinner.
 *
 * Writes never queue up behind one another: while one is out, the steps
 * that arrive are held, and the next write carries all of them. A write
 * that fails is let go; the next step tries again, and the run's outcome is
 * what counts. A fraction moves often, a file at a time, so it is written
 * at most once per `FRACTION_WRITE_MS`, and on reaching its total.
 */

import {
  ANALYSIS_PROGRESS_STEPS_MAX,
  ANALYSIS_PROGRESS_TEXT_MAX,
  type AnalysisProgress,
  type AnalysisProgressFraction,
  type AnalysisProgressStep,
} from "sandbox-factory";

export const FRACTION_WRITE_MS = 1_000;

export interface ProgressRecorder {
  /** Records one step, and writes it when no write is out. */
  step(text: string): void;
  /** Records how far a builder has got: `done` units of `total`. */
  advance(done: number, total: number): void;
  /** Resolves once every step recorded so far has been written, or tried. */
  settled(): Promise<void>;
}

export function progressRecorder(
  write: (progress: AnalysisProgress) => Promise<boolean>,
  now: () => Date = () => new Date(),
): ProgressRecorder {
  let count = 0;
  let steps: readonly AnalysisProgressStep[] = [];
  let fraction: AnalysisProgressFraction | undefined;
  let writing: Promise<void> | null = null;
  let dirty = false;
  let lastWrite = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = (): Promise<void> => {
    if (writing !== null) {
      dirty = true;
      return writing;
    }
    writing = (async () => {
      do {
        dirty = false;
        lastWrite = Date.now();
        const progress: AnalysisProgress =
          fraction === undefined
            ? { count, steps }
            : { count, steps, fraction };
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
    advance(done, total) {
      if (!Number.isFinite(total) || total < 1) return;
      const next = {
        done: Math.max(0, Math.min(Math.floor(done), Math.floor(total))),
        total: Math.floor(total),
      };
      if (next.done === fraction?.done && next.total === fraction.total) return;
      fraction = next;
      const wait = lastWrite + FRACTION_WRITE_MS - Date.now();
      if (next.done === next.total || wait <= 0) {
        clearTimeout(timer);
        timer = undefined;
        void flush();
      } else if (timer === undefined) {
        timer = setTimeout(() => {
          timer = undefined;
          void flush();
        }, wait);
        timer.unref();
      }
    },
    settled() {
      // A fraction still held for its turn is written now: the run ends.
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
        void flush();
      }
      return writing ?? Promise.resolve();
    },
  };
}

/** The units a phased bar counts in all: fine enough for any width. */
export const PHASED_UNITS = 1_000;

/**
 * One bar over several passes of a builder, each weighed by how much it
 * does (its files, say), so the bar fills once from start to end: a pass's
 * own `done of total` fills its share. A pass that is skipped is ended
 * with `(1, 1)`. The bar never moves back.
 */
export function phasedProgress<Phase extends string>(
  advance: ((done: number, total: number) => void) | undefined,
  weights: Readonly<Record<Phase, number>>,
): Record<Phase, (done: number, total: number) => void> {
  const phases = Object.keys(weights) as Phase[];
  const sum = phases.reduce(
    (total, phase) => total + Math.max(0, weights[phase]),
    0,
  );
  let offset = 0;
  let shown = 0;
  const reporters = {} as Record<Phase, (done: number, total: number) => void>;
  for (const phase of phases) {
    const start = offset;
    const share =
      sum === 0
        ? PHASED_UNITS / phases.length
        : (Math.max(0, weights[phase]) / sum) * PHASED_UNITS;
    offset += share;
    reporters[phase] = (done, total) => {
      if (advance === undefined || total <= 0) return;
      const at = Math.round(
        start + share * Math.min(1, Math.max(0, done / total)),
      );
      if (at <= shown) return;
      shown = at;
      advance(at, PHASED_UNITS);
    };
  }
  return reporters;
}
