/**
 * The audit log: what machine credentials changed in a workspace, and how
 * its credentials and webhooks were managed. See `schema/developer.ts`.
 *
 * Owner first, as every store, except `prune`, the retention pass, which
 * deletes by age across every organization.
 */

import { and, desc, eq, lt, sql } from "drizzle-orm";

import type { Database } from "./errors.js";
import { generateId } from "./mapping.js";
import { auditEntry, user } from "./schema.js";

/** How long an entry is kept. */
export const AUDIT_RETENTION_DAYS = 180;

export type AuditVia = "session" | "token" | "oauth" | "device";

export interface NewAuditEntry {
  readonly via: AuditVia;
  readonly credentialId: string;
  readonly client: string | null;
  readonly userId: string | null;
  readonly method: string;
  readonly route: string;
  readonly resourceId: string | null;
  readonly status: number;
  readonly requestId: string;
}

export interface AuditEntry extends Omit<NewAuditEntry, "userId"> {
  readonly id: string;
  readonly organizationId: string;
  /** Null once the person is gone. */
  readonly user: { readonly id: string; readonly name: string } | null;
  readonly at: Date;
}

export interface AuditListOptions {
  readonly limit: number;
  /** The last entry of the page before, as a `createdAt|id` cursor names it. */
  readonly cursor?: { readonly createdAt: string; readonly id: string };
}

export interface AuditStore {
  record(organizationId: string, entry: NewAuditEntry): Promise<void>;
  /** Newest first, a page at a time. */
  list(
    organizationId: string,
    options: AuditListOptions,
  ): Promise<AuditEntry[]>;
  /** Deletes every entry older than `before`; how many went. */
  prune(before: Date): Promise<number>;
}

/** To the millisecond, as a cursor carries it; see `bounties.ts`. */
const atMs = sql`date_trunc('milliseconds', ${auditEntry.at})`;

type Row = {
  id: string;
  organizationId: string;
  via: string;
  credentialId: string;
  client: string | null;
  userId: string | null;
  userName: string | null;
  method: string;
  route: string;
  resourceId: string | null;
  status: number;
  requestId: string;
  at: Date;
};

function toEntry({ userId, userName, via, ...row }: Row): AuditEntry {
  return {
    ...row,
    via: via as AuditVia,
    user: userId === null ? null : { id: userId, name: userName ?? "" },
  };
}

export function createAuditStore(db: Database): AuditStore {
  return {
    async record(owner, entry) {
      await db.insert(auditEntry).values({
        id: generateId("aud"),
        organizationId: owner,
        ...entry,
      });
    },

    async list(owner, options) {
      const rows = await db
        .select({
          id: auditEntry.id,
          organizationId: auditEntry.organizationId,
          via: auditEntry.via,
          credentialId: auditEntry.credentialId,
          client: auditEntry.client,
          userId: auditEntry.userId,
          userName: user.name,
          method: auditEntry.method,
          route: auditEntry.route,
          resourceId: auditEntry.resourceId,
          status: auditEntry.status,
          requestId: auditEntry.requestId,
          at: auditEntry.at,
        })
        .from(auditEntry)
        .leftJoin(user, eq(user.id, auditEntry.userId))
        .where(
          and(
            eq(auditEntry.organizationId, owner),
            options.cursor === undefined
              ? undefined
              : sql`(${atMs}, ${auditEntry.id}) < (${options.cursor.createdAt}::timestamptz, ${options.cursor.id})`,
          ),
        )
        .orderBy(desc(atMs), desc(auditEntry.id))
        .limit(options.limit);
      return rows.map(toEntry);
    },

    async prune(before) {
      const removed = await db
        .delete(auditEntry)
        .where(lt(auditEntry.at, before))
        .returning({ id: auditEntry.id });
      return removed.length;
    },
  };
}
