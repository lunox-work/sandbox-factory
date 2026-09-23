/**
 * The Jira connection: one consented Atlassian site, owned by an organization.
 *
 * Distinct from the Atlassian rows in Better Auth's `account` table, and
 * deliberately so. Sign-in asks Atlassian for identity only — see the
 * `disableDefaultScope` comment in `apps/api/src/auth.ts` — so a user who
 * signed in with Atlassian has granted nothing against their Jira data. This
 * table holds the second, separate grant that does.
 *
 * That difference is why the tokens here are encrypted and the ones in
 * `account` are not: a row here reads a client's tickets, and once write-back
 * is enabled it can edit them.
 */

import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

import { organization } from "./organizations.js";

export const jiraConnection = pgTable(
  "jira_connection",
  {
    id: text("id").primaryKey(),
    /**
     * The owner. A connection belongs to an organization, never to the person
     * who happened to click connect: they may leave, and the board should not
     * go with them. Every store method filters on this.
     */
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /**
     * Atlassian's id for the site. Every REST URL embeds it, and it cannot be
     * derived from the token — `accessibleSites` is the only way to learn it.
     */
    cloudId: text("cloud_id").notNull(),
    /** `https://acme.atlassian.net`. Display, and `browse/` links. */
    siteUrl: text("site_url").notNull(),
    siteName: text("site_name").notNull(),
    /** oauth | api-token. Only `oauth` is reachable through the UI. */
    kind: text("kind").notNull().default("oauth"),
    /**
     * AES-256-GCM ciphertext, `v1:<base64>`, never a bare token. See
     * `cipher.ts` for what that does and does not defend against.
     */
    accessTokenEnc: text("access_token_enc"),
    /**
     * Also encrypted, and the more valuable of the two: Atlassian rotates
     * refresh tokens, so a leaked one is live until the next refresh.
     */
    refreshTokenEnc: text("refresh_token_enc"),
    /**
     * Which key encrypted the two columns above. Rotation re-encrypts the rows
     * whose `key_id` is stale, so both keys can be readable at once and no row
     * is unreadable mid-rotation.
     */
    keyId: text("key_id"),
    /** Absolute expiry of the access token, resolved on receipt. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /**
     * The scopes actually granted, space separated as Atlassian reports them.
     *
     * Read before write-back: whether this holds `write:jira-work` decides
     * whether a comment can be posted at all. Scopes are fixed at consent, so
     * adding one means sending the user through consent again.
     */
    scopes: text("scopes").notNull().default(""),
    /** REST scopes reported for this particular accessible site. */
    resourceScopes: text("resource_scopes").notNull().default(""),
    /** Fences token refresh writes against a newer reconnect grant. */
    credentialRevision: integer("credential_revision").notNull().default(1),
    /** The connecting account's address, for showing whose grant this is. */
    email: text("email"),
    /**
     * False once Atlassian has refused the credential — a revoked grant, or a
     * refresh token rotated past. The row is kept so the UI can say
     * "reconnect Jira" against the site the user recognises.
     */
    healthy: boolean("healthy").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // One connection per organization per site. Re-connecting the same site
    // updates the grant in place rather than accumulating dead rows.
    unique("jira_connection_organization_site_unique").on(
      table.organizationId,
      table.cloudId,
    ),
    index("jira_connection_organization_id_idx").on(table.organizationId),
  ],
);

export type JiraConnectionRow = typeof jiraConnection.$inferSelect;
export type NewJiraConnectionRow = typeof jiraConnection.$inferInsert;

/**
 * A board a run reads tickets from.
 *
 * Registered explicitly rather than discovered: a site can have dozens of
 * boards and pricing the wrong one wastes model calls on work nobody asked
 * about. The row holds a pointer and the settings, never the tickets.
 */
