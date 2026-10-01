/**
 * The GitHub repository store: registered repositories, as pointers.
 *
 * A row records which repository (GitHub's numeric id, which survives renames
 * and transfers), what it is called now, and the commit its default branch
 * was last seen at. Two writers keep that commit current: the webhook, within
 * seconds of a push, and the reconcile sweep, every fifteen minutes, for
 * whatever the webhook missed.
 *
 * Owner-first throughout, except `dueForSync`, which the sweep calls with no
 * organization in hand — the same shape as the bounty watchdog's
 * `organizationsWithExpiredRuns`. It returns pointers, never contents, and
 * every write the sweep then makes is owner-scoped.
 */

import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";

import type { Database } from "./errors.js";
import { generateId } from "./mapping.js";
import { githubConnection, githubRepo } from "./schema.js";
import type { GithubRepoRow } from "./schema.js";

/** A registered repository, as the UI lists it. */
export interface GithubRepoSummary {
  readonly id: string;
  readonly connectionId: string;
  readonly role: "source";
  readonly externalId: string;
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly isPrivate: boolean;
  readonly sizeKb: number | null;
  readonly headSha: string | null;
  readonly pushedAt: string | null;
  readonly lastSyncedAt: string | null;
  readonly syncStatus: "pending" | "ok" | "error" | "gone";
  readonly syncError: string | null;
  readonly createdAt: string;
}

/** What GitHub says about a repository, as a sync records it. */
export interface GithubRepoMetadata {
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly isPrivate: boolean;
  readonly sizeKb: number | null;
  readonly pushedAt: string | null;
}

export interface RegisterGithubRepoInput extends GithubRepoMetadata {
  readonly connectionId: string;
  readonly externalId: string;
  readonly role: "source";
}

/** A repository the sweep should read, and how to reach it. */
export interface DueGithubRepo {
  readonly organizationId: string;
  readonly id: string;
  readonly connectionId: string;
  readonly installationId: string;
  readonly externalId: string;
  readonly headEtag: string | null;
}

export interface GithubRepoStore {
  list(organizationId: string): Promise<GithubRepoSummary[]>;
  get(
    organizationId: string,
    repoId: string,
  ): Promise<GithubRepoSummary | null>;
  /** The registered row for a repository of one connection, if any. */
  findByExternalId(
    organizationId: string,
    connectionId: string,
    externalId: string,
  ): Promise<GithubRepoSummary | null>;
  /**
   * Registers a repository, or refreshes one registered before (including a
   * `gone` one, which comes back `pending`). The caller has already checked
   * the connection is this organization's.
   */
  register(
    organizationId: string,
    input: RegisterGithubRepoInput,
  ): Promise<GithubRepoSummary>;
  /**
   * Records a completed read: fresh metadata, `ok`, and — when the branch
   * head was read rather than answered 304 — the new head and its ETag.
   *
   * Unconditional on the head, unlike `setHead`: this reads GitHub's current
   * state, and if a push lands between the read and the write the next
   * sweep's ETag no longer matches, so the row heals within one interval.
   *
   * Never applies to a `gone` row, nor does `setHead` or `markSyncError`: a
   * read that was already on the wire when the App was uninstalled must not
   * bring the row back as `ok`, because the sweep skips the now-unhealthy
   * connection and nothing would ever correct it. `register` and `revive`
   * are the only ways out of `gone`. `null` when the row is gone or absent.
   */
  recordSync(
    organizationId: string,
    repoId: string,
    metadata: GithubRepoMetadata,
    head?: { readonly sha: string; readonly etag: string | null },
  ): Promise<GithubRepoSummary | null>;
  /**
   * A push to the default branch. Guarded so a delivery that arrives late
   * cannot move the head backwards: it applies only when its `pushedAt` is
   * no older than the one recorded.
   *
   * GitHub's `pushed_at` has one-second precision, so two pushes in the same
   * second cannot be ordered by it. An equal one still applies, but leaves
   * the row due for the next sweep (`last_synced_at` cleared), which reads
   * the branch itself rather than trusting delivery order.
   */
  setHead(
    organizationId: string,
    repoId: string,
    head: { readonly headSha: string; readonly pushedAt: string | null },
  ): Promise<boolean>;
  /** A rename, a transfer, a new default branch, a visibility change. */
  update(
    organizationId: string,
    repoId: string,
    patch: Partial<
      Pick<GithubRepoMetadata, "fullName" | "defaultBranch" | "isPrivate">
    >,
  ): Promise<boolean>;
  markGone(organizationId: string, repoIds: readonly string[]): Promise<number>;
  /** Every repository of a connection, when the App is uninstalled. */
  markGoneForConnection(
    organizationId: string,
    connectionId: string,
  ): Promise<number>;
  /** Puts a `gone` repository back to `pending`, when it is re-added. */
  revive(organizationId: string, repoIds: readonly string[]): Promise<number>;
  /**
   * A failed read, in one line. Also stamps `last_synced_at`, so a repository
   * that keeps failing is retried once per interval rather than every sweep.
   */
  markSyncError(
    organizationId: string,
    repoId: string,
    message: string,
  ): Promise<boolean>;
  /**
   * Repositories not read since `staleBefore`, on healthy connections,
   * oldest first. Cross-organization; see the file comment.
   */
  dueForSync(staleBefore: Date, limit: number): Promise<DueGithubRepo[]>;
  remove(organizationId: string, repoId: string): Promise<boolean>;
}

