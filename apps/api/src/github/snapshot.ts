/**
 * Repository snapshots: the tree at each head a source repository is seen
 * at, and the facts drawn from it.
 *
 * Every writer of a head asks for one — registering a repository, a push,
 * a default-branch change, the reconcile sweep — and a snapshot is taken
 * when none exists yet for that `(repository, commit)`. Taking one reads the
 * recursive tree and the language totals with a token narrowed to that
 * repository and to reads, writes the file list gzipped to
 * `trees/<repoId>/<sha>/<objectId>.json.gz`, computes `TreeFacts`, and inserts
 * the row. Each attempt owns a different object, so delayed pruning cannot
 * delete a later snapshot of the same commit.
 *
 * **Pointers only.** Paths, sizes and Git's object ids, never a file's
 * contents; the tree endpoint does not send any. Beside each snapshot the
 * repository's tech stack is detected (`stack.ts`), which reads a capped
 * set of dependency manifests and keeps only the names found in them, on
 * the repository row. A snapshot that already exists has its stack redone
 * when the stack was found at another commit or by an older detection, so
 * the sweep brings every repository up to date within one interval.
 *
 * **The commit is read once, at the start.** Everything after describes
 * that commit, whatever the branch does meanwhile; a newer head is a newer
 * snapshot, asked for by whatever saw it move.
 *
 * **Off the request path.** A large tree takes seconds to send, longer than
 * GitHub gives a webhook delivery and longer than a person should wait on a
 * button. `schedule` queues the work, coalescing repeats for one repository,
 * and runs a few at a time; a job that fails is reported and left for the
 * sweep, which asks again for every repository it reads, so a lost one is
 * retried within one interval. Asking costs one indexed read when the
 * snapshot already exists.
 */

import { randomUUID } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

import type {
  GithubRepoStore,
  ObjectStore,
  RepoSnapshotStore,
} from "@sandbox-factory/db";
import {
  GithubAppAuthError,
  GithubAuthError,
  GithubInstallationUnavailable,
  GithubNotFound,
  GithubRateLimited,
  type InstallationTokens,
} from "@sandbox-factory/github";
import {
  STORED_TREE_VERSION,
  type StoredTree,
  type StoredTreeEntry,
  storedTreeSchema,
} from "@sandbox-factory/shared";
import { STACK_DETECTION_VERSION, treeFacts } from "sandbox-factory";

import { installationClient } from "./credential.js";
import { readStack } from "./stack.js";

/** Unreferenced snapshots kept per repository; older ones are pruned. */
export const SNAPSHOT_RETAIN = 20;
/** Snapshots taken at once, across every repository. */
export const SNAPSHOT_CONCURRENCY = 2;

/** Where a snapshot's file list lives in the private bucket. */
export function treeKey(
  repoId: string,
  commitSha: string,
  objectId: string,
): string {
  return `trees/${repoId}/${commitSha}/${objectId}.json.gz`;
}

export interface SnapshotTarget {
  readonly organizationId: string;
  readonly repoId: string;
  /** The repository's connection's installation, to mint with. */
  readonly installationId: string;
  /**
   * A commit another branch was seen at, asked for by a person pulling that
   * branch. Absent, the job takes the default branch's head as it is when
   * the job starts.
   */
  readonly commit?: { readonly sha: string; readonly branch: string };
}

/**
 * - `created` — a new snapshot of the head.
 * - `exists` — that head was already snapshotted.
 * - `refused` — the repository is absent, `gone`, or was gone by the time
 *   the row was written. Nothing is read from GitHub for one already gone.
 * - `no-head` — not read yet, or empty: there is no commit to snapshot.
 */
export type SnapshotOutcome = "created" | "exists" | "refused" | "no-head";

export interface GithubSnapshotterOptions {
  readonly repos: Pick<GithubRepoStore, "get" | "recordStack">;
  readonly snapshots: RepoSnapshotStore;
  readonly objects: Pick<ObjectStore, "put" | "get" | "remove">;
  readonly installations: InstallationTokens;
  readonly fetch?: typeof globalThis.fetch;
  readonly retain?: number;
  readonly concurrency?: number;
  /**
   * A job that failed, or an object that could not be removed. `detail` is
   * the error's name and message, never a path from the repository.
   */
  readonly onError?: (code: string, detail?: string) => void;
}

export class GithubSnapshotter {
  readonly #options: GithubSnapshotterOptions;
  /** Repositories waiting for a turn, by `org\nrepo\nbranch`; `branch` empty for the head. */
  readonly #pending = new Map<string, SnapshotTarget>();
  readonly #running = new Set<string>();
  #waiters: (() => void)[] = [];
  #stopping = false;

