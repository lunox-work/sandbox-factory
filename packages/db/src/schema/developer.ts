/**
 * The public API's credentials: workspace API tokens.
 *
 * A token belongs to one organization and acts as the person who made it,
 * for as long as they stay its owner or admin (checked on every use, in the
 * API). Only a SHA-256 of the secret is kept: the secret is shown once, on
 * create, and a lost one is revoked and replaced, never recovered.
 */

import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
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
