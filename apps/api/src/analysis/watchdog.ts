import type { AnalysisRunStore } from "@sandbox-factory/db";

export class AnalysisWatchdog {
  #timer: ReturnType<typeof setInterval> | undefined;
  #pending: Promise<void> | undefined;
  constructor(
    readonly options: {
      runs: Pick<
        AnalysisRunStore,
        "organizationsWithExpiredRuns" | "failExpired"
      >;
      ensureWorker: () => Promise<void>;
      now?: () => Date;
      onError?: () => void;
    },
  ) {}
  start(): void {
    if (this.#timer !== undefined) return;
    const sweep = () => {
      void this.sweep().catch(() => this.options.onError?.());
    };
    sweep();
    this.#timer = setInterval(sweep, 30_000);
  }
  async stop(): Promise<void> {
    clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#pending?.catch(() => {});
  }
  async sweep(): Promise<void> {
    if (this.#pending !== undefined) return this.#pending;
    const work = async () => {
      const now = (this.options.now ?? (() => new Date()))();
      for (const owner of await this.options.runs.organizationsWithExpiredRuns(
        now,
      ))
        await this.options.runs.failExpired(owner, now);
      await this.options.ensureWorker();
    };
    this.#pending = work();
    try {
      await this.#pending;
    } finally {
      this.#pending = undefined;
    }
  }
}
