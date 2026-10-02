/**
 * The repository snapshot store: one row per commit of a source repository
 * that the platform has read the tree of.
 *
 * Owner-first like every store, though the table has no owner column: every
 * read joins `github_repo` and filters on its `organization_id`, and every
 * write is reached through such a read or locks the repository row first.
 *
 * Rows are immutable. A new head is a new row; nothing here updates one.
 */

import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { TreeFacts } from "sandbox-factory";

import type { Database } from "./errors.js";
import { generateId } from "./mapping.js";
import { bountyProposal, githubRepo, repoSnapshot } from "./schema.js";
import type { RepoSnapshotRow } from "./schema.js";

/** A snapshot as lists show it: everything but the facts. */
export interface RepoSnapshotSummary {
  readonly id: string;
  readonly repoId: string;
  readonly commitSha: string;
  readonly ref: string;
  readonly treeSha: string;
  /** Where the file list is, in the private bucket. Never sent to a browser. */
  readonly treeKey: string;
  readonly treeTruncated: boolean;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly languages: Readonly<Record<string, number>>;
  readonly createdAt: string;
}

/** One snapshot in full, with the repository's current name. */
export interface StoredRepoSnapshot extends RepoSnapshotSummary {
  readonly repoFullName: string;
  readonly facts: TreeFacts;
}

export interface NewRepoSnapshot {
  readonly repoId: string;
  readonly commitSha: string;
  readonly ref: string;
  readonly treeSha: string;
  readonly treeKey: string;
  readonly treeTruncated: boolean;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly languages: Readonly<Record<string, number>>;
  readonly facts: TreeFacts;
}

/**
 * - `created` — the row is new.
 * - `exists` — this commit was already snapshotted, by this call's twin
 *   (the webhook and the sweep can see one head within seconds) or earlier.
 * - `refused` — the repository is absent, another organization's, or
 *   `gone`: a read already on the wire when the App was uninstalled must
 *   not leave a snapshot behind, as `recordSync` must not leave a head.
 */
export type CreateRepoSnapshotResult =
  | { readonly status: "created"; readonly snapshot: RepoSnapshotSummary }
  | { readonly status: "exists" | "refused" };

export interface RepoSnapshotStore {
  /** A repository's snapshots, newest first. */
  list(
    organizationId: string,
    repoId: string,
    limit: number,
  ): Promise<RepoSnapshotSummary[]>;
  get(
    organizationId: string,
    snapshotId: string,
  ): Promise<StoredRepoSnapshot | null>;
  /** The snapshot of one commit, if it was taken. */
  findByCommit(
    organizationId: string,
    repoId: string,
    commitSha: string,
  ): Promise<RepoSnapshotSummary | null>;
  /**
   * The snapshot to read a repository by now: the one of its current head
   * when there is one, else the most recently taken. A snapshot of an older
   * head can finish after a newer one's, so recency alone could pick a
   * commit the branch has already left.
   */
  current(
    organizationId: string,
    repoId: string,
  ): Promise<StoredRepoSnapshot | null>;
  create(
    organizationId: string,
    input: NewRepoSnapshot,
  ): Promise<CreateRepoSnapshotResult>;
  /**
   * Deletes a repository's snapshots past the newest `keep` that nothing
   * references, and returns their tree keys so the caller can remove the
   * objects. A snapshot a proposal was drafted beside is kept whatever its
   * age: it is the record of what that proposal read.
   */
  prune(
    organizationId: string,
    repoId: string,
    keep: number,
  ): Promise<string[]>;
}

/** No proposal points at the snapshot. Raw so it costs the fake no query. */
const unreferenced = sql`not exists (select 1 from ${bountyProposal} where ${bountyProposal.repoSnapshotId} = ${repoSnapshot.id})`;

