import type {
  BountyComplexity,
  BountySizingResult,
  RateCardSnapshot,
  PricedComplexity,
  SizingConfidence,
} from "sandbox-factory";
import { and, desc, eq, gt, inArray, lt, or, sql } from "drizzle-orm";

import type { Database } from "./errors.js";
import { jiraWriteGranted, splitScopes } from "./jira-connections.js";
import { generateId } from "./mapping.js";
import {
  bountyProposal,
  bountyRun,
  bountyWriteback,
  jiraBoard,
  jiraConnection,
  jiraIssue,
} from "./schema.js";
import type {
  BountyProposalRow,
  BountyRunRow,
  BountyWritebackRow,
} from "./schema.js";

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
  createForLease(
    organizationId: string,
    leaseToken: string,
    input: CreateBountyProposalInput,
  ): Promise<
    | { readonly status: "created"; readonly proposal: StoredBountyProposal }
    | { readonly status: "duplicate" | "lost-lease" | "not-found" }
  >;
  get(
    organizationId: string,
    proposalId: string,
  ): Promise<StoredBountyProposal | null>;
  listForBoard(
    organizationId: string,
    boardId: string,
    options?: {
      status?: "proposed" | "approved";
      cursor?: { readonly createdAt: string; readonly id: string };
      limit?: number;
    },
  ): Promise<StoredBountyProposal[]>;
  liveExternalIds(
    organizationId: string,
    boardId: string,
    externalIds: readonly string[],
  ): Promise<Set<string>>;
  /** The same tickets, each with the id of its live proposal. */
  liveProposalIds(
    organizationId: string,
    boardId: string,
    externalIds: readonly string[],
  ): Promise<Map<string, string>>;
  approve(
    organizationId: string,
    proposalId: string,
    expectedRevision: number,
    decidedBy: string,
    deliveryPolicy: "off" | "requested",
  ): Promise<ProposalMutationResult>;
  /** An approved proposal back to proposed, without re-sizing. */
  withdraw(
    organizationId: string,
    proposalId: string,
    expectedRevision: number,
  ): Promise<ProposalMutationResult>;
  resize(
    organizationId: string,
    proposalId: string,
    expectedRevision: number,
    resizedBy: string,
    complexity: PricedComplexity,
    amountMinor: number,
    currency: string,
  ): Promise<ProposalMutationResult>;
  /**
   * Deletes a proposed proposal, so the ticket has none and a later run may
   * propose it again. The returned proposal is the row as it was.
   */
  remove(
    organizationId: string,
    proposalId: string,
    expectedRevision: number,
  ): Promise<ProposalMutationResult>;
  /**
   * A re-price run's result: the same proposal, sized again and back to
   * proposed. Fenced by the run's lease and the source revision, like
   * `createForLease`. When the source was approved and its approval comment
   * is on the ticket, a `withdrawn` write-back is queued in the same
   * transaction and its id returned.
   */
  repriceForLease(
    organizationId: string,
    leaseToken: string,
    sourceProposalId: string,
    sourceRevision: number,
    input: CreateBountyProposalInput,
  ): Promise<
    | {
        readonly status: "repriced";
        readonly proposal: StoredBountyProposal;
        readonly writebackOperationId?: string;
      }
    | {
        readonly status:
          "lost-lease" | "not-found" | "changed" | "writeback-busy";
      }
  >;
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
  readonly resizedBy: string | null;
  readonly resizedAt: string | null;
  readonly amountMinor: number | null;
  readonly currency: string | null;
  readonly status: "proposed" | "approved" | "rejected" | "superseded";
  readonly revision: number;
  readonly decidedAt: string | null;
  readonly decidedBy: string | null;
  readonly decisionDeliveryPolicy: "off" | "requested" | null;
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
    rateCard: {
      ...row.rateCard,
      xsMinor: row.rateCard.xsMinor ?? row.rateCard.sMinor,
    },
    modelComplexity: row.modelComplexity as BountyComplexity,
    modelConfidence: row.modelConfidence as SizingConfidence,
    modelRationale: row.modelRationale,
    unsizedReason: row.unsizedReason,
    inputTruncated: row.inputTruncated,
    actualModel: row.actualModel,
    promptVersion: row.promptVersion,
    complexity: row.complexity as BountyComplexity,
    sizedBy: row.sizedBy as StoredBountyProposal["sizedBy"],
    resizedBy: row.resizedBy,
    resizedAt: row.resizedAt?.toISOString() ?? null,
    amountMinor: row.amountMinor,
    currency: row.currency,
    status: row.status as StoredBountyProposal["status"],
    revision: row.revision,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decidedBy: row.decidedBy,
    decisionDeliveryPolicy:
      row.decisionDeliveryPolicy as StoredBountyProposal["decisionDeliveryPolicy"],
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
  };
}

function uniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}

