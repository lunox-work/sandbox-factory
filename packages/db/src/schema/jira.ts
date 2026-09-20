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
