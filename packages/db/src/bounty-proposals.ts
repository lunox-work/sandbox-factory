import type {
  BountyComplexity,
  BountySizingResult,
  RateCardSnapshot,
  SizingConfidence,
} from "sandbox-factory";
import { and, desc, eq, inArray, lt, or } from "drizzle-orm";

import type { Database } from "./errors.js";
import { generateId } from "./mapping.js";
import { bountyProposal, bountyRun, jiraIssue } from "./schema.js";
import type { BountyProposalRow } from "./schema.js";

export interface CreateBountyProposalInput {
  readonly runId: string;
  readonly jiraIssueId: string;
  readonly specHash: string;
  readonly specHashVersion: number;
  readonly rateCard: RateCardSnapshot;
  readonly sizing: BountySizingResult;
  readonly inputTruncated: boolean;
  readonly actualModel: string;
  readonly promptVersion: string;
  readonly amountMinor: number | null;
  readonly currency: string | null;
  readonly replacesProposalId?: string;
}

export type ProposalMutationResult =
  | { readonly ok: true; readonly proposal: StoredBountyProposal }
  | {
      readonly ok: false;
      readonly reason: "not-found" | "changed" | "invalid-state";
      readonly current?: StoredBountyProposal;
    };

export interface BountyProposalStore {
  create(
    organizationId: string,
    input: CreateBountyProposalInput,
  ): Promise<StoredBountyProposal | null>;
  get(
    organizationId: string,
    proposalId: string,
  ): Promise<StoredBountyProposal | null>;
  listForBoard(
    organizationId: string,
    boardId: string,
    options?: {
      status?: "proposed" | "approved" | "rejected" | "superseded";
      cursor?: string;
      limit?: number;
    },
  ): Promise<StoredBountyProposal[]>;
  liveExternalIds(
    organizationId: string,
    boardId: string,
    externalIds: readonly string[],
  ): Promise<Set<string>>;
  approve(
    organizationId: string,
    proposalId: string,
    expectedRevision: number,
    decidedBy: string,
    deliveryPolicy: "off" | "requested",
  ): Promise<ProposalMutationResult>;
  reject(
    organizationId: string,
    proposalId: string,
    expectedRevision: number,
    decidedBy: string,
  ): Promise<ProposalMutationResult>;
  resize(
    organizationId: string,
    proposalId: string,
    expectedRevision: number,
    resizedBy: string,
    complexity: "S" | "M" | "L" | "XL",
    amountMinor: number,
    currency: string,
  ): Promise<ProposalMutationResult>;
  replace(
    organizationId: string,
    sourceProposalId: string,
    sourceRevision: number,
    input: CreateBountyProposalInput,
  ): Promise<ProposalMutationResult>;
}

