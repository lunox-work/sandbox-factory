import { and, eq, gt, lt, or, sql } from "drizzle-orm";

import type { Database } from "./errors.js";
import { generateId } from "./mapping.js";
import { bountyProposal, bountyWriteback } from "./schema.js";
import type { BountyWritebackPayload, BountyWritebackRow } from "./schema.js";

export type WritebackKind = "approved" | "withdrawn";
export type WritebackStatus =
  "pending" | "running" | "done" | "failed" | "uncertain" | "cancelled";

export interface StoredBountyWriteback {
  readonly id: string;
  readonly organizationId: string;
  readonly proposalId: string;
  readonly proposalRevision: number;
  readonly kind: WritebackKind;
  readonly status: WritebackStatus;
  readonly step: "comment" | "label";
  readonly payload: BountyWritebackPayload;
  readonly jiraCommentId: string | null;
  readonly errorCode: string | null;
  readonly commentAttemptedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BountyWritebackStore {
  approveWithIntent(
    organizationId: string,
    proposalId: string,
    expectedRevision: number,
    decidedBy: string,
    payload: BountyWritebackPayload,
  ): Promise<
    | { readonly status: "created"; readonly operation: StoredBountyWriteback }
    | { readonly status: "not-found" | "changed" | "invalid-state" }
  >;
  /**
   * An approved proposal back to proposed, with the withdrawal comment queued
   * in the same transaction. For an approval whose comment reached Jira.
   */
  withdrawWithIntent(
    organizationId: string,
    proposalId: string,
    expectedRevision: number,
    decidedBy: string,
    payload: BountyWritebackPayload,
  ): Promise<
    | { readonly status: "created"; readonly operation: StoredBountyWriteback }
    | { readonly status: "not-found" | "changed" | "invalid-state" }
  >;
  get(
    organizationId: string,
    id: string,
  ): Promise<StoredBountyWriteback | null>;
  listForProposal(
    organizationId: string,
    proposalId: string,
  ): Promise<StoredBountyWriteback[]>;
  claim(
    organizationId: string,
    id: string,
    leaseToken: string,
    now: Date,
  ): Promise<StoredBountyWriteback | null>;
  heartbeat(
    organizationId: string,
    id: string,
    leaseToken: string,
    now: Date,
  ): Promise<boolean>;
  markCommentAttempted(
    organizationId: string,
    id: string,
    leaseToken: string,
    now: Date,
  ): Promise<boolean>;
  recordComment(
    organizationId: string,
    id: string,
    leaseToken: string,
    commentId: string,
    needsLabel: boolean,
  ): Promise<StoredBountyWriteback | null>;
  completeLabel(
    organizationId: string,
    id: string,
    leaseToken: string,
  ): Promise<StoredBountyWriteback | null>;
  fail(
    organizationId: string,
    id: string,
    leaseToken: string,
    status: "failed" | "uncertain" | "cancelled",
    code: string,
  ): Promise<StoredBountyWriteback | null>;
  cancel(
    organizationId: string,
    id: string,
  ): Promise<StoredBountyWriteback | null>;
  adoptComment(
    organizationId: string,
    id: string,
    commentId: string,
  ): Promise<StoredBountyWriteback | null>;
  organizationsWithExpiredWritebacks(now: Date): Promise<string[]>;
  classifyExpired(organizationId: string, now: Date): Promise<number>;
}

function dto(row: BountyWritebackRow): StoredBountyWriteback {
  return {
    id: row.id,
    organizationId: row.organizationId,
    proposalId: row.proposalId,
    proposalRevision: row.proposalRevision,
    kind: row.kind as WritebackKind,
    status: row.status as WritebackStatus,
    step: row.step as "comment" | "label",
    payload: row.payload,
    jiraCommentId: row.jiraCommentId,
    errorCode: row.errorCode,
    commentAttemptedAt: row.commentAttemptedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function createBountyWritebackStore(db: Database): BountyWritebackStore {
  return {
    async approveWithIntent(
      organizationId,
      proposalId,
      expectedRevision,
      decidedBy,
      payload,
    ) {
      return db.transaction(async (transaction) => {
        const tx = transaction as unknown as Database;
        const now = new Date();
        const approved = (await tx
          .update(bountyProposal)
          .set({
            status: "approved",
            revision: expectedRevision + 1,
            decidedBy,
            decidedAt: now,
            decisionDeliveryPolicy: "requested",
            updatedAt: now,
          })
          .where(
            and(
              eq(bountyProposal.organizationId, organizationId),
              eq(bountyProposal.id, proposalId),
              eq(bountyProposal.status, "proposed"),
              eq(bountyProposal.revision, expectedRevision),
            ),
          )
          .returning()) as (typeof bountyProposal.$inferSelect)[];
        if (approved[0] === undefined) {
          const current = await tx
            .select({
              revision: bountyProposal.revision,
              status: bountyProposal.status,
            })
            .from(bountyProposal)
            .where(
              and(
                eq(bountyProposal.organizationId, organizationId),
                eq(bountyProposal.id, proposalId),
              ),
            );
          if (current[0] === undefined) return { status: "not-found" } as const;
          return {
            status:
              current[0].revision === expectedRevision
                ? "invalid-state"
                : "changed",
          } as const;
        }
        const rows = (await tx
          .insert(bountyWriteback)
          .values({
            id: generateId("bwo"),
            organizationId,
            proposalId,
            proposalRevision: expectedRevision + 1,
            kind: "approved",
            payload,
            requestedBy: decidedBy,
          })
          .returning()) as BountyWritebackRow[];
        const operation = rows[0];
        if (operation === undefined)
          throw new Error("Failed to create Jira write intent.");
        return { status: "created", operation: dto(operation) } as const;
      });
    },

    async withdrawWithIntent(
      organizationId,
      proposalId,
      expectedRevision,
      decidedBy,
      payload,
    ) {
      return db.transaction(async (transaction) => {
        const tx = transaction as unknown as Database;
        const now = new Date();
        const withdrawn = (await tx
          .update(bountyProposal)
          .set({
            status: "proposed",
            revision: expectedRevision + 1,
            decidedBy: null,
            decidedAt: null,
            decisionDeliveryPolicy: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(bountyProposal.organizationId, organizationId),
              eq(bountyProposal.id, proposalId),
              eq(bountyProposal.status, "approved"),
              eq(bountyProposal.revision, expectedRevision),
            ),
          )
          .returning()) as (typeof bountyProposal.$inferSelect)[];
        if (withdrawn[0] === undefined) {
          const current = await tx
            .select({
              revision: bountyProposal.revision,
              status: bountyProposal.status,
            })
            .from(bountyProposal)
            .where(
              and(
                eq(bountyProposal.organizationId, organizationId),
                eq(bountyProposal.id, proposalId),
              ),
            );
          if (current[0] === undefined) return { status: "not-found" } as const;
          return {
            status:
              current[0].revision === expectedRevision
                ? "invalid-state"
                : "changed",
          } as const;
        }
        const rows = (await tx
          .insert(bountyWriteback)
          .values({
            id: generateId("bwo"),
            organizationId,
            proposalId,
            proposalRevision: expectedRevision + 1,
            kind: "withdrawn",
            payload,
            requestedBy: decidedBy,
          })
          .returning()) as BountyWritebackRow[];
        if (rows[0] === undefined)
          throw new Error("Failed to create Jira withdrawal intent.");
        return { status: "created", operation: dto(rows[0]) } as const;
      });
    },

    async get(organizationId, id) {
      const rows = (await db
        .select()
        .from(bountyWriteback)
        .where(
          and(
            eq(bountyWriteback.organizationId, organizationId),
            eq(bountyWriteback.id, id),
          ),
        )) as BountyWritebackRow[];
      return rows[0] === undefined ? null : dto(rows[0]);
    },

    async listForProposal(organizationId, proposalId) {
      const rows = (await db
        .select()
        .from(bountyWriteback)
        .where(
          and(
            eq(bountyWriteback.organizationId, organizationId),
            eq(bountyWriteback.proposalId, proposalId),
          ),
        )) as BountyWritebackRow[];
      return rows.map(dto);
    },

    async claim(organizationId, id, leaseToken, now) {
      const rows = (await db
        .update(bountyWriteback)
        .set({
          status: "running",
          leaseToken,
          leaseExpiresAt: new Date(now.getTime() + 60_000),
          errorCode: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(bountyWriteback.organizationId, organizationId),
            eq(bountyWriteback.id, id),
            or(
              eq(bountyWriteback.status, "pending"),
              eq(bountyWriteback.status, "failed"),
            ),
          ),
        )
        .returning()) as BountyWritebackRow[];
      return rows[0] === undefined ? null : dto(rows[0]);
    },

    async heartbeat(organizationId, id, leaseToken, now) {
      const rows = await db
        .update(bountyWriteback)
        .set({
          leaseExpiresAt: new Date(now.getTime() + 60_000),
          updatedAt: now,
        })
        .where(
          and(
            eq(bountyWriteback.organizationId, organizationId),
            eq(bountyWriteback.id, id),
            eq(bountyWriteback.status, "running"),
            eq(bountyWriteback.leaseToken, leaseToken),
            gt(bountyWriteback.leaseExpiresAt, now),
          ),
        )
        .returning();
      return rows.length > 0;
    },

    async markCommentAttempted(organizationId, id, leaseToken, now) {
      const rows = await db
        .update(bountyWriteback)
        .set({ commentAttemptedAt: now, updatedAt: now })
        .where(
          and(
            eq(bountyWriteback.organizationId, organizationId),
            eq(bountyWriteback.id, id),
            eq(bountyWriteback.status, "running"),
            eq(bountyWriteback.step, "comment"),
            eq(bountyWriteback.leaseToken, leaseToken),
            gt(bountyWriteback.leaseExpiresAt, now),
          ),
        )
        .returning();
      return rows.length > 0;
    },

    async recordComment(organizationId, id, leaseToken, commentId, needsLabel) {
      const now = new Date();
      const rows = (await db
        .update(bountyWriteback)
        .set({
          jiraCommentId: commentId,
          status: needsLabel ? "running" : "done",
          step: needsLabel ? "label" : "comment",
          ...(needsLabel ? {} : { leaseToken: null, leaseExpiresAt: null }),
          updatedAt: now,
        })
        .where(
          and(
            eq(bountyWriteback.organizationId, organizationId),
            eq(bountyWriteback.id, id),
            eq(bountyWriteback.status, "running"),
            eq(bountyWriteback.leaseToken, leaseToken),
            gt(bountyWriteback.leaseExpiresAt, now),
          ),
        )
        .returning()) as BountyWritebackRow[];
      return rows[0] === undefined ? null : dto(rows[0]);
    },

    async completeLabel(organizationId, id, leaseToken) {
      const now = new Date();
      const rows = (await db
        .update(bountyWriteback)
        .set({
          status: "done",
          errorCode: null,
          leaseToken: null,
          leaseExpiresAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(bountyWriteback.organizationId, organizationId),
            eq(bountyWriteback.id, id),
            eq(bountyWriteback.status, "running"),
            eq(bountyWriteback.step, "label"),
            eq(bountyWriteback.leaseToken, leaseToken),
            gt(bountyWriteback.leaseExpiresAt, now),
          ),
        )
        .returning()) as BountyWritebackRow[];
      return rows[0] === undefined ? null : dto(rows[0]);
    },

    async fail(organizationId, id, leaseToken, status, code) {
      const now = new Date();
      const rows = (await db
        .update(bountyWriteback)
        .set({
          status,
          errorCode: code,
          leaseToken: null,
          leaseExpiresAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(bountyWriteback.organizationId, organizationId),
            eq(bountyWriteback.id, id),
            eq(bountyWriteback.status, "running"),
            eq(bountyWriteback.leaseToken, leaseToken),
          ),
        )
        .returning()) as BountyWritebackRow[];
      return rows[0] === undefined ? null : dto(rows[0]);
    },

    async cancel(organizationId, id) {
      const rows = (await db
        .update(bountyWriteback)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(
          and(
            eq(bountyWriteback.organizationId, organizationId),
            eq(bountyWriteback.id, id),
            or(
              eq(bountyWriteback.status, "pending"),
              and(
                eq(bountyWriteback.status, "failed"),
                or(
                  eq(bountyWriteback.step, "comment"),
                  sql`${bountyWriteback.jiraCommentId} IS NOT NULL`,
                ),
              ),
            ),
          ),
        )
        .returning()) as BountyWritebackRow[];
      return rows[0] === undefined ? null : dto(rows[0]);
    },

    async adoptComment(organizationId, id, commentId) {
      const rows = (await db
        .update(bountyWriteback)
        .set({
          jiraCommentId: commentId,
          status: sql`CASE WHEN ${bountyWriteback.kind} = 'approved' THEN 'pending' ELSE 'done' END`,
          step: sql`CASE WHEN ${bountyWriteback.kind} = 'approved' THEN 'label' ELSE 'comment' END`,
          errorCode: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(bountyWriteback.organizationId, organizationId),
            eq(bountyWriteback.id, id),
            eq(bountyWriteback.status, "uncertain"),
            eq(bountyWriteback.step, "comment"),
          ),
        )
        .returning()) as BountyWritebackRow[];
      return rows[0] === undefined ? null : dto(rows[0]);
    },

    async organizationsWithExpiredWritebacks(now) {
      const rows = await db
        .select({ organizationId: bountyWriteback.organizationId })
        .from(bountyWriteback)
        .where(
          and(
            eq(bountyWriteback.status, "running"),
            lt(bountyWriteback.leaseExpiresAt, now),
          ),
        );
      return [...new Set(rows.map((row) => row.organizationId))];
    },

    async classifyExpired(organizationId, now) {
      const rows = await db
        .update(bountyWriteback)
        .set({
          status: sql`CASE WHEN ${bountyWriteback.step} = 'comment' THEN 'uncertain' ELSE 'failed' END`,
          errorCode: "worker_lost",
          leaseToken: null,
          leaseExpiresAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(bountyWriteback.organizationId, organizationId),
            eq(bountyWriteback.status, "running"),
            lt(bountyWriteback.leaseExpiresAt, now),
          ),
        )
        .returning();
      return rows.length;
    },
  };
}
