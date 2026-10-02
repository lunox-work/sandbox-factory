/**
 * The GitHub connection store: installations of the App, each linked to one
 * organization.
 *
 * Owner-first like every store, with two deliberate exceptions, both reads
 * that answer "whose is this?" where no organization is in hand yet:
 *
 * - `ownerOf` — a webhook delivery names an installation and nothing else.
 *   The signature has proved the delivery is GitHub's; the installation is
 *   what says which organization it concerns.
 * - `owners` — the connect flow marks each installation a person can see as
 *   linked here, claimed elsewhere, or free. It learns *that* another
 *   organization holds one, never which, and the routes say only `claimed`.
 * - `flaggedForProbe` — the reconcile sweep, which runs for no organization,
 *   asks GitHub about every connection it has flagged. The same shape as
 *   `GithubRepoStore.dueForSync`: pointers, never contents.
 *
 * None returns a row's contents, and every write is owner-scoped.
 */

import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";

import { collectRepositoryObjects } from "./artifacts.js";
import type { Database } from "./errors.js";
import { generateId } from "./mapping.js";
import { githubConnection, githubRepo } from "./schema.js";
import type { GithubConnectionRow } from "./schema.js";

/** A connection as the API reads it. No token material exists to omit. */
export interface GithubConnectionSummary {
  readonly id: string;
  readonly installationId: string;
  readonly accountLogin: string;
  readonly accountType: string;
  readonly repositorySelection: string;
  readonly permissions: Readonly<Record<string, string>>;
  readonly healthy: boolean;
  readonly suspendedAt: string | null;
  /** When GitHub said the installation is gone; see the column. */
  readonly uninstalledAt: string | null;
  readonly createdAt: string;
}

/** A flagged connection, as the sweep's probe needs it. */
export interface GithubFlaggedConnection {
  readonly organizationId: string;
  readonly connectionId: string;
  readonly installationId: string;
}

/** What GitHub says about an installation, as linking records it. */
export interface GithubInstallationInput {
  readonly installationId: string;
  readonly accountLogin: string;
  readonly accountType: string;
  readonly repositorySelection: string;
  readonly permissions: Readonly<Record<string, string>>;
  readonly suspendedAt: string | null;
}

export type GithubLinkResult =
  | { readonly status: "linked"; readonly connection: GithubConnectionSummary }
  /** Linked to another organization. Nothing was written. */
  | { readonly status: "claimed" };

/** The fields a webhook may change on a connection. */
export interface GithubConnectionPatch {
  readonly healthy?: boolean;
  readonly suspendedAt?: string | null;
  readonly uninstalledAt?: string | null;
  readonly permissions?: Readonly<Record<string, string>>;
  readonly repositorySelection?: string;
}

export interface GithubConnectionStore {
  list(organizationId: string): Promise<GithubConnectionSummary[]>;
  get(
    organizationId: string,
    connectionId: string,
  ): Promise<GithubConnectionSummary | null>;
  /**
   * Links an installation to an organization, or refreshes the link it
   * already has.
   *
   * One statement: an insert that, on the installation's unique key, updates
   * the row **only if it is already this organization's**. A row held by
   * another organization is left exactly as it was and nothing comes back,
   * which is `claimed`. Re-linking resets `healthy` and `uninstalledAt`, so
   * reconnecting is always a way back for a connection.
   */
  link(
    organizationId: string,
    input: GithubInstallationInput,
  ): Promise<GithubLinkResult>;
  /** Whose an installation is. Cross-organization; see the file comment. */
  ownerOf(installationId: string): Promise<{
    readonly organizationId: string;
    readonly connectionId: string;
  } | null>;
  /**
   * Which organization holds each of these installations, keyed by
   * installation id. Absent means free. Cross-organization; see above.
   */
  owners(installationIds: readonly string[]): Promise<Map<string, string>>;
  /**
   * Connections flagged unhealthy but not known to be uninstalled, the
   * longest-unchanged first, across every organization. Cross-organization;
   * see the file comment.
   */
  flaggedForProbe(limit: number): Promise<GithubFlaggedConnection[]>;
  update(
    organizationId: string,
    connectionId: string,
    patch: GithubConnectionPatch,
  ): Promise<boolean>;
  /**
   * Deletes the row, and with it every repository registered from it. The
   * App stays installed on GitHub until the client removes it there.
   */
  remove(organizationId: string, connectionId: string): Promise<boolean>;
  /** Deletes the connection and returns cascaded tree, artifact and log keys. */
  removeWithTrees(
    organizationId: string,
    connectionId: string,
  ): Promise<{
    readonly removed: boolean;
    readonly treeKeys: string[];
    readonly objectKeys?: string[];
  }>;
}