  constructor(options: GithubSnapshotterOptions) {
    this.#options = options;
  }

  /**
   * Asks for a snapshot of the repository's head, in the background, or of
   * the branch commit the target names.
   *
   * Asking again while one is waiting changes nothing: the job reads the
   * head when it starts, so it takes whichever head is newest by then.
   * Asking while one is running queues one more turn, for a head that may
   * have moved since that run read it. Each branch waits in its own line,
   * the newest commit asked for replacing an older one still waiting.
   */
  schedule(target: SnapshotTarget): void {
    if (this.#stopping) return;
    this.#pending.set(keyOf(target), target);
    this.#pump();
  }

  /** Resolves once nothing is waiting or running. */
  idle(): Promise<void> {
    if (this.#pending.size === 0 && this.#running.size === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  /** Takes no more work, and resolves once the jobs running have finished. */
  async stop(): Promise<void> {
    this.#stopping = true;
    this.#pending.clear();
    await this.idle();
  }

  /** Takes the snapshot now, if one is due. Errors from GitHub propagate. */
  async snapshot(target: SnapshotTarget): Promise<SnapshotOutcome> {
    const { repos, snapshots, objects, installations } = this.#options;
    const { organizationId, repoId } = target;

    const repo = await repos.get(organizationId, repoId);
    if (repo === null || repo.syncStatus === "gone") return "refused";
    const commitSha = target.commit?.sha ?? repo.headSha;
    if (commitSha === null) return "no-head";
    // The stack is the repository's at its default branch's head; another
    // branch's commit is snapshotted without touching it.
    const atHead = commitSha === repo.headSha;
    const client = installationClient(
      installations,
      target.installationId,
      { kind: "repository", repositoryId: repo.externalId },
      this.#options.fetch,
    );
    const existing = await snapshots.findByCommit(
      organizationId,
      repoId,
      commitSha,
    );
    if (existing !== null) {
      if (
        atHead &&
        (repo.stackCommitSha !== commitSha ||
          repo.stackVersion !== STACK_DETECTION_VERSION)
      ) {
        const stored = await this.tree(existing.treeKey);
        if (stored === null) {
          this.#report(
            "github_stack_failed",
            new Error("The snapshot's tree could not be read."),
          );
        } else {
          await this.#detectStack(target, client, repo.fullName, commitSha, {
            entries: stored.entries,
            languages: existing.languages,
          });
        }
      }
      return "exists";
    }

    const [tree, languages] = await Promise.all([
      client.tree(repo.fullName, commitSha, { recursive: true }),
      client.languages(repo.fullName),
    ]);

    const truncated = tree.truncated === true;
    const entries = storedEntries(tree.tree);
    const stored: StoredTree = {
      version: STORED_TREE_VERSION,
      commitSha,
      treeSha: tree.sha,
      truncated,
      entries,
    };
    const key = treeKey(repoId, commitSha, randomUUID());
    // The object before the row, so a row never names a missing object.
    await objects.put(key, gzipSync(JSON.stringify(stored)), {
      contentType: "application/gzip",
    });

    const facts = treeFacts(entries, { truncated });
    const created = await snapshots
      .create(organizationId, {
        repoId,
        commitSha,
        ref: `refs/heads/${target.commit?.branch ?? repo.defaultBranch}`,
        treeSha: tree.sha,
        treeKey: key,
        treeTruncated: truncated,
        fileCount: facts.fileCount,
        totalBytes: facts.totalBytes,
        languages,
        facts,
      })
      .catch(async (error: unknown) => {
        // A lost COMMIT response can throw after the row was written.
        // Remove only when a read proves this object is not the row's.
        try {
          const found = await snapshots.findByCommit(
            organizationId,
            repoId,
            commitSha,
          );
          if (found?.treeKey !== key) await this.removeObjects([key]);
        } catch {
          // The database cannot confirm ownership; keep the object rather
          // than risk removing a successfully committed snapshot's tree.
        }
        throw error;
      });
    if (created.status !== "created") {
      // A competing insert or a removal won. Only this attempt's object
      // goes; it cannot be the winning row's object.
      await this.removeObjects([key]);
      return created.status;
    }

    if (atHead)
      await this.#detectStack(target, client, repo.fullName, commitSha, {
        entries,
        languages,
      });
    await this.#prune(organizationId, repoId);
    return "created";
  }

  /**
   * Detects the stack at a commit and records it on the repository. A
   * failure is reported and left for the next sweep, which finds the stack
   * still due; the snapshot it rides on stands either way.
   */
  async #detectStack(
    target: SnapshotTarget,
    client: Parameters<typeof readStack>[0],
    fullName: string,
    commitSha: string,
    source: {
      readonly entries: readonly StoredTreeEntry[];
      readonly languages: Readonly<Record<string, number>>;
    },
  ): Promise<void> {
    try {
      const stack = await readStack(
        client,
        fullName,
        source.entries,
        source.languages,
      );
      await this.#options.repos.recordStack(
        target.organizationId,
        target.repoId,
        { stack, commitSha, version: STACK_DETECTION_VERSION },
      );
    } catch (error) {
      this.#report("github_stack_failed", error);
    }
  }

  /**
   * A snapshot's file list, read back from the bucket. Null when the object
   * is missing or is not a tree this code wrote.
   */
  async tree(treeKeyOf: string): Promise<StoredTree | null> {
    const body = await this.#options.objects.get(treeKeyOf);
    if (body === undefined) return null;
    try {
      const parsed = storedTreeSchema.safeParse(
        JSON.parse(gunzipSync(body).toString("utf8")) as unknown,
      );
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /**
   * Removes the objects of snapshots that are going with their repository.
   * Best effort, like pruning: an object left behind costs storage, not
   * correctness, since nothing reads a tree but through its row.
   */
  async removeObjects(keys: readonly string[]): Promise<void> {
    await Promise.all(
      keys.map((key) =>
        this.#options.objects
          .remove(key)
          .catch((error: unknown) =>
            this.#report("github_snapshot_remove_failed", error),
          ),
      ),
    );
  }

  async #prune(organizationId: string, repoId: string): Promise<void> {
    try {
      // At least one: the snapshot just taken, which is newest; pruning it
      // would only have the next sweep, or the next pull, take it again.
      const removed = await this.#options.snapshots.prune(
        organizationId,
        repoId,
        Math.max(1, this.#options.retain ?? SNAPSHOT_RETAIN),
      );
      await this.removeObjects(removed);
    } catch (error) {
      // The snapshot is taken; a prune that failed runs again next time.
      this.#report("github_snapshot_prune_failed", error);
    }
  }

  #pump(): void {
    const limit = this.#options.concurrency ?? SNAPSHOT_CONCURRENCY;
    for (const [key, target] of this.#pending) {
      if (this.#running.size >= limit) break;
      // One run per repository at a time; this one waits its turn.
      if (this.#running.has(key)) continue;
      this.#pending.delete(key);
      this.#running.add(key);
      void this.snapshot(target)
        .catch((error: unknown) => this.#report(codeFor(error), error))
        .finally(() => {
          this.#running.delete(key);
          if (!this.#stopping) this.#pump();
          if (this.#pending.size === 0 && this.#running.size === 0) {
            const waiters = this.#waiters;
            this.#waiters = [];
            for (const resolve of waiters) resolve();
          }
        });
    }
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

/**
 * The tree's files and submodules, path order. Directories are left out:
 * every path names its own. A blob without a size (GitHub always sends
 * one) counts as zero rather than failing the snapshot.
 */
export function storedEntries(
  tree: readonly {
    path: string;
    mode: string;
    type: string;
    sha: string;
    size?: number | undefined;
  }[],
): StoredTreeEntry[] {
  return tree
    .filter(
      (entry): entry is typeof entry & { type: "blob" | "commit" } =>
        entry.type === "blob" || entry.type === "commit",
    )
    .map((entry) => ({
      path: entry.path,
      type: entry.type,
      mode: entry.mode,
      sha: entry.sha,
      size:
        entry.type === "blob" &&
        typeof entry.size === "number" &&
        Number.isSafeInteger(entry.size) &&
        entry.size > 0
          ? entry.size
          : 0,
    }))
    .sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
}

function keyOf(target: SnapshotTarget): string {
  return `${target.organizationId}\n${target.repoId}\n${target.commit?.branch ?? ""}`;
}

/**
 * A fixed code per kind of failure, for the operator's log. None of them
 * flags anything: the sweep reads the same repository with the same token
 * and is what marks it gone or its connection unhealthy.
 */
function codeFor(error: unknown): string {
  if (error instanceof GithubNotFound) return "github_snapshot_not_found";
  if (error instanceof GithubRateLimited) return "github_snapshot_rate_limited";
  if (
    error instanceof GithubInstallationUnavailable ||
    error instanceof GithubAuthError ||
    error instanceof GithubAppAuthError
  ) {
    return "github_snapshot_refused";
  }
  return "github_snapshot_failed";
}
