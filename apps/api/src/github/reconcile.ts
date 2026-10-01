/**
 * The reconcile sweep: what keeps a pointer right when a webhook did not.
 *
 * Deliveries get lost — GitHub does not retry a failed one on its own, and a
 * local API cannot receive them at all — so every registered repository is
 * also read on a timer. Each is read at most once per fifteen minutes; the
 * sweep runs every five, so none waits much longer than that.
 *
 * Cheap by construction. The branch head is read with `If-None-Match`, and
 * GitHub's 304 for a quiet repository does not count against the rate limit.
 * Rate limits are per installation, so one that is limited is skipped for the
 * rest of the sweep while the others carry on.
 *
 * It also asks GitHub about every connection it has flagged unhealthy and
 * not seen uninstalled, so a flag left by a lost `unsuspend` delivery or by a
 * refusal that has passed clears itself rather than waiting for a reconnect.
 *
 * Every API task runs one. Two tasks reading the same repository in the same
 * minute cost a second conditional request, which is cheaper than any lock.
 * Within a task, a sweep never starts while the last one is still running.
 */

import type {
  GithubConnectionStore,
  GithubRepoStore,
} from "@sandbox-factory/db";
import {
  GithubApiError,
  GithubAppAuthError,
  GithubAuthError,
  type GithubClient,
  GithubInstallationUnavailable,
  GithubRateLimited,
  type InstallationTokens,
} from "@sandbox-factory/github";

import { installationClient } from "./credential.js";
import { syncRepo } from "./sync.js";

/** How often the sweep wakes. */
export const RECONCILE_INTERVAL_MS = 5 * 60_000;
/** How long a repository's last read stays good enough. */
export const RECONCILE_STALE_MS = 15 * 60_000;
/** The most repositories one sweep reads. */
export const RECONCILE_BATCH = 100;
/** The most flagged connections one sweep asks GitHub about. */
export const PROBE_BATCH = 20;

export interface GithubReconcilerOptions {
  readonly repos: GithubRepoStore;
  readonly connections: Pick<
    GithubConnectionStore,
    "update" | "flaggedForProbe"
  >;
  readonly installations: InstallationTokens;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
  readonly setInterval?: typeof globalThis.setInterval;
  readonly clearInterval?: typeof globalThis.clearInterval;
  /**
   * A failure worth a log line. `detail` is the error's name and message,
   * never the error itself: nothing here should print a request or a row.
   */
  readonly onError?: (code: string, detail?: string) => void;
}

/** What one sweep did, for tests and for a caller that wants to log it. */
export interface SweepResult {
  readonly read: number;
  readonly failed: number;
  /** True when a rate limit made the sweep skip an installation. */
  readonly rateLimited: boolean;
  /**
   * True when GitHub refused the App's own credential, which stops the sweep
   * without flagging anything: every installation would have answered the
   * same, and none of them is at fault.
   */
  readonly appRefused: boolean;
  /** Flagged connections the probe found healthy again. */
  readonly recovered: number;
}

export class GithubReconciler {
  readonly #options: GithubReconcilerOptions;
  #timer: ReturnType<typeof setInterval> | undefined;
  #running: Promise<unknown> | undefined;
  #stopping = false;

  constructor(options: GithubReconcilerOptions) {
    this.#options = options;
  }

  start(): void {
    if (this.#timer !== undefined) return;
    this.#stopping = false;
    const run = () => {
      // A slow GitHub must not stack sweeps over the same unstamped rows.
      if (this.#running !== undefined) return;
      this.#running = this.sweep()
        .catch((error: unknown) =>
          this.#report("github_reconcile_failed", error),
        )
        .finally(() => {
          this.#running = undefined;
        });
    };
    run();
    this.#timer = (this.#options.setInterval ?? setInterval)(
      run,
      RECONCILE_INTERVAL_MS,
    );
  }

  /**
   * Stops the timer, and resolves once a sweep in progress has finished the
   * repository it was on — so the caller can close the database after.
   */
  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#timer !== undefined) {
      (this.#options.clearInterval ?? clearInterval)(this.#timer);
      this.#timer = undefined;
    }
    await this.#running;
  }

