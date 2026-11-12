/**
 * The public API's credentials (workspace API tokens), what they leave
 * behind (the audit log of what machine credentials changed, the
 * idempotency keys a create was retried under), and the webhooks a
 * workspace is told of changes by.
 *
 * A token belongs to one organization and acts as the person who made it,
 * for as long as they stay its owner or admin (checked on every use, in the
 * API). Only a SHA-256 of the secret is kept: the secret is shown once, on
 * create, and a lost one is revoked and replaced, never recovered.
 */

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
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

const at = (name: string) => timestamp(name, { withTimezone: true });

/**
 * Where a workspace is told of changes: an https URL, the event types it
 * takes, and the secret each delivery is signed with. The secret is held
 * encrypted like integration credentials (`cipher.ts`, `key_id` beside it),
 * shown once on create and on rotation.
 *
 * Disabled by a person, or automatically after `WEBHOOK_DISABLE_AFTER`
 * failed attempts in a row, with the reason; enabling again clears both.
 */
export const webhookEndpoint = pgTable(
  "webhook_endpoint",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    description: text("description").notNull().default(""),
    eventTypes: jsonb("event_types").$type<string[]>().notNull(),
    enabled: boolean("enabled").notNull().default(true),
    /** `v1:` ciphertext of the signing secret, never the secret. */
    secretEnc: text("secret_enc").notNull(),
    keyId: text("key_id").notNull(),
    createdBy: text("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    /** Failed attempts since the last success, across its deliveries. */
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    disabledReason: text("disabled_reason"),
    disabledAt: at("disabled_at"),
    createdAt: at("created_at").notNull().defaultNow(),
    updatedAt: at("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("webhook_endpoint_organization_created_idx").on(
      table.organizationId,
      table.createdAt,
    ),
  ],
);

/**
 * One event owed to one endpoint, and how sending it has gone. Due while
 * `next_attempt_at` is set; delivered when `delivered_at` is; given up when
 * neither is. An event reaches an endpoint once (`event_id` unique per
 * endpoint), however many API processes saw it happen.
 */
export const webhookDelivery = pgTable(
  "webhook_delivery",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    endpointId: text("endpoint_id")
      .notNull()
      .references(() => webhookEndpoint.id, { onDelete: "cascade" }),
    eventId: text("event_id").notNull(),
    type: text("type").notNull(),
    /** The body sent: ids and states only, never a resource's content. */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: at("next_attempt_at"),
    lastStatusCode: integer("last_status_code"),
    lastError: text("last_error"),
    deliveredAt: at("delivered_at"),
    createdAt: at("created_at").notNull().defaultNow(),
  },
  (table) => [
    unique("webhook_delivery_endpoint_event_unique").on(
      table.endpointId,
      table.eventId,
    ),
    index("webhook_delivery_endpoint_created_idx").on(
      table.endpointId,
      table.createdAt,
    ),
    index("webhook_delivery_due_idx")
      .on(table.nextAttemptAt)
      .where(sql`${table.nextAttemptAt} is not null`),
  ],
);

export type WebhookEndpointRow = typeof webhookEndpoint.$inferSelect;
export type WebhookDeliveryRow = typeof webhookDelivery.$inferSelect;

/**
 * A create a machine credential asked for under an `Idempotency-Key`: the
 * first answer, replayed to a retry for 24 hours. Keyed by organization,
 * route pattern and key; the request's hash tells a retry from a different
 * request reusing the key. The answer is held encrypted (`cipher.ts`): a
 * create can answer a secret, as a CLI token's mint does. While the first
 * request runs, `status` is null.
 */
export const idempotencyKey = pgTable(
  "idempotency_key",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** `POST /api/v1/orgs/:orgId/bounties`: the method and pattern. */
    route: text("route").notNull(),
    key: text("key").notNull(),
    /** Hex SHA-256 of the request's path and body. */
    requestHash: text("request_hash").notNull(),
    status: integer("status"),
    bodyEnc: text("body_enc"),
    keyId: text("key_id"),
    createdAt: at("created_at").notNull().defaultNow(),
    expiresAt: at("expires_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.route, table.key] }),
    index("idempotency_key_expires_idx").on(table.expiresAt),
  ],
);

export type IdempotencyKeyRow = typeof idempotencyKey.$inferSelect;