/** Errors are one line and short: they are shown in a table cell. */
const SYNC_ERROR_MAX = 200;

export function createGithubRepoStore(db: Database): GithubRepoStore {
  /** Owned, and not `gone`; see `recordSync`. */
  const live = (organizationId: string, repoId: string) =>
    and(owned(organizationId, repoId), ne(githubRepo.syncStatus, "gone"));
  const owned = (organizationId: string, repoId: string) =>
    and(
      eq(githubRepo.organizationId, organizationId),
      eq(githubRepo.id, repoId),
    );

  return {
    async list(organizationId) {
      const rows = (await db
        .select()
        .from(githubRepo)
        .where(eq(githubRepo.organizationId, organizationId))
        .orderBy(asc(githubRepo.fullName))) as GithubRepoRow[];
      return rows.map(toSummary);
    },

    async get(organizationId, repoId) {
      const rows = (await db
        .select()
        .from(githubRepo)
        .where(owned(organizationId, repoId))) as GithubRepoRow[];
      const row = rows[0];
      return row === undefined ? null : toSummary(row);
    },

    async findByExternalId(organizationId, connectionId, externalId) {
      const rows = (await db
        .select()
        .from(githubRepo)
        .where(
          and(
            eq(githubRepo.organizationId, organizationId),
            eq(githubRepo.connectionId, connectionId),
            eq(githubRepo.externalId, externalId),
          ),
        )) as GithubRepoRow[];
      const row = rows[0];
      return row === undefined ? null : toSummary(row);
    },

    async register(organizationId, input) {
      const refreshed = {
        role: input.role,
        ...metadataColumns(input),
        syncStatus: "pending",
        syncError: null,
        updatedAt: new Date(),
      };
      const rows = (await db
        .insert(githubRepo)
        .values({
          id: generateId("ghr"),
          organizationId,
          connectionId: input.connectionId,
          externalId: input.externalId,
          ...refreshed,
        })
        .onConflictDoUpdate({
          target: [githubRepo.connectionId, githubRepo.externalId],
          set: refreshed,
          // A connection is one organization's, so this always holds; it is
          // here so that a caller that skipped the connection check cannot
          // reach another organization's row through the conflict branch.
          setWhere: eq(githubRepo.organizationId, organizationId),
        })
        .returning()) as GithubRepoRow[];
      const row = rows[0];
      if (row === undefined) {
        throw new Error("Failed to register the repository.");
      }
      return toSummary(row);
    },

    async recordSync(organizationId, repoId, metadata, head) {
      const now = new Date();
      const rows = (await db
        .update(githubRepo)
        .set({
          ...metadataColumns(metadata),
          ...(head === undefined
            ? {}
            : { headSha: head.sha, headEtag: head.etag }),
          syncStatus: "ok",
          syncError: null,
          lastSyncedAt: now,
          updatedAt: now,
        })
        .where(live(organizationId, repoId))
        .returning()) as GithubRepoRow[];
      const row = rows[0];
      return row === undefined ? null : toSummary(row);
    },

    async setHead(organizationId, repoId, head) {
      const now = new Date();
      const pushedAt = head.pushedAt === null ? null : new Date(head.pushedAt);
      const rows = await db
        .update(githubRepo)
        .set({
          headSha: head.headSha,
          // The ETag described the old head; a stale one would make the next
          // sweep's conditional read answer 304 about a ref that has moved.
          headEtag: null,
          ...(pushedAt === null ? {} : { pushedAt }),
          syncStatus: "ok",
          syncError: null,
          // Compared with the row's *old* `pushed_at`, as every expression in
          // a SET is. ISO strings, not Dates: postgres-js cannot bind a Date
          // inside a `sql` template.
          lastSyncedAt:
            pushedAt === null
              ? now
              : sql`case when ${githubRepo.pushedAt} = ${pushedAt.toISOString()}::timestamptz then null else ${now.toISOString()}::timestamptz end`,
          updatedAt: now,
        })
        .where(
          and(
            live(organizationId, repoId),
            pushedAt === null
              ? undefined
              : or(
                  isNull(githubRepo.pushedAt),
                  lte(githubRepo.pushedAt, pushedAt),
                ),
          ),
        )
        .returning();
      return rows.length > 0;
    },

    async update(organizationId, repoId, patch) {
      const rows = await db
        .update(githubRepo)
        .set({
          ...(patch.fullName === undefined ? {} : { fullName: patch.fullName }),
          ...(patch.defaultBranch === undefined
            ? {}
            : { defaultBranch: patch.defaultBranch }),
          ...(patch.isPrivate === undefined
            ? {}
            : { isPrivate: patch.isPrivate }),
          updatedAt: new Date(),
        })
        .where(owned(organizationId, repoId))
        .returning();
      return rows.length > 0;
    },

    async markGone(organizationId, repoIds) {
      if (repoIds.length === 0) return 0;
      const rows = await db
        .update(githubRepo)
        .set({ syncStatus: "gone", updatedAt: new Date() })
        .where(
          and(
            eq(githubRepo.organizationId, organizationId),
            inArray(githubRepo.id, [...repoIds]),
          ),
        )
        .returning();
      return rows.length;
    },

    async markGoneForConnection(organizationId, connectionId) {
      const rows = await db
        .update(githubRepo)
        .set({ syncStatus: "gone", updatedAt: new Date() })
        .where(
          and(
            eq(githubRepo.organizationId, organizationId),
            eq(githubRepo.connectionId, connectionId),
          ),
        )
        .returning();
      return rows.length;
    },

    async revive(organizationId, repoIds) {
      if (repoIds.length === 0) return 0;
      const rows = await db
        .update(githubRepo)
        .set({ syncStatus: "pending", syncError: null, updatedAt: new Date() })
        .where(
          and(
            eq(githubRepo.organizationId, organizationId),
            inArray(githubRepo.id, [...repoIds]),
            eq(githubRepo.syncStatus, "gone"),
          ),
        )
        .returning();
      return rows.length;
    },

    async markSyncError(organizationId, repoId, message) {
      const now = new Date();
      const rows = await db
        .update(githubRepo)
        .set({
          syncStatus: "error",
          syncError: oneLine(message),
          lastSyncedAt: now,
          updatedAt: now,
        })
        .where(live(organizationId, repoId))
        .returning();
      return rows.length > 0;
    },

    async dueForSync(staleBefore, limit) {
      return (
        db
          .select({
            organizationId: githubRepo.organizationId,
            id: githubRepo.id,
            connectionId: githubRepo.connectionId,
            installationId: githubConnection.installationId,
            externalId: githubRepo.externalId,
            headEtag: githubRepo.headEtag,
          })
          .from(githubRepo)
          .innerJoin(
            githubConnection,
            eq(githubConnection.id, githubRepo.connectionId),
          )
          .where(
            and(
              eq(githubConnection.healthy, true),
              inArray(githubRepo.syncStatus, ["pending", "ok", "error"]),
              or(
                isNull(githubRepo.lastSyncedAt),
                lt(githubRepo.lastSyncedAt, staleBefore),
              ),
            ),
          )
          // Never-synced first, then the longest-waiting.
          .orderBy(sql`${githubRepo.lastSyncedAt} asc nulls first`)
          .limit(limit)
      );
    },

    async remove(organizationId, repoId) {
      const rows = await db
        .delete(githubRepo)
        .where(owned(organizationId, repoId))
        .returning();
      return rows.length > 0;
    },
  };
}