export const jiraBoard = pgTable(
  "jira_board",
  {
    id: text("id").primaryKey(),
    /** Denormalised from the connection so every read filters on one column. */
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    connectionId: text("connection_id")
      .notNull()
      .references(() => jiraConnection.id, { onDelete: "cascade" }),
    /** Jira's board id. Survives a rename; the name does not. */
    externalId: text("external_id").notNull(),
    /** Display only, refreshed whenever the board is read from Jira. */
    name: text("name").notNull(),
    /**
     * `scrum`, `kanban` or `unknown`.
     *
     * Decides how the backlog is asked for: a Scrum board (and a Kanban board
     * with the backlog feature on) answers `/board/{id}/backlog`, while a
     * plain Kanban board has no backlog endpoint at all and has to be read
     * through `/board/{id}/issue` filtered to the To Do category.
     */
    boardType: text("board_type").notNull(),
    projectKey: text("project_key"),
    /**
     * Which backlog tickets a run takes; `boardSelectionSchema` in
     * `packages/shared` is the shape. `jsonb` rather than columns because the
     * settings are expected to grow, and each addition would otherwise be a
     * migration.
     */
    selection: jsonb("selection").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // One row per board per connection. Registering twice edits the settings
    // rather than creating a second board that would be priced twice.
    unique("jira_board_connection_external_unique").on(
      table.connectionId,
      table.externalId,
    ),
    index("jira_board_organization_id_idx").on(table.organizationId),
  ],
);

export type JiraBoardRow = typeof jiraBoard.$inferSelect;
export type NewJiraBoardRow = typeof jiraBoard.$inferInsert;

/**
 * A ticket a run has looked at.
 *
 * A pointer, not a copy: the summary, description and status live in Jira and
 * are read when they are needed. What is here is the minimum to answer
 * questions that would otherwise need the client — which tickets has a run
 * already considered, and when did Jira last say this one changed.
 *
 * Nothing writes a row yet. The backlog preview reads live from Jira and
 * stores nothing, deliberately: a preview that persisted rows would make
 * looking at a board indistinguishable from pricing it. The first writer is
 * the run in M5, which records a ticket as it prices it.
 *
 * No `syncedAt`, no body columns, no full-board mirror. An earlier design
 * synced whole boards and the decision was reversed: a mirror of a client's
 * tickets is a liability to hold and a cache to invalidate, and every question
 * the product asks can be answered from a pointer plus a live read.
 */
export const jiraIssue = pgTable(
  "jira_issue",
  {
    id: text("id").primaryKey(),
    /** Denormalised from the board, as everywhere: one column to filter on. */
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    boardId: text("board_id")
      .notNull()
      .references(() => jiraBoard.id, { onDelete: "cascade" }),
    /**
     * Jira's numeric issue id, as a string.
     *
     * The identity, rather than the key: a key changes when an issue moves
     * project, and keying on it would make one ticket look like two.
     */
    externalId: text("external_id").notNull(),
    /** `ACME-123`. Display only, refreshed whenever the ticket is seen. */
    key: text("key").notNull(),
    /** `new`, `indeterminate` or `done`, normalised by `toIssueDto`. */
    statusCategory: text("status_category").notNull(),
    /** Jira's own created time. What "the oldest backlog tickets" sorts on. */
    remoteCreatedAt: timestamp("remote_created_at", {
      withTimezone: true,
    }).notNull(),
    /** Jira's own updated time, for noticing a ticket has changed since. */
    remoteUpdatedAt: timestamp("remote_updated_at", {
      withTimezone: true,
    }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /**
     * When Jira stopped returning the ticket: deleted, moved out of reach, or
     * no longer visible to this connection's grant. Set rather than deleting
     * the row, because a proposal may reference it and a priced ticket that
     * vanished is a thing the review page has to be able to explain.
     */
    removedAt: timestamp("removed_at", { withTimezone: true }),
  },
  (table) => [
    // One row per ticket per board. A ticket on two boards is two rows: the
    // selection settings, and so the pricing, belong to the board.
    unique("jira_issue_board_external_unique").on(
      table.boardId,
      table.externalId,
    ),
    index("jira_issue_organization_id_idx").on(table.organizationId),
  ],
);

export type JiraIssueRow = typeof jiraIssue.$inferSelect;
export type NewJiraIssueRow = typeof jiraIssue.$inferInsert;
