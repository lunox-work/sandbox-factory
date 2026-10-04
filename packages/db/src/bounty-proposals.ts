import { snapshotForWrite } from "./snapshot-write.js";
export { snapshotForWrite } from "./snapshot-write.js";
import { insertProfileIntent } from "./profile-intent.js";
import type {
  BountyComplexity,
  BountySizingResult,
  CategoryMatch,
  ModelComplexity,
  RateCardSnapshot,
  PricedComplexity,
  SizingConfidence,
  StepResult,
} from "sandbox-factory";
import { bountyKey } from "sandbox-factory";
import { and, desc, eq, gt, inArray, or, sql } from "drizzle-orm";

import {
  insertSpecRevision,
  nextSpecRevision,
  type NewBountySpec,
} from "./bounty-specs.js";
import {
  isUniqueViolation,
  type Database,
  type QueryExecutor,
} from "./errors.js";
import { jiraWriteGranted, splitScopes } from "./jira-connections.js";
import { generateId } from "./mapping.js";
import {
  bountyProposal,
  bountyRun,
  bountyWriteback,
  jiraBoard,
  jiraConnection,
  jiraIssue,
  bounty,
} from "./schema.js";
import type {
  BountyProposalRow,
  BountyRunRow,
  BountyWritebackRow,
} from "./schema.js";

export interface CreateBountyProposalInput {
  readonly runId: string;
  /** The bounty priced. One the run may write for: see `bountyForRun`. */
  readonly bountyId: string;
  readonly specHash: string;
  readonly specHashVersion: number;
  readonly rateCard: RateCardSnapshot;
  readonly sizing: BountySizingResult;
  readonly inputTruncated: boolean;
  readonly actualModel: string;
  readonly promptVersion: string;
  readonly amountMinor: number | null;
  readonly currency: string | null;
  /**
   * The scenario step, when the size has one. The proposal's `complexity`
   * is then the step's, and `amountMinor` must be its price; without one
   * it is the model's own size.
   */
  readonly step?: StepResult | null;
  /**
   * The repository snapshot the spec was drafted beside, when the bounty
   * had a repository with one. Its organization is the bounty's, which the
   * caller read it through.
   */
  readonly repoSnapshotId?: string | null;
}

/**
 * What a run writes under its lease: the proposal, and the spec drafted for
 * it when there is one. The two are one transaction, so a proposal never
 * points at a spec revision that was not stored.
 */
export interface LeasedBountyProposalInput extends CreateBountyProposalInput {
  readonly spec?: NewBountySpec;
  /** Frozen sizing content, supplied only when profiling is configured. */
  readonly profileIntent?: import("sandbox-factory").ProfileBounty;
}

/**
 * What a spec change writes under its run's lease: the changed spec as the
 * proposal's next revision, and the size and price the step makes of it.
 */
export interface RespecBountyProposalInput {
  readonly runId: string;
  readonly spec: NewBountySpec;
  /**
   * The spec revision the change was made of. Still the proposal's, or
   * the proposal is `changed`: a change made of an older revision would
   * undo whatever came between.
   */
  readonly fromSpecRevision: number;
  readonly step: StepResult;
  readonly amountMinor: number;
  readonly currency: string;
}

export type ProposalMutationResult =
  | { readonly ok: true; readonly proposal: StoredBountyProposal }
  | {
      readonly ok: false;
      readonly reason: "not-found" | "changed" | "invalid-state";
      readonly current?: StoredBountyProposal;
    };

/** A proposal as a list returns it. */
export type ListedBountyProposal = StoredBountyProposal & {
  /** The Jira board the bounty came through, or null for one written here. */
  readonly boardId: string | null;
  /**
   * Why the run picked the bounty: the categories it fit and the reason for
   * each, from the same plan entry. Empty for a bounty someone picked by
   * hand, and for a run from before categories existed.
   */
  readonly categories: readonly CategoryMatch[];
};

