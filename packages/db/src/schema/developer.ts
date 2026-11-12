/**
 * The public API's credentials (workspace API tokens) and what they leave
 * behind: the audit log of what machine credentials changed.
 *
 * A token belongs to one organization and acts as the person who made it,
 * for as long as they stay its owner or admin (checked on every use, in the
 * API). Only a SHA-256 of the secret is kept: the secret is shown once, on
 * create, and a lost one is revoked and replaced, never recovered.
 */

import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type { ApiScope } from "sandbox-factory";

import { user } from "./auth.js";
import { organization } from "./organizations.js";

export const apiToken = pgTable(
  "api_token",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** The token acts as this person; it goes when they do. */
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** The secret's first characters, `lnx_` included: display only. */
    prefix: text("prefix").notNull(),
    /** Hex SHA-256 of the whole secret; the lookup key on every request. */
    hash: text("hash").notNull().unique(),
    scopes: jsonb("scopes").$type<ApiScope[]>().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** Written at most once a minute, so a busy token is one write a minute. */
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("api_token_organization_created_idx").on(
      table.organizationId,
      table.createdAt,
    ),
  ],
);

export type ApiTokenRow = typeof apiToken.$inferSelect;
export type NewApiTokenRow = typeof apiToken.$inferInsert;

/**
 * One request that changed something: every POST, PUT, PATCH or DELETE a
 * machine credential (`token`, `oauth`, `device`) made, and credential and
 * webhook management by a person's session. Who (the person, the
 * credential, its client), what (method and the route's pattern, the
 * resource when the path names one) and how it ended. Never a body, a
 * secret or a query string: the route pattern is stored, not the URL.
 *
 * Kept 180 days (`AUDIT_RETENTION_DAYS`); a periodic pass deletes older.
 */
export const auditEntry = pgTable(
  "audit_entry",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** The principal's `via`: `token`, `oauth`, `device` or `session`. */
    via: text("via").notNull(),
    /** The API token's, access token's or session's id; never a secret. */
    credentialId: text("credential_id").notNull(),
    /** An OAuth token's client id, or a device sign-in's client. */
    client: text("client"),
    /** Kept when the person goes, as the entry's subject is the act. */
    userId: text("user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    method: text("method").notNull(),
    /** The Hono pattern that answered, `/api/v1/orgs/:orgId/...`. */
    route: text("route").notNull(),
    resourceId: text("resource_id"),
    status: integer("status").notNull(),
    requestId: text("request_id").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("audit_entry_organization_at_idx").on(
      table.organizationId,
      table.at,
      table.id,
    ),
    index("audit_entry_at_idx").on(table.at),
    check(
      "audit_entry_via_check",
      sql`${table.via} in ('session', 'token', 'oauth', 'device')`,
    ),
  ],
);

export type AuditEntryRow = typeof auditEntry.$inferSelect;
export type NewAuditEntryRow = typeof auditEntry.$inferInsert;
