import type { EvaluationProvider } from "sandbox-factory";

/** Evaluation jobs one worker runs at once. */
export const EVALUATION_JOBS_MAX = 2;

/**
 * At most `max` of a provider's jobs at once on this worker. Agent runs share
 * a worker three at a time, and a job is a whole install, build and test
 * run: past the cap, a job waits for one to be destroyed before it is
 * created, or for its run to stop.
 */
export function limitJobs(
  provider: EvaluationProvider,
  max: number,
): EvaluationProvider {
  let running = 0;
  const waiting: (() => void)[] = [];
  const release = () => {
    const next = waiting.shift();
    if (next === undefined) running -= 1;
    else next();
  };
  const acquire = (signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (running < max) {
        running += 1;
        resolve();
        return;
      }
      const turn = () => {
        signal.removeEventListener("abort", stop);
        resolve();
      };
      const stop = () => {
        waiting.splice(waiting.indexOf(turn), 1);
        reject(signal.reason);
      };
      signal.throwIfAborted();
      waiting.push(turn);
      signal.addEventListener("abort", stop, { once: true });
    });
  return {
    name: provider.name,
    async create(spec) {
      await acquire(spec.signal);
      let job;
      try {
        job = await provider.create(spec);
      } catch (error) {
        release();
        throw error;
      }
      let released = false;
      const created = job;
      return {
        id: created.id,
        environment: created.environment,
        stage: (files) => created.stage(files),
        exec: (command) => created.exec(command),
        read: (path) => created.read(path),
        async destroy() {
          try {
            await created.destroy();
          } finally {
            if (!released) {
              released = true;
              release();
            }
          }
        },
      };
    },
  };
}