export interface BountyProposalStore {
  create(
    organizationId: string,
    input: CreateBountyProposalInput,
  ): Promise<StoredBountyProposal | null>;
  /**
   * A run's new proposal, fenced by its lease. A spec on the input is
   * stored as the proposal's revision 1 in the same transaction.
   */
  createForLease(
    organizationId: string,
    leaseToken: string,
    input: LeasedBountyProposalInput,
  ): Promise<
    | { readonly status: "created"; readonly proposal: StoredBountyProposal }
    | { readonly status: "duplicate" | "lost-lease" | "not-found" }
  >;
  get(
    organizationId: string,
    proposalId: string,
  ): Promise<StoredBountyProposal | null>;
  /**
   * The organization's proposals, newest first, or one board's: those its
   * runs made, which is every proposal of a bounty imported through it.
   */
  list(
    organizationId: string,
    options?: {
      boardId?: string;
      /**
       * Only proposals of bounties about this repository: one the bounty
       * names, or, when it names none, its Jira board's.
       */
      repoId?: string;
      status?: "proposed" | "approved";
      cursor?: { readonly createdAt: string; readonly id: string };
      limit?: number;
      /** Only proposals whose bounty was picked for this category. */
      category?: string;
      /** Only proposals whose bounty was picked for no category at all. */
      uncategorized?: boolean;
    },
  ): Promise<ListedBountyProposal[]>;
  /**
   * How many proposals fall in each category, by category id, how many fall
   * in none, and how many there are in all: the organization's, or one
   * board's.
   *
   * Counted here rather than from a page of the list, because the list is
   * paged and a count of fifty rows says nothing about a board of three
   * hundred. A bounty picked for two categories counts in both, so the
   * counts can sum to more than `total`.
   *
   * `uncategorized` is the proposals with no category recorded at all,
   * which is what `list`'s `uncategorized` lists. A bounty whose
   * only category has since left the registry is not one of them: it still
   * has its reason, under an id nothing offers as a view.
   */
  categoryCounts(
    organizationId: string,
    options?: { boardId?: string },
  ): Promise<{
    readonly total: number;
    readonly uncategorized: number;
    readonly counts: Readonly<Record<string, number>>;
  }>;
  liveExternalIds(
    organizationId: string,
    boardId: string,
    externalIds: readonly string[],
  ): Promise<Set<string>>;
  /** The same bounties, each with the id of its live proposal. */
  liveProposalIds(
    organizationId: string,
    boardId: string,
    externalIds: readonly string[],
  ): Promise<Map<string, string>>;
  /** The bounty's live proposal, proposed or approved, if it has one. */
  liveForBounty(
    organizationId: string,
    bountyId: string,
  ): Promise<string | null>;
  /**
   * The Jira issue behind each of these proposals' bounties, for reading its
   * live title. Only proposals of the owner whose bounty came from this
   * board are in the map; any other id is simply absent.
   */
  issuesForProposals(
    organizationId: string,
    boardId: string,
    proposalIds: readonly string[],
  ): Promise<
    Map<string, { readonly jiraIssueId: string; readonly externalId: string }>
  >;
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
  /**
   * A reviewer's size. `complexity` and `amountMinor` are what it comes to:
   * the reviewer's own size, or, when `step` is given (the proposal's step
   * rebased on that size), the step's. Without `step` the proposal is left
   * with none.
   */
  resize(
    organizationId: string,
    proposalId: string,
    expectedRevision: number,
    resizedBy: string,
    complexity: PricedComplexity,
    amountMinor: number,
    currency: string,
    step?: StepResult | null,
  ): Promise<ProposalMutationResult>;
  /**
   * Deletes a proposed proposal, so the bounty has none and a later run may
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
   * is on the bounty, a `withdrawn` write-back is queued in the same
   * transaction and its id returned.
   *
   * A spec on the input becomes the proposal's next spec revision, and the
   * proposal points at it. Without one the pointer is cleared: the earlier
   * revisions stay, but none of them is what this size goes with.
   */
  repriceForLease(
    organizationId: string,
    leaseToken: string,
    sourceProposalId: string,
    sourceRevision: number,
    input: LeasedBountyProposalInput,
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
  /**
   * A spec change's result: the proposal's next spec revision, and the
   * size the scenario step makes of it, priced. Fenced by the run's lease
   * and the source revision like a re-price, and only for a proposal still
   * proposed: an approval is made on a size, and the size must not move
   * under it.
   *
   * Everything else stays: the model's size and reasoning, who set the
   * base, and the run the proposal was sized by, which is where its reasons
   * for being picked are read from. The new revision records the spec
   * change's run and the person who asked for it.
   */
  respecForLease(
    organizationId: string,
    leaseToken: string,
    sourceProposalId: string,
    sourceRevision: number,
    input: RespecBountyProposalInput,
  ): Promise<
    | {
        readonly status: "respecced";
        readonly proposal: StoredBountyProposal;
        /** The size before the change, for the run's outcome. */
        readonly previousComplexity: BountyComplexity;
      }
    | { readonly status: "lost-lease" | "not-found" | "changed" }
  >;
}

export interface StoredBountyProposal {
  readonly id: string;
  readonly organizationId: string;
  readonly runId: string;
  readonly bountyId: string;
  /** The bounty's key: its Jira key while it has one, `B-<number>` otherwise. */
  readonly issueKey: string;
  /** The bounty's title as the platform holds it. */
  readonly title: string;
  readonly specHash: string;
  readonly specHashVersion: number;
  readonly rateCard: RateCardSnapshot;
  readonly modelComplexity: ModelComplexity;
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
  /** The spec revision this size goes with, or null when there is none. */
  readonly specRevision: number | null;
  /** How the spec's added weight moved the size, or null when nothing could. */
  readonly step: StepResult | null;
  /** The repository snapshot the spec was drafted beside, if any. */
  readonly repoSnapshotId: string | null;
  readonly decidedAt: string | null;
  readonly decidedBy: string | null;
  readonly decisionDeliveryPolicy: "off" | "requested" | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** What a proposal shows of its bounty. */
interface BountyName {
  readonly issueKey: string;
  readonly title: string;
}

/** The bounty's columns a proposal read joins for its name. */
const nameColumns = {
  bountyNumber: bounty.number,
  bountyTitle: bounty.title,
  jiraKey: jiraIssue.key,
};

/**
 * What a plan entry calls the bounty: Jira's issue id for one imported from
 * a board, the bounty's own id for one written here. A plan entry is matched
 * to its proposal by this.
 */
const PLAN_KEY = sql`coalesce(${jiraIssue.externalId}, ${bounty.id})`;

function nameOf(row: {
  readonly bountyNumber: number;
  readonly bountyTitle: string;
  readonly jiraKey: string | null;
}): BountyName {
  return {
    issueKey: bountyKey({ number: row.bountyNumber, jiraKey: row.jiraKey }),
    title: row.bountyTitle,
  };
}

function toDto(row: BountyProposalRow, name: BountyName): StoredBountyProposal {
  return {
    id: row.id,
    organizationId: row.organizationId,
    runId: row.runId,
    bountyId: row.bountyId,
    issueKey: name.issueKey,
    title: name.title,
    specHash: row.specHash,
    specHashVersion: row.specHashVersion,
    rateCard: {
      ...row.rateCard,
      xsMinor: row.rateCard.xsMinor ?? row.rateCard.sMinor,
    },
    modelComplexity: row.modelComplexity as ModelComplexity,
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
    specRevision: row.specRevision,
    step: row.step ?? null,
    repoSnapshotId: row.repoSnapshotId ?? null,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decidedBy: row.decidedBy,
    decisionDeliveryPolicy:
      row.decisionDeliveryPolicy as StoredBountyProposal["decisionDeliveryPolicy"],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function first(
  db: QueryExecutor,
  organizationId: string,
  proposalId: string,
): Promise<{ row: BountyProposalRow; name: BountyName } | undefined> {
  const rows = (await db
    .select({ row: bountyProposal, ...nameColumns })
    .from(bountyProposal)
    .innerJoin(bounty, eq(bounty.id, bountyProposal.bountyId))
    .leftJoin(jiraIssue, eq(jiraIssue.bountyId, bounty.id))
    .where(
      and(
        eq(bountyProposal.organizationId, organizationId),
        eq(bountyProposal.id, proposalId),
      ),
    )) as ({ row: BountyProposalRow } & NameRow)[];
  const found = rows[0];
  return found === undefined
    ? undefined
    : { row: found.row, name: nameOf(found) };
}

interface NameRow {
  readonly bountyNumber: number;
  readonly bountyTitle: string;
  readonly jiraKey: string | null;
}

/**
 * The bounty's name, if a run may write a proposal for it: the
 * organization's, and the run's own. A run that names its bounty writes
 * for that one only; a board's run, for a bounty imported through that
 * board.
 */
async function bountyForRun(
  db: QueryExecutor,
  organizationId: string,
  run: Pick<BountyRunRow, "bountyId" | "boardId">,
  bountyId: string,
): Promise<BountyName | null> {
  const rows = (await db
    .select({ ...nameColumns, boardId: jiraIssue.boardId })
    .from(bounty)
    .leftJoin(jiraIssue, eq(jiraIssue.bountyId, bounty.id))
    .where(
      and(eq(bounty.organizationId, organizationId), eq(bounty.id, bountyId)),
    )) as (NameRow & { readonly boardId: string | null })[];
  const found = rows[0];
  if (found === undefined) return null;
  const allowed =
    run.bountyId !== null
      ? run.bountyId === bountyId
      : run.boardId !== null && found.boardId === run.boardId;
  return allowed ? nameOf(found) : null;
}

async function mutationMiss(
  db: QueryExecutor,
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
    current: toDto(current.row, current.name),
  };
}

function insertValues(
  organizationId: string,
  input: CreateBountyProposalInput,
  specRevision: number | null = null,
) {
  return {
    id: generateId("bpr"),
    specRevision,
    organizationId,
    runId: input.runId,
    bountyId: input.bountyId,
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
    complexity: input.step?.complexity ?? input.sizing.complexity,
    step: input.step ?? null,
    stepVersion: input.step?.stepVersion ?? null,
    repoSnapshotId: input.repoSnapshotId ?? null,
    amountMinor: input.amountMinor,
    currency: input.currency,
  };
}

/**
 * When a proposal was created, to the millisecond: the precision of a page's
 * cursor, which carries an ISO string, where Postgres stores microseconds.
 * Ordered and compared at the cursor's, a proposal made in the same
 * millisecond as a page's last row is not skipped.
 */
const proposalCreatedMs = sql`date_trunc('milliseconds', ${bountyProposal.createdAt})`;

/** Each bounty's live proposal, for the bounties that have one. */
async function liveProposalIds(
  db: QueryExecutor,
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
    .innerJoin(jiraIssue, eq(jiraIssue.bountyId, bountyProposal.bountyId))
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
      return db.transaction(async (transaction) => {
        const tx = transaction;
        const runs = (await tx
          .select()
          .from(bountyRun)
          .where(
            and(
              eq(bountyRun.organizationId, organizationId),
              eq(bountyRun.id, input.runId),
            ),
          )) as BountyRunRow[];
        const run = runs[0];
        if (run === undefined) return null;
        const name = await bountyForRun(
          tx,
          organizationId,
          run,
          input.bountyId,
        );
        if (name === null) return null;

        const repoSnapshotId = await snapshotForWrite(
          tx,
          organizationId,
          input.repoSnapshotId,
        );
        try {
          const rows = (await tx
            .insert(bountyProposal)
            .values(insertValues(organizationId, { ...input, repoSnapshotId }))
            .returning()) as BountyProposalRow[];
          return rows[0] === undefined ? null : toDto(rows[0], name);
        } catch (error) {
          // Another worker or process may have won the one-live-proposal race.
          if (isUniqueViolation(error)) return null;
          throw error;
        }
      });
    },

    async createForLease(organizationId, leaseToken, input) {
      return db.transaction(async (transaction) => {
        const tx = transaction;
        const repoSnapshotId = await snapshotForWrite(
          tx,
          organizationId,
          input.repoSnapshotId,
        );
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

        const name = await bountyForRun(
          tx,
          organizationId,
          run,
          input.bountyId,
        );
        if (name === null) return { status: "not-found" } as const;

        const rows = (await tx
          .insert(bountyProposal)
          .values(
            insertValues(
              organizationId,
              { ...input, repoSnapshotId },
              input.spec === undefined ? null : 1,
            ),
          )
          .onConflictDoNothing()
          .returning()) as BountyProposalRow[];
        const created = rows[0];
        if (created === undefined) return { status: "duplicate" } as const;
        // After the proposal, which it references, and only when there is
        // one: a bounty that already has a live proposal gets no spec.
        if (input.spec !== undefined) {
          await insertSpecRevision(
            tx,
            organizationId,
            { proposalId: created.id, runId: input.runId, revision: 1 },
            input.spec,
          );
          if (input.profileIntent !== undefined && repoSnapshotId !== null) {
            await insertProfileIntent(tx, organizationId, {
              proposalId: created.id,
              specRevision: 1,
              specHash: input.spec.specHash,
              snapshotId: repoSnapshotId,
              bounty: input.profileIntent,
            });
          }
        }
        return {
          status: "created",
          proposal: toDto(created, name),
        } as const;
      });
    },

    async get(organizationId, proposalId) {
      const found = await first(db, organizationId, proposalId);
      return found === undefined ? null : toDto(found.row, found.name);
    },

    async list(organizationId, options = {}) {
      const limit = Math.min(Math.max(options.limit ?? 25, 1), 50);
      const rows = (await db
        .select({
          row: bountyProposal,
          ...nameColumns,
          externalId: jiraIssue.externalId,
          issueBoardId: jiraIssue.boardId,
          planned: bountyRun.planned,
        })
        .from(bountyProposal)
        .innerJoin(bountyRun, eq(bountyProposal.runId, bountyRun.id))
        .innerJoin(bounty, eq(bounty.id, bountyProposal.bountyId))
        .leftJoin(jiraIssue, eq(jiraIssue.bountyId, bounty.id))
        .where(
          and(
            eq(bountyProposal.organizationId, organizationId),
            options.boardId === undefined
              ? undefined
              : eq(bountyRun.boardId, options.boardId),
            options.repoId === undefined
              ? undefined
              : sql`coalesce(
                  ${bounty.repoId},
                  (select ${jiraBoard.sourceRepoId} from ${jiraBoard} where ${jiraBoard.id} = ${jiraIssue.boardId})
                ) = ${options.repoId}`,
            options.status === undefined
              ? undefined
              : eq(bountyProposal.status, options.status),
            // Why a bounty was picked lives on its run's plan, so the filter
            // looks there: the plan entry for this bounty, holding a
            // category with this id. `@>` is jsonb containment, and the id
            // travels as a bound parameter inside the JSON it is matched
            // against, never as SQL.
            options.category === undefined
              ? undefined
              : sql`exists (
                  select 1
                  from jsonb_array_elements(${bountyRun.planned}) as planned_issue
                  where planned_issue->>'externalIssueId' = ${PLAN_KEY}
                    and coalesce(planned_issue->'categories', '[]'::jsonb)
                      @> ${JSON.stringify([{ id: options.category }])}::jsonb
                )`,
            // The other side of the same question: no plan entry for this
            // bounty holding any category. "Holding one" is an entry of
            // `categories` with a string id, the same test `categoryCounts`
            // applies, so the tile's number and its list agree. The path is
            // lax, so a plan with no `categories`, or one that is not a
            // list, has none rather than being an error.
            options.uncategorized !== true
              ? undefined
              : sql`not exists (
                  select 1
                  from jsonb_array_elements(${bountyRun.planned}) as planned_issue
                  where planned_issue->>'externalIssueId' = ${PLAN_KEY}
                    and jsonb_path_exists(
                      planned_issue,
                      '$.categories[*].id ? (@.type() == "string")'
                    )
                )`,
            options.cursor === undefined
              ? undefined
              : sql`(${proposalCreatedMs}, ${bountyProposal.id}) < (${options.cursor.createdAt}::timestamptz, ${options.cursor.id})`,
          ),
        )
        .orderBy(desc(proposalCreatedMs), desc(bountyProposal.id))
        .limit(limit)) as ({
        row: BountyProposalRow;
        externalId: string | null;
        issueBoardId: string | null;
        planned: BountyRunRow["planned"];
      } & NameRow)[];
      return rows.map((found) => {
        const key = found.externalId ?? found.row.bountyId;
        const entry = found.planned.find(
          (issue) => issue.externalIssueId === key,
        );
        return {
          ...toDto(found.row, nameOf(found)),
          boardId: found.issueBoardId,
          categories: entry?.categories ?? [],
        };
      });
    },

    async categoryCounts(organizationId, options = {}) {
      // One row per proposal, carrying only that bounty's categories: the
      // plan entry is picked out in SQL, so a run's whole plan is not sent
      // once for every proposal it produced.
      const rows = await db
        .select({
          categories: sql<readonly { readonly id?: unknown }[] | null>`(
            select planned_issue->'categories'
            from jsonb_array_elements(${bountyRun.planned}) as planned_issue
            where planned_issue->>'externalIssueId' = ${PLAN_KEY}
            limit 1
          )`,
        })
        .from(bountyProposal)
        .innerJoin(bountyRun, eq(bountyProposal.runId, bountyRun.id))
        .innerJoin(bounty, eq(bounty.id, bountyProposal.bountyId))
        .leftJoin(jiraIssue, eq(jiraIssue.bountyId, bounty.id))
        .where(
          and(
            eq(bountyProposal.organizationId, organizationId),
            options.boardId === undefined
              ? undefined
              : eq(bountyRun.boardId, options.boardId),
          ),
        );

      const counts: Record<string, number> = {};
      let uncategorized = 0;
      for (const { categories } of rows) {
        // Once per proposal, even if a plan somehow named a category twice.
        // A plan from before categories has no list, and a bounty someone
        // picked by hand has an empty one: both are in no category.
        const ids = new Set(
          (Array.isArray(categories) ? categories : [])
            .map((category) => category?.id)
            .filter((id): id is string => typeof id === "string"),
        );
        if (ids.size === 0) uncategorized += 1;
        for (const id of ids) counts[id] = (counts[id] ?? 0) + 1;
      }
      return { total: rows.length, uncategorized, counts };
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

    async liveForBounty(organizationId, bountyId) {
      const rows = await db
        .select({ id: bountyProposal.id })
        .from(bountyProposal)
        .where(
          and(
            eq(bountyProposal.organizationId, organizationId),
            eq(bountyProposal.bountyId, bountyId),
            or(
              eq(bountyProposal.status, "proposed"),
              eq(bountyProposal.status, "approved"),
            ),
          ),
        );
      return rows[0]?.id ?? null;
    },

    async issuesForProposals(organizationId, boardId, proposalIds) {
      if (proposalIds.length === 0) return new Map();
      const rows = await db
        .select({
          proposalId: bountyProposal.id,
          jiraIssueId: jiraIssue.id,
          externalId: jiraIssue.externalId,
        })
        .from(bountyProposal)
        .innerJoin(jiraIssue, eq(jiraIssue.bountyId, bountyProposal.bountyId))
        .where(
          and(
            eq(bountyProposal.organizationId, organizationId),
            eq(jiraIssue.boardId, boardId),
            inArray(bountyProposal.id, [...proposalIds]),
          ),
        );
      return new Map(
        rows.map(({ proposalId, jiraIssueId, externalId }) => [
          proposalId,
          { jiraIssueId, externalId },
        ]),
      );
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
          return { ok: true, proposal: toDto(current.row, current.name) };
        }
        return mutationMiss(db, organizationId, proposalId, expectedRevision);
      }
      const found = await first(db, organizationId, updated.id);
      if (found === undefined) return { ok: false, reason: "not-found" };
      return { ok: true, proposal: toDto(found.row, found.name) };
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
      return { ok: true, proposal: toDto(found.row, found.name) };
    },

