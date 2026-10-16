/**
 * Cuts the versions asked for before their slice was ready. Starting a
 * linked sandbox, or slicing one, while its sizing's slice is still in
 * flight answers with where it stands and remembers the request
 * (`version-service.ts`); this makes the request again, as the person who
 * asked, once the profiler settles a profile, so the tab follows one run
 * from the click to the build instead of waiting for a second click.
 *
 * A request still pending stays for the next pass, as does one refused at
 * the organization's analysis cap: its draft is cut, and the next pass
 * builds it. Any other refusal is final and clears it, as does a sandbox
 * or a person no longer there. A timer pass catches a settle this process
 * did not see, such as one before a restart.
 */

import type {
  PendingCut,
  SandboxStore,
  StoredSandbox,
} from "@sandbox-factory/db";

import type { versionService } from "./version-service.js";

/** How often pending requests are looked at without a settle to prompt it. */
export const CUT_SWEEP_MS = 30_000;

type Slice = ReturnType<typeof versionService>["slice"];

export interface SandboxCutterOptions {
  readonly sandboxes: Pick<
    SandboxStore,
    "get" | "pendingCuts" | "organizationsWithPendingCuts" | "clearCut"
  >;
  readonly slice: (
    owner: string,
    actor: string,
    sandbox: StoredSandbox,
    now: Date,
  ) => ReturnType<Slice>;
  readonly now?: () => Date;
  readonly intervalMs?: number;
  readonly onError?: (code: string, error?: unknown) => void;
}

export class SandboxCutter {
  readonly #options: SandboxCutterOptions;
  #timer: ReturnType<typeof setInterval> | undefined;
  #pending: Promise<void> | undefined;
  #again = false;
  #stopped = false;

  constructor(options: SandboxCutterOptions) {
    this.#options = options;
  }

  start(): void {
    if (this.#timer !== undefined) return;
    this.#stopped = false;
    this.kick();
    this.#timer = setInterval(
      () => this.kick(),
      this.#options.intervalMs ?? CUT_SWEEP_MS,
    );
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#pending?.catch(() => {});
  }

  /** A pass now, or another straight after the one in progress. */
  kick(): void {
    if (this.#stopped) return;
    void this.sweep().catch((error: unknown) =>
      this.#options.onError?.("sandbox_cut_sweep_failed", error),
    );
  }

  async sweep(): Promise<void> {
    if (this.#pending !== undefined) {
      this.#again = true;
      return this.#pending;
    }
    const work = async () => {
      do {
        this.#again = false;
        for (const owner of await this.#options.sandboxes.organizationsWithPendingCuts())
          for (const cut of await this.#options.sandboxes.pendingCuts(owner))
            try {
              await this.#cut(owner, cut);
            } catch (error) {
              // Left for the next pass; the other requests still move.
              this.#options.onError?.("sandbox_cut_failed", error);
            }
      } while (this.#again);
    };
    this.#pending = work();
    try {
      await this.#pending;
    } finally {
      this.#pending = undefined;
    }
  }

  async #cut(owner: string, cut: PendingCut): Promise<void> {
    const clear = () =>
      this.#options.sandboxes.clearCut(owner, cut.sandboxId, cut.requestedAt);
    const sandbox = await this.#options.sandboxes.get(owner, cut.sandboxId);
    if (sandbox === null || cut.requestedBy === null) return clear();
    const now = (this.#options.now ?? (() => new Date()))();
    const sliced = await this.#options.slice(
      owner,
      cut.requestedBy,
      sandbox,
      now,
    );
    // Still in flight: the service has asked again, and it stays asked.
    if (sliced.ok && sliced.result === null) return;
    // A cut draft clears the request itself; a refusal is cleared here,
    // except the cap, which the next pass meets with the draft already cut.
    if (!sliced.ok && codeOf(sliced.body) !== "run_limit") await clear();
  }
}

const codeOf = (body: object): unknown =>
  "code" in body ? body.code : undefined;