  async sweep(): Promise<SweepResult> {
    const { repos, connections, installations } = this.#options;
    const now = (this.#options.now ?? (() => new Date()))();
    const due = await repos.dueForSync(
      new Date(now.getTime() - RECONCILE_STALE_MS),
      RECONCILE_BATCH,
    );

    const clients = new Map<string, GithubClient>();
    /** Installations not to read again this sweep: limited, or refused. */
    const skipped = new Set<string>();
    let read = 0;
    let failed = 0;
    let rateLimited = false;

    for (const repo of due) {
      if (this.#stopping) break;
      if (skipped.has(repo.installationId)) continue;
      let client = clients.get(repo.installationId);
      if (client === undefined) {
        client = installationClient(
          installations,
          repo.installationId,
          this.#options.fetch,
        );
        clients.set(repo.installationId, client);
      }

      try {
        await syncRepo(repos, client, {
          organizationId: repo.organizationId,
          repoId: repo.id,
          externalId: repo.externalId,
          headEtag: repo.headEtag,
        });
        read += 1;
      } catch (error) {
        failed += 1;
        if (error instanceof GithubAppAuthError) {
          this.#report("github_reconcile_app_refused", error);
          return { read, failed, rateLimited, appRefused: true, recovered: 0 };
        }
        if (error instanceof GithubRateLimited) {
          // This installation waits for the next sweep; the others do not.
          skipped.add(repo.installationId);
          rateLimited = true;
          this.#report("github_reconcile_rate_limited", error);
          continue;
        }
        try {
          // The token itself: GitHub would not mint one, or refused one it
          // minted earlier (a 401 after an uninstall, before the cache
          // knew). The installation is gone or suspended and the webhook
          // that says so did not arrive; its other repositories would fail
          // the same way.
          if (
            error instanceof GithubInstallationUnavailable ||
            (error instanceof GithubAuthError && error.status === 401)
          ) {
            skipped.add(repo.installationId);
            installations.forget(repo.installationId);
            await connections.update(repo.organizationId, repo.connectionId, {
              healthy: false,
            });
            continue;
          }
          // One line, and ours: never a path or anything from the repository.
          await repos.markSyncError(
            repo.organizationId,
            repo.id,
            error instanceof GithubApiError
              ? error.message
              : "Could not read the repository from GitHub.",
          );
        } catch (writeError) {
          // One row that cannot be written must not end the batch.
          this.#report("github_reconcile_write_failed", writeError);
        }
      }
    }

    const probed = await this.#probe(now);
    return {
      read,
      failed,
      rateLimited,
      appRefused: probed === "app-refused",
      recovered: probed === "app-refused" ? 0 : probed,
    };
  }

  /**
   * Asks GitHub about each flagged connection, with the App's JWT: gone
   * (final, its repositories `gone` as the `deleted` webhook would leave
   * them), still suspended (left flagged), or live again (cleared).
   */
  async #probe(now: Date): Promise<number | "app-refused"> {
    const { repos, connections, installations } = this.#options;
    const flagged = await connections.flaggedForProbe(PROBE_BATCH);
    let recovered = 0;
    for (const entry of flagged) {
      if (this.#stopping) break;
      let state: Awaited<ReturnType<InstallationTokens["probe"]>>;
      try {
        state = await installations.probe(entry.installationId);
      } catch (error) {
        if (error instanceof GithubAppAuthError) {
          this.#report("github_reconcile_app_refused", error);
          return "app-refused";
        }
        // The JWT's limit is the App's, not an installation's: stop asking.
        if (error instanceof GithubRateLimited) break;
        this.#report("github_reconcile_probe_failed", error);
        continue;
      }
      const { organizationId, connectionId } = entry;
      try {
        if (state === null) {
          await connections.update(organizationId, connectionId, {
            uninstalledAt: now.toISOString(),
          });
          await repos.markGoneForConnection(organizationId, connectionId);
        } else if (state.suspendedAt !== null) {
          // Written even when unchanged, which moves the row to the back of
          // the probe's queue.
          await connections.update(organizationId, connectionId, {
            suspendedAt: state.suspendedAt,
          });
        } else {
          installations.forget(entry.installationId);
          await connections.update(organizationId, connectionId, {
            healthy: true,
            suspendedAt: null,
          });
          recovered += 1;
        }
      } catch (writeError) {
        this.#report("github_reconcile_write_failed", writeError);
      }
    }
    return recovered;
  }

  #report(code: string, error: unknown): void {
    this.#options.onError?.(
      code,
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error),
    );
  }
}