function metadataColumns(metadata: GithubRepoMetadata) {
  return {
    fullName: metadata.fullName,
    defaultBranch: metadata.defaultBranch,
    isPrivate: metadata.isPrivate,
    sizeKb: metadata.sizeKb,
    pushedAt: metadata.pushedAt === null ? null : new Date(metadata.pushedAt),
  };
}

function oneLine(message: string): string {
  const line = message.replace(/\s+/g, " ").trim();
  return line.length > SYNC_ERROR_MAX
    ? `${line.slice(0, SYNC_ERROR_MAX - 1)}…`
    : line;
}

const SYNC_STATUSES = ["pending", "ok", "error", "gone"] as const;

function toSummary(row: GithubRepoRow): GithubRepoSummary {
  return {
    id: row.id,
    connectionId: row.connectionId,
    // `source` is the only role this phase writes; see `shared`.
    role: "source",
    externalId: row.externalId,
    fullName: row.fullName,
    defaultBranch: row.defaultBranch,
    isPrivate: row.isPrivate,
    sizeKb: row.sizeKb,
    headSha: row.headSha,
    pushedAt: row.pushedAt?.toISOString() ?? null,
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
    // Read defensively: a value this code never writes reads as an error
    // the UI can show, rather than one it cannot render.
    syncStatus:
      SYNC_STATUSES.find((status) => status === row.syncStatus) ?? "error",
    syncError: row.syncError,
    createdAt: row.createdAt.toISOString(),
  };
}
