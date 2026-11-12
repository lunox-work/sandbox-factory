/**
 * Webhooks out: a workspace's endpoints, and the deliveries owed to them.
 * See `schema/developer.ts`.
 *
 * The signing secret goes in and comes out through the cipher, as Jira's
 * and GitHub's grants do: nothing above this file handles ciphertext, and
 * only `secretOf` and `claimDue` (the sender's read) hand the secret out.
 *
 * Owner first, as every store, except the sender's `claimDue` and the
 * retention pass's `pruneDeliveries`, which work across organizations, as
 * the watchdogs do; each claimed row carries its organization.
 */

import { and, desc, eq, inArray, isNull, lt, lte, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";

import type { TokenCipher } from "./cipher.js";
import type { Database } from "./errors.js";
import { generateId } from "./mapping.js";
import { user, webhookDelivery, webhookEndpoint } from "./schema.js";

/** How long a delivery is kept, delivered or not. */
export const WEBHOOK_DELIVERY_RETENTION_DAYS = 30;

export interface StoredWebhookEndpoint {
  readonly id: string;
  readonly organizationId: string;
  readonly url: string;
  readonly description: string;
  readonly eventTypes: readonly string[];
  readonly enabled: boolean;
  readonly createdBy: { readonly id: string; readonly name: string } | null;
  readonly consecutiveFailures: number;
  readonly disabledReason: string | null;
  readonly disabledAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface NewWebhookEndpoint {
  readonly url: string;
  readonly description: string;
  readonly eventTypes: readonly string[];
  /** The plaintext secret; stored encrypted. */
  readonly secret: string;
  readonly createdBy: string;
}

export interface WebhookEndpointChange {
  readonly url?: string | undefined;
  readonly description?: string | undefined;
  readonly eventTypes?: readonly string[] | undefined;
  /** Enabling clears an automatic disable's reason and failure count. */
  readonly enabled?: boolean | undefined;
}

export interface StoredWebhookDelivery {
  readonly id: string;
  readonly organizationId: string;
  readonly endpointId: string;
  readonly eventId: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly attemptCount: number;
  readonly nextAttemptAt: Date | null;
  readonly lastStatusCode: number | null;
  readonly lastError: string | null;
  readonly deliveredAt: Date | null;
  readonly createdAt: Date;
}

/** A delivery the sender holds, with where it goes and how to sign it. */
export interface ClaimedWebhookDelivery extends StoredWebhookDelivery {
  readonly url: string;
  readonly secret: string;
}

/** An event to owe the endpoints that take its type. */
export interface WebhookEvent {
  readonly id: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

export interface WebhookAttempt {
  readonly at: Date;
  readonly ok: boolean;
  readonly statusCode: number | null;
  readonly error: string | null;
  /** When to try again; null when delivered or given up. */
  readonly nextAttemptAt: Date | null;
}

export interface WebhookStore {
  createEndpoint(
    organizationId: string,
    input: NewWebhookEndpoint,
  ): Promise<StoredWebhookEndpoint>;
  listEndpoints(organizationId: string): Promise<StoredWebhookEndpoint[]>;
  getEndpoint(
    organizationId: string,
    id: string,
  ): Promise<StoredWebhookEndpoint | null>;
  updateEndpoint(
    organizationId: string,
    id: string,
    change: WebhookEndpointChange,
  ): Promise<StoredWebhookEndpoint | null>;
  /** Deletes it and its deliveries. False when there is none. */
  deleteEndpoint(organizationId: string, id: string): Promise<boolean>;
  /** Replaces the secret; the old one stops signing at once. */
  rotateSecret(
    organizationId: string,
    id: string,
    secret: string,
  ): Promise<StoredWebhookEndpoint | null>;
  /**
   * Owes `event` to every enabled endpoint taking its type, or to `only`
   * whatever its types (a test ping). An endpoint already owed the event
   * is skipped. The deliveries made.
   */
  enqueue(
    organizationId: string,
    event: WebhookEvent,
    at: Date,
    only?: string,
  ): Promise<StoredWebhookDelivery[]>;
  /** An endpoint's deliveries, newest first, a page at a time. */
  listDeliveries(
    organizationId: string,
    endpointId: string,
    options: {
      readonly limit: number;
      readonly cursor?: { readonly createdAt: string; readonly id: string };
    },
  ): Promise<StoredWebhookDelivery[]>;
  /** Due again now, with its attempts counted afresh. */
  redeliver(
    organizationId: string,
    endpointId: string,
    deliveryId: string,
    at: Date,
  ): Promise<StoredWebhookDelivery | null>;
  /**
   * Up to `limit` deliveries due by `at` to enabled endpoints, across
   * organizations, leased until `leaseUntil` so another process skips
   * them.
   */
  claimDue(
    at: Date,
    leaseUntil: Date,
    limit: number,
  ): Promise<ClaimedWebhookDelivery[]>;
  /**
   * Writes an attempt's outcome on the delivery and its endpoint: a
   * success clears the endpoint's failure count, a failure adds one and,
   * at `disableAfter`, disables an enabled endpoint with `reason`. Whether
   * this attempt disabled it.
   */
  recordAttempt(
    delivery: Pick<
      StoredWebhookDelivery,
      "id" | "organizationId" | "endpointId"
    >,
    attempt: WebhookAttempt,
    disableAfter: number,
    reason: string,
  ): Promise<{ readonly disabled: boolean }>;
  /** Deletes deliveries made before `before`; how many went. */
  pruneDeliveries(before: Date): Promise<number>;
}

const endpointColumns = {
  id: webhookEndpoint.id,
  organizationId: webhookEndpoint.organizationId,
  url: webhookEndpoint.url,
  description: webhookEndpoint.description,
  eventTypes: webhookEndpoint.eventTypes,
  enabled: webhookEndpoint.enabled,
  createdById: webhookEndpoint.createdBy,
  createdByName: user.name,
  consecutiveFailures: webhookEndpoint.consecutiveFailures,
  disabledReason: webhookEndpoint.disabledReason,
  disabledAt: webhookEndpoint.disabledAt,
  createdAt: webhookEndpoint.createdAt,
  updatedAt: webhookEndpoint.updatedAt,
};

type EndpointRow = {
  id: string;
  organizationId: string;
  url: string;
  description: string;
  eventTypes: string[];
  enabled: boolean;
  createdById: string | null;
  createdByName: string | null;
  consecutiveFailures: number;
  disabledReason: string | null;
  disabledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function toEndpoint({
  createdById,
  createdByName,
  ...row
}: EndpointRow): StoredWebhookEndpoint {
  return {
    ...row,
    createdBy:
      createdById === null
        ? null
        : { id: createdById, name: createdByName ?? "" },
  };
}

const deliveryColumns = {
  id: webhookDelivery.id,
  organizationId: webhookDelivery.organizationId,
  endpointId: webhookDelivery.endpointId,
  eventId: webhookDelivery.eventId,
  type: webhookDelivery.type,
  payload: webhookDelivery.payload,
  attemptCount: webhookDelivery.attemptCount,
  nextAttemptAt: webhookDelivery.nextAttemptAt,
  lastStatusCode: webhookDelivery.lastStatusCode,
  lastError: webhookDelivery.lastError,
  deliveredAt: webhookDelivery.deliveredAt,
  createdAt: webhookDelivery.createdAt,
};

/** To the millisecond, as a cursor carries it; see `bounties.ts`. */
const createdMs = sql`date_trunc('milliseconds', ${webhookDelivery.createdAt})`;

export function createWebhookStore(
  db: Database,
  cipher: TokenCipher,
): WebhookStore {
  const oneEndpoint = (owner: string, id: string) =>
    and(eq(webhookEndpoint.organizationId, owner), eq(webhookEndpoint.id, id));

  const readEndpoint = async (owner: string, id: string) => {
    const [row] = await db
      .select(endpointColumns)
      .from(webhookEndpoint)
      .leftJoin(user, eq(user.id, webhookEndpoint.createdBy))
      .where(oneEndpoint(owner, id))
      .limit(1);
    return row === undefined ? null : toEndpoint(row);
  };

  /** Writes `values` on one endpoint, then reads it back; null when none. */
  const updated = async (
    owner: string,
    id: string,
    values: PgUpdateSetSource<typeof webhookEndpoint>,
  ) => {
    const rows = await db
      .update(webhookEndpoint)
      .set({ ...values, updatedAt: sql`now()` })
      .where(oneEndpoint(owner, id))
      .returning({ id: webhookEndpoint.id });
    return rows.length === 0 ? null : readEndpoint(owner, id);
  };

  return {
    async createEndpoint(owner, input) {
      const id = generateId("whk");
      await db.insert(webhookEndpoint).values({
        id,
        organizationId: owner,
        url: input.url,
        description: input.description,
        eventTypes: [...input.eventTypes],
        secretEnc: cipher.encrypt(input.secret) ?? "",
        keyId: cipher.keyId,
        createdBy: input.createdBy,
      });
      const created = await readEndpoint(owner, id);
      if (created === null) throw new Error("Webhook insert returned no row.");
      return created;
    },

    async listEndpoints(owner) {
      const rows = await db
        .select(endpointColumns)
        .from(webhookEndpoint)
        .leftJoin(user, eq(user.id, webhookEndpoint.createdBy))
        .where(eq(webhookEndpoint.organizationId, owner))
        .orderBy(desc(webhookEndpoint.createdAt), desc(webhookEndpoint.id))
        .limit(100);
      return rows.map(toEndpoint);
    },

    getEndpoint: readEndpoint,

    async updateEndpoint(owner, id, change) {
      return updated(owner, id, {
        ...(change.url === undefined ? {} : { url: change.url }),
        ...(change.description === undefined
          ? {}
          : { description: change.description }),
        ...(change.eventTypes === undefined
          ? {}
          : { eventTypes: [...change.eventTypes] }),
        ...(change.enabled === undefined
          ? {}
          : change.enabled
            ? {
                enabled: true,
                consecutiveFailures: 0,
                disabledReason: null,
                disabledAt: null,
              }
            : { enabled: false, disabledReason: null, disabledAt: sql`now()` }),
      });
    },

    async deleteEndpoint(owner, id) {
      const rows = await db
        .delete(webhookEndpoint)
        .where(oneEndpoint(owner, id))
        .returning({ id: webhookEndpoint.id });
      return rows.length > 0;
    },

    async rotateSecret(owner, id, secret) {
      return updated(owner, id, {
        secretEnc: cipher.encrypt(secret) ?? "",
        keyId: cipher.keyId,
      });
    },

    async enqueue(owner, event, at, only) {
      const endpoints = await db
        .select({ id: webhookEndpoint.id })
        .from(webhookEndpoint)
        .where(
          and(
            eq(webhookEndpoint.organizationId, owner),
            only === undefined
              ? and(
                  eq(webhookEndpoint.enabled, true),
                  sql`${webhookEndpoint.eventTypes} @> ${JSON.stringify([event.type])}::jsonb`,
                )
              : eq(webhookEndpoint.id, only),
          ),
        );
      if (endpoints.length === 0) return [];
      return db
        .insert(webhookDelivery)
        .values(
          endpoints.map(({ id }) => ({
            id: generateId("whd"),
            organizationId: owner,
            endpointId: id,
            eventId: event.id,
            type: event.type,
            payload: event.payload,
            nextAttemptAt: at,
          })),
        )
        .onConflictDoNothing({
          target: [webhookDelivery.endpointId, webhookDelivery.eventId],
        })
        .returning(deliveryColumns);
    },

    async listDeliveries(owner, endpointId, options) {
      return db
        .select(deliveryColumns)
        .from(webhookDelivery)
        .where(
          and(
            eq(webhookDelivery.organizationId, owner),
            eq(webhookDelivery.endpointId, endpointId),
            options.cursor === undefined
              ? undefined
              : sql`(${createdMs}, ${webhookDelivery.id}) < (${options.cursor.createdAt}::timestamptz, ${options.cursor.id})`,
          ),
        )
        .orderBy(desc(createdMs), desc(webhookDelivery.id))
        .limit(options.limit);
    },

    async redeliver(owner, endpointId, deliveryId, at) {
      const [row] = await db
        .update(webhookDelivery)
        .set({ attemptCount: 0, nextAttemptAt: at, deliveredAt: null })
        .where(
          and(
            eq(webhookDelivery.organizationId, owner),
            eq(webhookDelivery.endpointId, endpointId),
            eq(webhookDelivery.id, deliveryId),
          ),
        )
        .returning(deliveryColumns);
      return row ?? null;
    },

    async claimDue(at, leaseUntil, limit) {
      return db.transaction(async (tx) => {
        const rows = await tx
          .select({
            ...deliveryColumns,
            url: webhookEndpoint.url,
            secretEnc: webhookEndpoint.secretEnc,
          })
          .from(webhookDelivery)
          .innerJoin(
            webhookEndpoint,
            eq(webhookEndpoint.id, webhookDelivery.endpointId),
          )
          .where(
            and(
              lte(webhookDelivery.nextAttemptAt, at),
              isNull(webhookDelivery.deliveredAt),
              eq(webhookEndpoint.enabled, true),
            ),
          )
          .orderBy(webhookDelivery.nextAttemptAt)
          .limit(limit)
          .for("update", { of: webhookDelivery, skipLocked: true });
        if (rows.length === 0) return [];
        await tx
          .update(webhookDelivery)
          .set({ nextAttemptAt: leaseUntil })
          .where(
            inArray(
              webhookDelivery.id,
              rows.map(({ id }) => id),
            ),
          );
        return rows.map(({ secretEnc, ...row }) => ({
          ...row,
          nextAttemptAt: leaseUntil,
          secret: cipher.decrypt(secretEnc) ?? "",
        }));
      });
    },

    async recordAttempt(delivery, attempt, disableAfter, reason) {
      return db.transaction(async (tx) => {
        await tx
          .update(webhookDelivery)
          .set({
            attemptCount: sql`${webhookDelivery.attemptCount} + 1`,
            nextAttemptAt: attempt.nextAttemptAt,
            lastStatusCode: attempt.statusCode,
            lastError: attempt.error,
            ...(attempt.ok ? { deliveredAt: attempt.at } : {}),
          })
          .where(
            and(
              eq(webhookDelivery.organizationId, delivery.organizationId),
              eq(webhookDelivery.id, delivery.id),
            ),
          );
        const endpoint = oneEndpoint(
          delivery.organizationId,
          delivery.endpointId,
        );
        if (attempt.ok) {
          await tx
            .update(webhookEndpoint)
            .set({ consecutiveFailures: 0 })
            .where(endpoint);
          return { disabled: false };
        }
        const [counted] = await tx
          .update(webhookEndpoint)
          .set({
            consecutiveFailures: sql`${webhookEndpoint.consecutiveFailures} + 1`,
          })
          .where(endpoint)
          .returning({
            failures: webhookEndpoint.consecutiveFailures,
            enabled: webhookEndpoint.enabled,
          });
        if (
          counted === undefined ||
          !counted.enabled ||
          counted.failures < disableAfter
        )
          return { disabled: false };
        await tx
          .update(webhookEndpoint)
          .set({
            enabled: false,
            disabledReason: reason,
            disabledAt: attempt.at,
            updatedAt: attempt.at,
          })
          .where(endpoint);
        return { disabled: true };
      });
    },

    async pruneDeliveries(before) {
      const removed = await db
        .delete(webhookDelivery)
        .where(lt(webhookDelivery.createdAt, before))
        .returning({ id: webhookDelivery.id });
      return removed.length;
    },
  };
}

/** Where a delivery stands, from its columns. */
export function deliveryState(
  delivery: Pick<StoredWebhookDelivery, "deliveredAt" | "nextAttemptAt">,
): "delivered" | "pending" | "failed" {
  if (delivery.deliveredAt !== null) return "delivered";
  return delivery.nextAttemptAt === null ? "failed" : "pending";
}
