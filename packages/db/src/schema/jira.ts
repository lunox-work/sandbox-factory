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
    /**
     * Whether approving a proposal writes a comment back to the ticket.
     *
     * Off by default, and per board rather than per organization: write-back
     * needs `write:jira-work`, which is a scope the connection may not hold.
     */
    writebackEnabled: boolean("writeback_enabled").notNull().default(false),
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
