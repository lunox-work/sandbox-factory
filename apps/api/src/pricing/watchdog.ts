import type { BountyRunStore, BountyWritebackStore } from "@sandbox-factory/db";

const WATCHDOG_INTERVAL_MS = 30_000;
/** Retention passes run at most this often, beside the sweep. */
export const RETENTION_INTERVAL_MS = 60 * 60_000;

export interface BountyWatchdogOptions {
  readonly runs: Pick<
    BountyRunStore,
    "organizationsWithExpiredRuns" | "failExpired"
  >;
  readonly writebacks?: Pick<
    BountyWritebackStore,
    "organizationsWithExpiredWritebacks" | "classifyExpired"
  >;
  /**
   * Deletes what is kept for a while only (the audit log past its 180
   * days), given the time now; run at most hourly. Each answers how many
   * rows went.
   */
  readonly retention?: readonly ((now: Date) => Promise<number>)[];
  readonly now?: () => Date;
  readonly setInterval?: typeof globalThis.setInterval;
  readonly clearInterval?: typeof globalThis.clearInterval;
  readonly onError?: (code: string) => void;
}

/** Marks abandoned work terminal without replaying provider or Jira calls. */
export class BountyWatchdog {
  readonly #options: BountyWatchdogOptions;
  #timer: ReturnType<typeof setInterval> | undefined;
  #retainedAt: number | undefined;

  constructor(options: BountyWatchdogOptions) {
    this.#options = options;
  }

  start(): void {
    if (this.#timer !== undefined) return;
    void this.sweep().catch(() =>
      this.#options.onError?.("bounty_watchdog_failed"),
    );
    this.#timer = (this.#options.setInterval ?? setInterval)(() => {
      void this.sweep().catch(() =>
        this.#options.onError?.("bounty_watchdog_failed"),
      );
    }, WATCHDOG_INTERVAL_MS);
  }

  stop(): void {
    if (this.#timer === undefined) return;
    (this.#options.clearInterval ?? clearInterval)(this.#timer);
    this.#timer = undefined;
  }

  async sweep(): Promise<number> {
    const now = (this.#options.now ?? (() => new Date()))();
    const organizations =
      await this.#options.runs.organizationsWithExpiredRuns(now);
    let failed = 0;
    for (const organizationId of organizations) {
      failed += await this.#options.runs.failExpired(organizationId, now);
    }
    if (this.#options.writebacks !== undefined) {
      const writebackOrganizations =
        await this.#options.writebacks.organizationsWithExpiredWritebacks(now);
      for (const organizationId of writebackOrganizations) {
        failed += await this.#options.writebacks.classifyExpired(
          organizationId,
          now,
        );
      }
    }
    await this.#retain(now);
    return failed;
  }

  async #retain(now: Date): Promise<void> {
    const passes = this.#options.retention ?? [];
    if (
      passes.length === 0 ||
      (this.#retainedAt !== undefined &&
        now.getTime() - this.#retainedAt < RETENTION_INTERVAL_MS)
    )
      return;
    this.#retainedAt = now.getTime();
    for (const pass of passes) {
      try {
        await pass(now);
      } catch {
        this.#options.onError?.("retention_pass_failed");
      }
    }
  }
}