export interface StoredBountyProposal {
  readonly id: string;
  readonly organizationId: string;
  readonly runId: string;
  readonly jiraIssueId: string;
  readonly issueKey: string;
  readonly specHash: string;
  readonly specHashVersion: number;
  readonly rateCard: RateCardSnapshot;
  readonly modelComplexity: BountyComplexity;
  readonly modelConfidence: SizingConfidence;
  readonly modelRationale: string;
  readonly unsizedReason: string | null;
  readonly inputTruncated: boolean;
  readonly actualModel: string;
  readonly promptVersion: string;
  readonly complexity: BountyComplexity;
  readonly sizedBy: "model" | "reviewer";
  readonly amountMinor: number | null;
  readonly currency: string | null;
  readonly status: "proposed" | "approved" | "rejected" | "superseded";
  readonly revision: number;
  readonly decidedAt: string | null;
  readonly replacesProposalId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function toDto(row: BountyProposalRow, issueKey: string): StoredBountyProposal {
  return {
    id: row.id,
    organizationId: row.organizationId,
    runId: row.runId,
    jiraIssueId: row.jiraIssueId,
    issueKey,
    specHash: row.specHash,
    specHashVersion: row.specHashVersion,
    rateCard: row.rateCard,
    modelComplexity: row.modelComplexity as BountyComplexity,
    modelConfidence: row.modelConfidence as SizingConfidence,
    modelRationale: row.modelRationale,
    unsizedReason: row.unsizedReason,
    inputTruncated: row.inputTruncated,
    actualModel: row.actualModel,
    promptVersion: row.promptVersion,
    complexity: row.complexity as BountyComplexity,
    sizedBy: row.sizedBy as StoredBountyProposal["sizedBy"],
    amountMinor: row.amountMinor,
    currency: row.currency,
    status: row.status as StoredBountyProposal["status"],
    revision: row.revision,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    replacesProposalId: row.replacesProposalId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function first(
  db: Database,
  organizationId: string,
  proposalId: string,
): Promise<{ row: BountyProposalRow; issueKey: string } | undefined> {
  const rows = await db
    .select({ row: bountyProposal, issueKey: jiraIssue.key })
    .from(bountyProposal)
    .innerJoin(jiraIssue, eq(bountyProposal.jiraIssueId, jiraIssue.id))
    .where(
      and(
        eq(bountyProposal.organizationId, organizationId),
        eq(bountyProposal.id, proposalId),
      ),
    );
  return rows[0];
}

async function mutationMiss(
  db: Database,
  organizationId: string,
  proposalId: string,
  expectedRevision: number,
): Promise<ProposalMutationResult> {
  const current = await first(db, organizationId, proposalId);
  if (current === undefined) return { ok: false, reason: "not-found" };
  return {
    ok: false,
    reason:
      current.row.revision === expectedRevision ? "invalid-state" : "changed",
    current: toDto(current.row, current.issueKey),
  };
}

function insertValues(
  organizationId: string,
  input: CreateBountyProposalInput,
) {
  return {
    id: generateId("bpr"),
    organizationId,
    runId: input.runId,
    jiraIssueId: input.jiraIssueId,
    specHash: input.specHash,
    specHashVersion: input.specHashVersion,
    rateCard: input.rateCard,
    modelComplexity: input.sizing.complexity,
    modelConfidence: input.sizing.confidence,
    modelRationale: input.sizing.rationale,
    unsizedReason: input.sizing.unsizedReason ?? null,
    inputTruncated: input.inputTruncated,
    actualModel: input.actualModel,
    promptVersion: input.promptVersion,
    complexity: input.sizing.complexity,
    amountMinor: input.amountMinor,
    currency: input.currency,
    replacesProposalId: input.replacesProposalId ?? null,
  };
}

export function createBountyProposalStore(db: Database): BountyProposalStore {
  return {
    async create(organizationId, input) {
      const parents = await db
        .select({ runId: bountyRun.id, issueKey: jiraIssue.key })
        .from(bountyRun)
        .innerJoin(
          jiraIssue,
          and(
            eq(jiraIssue.id, input.jiraIssueId),
            eq(jiraIssue.organizationId, organizationId),
          ),
        )
        .where(
          and(
            eq(bountyRun.organizationId, organizationId),
            eq(bountyRun.id, input.runId),
          ),
        );
      const parent = parents[0];
      if (parent === undefined) return null;

      const rows = (await db
        .insert(bountyProposal)
        .values(insertValues(organizationId, input))
        .returning()) as BountyProposalRow[];
      return rows[0] === undefined ? null : toDto(rows[0], parent.issueKey);
    },

    async get(organizationId, proposalId) {
      const found = await first(db, organizationId, proposalId);
      return found === undefined ? null : toDto(found.row, found.issueKey);
    },

    async listForBoard(organizationId, boardId, options = {}) {
      const limit = Math.min(Math.max(options.limit ?? 25, 1), 50);
      const rows = await db
        .select({ row: bountyProposal, issueKey: jiraIssue.key })
        .from(bountyProposal)
        .innerJoin(bountyRun, eq(bountyProposal.runId, bountyRun.id))
        .innerJoin(jiraIssue, eq(bountyProposal.jiraIssueId, jiraIssue.id))
        .where(
          and(
            eq(bountyProposal.organizationId, organizationId),
            eq(bountyRun.boardId, boardId),
            options.status === undefined
              ? or(
                  eq(bountyProposal.status, "proposed"),
                  eq(bountyProposal.status, "approved"),
                  eq(bountyProposal.status, "rejected"),
                  eq(bountyProposal.status, "superseded"),
                )
              : eq(bountyProposal.status, options.status),
            options.cursor === undefined
              ? undefined
              : lt(bountyProposal.createdAt, new Date(options.cursor)),
          ),
        )
        .orderBy(desc(bountyProposal.createdAt))
        .limit(limit);
      return rows.map(({ row, issueKey }) => toDto(row, issueKey));
    },

    async liveExternalIds(organizationId, boardId, externalIds) {
      if (externalIds.length === 0) return new Set();
      const rows = await db
        .select({ externalId: jiraIssue.externalId })
        .from(bountyProposal)
        .innerJoin(jiraIssue, eq(bountyProposal.jiraIssueId, jiraIssue.id))
        .where(
          and(
            eq(bountyProposal.organizationId, organizationId),
            eq(jiraIssue.boardId, boardId),
            inArray(jiraIssue.externalId, [...externalIds]),
            or(
              eq(bountyProposal.status, "proposed"),
              eq(bountyProposal.status, "approved"),
            ),
          ),
        );
      return new Set(rows.map(({ externalId }) => externalId));
    },

    async approve(
      organizationId,
      proposalId,
      expectedRevision,
      decidedBy,
      deliveryPolicy,
    ) {
      const now = new Date();
      const rows = (await db
        .update(bountyProposal)
        .set({
          status: "approved",
          revision: expectedRevision + 1,
          decidedBy,
          decidedAt: now,
          decisionDeliveryPolicy: deliveryPolicy,
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
        .returning()) as BountyProposalRow[];
      const updated = rows[0];
      if (updated === undefined) {
        const current = await first(db, organizationId, proposalId);
        if (
          current !== undefined &&
          current.row.status === "approved" &&
          current.row.revision === expectedRevision + 1
        ) {
          return { ok: true, proposal: toDto(current.row, current.issueKey) };
        }
        return mutationMiss(db, organizationId, proposalId, expectedRevision);
      }
      const found = await first(db, organizationId, updated.id);
      if (found === undefined) return { ok: false, reason: "not-found" };
      return { ok: true, proposal: toDto(found.row, found.issueKey) };
    },

    async reject(organizationId, proposalId, expectedRevision, decidedBy) {
      const now = new Date();
      const rows = (await db
        .update(bountyProposal)
        .set({
          status: "rejected",
          revision: expectedRevision + 1,
          decidedBy,
          decidedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(bountyProposal.organizationId, organizationId),
            eq(bountyProposal.id, proposalId),
            or(
              eq(bountyProposal.status, "proposed"),
              eq(bountyProposal.status, "approved"),
            ),
            eq(bountyProposal.revision, expectedRevision),
          ),
        )
        .returning()) as BountyProposalRow[];
      const updated = rows[0];
      if (updated === undefined) {
        return mutationMiss(db, organizationId, proposalId, expectedRevision);
      }
      const found = await first(db, organizationId, updated.id);
      if (found === undefined) return { ok: false, reason: "not-found" };
      return { ok: true, proposal: toDto(found.row, found.issueKey) };
    },

    async resize(
      organizationId,
      proposalId,
      expectedRevision,
      resizedBy,
      complexity,
      amountMinor,
      currency,
    ) {
      const now = new Date();
      const rows = (await db
        .update(bountyProposal)
        .set({
          complexity,
          sizedBy: "reviewer",
          resizedBy,
          resizedAt: now,
          amountMinor,
          currency,
          revision: expectedRevision + 1,
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
        .returning()) as BountyProposalRow[];
      const updated = rows[0];
      if (updated === undefined) {
        return mutationMiss(db, organizationId, proposalId, expectedRevision);
      }
      const found = await first(db, organizationId, updated.id);
      if (found === undefined) return { ok: false, reason: "not-found" };
      return { ok: true, proposal: toDto(found.row, found.issueKey) };
    },

    async replace(organizationId, sourceProposalId, sourceRevision, input) {
      return db.transaction(async (transaction) => {
        const tx = transaction as unknown as Database;
        const now = new Date();
        const superseded = (await tx
          .update(bountyProposal)
          .set({
            status: "superseded",
            revision: sourceRevision + 1,
            updatedAt: now,
          })
          .where(
            and(
              eq(bountyProposal.organizationId, organizationId),
              eq(bountyProposal.id, sourceProposalId),
              or(
                eq(bountyProposal.status, "proposed"),
                eq(bountyProposal.status, "approved"),
              ),
              eq(bountyProposal.revision, sourceRevision),
            ),
          )
          .returning()) as BountyProposalRow[];
        if (superseded[0] === undefined) {
          return mutationMiss(
            tx,
            organizationId,
            sourceProposalId,
            sourceRevision,
          );
        }

        const created = (await tx
          .insert(bountyProposal)
          .values({
            ...insertValues(organizationId, {
              ...input,
              replacesProposalId: sourceProposalId,
            }),
            createdAt: now,
            updatedAt: now,
          })
          .returning()) as BountyProposalRow[];
        const replacement = created[0];
        if (replacement === undefined) {
          throw new Error("Failed to replace bounty proposal.");
        }
        const found = await first(tx, organizationId, replacement.id);
        if (found === undefined)
          throw new Error("Replacement proposal vanished.");
        return { ok: true, proposal: toDto(found.row, found.issueKey) };
      });
    },
  };
}