/** Each ticket's live proposal, for the tickets that have one. */
async function liveProposalIds(
  db: Database,
  organizationId: string,
  boardId: string,
  externalIds: readonly string[],
): Promise<Map<string, string>> {
  if (externalIds.length === 0) return new Map();
  const rows = await db
    .select({
      externalId: jiraIssue.externalId,
      proposalId: bountyProposal.id,
    })
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
  return new Map(
    rows.map(({ externalId, proposalId }) => [externalId, proposalId]),
  );
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
            eq(jiraIssue.boardId, bountyRun.boardId),
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

      try {
        const rows = (await db
          .insert(bountyProposal)
          .values(insertValues(organizationId, input))
          .returning()) as BountyProposalRow[];
        return rows[0] === undefined ? null : toDto(rows[0], parent.issueKey);
      } catch (error) {
        // Another worker or process may have won the one-live-proposal race.
        if (uniqueViolation(error)) return null;
        throw error;
      }
    },

    async createForLease(organizationId, leaseToken, input) {
      return db.transaction(async (transaction) => {
        const tx = transaction as unknown as Database;
        const now = new Date();
        // This UPDATE is the row lock. A watchdog cannot fail the run between
        // this lease check and the proposal insert in the same transaction.
        const claimed = (await tx
          .update(bountyRun)
          .set({ updatedAt: sql`${bountyRun.updatedAt}` })
          .where(
            and(
              eq(bountyRun.organizationId, organizationId),
              eq(bountyRun.id, input.runId),
              eq(bountyRun.status, "running"),
              eq(bountyRun.leaseToken, leaseToken),
              gt(bountyRun.leaseExpiresAt, now),
              gt(bountyRun.deadlineAt, now),
            ),
          )
          .returning()) as BountyRunRow[];
        const run = claimed[0];
        if (run === undefined) return { status: "lost-lease" } as const;

        const ownedIssue = await tx
          .select({ key: jiraIssue.key })
          .from(jiraIssue)
          .where(
            and(
              eq(jiraIssue.organizationId, organizationId),
              eq(jiraIssue.id, input.jiraIssueId),
              eq(jiraIssue.boardId, run.boardId),
            ),
          );
        const issue = ownedIssue[0];
        if (issue === undefined) return { status: "not-found" } as const;

        const rows = (await tx
          .insert(bountyProposal)
          .values(insertValues(organizationId, input))
          .onConflictDoNothing()
          .returning()) as BountyProposalRow[];
        const created = rows[0];
        return created === undefined
          ? ({ status: "duplicate" } as const)
          : ({
              status: "created",
              proposal: toDto(created, issue.key),
            } as const);
      });
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
              ? undefined
              : eq(bountyProposal.status, options.status),
            options.cursor === undefined
              ? undefined
              : or(
                  lt(
                    bountyProposal.createdAt,
                    new Date(options.cursor.createdAt),
                  ),
                  and(
                    eq(
                      bountyProposal.createdAt,
                      new Date(options.cursor.createdAt),
                    ),
                    lt(bountyProposal.id, options.cursor.id),
                  ),
                ),
          ),
        )
        .orderBy(desc(bountyProposal.createdAt), desc(bountyProposal.id))
        .limit(limit);
      return rows.map(({ row, issueKey }) => toDto(row, issueKey));
    },

    async liveExternalIds(organizationId, boardId, externalIds) {
      return new Set(
        (
          await liveProposalIds(db, organizationId, boardId, externalIds)
        ).keys(),
      );
    },

    liveProposalIds: (organizationId, boardId, externalIds) =>
      liveProposalIds(db, organizationId, boardId, externalIds),

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

    async withdraw(organizationId, proposalId, expectedRevision) {
      // The decision columns are cleared rather than overwritten: a proposed
      // proposal has no decision, and the write-back records who withdrew.
      const now = new Date();
      const rows = (await db
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

    async remove(organizationId, proposalId, expectedRevision) {
      const found = await first(db, organizationId, proposalId);
      if (found === undefined) return { ok: false, reason: "not-found" };
      const rows = (await db
        .delete(bountyProposal)
        .where(
          and(
            eq(bountyProposal.organizationId, organizationId),
            eq(bountyProposal.id, proposalId),
            eq(bountyProposal.status, "proposed"),
            eq(bountyProposal.revision, expectedRevision),
          ),
        )
        .returning()) as BountyProposalRow[];
      if (rows[0] === undefined) {
        return mutationMiss(db, organizationId, proposalId, expectedRevision);
      }
      return { ok: true, proposal: toDto(found.row, found.issueKey) };
    },

    async repriceForLease(
      organizationId,
      leaseToken,
      sourceProposalId,
      sourceRevision,
      input,
    ) {
      return db.transaction(async (transaction) => {
        const tx = transaction as unknown as Database;
        const now = new Date();
        const claimed = (await tx
          .update(bountyRun)
          .set({ updatedAt: sql`${bountyRun.updatedAt}` })
          .where(
            and(
              eq(bountyRun.organizationId, organizationId),
              eq(bountyRun.id, input.runId),
              eq(bountyRun.status, "running"),
              eq(bountyRun.kind, "reprice"),
              eq(bountyRun.sourceProposalId, sourceProposalId),
              eq(bountyRun.sourceRevision, sourceRevision),
              eq(bountyRun.leaseToken, leaseToken),
              gt(bountyRun.leaseExpiresAt, now),
              gt(bountyRun.deadlineAt, now),
            ),
          )
          .returning()) as BountyRunRow[];
        const run = claimed[0];
        if (run === undefined) return { status: "lost-lease" } as const;

        // Lock the source before inspecting delivery state. A re-price may not
        // overtake an approval comment whose result is still unresolved.
        const locked = (await tx
          .update(bountyProposal)
          .set({ updatedAt: sql`${bountyProposal.updatedAt}` })
          .where(
            and(
              eq(bountyProposal.organizationId, organizationId),
              eq(bountyProposal.id, sourceProposalId),
              eq(bountyProposal.jiraIssueId, input.jiraIssueId),
              or(
                eq(bountyProposal.status, "proposed"),
                eq(bountyProposal.status, "approved"),
              ),
              eq(bountyProposal.revision, sourceRevision),
            ),
          )
          .returning()) as BountyProposalRow[];
        const source = locked[0];
        if (source === undefined) {
          const current = await first(tx, organizationId, sourceProposalId);
          return {
            status: current === undefined ? "not-found" : "changed",
          } as const;
        }

        let announced: BountyWritebackRow | undefined;
        if (
          source.status === "approved" &&
          source.decisionDeliveryPolicy === "requested"
        ) {
          const operations = (await tx
            .select()
            .from(bountyWriteback)
            .where(
              and(
                eq(bountyWriteback.organizationId, organizationId),
                eq(bountyWriteback.proposalId, sourceProposalId),
              ),
            )
            .orderBy(desc(bountyWriteback.createdAt))) as BountyWritebackRow[];
          if (
            operations.some(({ status }) =>
              ["pending", "running", "uncertain"].includes(status),
            )
          ) {
            return { status: "writeback-busy" } as const;
          }
          announced = operations.find(
            (operation) =>
              operation.kind === "approved" && operation.jiraCommentId !== null,
          );
        }

        // The same row, sized again: the id is what links and Jira comments
        // point at, and a decision made earlier does not carry over.
        const values = insertValues(organizationId, input);
        const repriced = (await tx
          .update(bountyProposal)
          .set({
            runId: values.runId,
            specHash: values.specHash,
            specHashVersion: values.specHashVersion,
            rateCard: values.rateCard,
            modelComplexity: values.modelComplexity,
            modelConfidence: values.modelConfidence,
            modelRationale: values.modelRationale,
            unsizedReason: values.unsizedReason,
            inputTruncated: values.inputTruncated,
            actualModel: values.actualModel,
            promptVersion: values.promptVersion,
            complexity: values.complexity,
            sizedBy: "model",
            resizedBy: null,
            resizedAt: null,
            amountMinor: values.amountMinor,
            currency: values.currency,
            status: "proposed",
            revision: sourceRevision + 1,
            decidedBy: null,
            decidedAt: null,
            decisionDeliveryPolicy: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(bountyProposal.organizationId, organizationId),
              eq(bountyProposal.id, sourceProposalId),
              eq(bountyProposal.revision, sourceRevision),
            ),
          )
          .returning()) as BountyProposalRow[];
        if (repriced[0] === undefined) {
          throw new Error("Failed to re-price bounty proposal.");
        }
        const found = await first(tx, organizationId, sourceProposalId);
        if (found === undefined)
          throw new Error("Re-priced proposal vanished.");
        let writebackOperationId: string | undefined;
        if (announced !== undefined) {
          // Whether the site posts back is the connection's grant, read in
          // the same transaction as the re-price so a site disconnected
          // between the two cannot leave a follow-up nobody can deliver.
          const site = await tx
            .select({
              scopes: jiraConnection.scopes,
              resourceScopes: jiraConnection.resourceScopes,
            })
            .from(jiraBoard)
            .innerJoin(
              jiraConnection,
              eq(jiraConnection.id, jiraBoard.connectionId),
            )
            .where(
              and(
                eq(jiraBoard.organizationId, organizationId),
                eq(jiraBoard.id, run.boardId),
              ),
            );
          const granted =
            site[0] !== undefined &&
            jiraWriteGranted(
              splitScopes(site[0].scopes),
              splitScopes(site[0].resourceScopes),
            );
          if (granted) {
            writebackOperationId = generateId("bwo");
            await tx.insert(bountyWriteback).values({
              id: writebackOperationId,
              organizationId,
              proposalId: sourceProposalId,
              proposalRevision: sourceRevision + 1,
              kind: "withdrawn",
              payload: announced.payload,
              requestedBy: run.startedBy,
              createdAt: now,
              updatedAt: now,
            });
          }
        }
        return {
          status: "repriced",
          proposal: toDto(found.row, found.issueKey),
          ...(writebackOperationId === undefined
            ? {}
            : { writebackOperationId }),
        } as const;
      });
    },
  };
}