export function createGithubConnectionStore(
  db: Database,
): GithubConnectionStore {
  return {
    async list(organizationId) {
      const rows = (await db
        .select()
        .from(githubConnection)
        .where(eq(githubConnection.organizationId, organizationId))
        .orderBy(desc(githubConnection.createdAt))) as GithubConnectionRow[];
      return rows.map(toSummary);
    },

    async get(organizationId, connectionId) {
      const rows = (await db
        .select()
        .from(githubConnection)
        .where(
          and(
            eq(githubConnection.organizationId, organizationId),
            eq(githubConnection.id, connectionId),
          ),
        )) as GithubConnectionRow[];
      const row = rows[0];
      return row === undefined ? null : toSummary(row);
    },

    async link(organizationId, input) {
      const suspendedAt =
        input.suspendedAt === null ? null : new Date(input.suspendedAt);
      const refreshed = {
        accountLogin: input.accountLogin,
        accountType: input.accountType,
        repositorySelection: input.repositorySelection,
        permissions: { ...input.permissions },
        // A suspended installation can be linked, but cannot mint tokens
        // until the client unsuspends it; the webhook flips this back.
        healthy: suspendedAt === null,
        suspendedAt,
        uninstalledAt: null,
        updatedAt: new Date(),
      };
      const rows = (await db
        .insert(githubConnection)
        .values({
          id: generateId("ghc"),
          organizationId,
          installationId: input.installationId,
          ...refreshed,
        })
        .onConflictDoUpdate({
          target: githubConnection.installationId,
          set: refreshed,
          setWhere: eq(githubConnection.organizationId, organizationId),
        })
        .returning()) as GithubConnectionRow[];
      const row = rows[0];
      return row === undefined
        ? { status: "claimed" }
        : { status: "linked", connection: toSummary(row) };
    },

    async ownerOf(installationId) {
      const rows = await db
        .select({
          organizationId: githubConnection.organizationId,
          connectionId: githubConnection.id,
        })
        .from(githubConnection)
        .where(eq(githubConnection.installationId, installationId));
      return rows[0] ?? null;
    },

    async owners(installationIds) {
      if (installationIds.length === 0) return new Map();
      const rows = await db
        .select({
          installationId: githubConnection.installationId,
          organizationId: githubConnection.organizationId,
        })
        .from(githubConnection)
        .where(inArray(githubConnection.installationId, [...installationIds]));
      return new Map(
        rows.map((row) => [row.installationId, row.organizationId]),
      );
    },

    async flaggedForProbe(limit) {
      return db
        .select({
          organizationId: githubConnection.organizationId,
          connectionId: githubConnection.id,
          installationId: githubConnection.installationId,
        })
        .from(githubConnection)
        .where(
          and(
            eq(githubConnection.healthy, false),
            isNull(githubConnection.uninstalledAt),
          ),
        )
        .orderBy(asc(githubConnection.updatedAt))
        .limit(limit) as Promise<GithubFlaggedConnection[]>;
    },

    async update(organizationId, connectionId, patch) {
      const rows = await db
        .update(githubConnection)
        .set({
          ...(patch.healthy === undefined ? {} : { healthy: patch.healthy }),
          ...(patch.suspendedAt === undefined
            ? {}
            : {
                suspendedAt:
                  patch.suspendedAt === null
                    ? null
                    : new Date(patch.suspendedAt),
              }),
          ...(patch.uninstalledAt === undefined
            ? {}
            : {
                uninstalledAt:
                  patch.uninstalledAt === null
                    ? null
                    : new Date(patch.uninstalledAt),
              }),
          ...(patch.permissions === undefined
            ? {}
            : { permissions: { ...patch.permissions } }),
          ...(patch.repositorySelection === undefined
            ? {}
            : { repositorySelection: patch.repositorySelection }),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(githubConnection.organizationId, organizationId),
            eq(githubConnection.id, connectionId),
          ),
        )
        .returning();
      return rows.length > 0;
    },

    async remove(organizationId, connectionId) {
      const rows = await db
        .delete(githubConnection)
        .where(
          and(
            eq(githubConnection.organizationId, organizationId),
            eq(githubConnection.id, connectionId),
          ),
        )
        .returning();
      return rows.length > 0;
    },

    async removeWithTrees(organizationId, connectionId) {
      return db.transaction(async (transaction) => {
        const tx = transaction as unknown as Database;
        const owner = and(
          eq(githubConnection.organizationId, organizationId),
          eq(githubConnection.id, connectionId),
        );
        // Block new registrations, then wait for snapshot writers already
        // holding a repository. Keys are read after those writers commit.
        const held = await tx
          .select({ id: githubConnection.id })
          .from(githubConnection)
          .where(owner)
          .for("update");
        if (held.length === 0) return { removed: false, treeKeys: [] };
        await tx
          .select({ id: githubRepo.id })
          .from(githubRepo)
          .where(
            and(
              eq(githubRepo.organizationId, organizationId),
              eq(githubRepo.connectionId, connectionId),
            ),
          )
          .for("update");
        const keys = await collectRepositoryObjects(
          tx,
          organizationId,
          eq(githubRepo.connectionId, connectionId),
        );
        await tx.delete(githubConnection).where(owner);
        return { removed: true, ...keys };
      });
    },
  };
}

function toSummary(row: GithubConnectionRow): GithubConnectionSummary {
  return {
    id: row.id,
    installationId: row.installationId,
    accountLogin: row.accountLogin,
    accountType: row.accountType,
    repositorySelection: row.repositorySelection,
    permissions: permissionsOf(row.permissions),
    healthy: row.healthy,
    suspendedAt: row.suspendedAt?.toISOString() ?? null,
    uninstalledAt: row.uninstalledAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The stored `jsonb`, read defensively: only string values survive. */
function permissionsOf(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== "object" || value === null) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}