export function createRepoSnapshotStore(db: Database): RepoSnapshotStore {
  const owned = (organizationId: string) =>
    eq(githubRepo.organizationId, organizationId);

  const joined = () =>
    db
      .select({ snapshot: repoSnapshot, repoFullName: githubRepo.fullName })
      .from(repoSnapshot)
      .innerJoin(githubRepo, eq(githubRepo.id, repoSnapshot.repoId));

  return {
    async list(organizationId, repoId, limit) {
      const rows = (await joined()
        .where(and(owned(organizationId), eq(repoSnapshot.repoId, repoId)))
        .orderBy(desc(repoSnapshot.createdAt), desc(repoSnapshot.id))
        .limit(limit)) as Joined[];
      return rows.map(({ snapshot }) => toSummary(snapshot));
    },

    async get(organizationId, snapshotId) {
      const rows = (await joined().where(
        and(owned(organizationId), eq(repoSnapshot.id, snapshotId)),
      )) as Joined[];
      const row = rows[0];
      return row === undefined ? null : toStored(row);
    },

    async findByCommit(organizationId, repoId, commitSha) {
      const rows = (await joined().where(
        and(
          owned(organizationId),
          eq(repoSnapshot.repoId, repoId),
          eq(repoSnapshot.commitSha, commitSha),
        ),
      )) as Joined[];
      const row = rows[0];
      return row === undefined ? null : toSummary(row.snapshot);
    },

    async current(organizationId, repoId) {
      const rows = (await joined()
        .where(and(owned(organizationId), eq(repoSnapshot.repoId, repoId)))
        .orderBy(
          sql`(${repoSnapshot.commitSha} = ${githubRepo.headSha}) desc nulls last`,
          desc(repoSnapshot.createdAt),
          desc(repoSnapshot.id),
        )
        .limit(1)) as Joined[];
      const row = rows[0];
      return row === undefined ? null : toStored(row);
    },

    async create(organizationId, input) {
      return db.transaction(async (transaction) => {
        const tx = transaction as unknown as Database;
        // This UPDATE is the row lock: a `markGone` waits for the insert,
        // or the insert sees the repository already gone.
        const live = await tx
          .update(githubRepo)
          .set({ updatedAt: sql`${githubRepo.updatedAt}` })
          .where(
            and(
              owned(organizationId),
              eq(githubRepo.id, input.repoId),
              ne(githubRepo.syncStatus, "gone"),
            ),
          )
          .returning({ id: githubRepo.id });
        if (live.length === 0) return { status: "refused" } as const;

        const rows = (await tx
          .insert(repoSnapshot)
          .values({
            id: generateId("rsn"),
            repoId: input.repoId,
            commitSha: input.commitSha,
            ref: input.ref,
            treeSha: input.treeSha,
            treeKey: input.treeKey,
            treeTruncated: input.treeTruncated,
            fileCount: input.fileCount,
            totalBytes: input.totalBytes,
            languages: { ...input.languages },
            facts: input.facts,
          })
          .onConflictDoNothing({
            target: [repoSnapshot.repoId, repoSnapshot.commitSha],
          })
          .returning()) as RepoSnapshotRow[];
        const row = rows[0];
        return row === undefined
          ? ({ status: "exists" } as const)
          : ({ status: "created", snapshot: toSummary(row) } as const);
      });
    },

    async prune(organizationId, repoId, keep) {
      // Read first, through the owner: the delete then names only rows the
      // owner was shown to hold.
      const surplus = (await db
        .select({ id: repoSnapshot.id })
        .from(repoSnapshot)
        .innerJoin(githubRepo, eq(githubRepo.id, repoSnapshot.repoId))
        .where(
          and(
            owned(organizationId),
            eq(repoSnapshot.repoId, repoId),
            unreferenced,
          ),
        )
        .orderBy(desc(repoSnapshot.createdAt), desc(repoSnapshot.id))
        .offset(Math.max(0, keep))) as { id: string }[];
      if (surplus.length === 0) return [];

      return db.transaction(async (transaction) => {
        const tx = transaction as unknown as Database;
        // Wait for a proposal writer holding KEY SHARE, then check references
        // in a fresh statement snapshot. A DELETE that checks before waiting
        // can otherwise miss the proposal that commits while it is blocked.
        await tx
          .select({ id: repoSnapshot.id })
          .from(repoSnapshot)
          .innerJoin(githubRepo, eq(githubRepo.id, repoSnapshot.repoId))
          .where(
            and(
              owned(organizationId),
              eq(repoSnapshot.repoId, repoId),
              inArray(
                repoSnapshot.id,
                surplus.map(({ id }) => id),
              ),
            ),
          )
          .for("update", { of: repoSnapshot });
        const removed = (await tx
          .delete(repoSnapshot)
          .where(
            and(
              eq(repoSnapshot.repoId, repoId),
              inArray(
                repoSnapshot.id,
                surplus.map(({ id }) => id),
              ),
              unreferenced,
            ),
          )
          .returning({ treeKey: repoSnapshot.treeKey })) as {
          treeKey: string;
        }[];
        return removed.map(({ treeKey }) => treeKey);
      });
    },
  };
}

interface Joined {
  readonly snapshot: RepoSnapshotRow;
  readonly repoFullName: string;
}

function toSummary(row: RepoSnapshotRow): RepoSnapshotSummary {
  return {
    id: row.id,
    repoId: row.repoId,
    commitSha: row.commitSha,
    ref: row.ref,
    treeSha: row.treeSha,
    treeKey: row.treeKey,
    treeTruncated: row.treeTruncated,
    fileCount: row.fileCount,
    totalBytes: row.totalBytes,
    languages: row.languages,
    createdAt: row.createdAt.toISOString(),
  };
}

function toStored({ snapshot, repoFullName }: Joined): StoredRepoSnapshot {
  return { ...toSummary(snapshot), repoFullName, facts: snapshot.facts };
}