    async resize(
      organizationId,
      proposalId,
      expectedRevision,
      resizedBy,
      complexity,
      amountMinor,
      currency,
      step = null,
    ) {
      const now = new Date();
      const rows = (await db
        .update(bountyProposal)
        .set({
          complexity,
          step,
          stepVersion: step?.stepVersion ?? null,
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
      return { ok: true, proposal: toDto(found.row, found.name) };
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
      return { ok: true, proposal: toDto(found.row, found.name) };
    },

    async repriceForLease(
      organizationId,
      leaseToken,
      sourceProposalId,
      sourceRevision,
      input,
    ) {
      return db.transaction(async (transaction) => {
        const tx = transaction;
        // Snapshot before proposal locks: cascading snapshot deletion also
        // locks proposals, so both paths acquire these locks in that order.
        const repoSnapshotId = await snapshotForWrite(
          tx,
          organizationId,
          input.repoSnapshotId,
        );
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
              eq(bountyProposal.bountyId, input.bountyId),
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

        // The source row is locked above, so the revision read here is
        // still the latest when the new one is written below.
        const specRevision =
          input.spec === undefined
            ? null
            : await nextSpecRevision(tx, organizationId, sourceProposalId);

        // The same row, sized again: the id is what links and Jira comments
        // point at, and a decision made earlier does not carry over.
        const values = insertValues(organizationId, {
          ...input,
          repoSnapshotId,
        });
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
            step: values.step,
            stepVersion: values.stepVersion,
            // The draft is new, and so is what it was drafted beside.
            repoSnapshotId: values.repoSnapshotId,
            sizedBy: "model",
            resizedBy: null,
            resizedAt: null,
            amountMinor: values.amountMinor,
            currency: values.currency,
            status: "proposed",
            revision: sourceRevision + 1,
            specRevision,
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
        if (input.spec !== undefined && specRevision !== null) {
          await insertSpecRevision(
            tx,
            organizationId,
            {
              proposalId: sourceProposalId,
              runId: input.runId,
              revision: specRevision,
            },
            input.spec,
          );
          if (input.profileIntent !== undefined && repoSnapshotId !== null) {
            await insertProfileIntent(tx, organizationId, {
              proposalId: sourceProposalId,
              specRevision,
              specHash: input.spec.specHash,
              snapshotId: repoSnapshotId,
              bounty: input.profileIntent,
            });
          }
        }
        const found = await first(tx, organizationId, sourceProposalId);
        if (found === undefined)
          throw new Error("Re-priced proposal vanished.");
        let writebackOperationId: string | undefined;
        if (announced !== undefined) {
          // Whether the site posts back is the connection's grant, read in
          // the same transaction as the re-price so a site disconnected
          // between the two cannot leave a follow-up nobody can deliver.
          // The site is the bounty's: an approval comment went to its issue.
          const site = await tx
            .select({
              scopes: jiraConnection.scopes,
              resourceScopes: jiraConnection.resourceScopes,
            })
            .from(jiraIssue)
            .innerJoin(jiraBoard, eq(jiraBoard.id, jiraIssue.boardId))
            .innerJoin(
              jiraConnection,
              eq(jiraConnection.id, jiraBoard.connectionId),
            )
            .where(
              and(
                eq(jiraIssue.organizationId, organizationId),
                eq(jiraIssue.bountyId, input.bountyId),
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
          proposal: toDto(found.row, found.name),
          ...(writebackOperationId === undefined
            ? {}
            : { writebackOperationId }),
        } as const;
      });
    },

    async respecForLease(
      organizationId,
      leaseToken,
      sourceProposalId,
      sourceRevision,
      input,
    ) {
      return db.transaction(async (transaction) => {
        const tx = transaction;
        const now = new Date();
        const claimed = (await tx
          .update(bountyRun)
          .set({ updatedAt: sql`${bountyRun.updatedAt}` })
          .where(
            and(
              eq(bountyRun.organizationId, organizationId),
              eq(bountyRun.id, input.runId),
              eq(bountyRun.status, "running"),
              eq(bountyRun.kind, "respec"),
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

        // The row lock, and the check that nothing moved it since the
        // change was asked for: not its revision, not its spec, and not an
        // approval.
        const locked = (await tx
          .update(bountyProposal)
          .set({ updatedAt: sql`${bountyProposal.updatedAt}` })
          .where(
            and(
              eq(bountyProposal.organizationId, organizationId),
              eq(bountyProposal.id, sourceProposalId),
              eq(bountyProposal.status, "proposed"),
              eq(bountyProposal.revision, sourceRevision),
              eq(bountyProposal.specRevision, input.fromSpecRevision),
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

        const specRevision = await nextSpecRevision(
          tx,
          organizationId,
          sourceProposalId,
        );
        const updated = (await tx
          .update(bountyProposal)
          .set({
            complexity: input.step.complexity,
            step: input.step,
            stepVersion: input.step.stepVersion,
            amountMinor: input.amountMinor,
            currency: input.currency,
            specRevision,
            revision: sourceRevision + 1,
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
        if (updated[0] === undefined) {
          throw new Error("Failed to change the proposal's spec.");
        }
        await insertSpecRevision(
          tx,
          organizationId,
          {
            proposalId: sourceProposalId,
            runId: input.runId,
            revision: specRevision,
            createdBy: run.startedBy,
          },
          input.spec,
        );
        const found = await first(tx, organizationId, sourceProposalId);
        if (found === undefined)
          throw new Error("Respecced proposal vanished.");
        return {
          status: "respecced",
          proposal: toDto(found.row, found.name),
          previousComplexity: source.complexity as BountyComplexity,
        } as const;
      });
    },
  };
}
