/**
 * Where a merge-back writes: the sandbox's repository, a writer whose token
 * is narrowed to it, and whether the installation has accepted the
 * permissions merge-back needs (`MERGE_BACK_PERMISSIONS`).
 *
 * The connection row's `permissions` is the cache: written when the
 * installation is linked and on GitHub's `new_permissions_accepted`
 * webhook. A read that would be refused on it, and every merge, asks
 * GitHub (`GET /app/installations/:id`, the App's JWT) instead, so a lost
 * webhook neither blocks the button nor lets a merge through; what GitHub
 * says is written back. Refused answers are kept for a minute, so a page
 * read repeatedly does not ask each time; a merge always asks.
 *
 * Reading the pull request's CI back needs `CI_READ_PERMISSIONS` too. They
 * never block a merge-back: without them the target has no `ciReader`,
 * names them in `ciMissingPermissions`, and CI reads `unknown`.
 */

import type {
  GithubConnectionStore,
  GithubConnectionSummary,
  GithubRepoStore,
} from "@sandbox-factory/db";
import {
  CI_READ_PERMISSIONS,
  type InstallationTokens,
  MERGE_BACK_PERMISSIONS,
  missingPermissions,
  type PullRequestCiReader,
  type PullRequestWriter,
} from "@sandbox-factory/github";
import { githubInstallationSettingsUrl } from "@sandbox-factory/shared";

import { mergeBackWriter, mergeCiReader } from "./credential.js";

/** Everything a merge-back and its CI read-back use. */
const ALL_PERMISSIONS: Readonly<Record<string, string>> = {
  ...MERGE_BACK_PERMISSIONS,
  ...CI_READ_PERMISSIONS,
};

/** How long a live read of an installation's permissions stands for a page read. */
export const PERMISSIONS_TTL_MS = 60_000;

export interface MergeBackTarget {
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly writer: Pick<PullRequestWriter, "open" | "getPullRequest" | "merge">;
  /** `name:level`, e.g. `pull_requests:write`; empty when all are held. */
  readonly missingPermissions: readonly string[];
  /** Reads the pull request's CI; null while `ciMissingPermissions` has any. */
  readonly ciReader: Pick<PullRequestCiReader, "checkRuns" | "statuses"> | null;
  /** What reading CI back still needs, e.g. `checks:read`; never blocking. */
  readonly ciMissingPermissions: readonly string[];
  /** The installation's page on GitHub, where an admin accepts them. */
  readonly acceptUrl: string;
}

export interface MergeBackTargets {
  /**
   * The repository's target; null when it is gone or its installation is
   * unhealthy or uninstalled. `fresh` asks GitHub for the permissions even
   * when the stored ones suffice: a merge's read.
   */
  target(
    organizationId: string,
    repoId: string,
    options?: { readonly fresh?: boolean },
  ): Promise<MergeBackTarget | null>;
}

export interface MergeBackTargetsOptions {
  readonly repos: Pick<GithubRepoStore, "get">;
  readonly connections: Pick<GithubConnectionStore, "get" | "update">;
  readonly installations: InstallationTokens;
  readonly now?: () => number;
  /** For tests: the writer's GitHub. */
  readonly fetch?: typeof globalThis.fetch;
}

export function mergeBackTargets(
  options: MergeBackTargetsOptions,
): MergeBackTargets {
  const now = options.now ?? Date.now;
  /** Live reads that found something missing, by installation. */
  const refused = new Map<
    string,
    { readonly permissions: Readonly<Record<string, string>>; at: number }
  >();

  /** The installation's permissions, or null once GitHub says it is gone. */
  async function permissionsOf(
    organizationId: string,
    connection: GithubConnectionSummary,
    fresh: boolean,
  ): Promise<Readonly<Record<string, string>> | null> {
    const stored = connection.permissions;
    if (!fresh && missingPermissions(stored, ALL_PERMISSIONS).length === 0)
      return stored;
    const cached = refused.get(connection.installationId);
    if (
      !fresh &&
      cached !== undefined &&
      now() - cached.at < PERMISSIONS_TTL_MS
    )
      return cached.permissions;
    let state;
    try {
      state = await options.installations.probe(connection.installationId);
    } catch {
      // GitHub did not answer: the stored permissions decide, and a merge
      // that lacks them is refused by GitHub's own mint.
      return stored;
    }
    if (state === null) return null;
    const live = state.permissions;
    if (missingPermissions(live, ALL_PERMISSIONS).length > 0)
      refused.set(connection.installationId, { permissions: live, at: now() });
    else refused.delete(connection.installationId);
    if (!samePermissions(stored, live)) {
      // The webhook was lost or is late: tokens minted before carry the
      // old permissions.
      options.installations.forget(connection.installationId);
      await options.connections.update(organizationId, connection.id, {
        permissions: live,
      });
    }
    return live;
  }

  return {
    async target(organizationId, repoId, { fresh = false } = {}) {
      const repo = await options.repos.get(organizationId, repoId);
      if (repo === null || repo.syncStatus === "gone") return null;
      const connection = await options.connections.get(
        organizationId,
        repo.connectionId,
      );
      if (connection === null || !connection.healthy) return null;
      const permissions = await permissionsOf(
        organizationId,
        connection,
        fresh,
      );
      if (permissions === null) return null;
      const ciMissing = missingPermissions(permissions, CI_READ_PERMISSIONS);
      return {
        fullName: repo.fullName,
        defaultBranch: repo.defaultBranch,
        writer: mergeBackWriter(
          options.installations,
          connection.installationId,
          repo.externalId,
          options.fetch,
        ),
        missingPermissions: missingPermissions(
          permissions,
          MERGE_BACK_PERMISSIONS,
        ),
        ciReader:
          ciMissing.length > 0
            ? null
            : mergeCiReader(
                options.installations,
                connection.installationId,
                repo.externalId,
                options.fetch,
              ),
        ciMissingPermissions: ciMissing,
        acceptUrl: githubInstallationSettingsUrl(
          connection.accountType,
          connection.accountLogin,
          connection.installationId,
        ),
      };
    },
  };
}

function samePermissions(
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>,
): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((key) => a[key] === b[key]);
}
