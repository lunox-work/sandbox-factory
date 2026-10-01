/**
 * Reading one registered repository's pointer from GitHub and recording it.
 *
 * One routine for every caller that needs a repository's current state —
 * registration, a webhook that changed the default branch, and the reconcile
 * sweep — so they cannot disagree about what "synced" means or how a missing
 * repository is reported.
 */

import type { GithubRepoMetadata, GithubRepoStore } from "@sandbox-factory/db";
import { type GithubClient, GithubNotFound } from "@sandbox-factory/github";
import {
  type GithubRepositoryResponse,
  githubTimestamp,
} from "@sandbox-factory/shared";

/** What GitHub says about a repository, in the store's terms. */
export function repoMetadata(
  repository: GithubRepositoryResponse,
): GithubRepoMetadata {
  return {
    fullName: repository.full_name,
    // GitHub always sends it on a full repository object; `main` stands in
    // only for a payload that did not, rather than failing the whole read.
    defaultBranch: repository.default_branch ?? "main",
    // Assumed private when unsaid, which errs toward the careful reading.
    isPrivate: repository.private ?? true,
    sizeKb: repository.size ?? null,
    pushedAt: githubTimestamp(repository.pushed_at),
  };
}

/** How a sync ended, for a caller that counts or reports. */
export type SyncOutcome = "ok" | "unchanged" | "error" | "gone";

export interface SyncTarget {
  readonly organizationId: string;
  readonly repoId: string;
  readonly externalId: string;
  /** From the last read; sent as `If-None-Match`. */
  readonly headEtag: string | null;
}

/**
 * Reads a repository and its default-branch head, and records both.
 *
 * - The repository by numeric id first, so a rename or a transfer is picked
 *   up and the head is read under the current name. A 404 here is `gone`.
 * - Then the head, conditionally. A 304 records the fresh metadata and
 *   leaves the head as it was.
 * - An empty repository, or a default branch GitHub cannot find, is an
 *   `error` with a line the UI can show; the next sweep tries again.
 *
 * Anything else — a rate limit, a refused token — propagates: the caller
 * knows whether to stop a sweep or answer a request.
 *
 * `prefetched` skips the first read when the caller already holds the
 * repository from a listing.
 */
export async function syncRepo(
  repos: GithubRepoStore,
  client: GithubClient,
  target: SyncTarget,
  prefetched?: GithubRepositoryResponse,
): Promise<SyncOutcome> {
  const { organizationId, repoId } = target;

  let repository: GithubRepositoryResponse;
  try {
    repository = prefetched ?? (await client.repository(target.externalId));
  } catch (error) {
    if (error instanceof GithubNotFound) {
      await repos.markGone(organizationId, [repoId]);
      return "gone";
    }
    throw error;
  }

  const metadata = repoMetadata(repository);
  let head: Awaited<ReturnType<GithubClient["branchHead"]>>;
  try {
    head = await client.branchHead(
      metadata.fullName,
      metadata.defaultBranch,
      target.headEtag,
    );
  } catch (error) {
    if (error instanceof GithubNotFound) {
      await repos.markSyncError(
        organizationId,
        repoId,
        `The default branch ${metadata.defaultBranch} was not found.`,
      );
      return "error";
    }
    throw error;
  }

  if (head.status === "modified") {
    await repos.recordSync(organizationId, repoId, metadata, {
      sha: head.sha,
      etag: head.etag,
    });
    return "ok";
  }
  await repos.recordSync(organizationId, repoId, metadata);
  if (head.status === "empty") {
    await repos.markSyncError(
      organizationId,
      repoId,
      "The repository has no commits yet.",
    );
    return "error";
  }
  return "unchanged";
}
