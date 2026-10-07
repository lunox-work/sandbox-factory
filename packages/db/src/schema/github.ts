/**
 * GitHub: an organization's installations of the App, the people who granted
 * it their own authorization, and the repositories registered from them.
 *
 * Pointers only. A repository row is a numeric id, a name and the commit its
 * default branch points at — never contents. Installation tokens are minted
 * per call and never stored, so the only credential at rest here is a
 * person's user-to-server grant, encrypted as Jira's tokens are.
 */

import { sql } from "drizzle-orm";
import {
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

import { user } from "./auth.js";
import { organization } from "./organizations.js";

const ts = (name: string) => timestamp(name, { withTimezone: true });

/** The owner column every table here carries and every store filters on. */
const owner = () =>
  text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" });

/**
 * One installation of the App, linked to one organization.
 *
 * `installation_id` is unique across the whole table, not per organization:
 * an installation belongs to exactly one of our organizations, and the
 * constraint is what makes a second organization's attempt to link it a
 * refusal (`claimed`) rather than a second row able to mint tokens for it.
 */
export const githubConnection = pgTable(
  "github_connection",
  {
    id: text("id").primaryKey(),
    organizationId: owner(),
    /** GitHub's numeric id, as text like every external id here. */
    installationId: text("installation_id").notNull().unique(),
    accountLogin: text("account_login").notNull(),
    /** `User` or `Organization`, as GitHub reports the account. */
    accountType: text("account_type").notNull(),
    /** `all` or `selected`. Kept current from webhooks and the callback. */
    repositorySelection: text("repository_selection").notNull(),
    /** As granted; compared when the client accepts new permissions. */
    permissions: jsonb("permissions").notNull(),
    /**
     * False once the App is uninstalled or suspended on GitHub's side. The
     * row is kept so the UI can say what happened to a connection the
     * organization recognises.
     */
    healthy: boolean("healthy").notNull().default(true),
    suspendedAt: ts("suspended_at"),
    /**
     * When GitHub said the installation is gone: the `deleted` webhook, or
     * the sweep's probe finding no such installation. Final — a reinstall is
     * a new installation id — so the sweep stops probing a connection once
     * this is set, while one merely flagged unhealthy is probed until it
     * recovers.
     */
    uninstalledAt: ts("uninstalled_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("github_connection_organization_id_idx").on(table.organizationId),
    // Redundant as a key — `id` alone is one — but it is what lets
    // `github_repo` reference a connection *and its owner* together.
    unique("github_connection_id_organization_unique").on(
      table.id,
      table.organizationId,
    ),
  ],
);

export type GithubConnectionRow = typeof githubConnection.$inferSelect;
export type NewGithubConnectionRow = typeof githubConnection.$inferInsert;

/**
 * A person's user-to-server grant, one per organization they connected from.
 *
 * What the connect flow uses to prove which installations the person can
 * see, and what will later attribute writes to them. Nothing unattended
 * depends on it: losing one breaks only the next connect, which re-creates
 * it.
 */
export const githubGrant = pgTable(
  "github_grant",
  {
    id: text("id").primaryKey(),
    organizationId: owner(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    githubLogin: text("github_login").notNull(),
    githubUserId: text("github_user_id").notNull(),
    /** AES-256-GCM, `v1:<base64>`; see `cipher.ts`. */
    accessTokenEnc: text("access_token_enc").notNull(),
    /** Present when the App expires user tokens, which it is registered to. */
    refreshTokenEnc: text("refresh_token_enc"),
    keyId: text("key_id").notNull(),
    expiresAt: ts("expires_at"),
    /** Fences refresh write-backs against a newer grant; see the Jira store. */
    credentialRevision: integer("credential_revision").notNull().default(1),
    healthy: boolean("healthy").notNull().default(true),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("github_grant_org_user_unique").on(
      table.organizationId,
      table.userId,
    ),
    // Deleting a user cascades here; without it that is a full scan.
    index("github_grant_user_id_idx").on(table.userId),
  ],
);

export type GithubGrantRow = typeof githubGrant.$inferSelect;
export type NewGithubGrantRow = typeof githubGrant.$inferInsert;

/**
 * A repository registered from a connection: a pointer, and the commit its
 * default branch was last seen at.
 */
export const githubRepo = pgTable(
  "github_repo",
  {
    id: text("id").primaryKey(),
    /**
     * Denormalised from the connection so every read filters on one column.
     * The composite key below makes the database hold it equal to the
     * connection's own: the sweep mints with the connection's installation
     * and writes under this column, so the two must never disagree.
     */
    organizationId: owner(),
    connectionId: text("connection_id").notNull(),
    /** `source` only, until the sandbox phase widens it in `shared`. */
    role: text("role").notNull(),
    /** GitHub's numeric repository id. Survives renames; the name does not. */
    externalId: text("external_id").notNull(),
    /** `owner/name`. Display, refreshed on every sync. */
    fullName: text("full_name").notNull(),
    defaultBranch: text("default_branch").notNull(),
    isPrivate: boolean("is_private").notNull().default(true),
    /** GitHub's estimate, in kilobytes. The pre-fetch size gate later. */
    sizeKb: integer("size_kb"),
    headSha: text("head_sha"),
    /**
     * The ETag of the last branch-head read. Reconcile sends it as
     * `If-None-Match`, and a 304 costs nothing against the rate limit.
     */
    headEtag: text("head_etag"),
    /** GitHub's own `pushed_at`. Also what orders out-of-order pushes. */
    pushedAt: ts("pushed_at"),
    lastSyncedAt: ts("last_synced_at"),
    /** `pending | ok | error | gone`; `githubSyncStatusSchema` in `shared`. */
    syncStatus: text("sync_status").notNull().default("pending"),
    /** One line, for the UI. Never contents from the repository. */
    syncError: text("sync_error"),
    /**
     * The tech stack detected at `stack_commit_sha` by detection version
     * `stack_version` (`packages/core/src/repo/stack.ts`): names only, the
     * one thing kept from the manifests read to find it. All three null
     * until the first detection; a stale commit or version is redone.
     */
    stack: jsonb("stack").$type<string[]>(),
    stackCommitSha: text("stack_commit_sha"),
    stackVersion: integer("stack_version"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (table) => [
    // One row per repository per connection; registering twice refreshes it.
    unique("github_repo_connection_external_unique").on(
      table.connectionId,
      table.externalId,
    ),
    index("github_repo_organization_id_idx").on(table.organizationId),
    // The sync sweep's question, the never-synced and longest-waiting
    // first, answered from the index rather than a scan and a sort.
    index("github_repo_due_for_sync_idx")
      .on(sql`${table.lastSyncedAt} asc nulls first`)
      .where(sql`${table.syncStatus} <> 'gone'`),
    foreignKey({
      name: "github_repo_connection_owner_fk",
      columns: [table.connectionId, table.organizationId],
      foreignColumns: [githubConnection.id, githubConnection.organizationId],
    }).onDelete("cascade"),
  ],
);

export type GithubRepoRow = typeof githubRepo.$inferSelect;
export type NewGithubRepoRow = typeof githubRepo.$inferInsert;
