import type {
  BountyRunOutcome,
  BountyRunPlannedIssue,
  BountySelection,
  RateCardSnapshot,
} from "sandbox-factory";
import { and, desc, eq, gt, lt, ne, or, sql } from "drizzle-orm";

import { isUniqueViolation, type Database } from "./errors.js";
import { generateId } from "./mapping.js";
import { bountyRun, jiraBoard } from "./schema.js";
import type { BountyRunRow } from "./schema.js";

export interface CreateBountyRunInput {
  readonly boardId: string;
  readonly startedBy: string;
  readonly kind?: "backlog" | "reprice" | "issue";
  /** The ticket an `issue` run sizes, stored as its plan from the start. */
  readonly planned?: readonly BountyRunPlannedIssue[];
  readonly sourceProposalId?: string;
  readonly sourceRevision?: number;
  readonly requestId: string;
  readonly selection: BountySelection;
  readonly rateCard: RateCardSnapshot;
  readonly requestedModel: string;
  readonly promptVersion: string;
}

export type CreateBountyRunResult =
  | {
      readonly ok: true;
      readonly run: StoredBountyRun;
      readonly created: boolean;
    }
  | { readonly ok: false; readonly reason: "not-found" }
  | { readonly ok: false; readonly reason: "request-conflict" }
  | { readonly ok: false; readonly reason: "active"; readonly runId: string };

export interface BountyRunStore {
  create(
    organizationId: string,
    input: CreateBountyRunInput,
  ): Promise<CreateBountyRunResult>;
  get(organizationId: string, runId: string): Promise<StoredBountyRun | null>;
  listForBoard(
    organizationId: string,
    boardId: string,
    options?: { cursor?: string; limit?: number },
  ): Promise<StoredBountyRun[]>;
  claim(
    organizationId: string,
    runId: string,
    leaseToken: string,
    now: Date,
  ): Promise<StoredBountyRun | null>;
  heartbeat(
    organizationId: string,
    runId: string,
    leaseToken: string,
    now: Date,
  ): Promise<boolean>;
  /**
   * The tickets a claimed run is about to size, written once before the
   * first. Guarded by the lease like an outcome, so a run that lost its lease
   * cannot overwrite the plan of the worker that took it over.
   *
   * **Also sets the run's deadline from the size of the plan** (see
   * `runDeadline`), and returns the run so the caller sizes against the
   * deadline now in force rather than the one it claimed with. Null when the
   * lease is gone.
   */
  recordPlan(
    organizationId: string,
    runId: string,
    leaseToken: string,
    planned: readonly BountyRunPlannedIssue[],
  ): Promise<StoredBountyRun | null>;
  recordOutcome(
    organizationId: string,
    runId: string,
    leaseToken: string,
    outcome: BountyRunOutcome,
  ): Promise<boolean>;
  finish(
    organizationId: string,
    runId: string,
    leaseToken: string,
    status: "succeeded" | "partial" | "failed",
    details?: {
      fatalErrorCode?: string;
      candidatesScanned?: number;
      skippedLive?: number;
      scanLimitReached?: boolean;
    },
  ): Promise<StoredBountyRun | null>;
  failExpired(organizationId: string, now: Date): Promise<number>;
  /** Privileged watchdog discovery; returned ids must still be passed to failExpired. */
  organizationsWithExpiredRuns(now: Date): Promise<string[]>;
}

/** How long a run has to choose its tickets, before any is sized. */
const RUN_BASE_MS = 10 * 60_000;
/**
 * The allowance each planned ticket adds. A ticket costs one Jira read and
 * one model call, and three are sized at a time, so this is several times
 * what one needs. It is a bound on a stuck run, not a target.
 */
const RUN_PER_TICKET_MS = 20_000;

/**
 * When a run with this many planned tickets must be finished.
 *
 * A run takes every ticket that matches a category, so its length is the
 * board's to decide, not a constant. A fixed deadline would fail a large
 * run partway as `worker_lost`; one that grows with the plan still ends a
 * run that has stopped making progress.
 */
export function runDeadline(now: Date, plannedTickets: number): Date {
  return new Date(
    now.getTime() + RUN_BASE_MS + RUN_PER_TICKET_MS * plannedTickets,
  );
}

export interface StoredBountyRun {
  readonly id: string;
  readonly organizationId: string;
  readonly boardId: string;
  readonly kind: "backlog" | "reprice" | "issue";
  readonly sourceProposalId: string | null;
  readonly sourceRevision: number | null;
  readonly requestId: string;
  readonly status: "queued" | "running" | "succeeded" | "partial" | "failed";
  readonly selection: BountySelection;
  readonly rateCard: RateCardSnapshot;
  readonly requestedModel: string;
  readonly promptVersion: string;
  readonly planned: BountyRunPlannedIssue[];
  readonly outcomes: BountyRunOutcome[];
  readonly candidatesScanned: number;
  readonly skippedLive: number;
  readonly scanLimitReached: boolean;
  readonly fatalErrorCode: string | null;
  readonly startedAt: string | null;
  readonly deadlineAt: string | null;
  readonly finishedAt: string | null;
  readonly createdAt: string;
}

function toDto(row: BountyRunRow): StoredBountyRun {
  return {
    id: row.id,
    organizationId: row.organizationId,
    boardId: row.boardId,
    kind: row.kind as StoredBountyRun["kind"],
    sourceProposalId: row.sourceProposalId,
    sourceRevision: row.sourceRevision,
    requestId: row.requestId,
    status: row.status as StoredBountyRun["status"],
    selection: row.selection,
    rateCard: {
      ...row.rateCard,
      xsMinor: row.rateCard.xsMinor ?? row.rateCard.sMinor,
    },
    requestedModel: row.requestedModel,
    promptVersion: row.promptVersion,
    planned: row.planned,
    outcomes: row.outcomes,
    candidatesScanned: row.candidatesScanned,
    skippedLive: row.skippedLive,
    scanLimitReached: row.scanLimitReached,
    fatalErrorCode: row.fatalErrorCode,
    startedAt: row.startedAt?.toISOString() ?? null,
    deadlineAt: row.deadlineAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

async function firstByRequest(
  db: Database,
  organizationId: string,
  requestId: string,
): Promise<BountyRunRow | undefined> {
  const rows = (await db
    .select()
    .from(bountyRun)
    .where(
      and(
        eq(bountyRun.organizationId, organizationId),
        eq(bountyRun.requestId, requestId),
      ),
    )) as BountyRunRow[];
  return rows[0];
}

async function activeForBoard(
  db: Database,
  organizationId: string,
  boardId: string,
): Promise<BountyRunRow | undefined> {
  const rows = (await db
    .select()
    .from(bountyRun)
    .where(
      and(
        eq(bountyRun.organizationId, organizationId),
        eq(bountyRun.boardId, boardId),
        or(eq(bountyRun.status, "queued"), eq(bountyRun.status, "running")),
        ne(bountyRun.kind, "issue"),
      ),
    )) as BountyRunRow[];
  return rows[0];
}

function sameRequest(row: BountyRunRow, input: CreateBountyRunInput): boolean {
  return (
    row.boardId === input.boardId &&
    row.kind === (input.kind ?? "backlog") &&
    row.sourceProposalId === (input.sourceProposalId ?? null) &&
    row.sourceRevision === (input.sourceRevision ?? null) &&
    row.planned[0]?.externalIssueId === input.planned?.[0]?.externalIssueId
  );
}

export function createBountyRunStore(db: Database): BountyRunStore {
  return {
    async create(organizationId, input) {
      const existing = await firstByRequest(
        db,
        organizationId,
        input.requestId,
      );
      if (existing !== undefined) {
        return sameRequest(existing, input)
          ? { ok: true, run: toDto(existing), created: false }
          : { ok: false, reason: "request-conflict" };
      }

      const ownedBoard = await db
        .select({ id: jiraBoard.id })
        .from(jiraBoard)
        .where(
          and(
            eq(jiraBoard.organizationId, organizationId),
            eq(jiraBoard.id, input.boardId),
          ),
        );
      if (ownedBoard[0] === undefined)
        return { ok: false, reason: "not-found" };

      const active =
        input.kind === "issue"
          ? undefined
          : await activeForBoard(db, organizationId, input.boardId);
      if (active !== undefined) {
        return { ok: false, reason: "active", runId: active.id };
      }

      try {
        const rows = (await db
          .insert(bountyRun)
          .values({
            id: generateId("brn"),
            organizationId,
            boardId: input.boardId,
            startedBy: input.startedBy,
            kind: input.kind ?? "backlog",
            sourceProposalId: input.sourceProposalId ?? null,
            sourceRevision: input.sourceRevision ?? null,
            requestId: input.requestId,
            selection: input.selection,
            rateCard: input.rateCard,
            requestedModel: input.requestedModel,
            promptVersion: input.promptVersion,
            planned: [...(input.planned ?? [])],
          })
          .returning()) as BountyRunRow[];
        const created = rows[0];
        if (created === undefined)
          throw new Error("Failed to create bounty run.");
        return { ok: true, run: toDto(created), created: true };
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        const racedRequest = await firstByRequest(
          db,
          organizationId,
          input.requestId,
        );
        if (racedRequest !== undefined) {
          return sameRequest(racedRequest, input)
            ? { ok: true, run: toDto(racedRequest), created: false }
            : { ok: false, reason: "request-conflict" };
        }
        const racedActive = await activeForBoard(
          db,
          organizationId,
          input.boardId,
        );
        if (racedActive !== undefined) {
          return { ok: false, reason: "active", runId: racedActive.id };
        }
        throw error;
      }
    },

    async get(organizationId, runId) {
      const rows = (await db
        .select()
        .from(bountyRun)
        .where(
          and(
            eq(bountyRun.organizationId, organizationId),
            eq(bountyRun.id, runId),
          ),
        )) as BountyRunRow[];
      return rows[0] === undefined ? null : toDto(rows[0]);
    },

    async listForBoard(organizationId, boardId, options = {}) {
      const limit = Math.min(Math.max(options.limit ?? 25, 1), 50);
      const rows = (await db
        .select()
        .from(bountyRun)
        .where(
          and(
            eq(bountyRun.organizationId, organizationId),
            eq(bountyRun.boardId, boardId),
            options.cursor === undefined
              ? sql`true`
              : lt(bountyRun.createdAt, new Date(options.cursor)),
          ),
        )
        .orderBy(desc(bountyRun.createdAt))
        .limit(limit)) as BountyRunRow[];
      return rows.map(toDto);
    },

    async claim(organizationId, runId, leaseToken, now) {
      const leaseExpiresAt = new Date(now.getTime() + 60_000);
      // Before the plan exists, so with no tickets to allow for. `recordPlan`
      // moves it once the run knows how many it will size.
      const deadlineAt = runDeadline(now, 0);
      const rows = (await db
        .update(bountyRun)
        .set({
          status: "running",
          leaseToken,
          leaseExpiresAt,
          heartbeatAt: now,
          deadlineAt,
          startedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(bountyRun.organizationId, organizationId),
            eq(bountyRun.id, runId),
            eq(bountyRun.status, "queued"),
          ),
        )
        .returning()) as BountyRunRow[];
      return rows[0] === undefined ? null : toDto(rows[0]);
    },

    async heartbeat(organizationId, runId, leaseToken, now) {
      const rows = (await db
        .update(bountyRun)
        .set({
          heartbeatAt: now,
          leaseExpiresAt: new Date(now.getTime() + 60_000),
          updatedAt: now,
        })
        .where(
          and(
            eq(bountyRun.organizationId, organizationId),
            eq(bountyRun.id, runId),
            eq(bountyRun.status, "running"),
            eq(bountyRun.leaseToken, leaseToken),
            gt(bountyRun.leaseExpiresAt, now),
            gt(bountyRun.deadlineAt, now),
          ),
        )
        .returning()) as BountyRunRow[];
      return rows.length > 0;
    },

    async recordPlan(organizationId, runId, leaseToken, planned) {
      const now = new Date();
      const rows = (await db
        .update(bountyRun)
        .set({
          planned: [...planned],
          // Always later than the deadline `claim` set: this runs after it,
          // from a later `now`, with at least the same allowance.
          deadlineAt: runDeadline(now, planned.length),
          updatedAt: now,
        })
        .where(
          and(
            eq(bountyRun.organizationId, organizationId),
            eq(bountyRun.id, runId),
            eq(bountyRun.status, "running"),
            eq(bountyRun.leaseToken, leaseToken),
            gt(bountyRun.leaseExpiresAt, now),
          ),
        )
        .returning()) as BountyRunRow[];
      return rows[0] === undefined ? null : toDto(rows[0]);
    },

    async recordOutcome(organizationId, runId, leaseToken, outcome) {
      const now = new Date();
      const rows = (await db
        .update(bountyRun)
        .set({
          outcomes: sql`${bountyRun.outcomes} || ${JSON.stringify([outcome])}::jsonb`,
          updatedAt: now,
        })
        .where(
          and(
            eq(bountyRun.organizationId, organizationId),
            eq(bountyRun.id, runId),
            eq(bountyRun.status, "running"),
            eq(bountyRun.leaseToken, leaseToken),
            gt(bountyRun.leaseExpiresAt, now),
            gt(bountyRun.deadlineAt, now),
            // One outcome per planned ticket, and no more. The plan is the
            // bound now that a run has no fixed number of tickets.
            sql`jsonb_array_length(${bountyRun.outcomes}) < jsonb_array_length(${bountyRun.planned})`,
          ),
        )
        .returning()) as BountyRunRow[];
      return rows.length > 0;
    },

    async finish(organizationId, runId, leaseToken, status, details = {}) {
      const now = new Date();
      const rows = (await db
        .update(bountyRun)
        .set({
          status,
          fatalErrorCode: details.fatalErrorCode ?? null,
          ...(details.candidatesScanned === undefined
            ? {}
            : { candidatesScanned: details.candidatesScanned }),
          ...(details.skippedLive === undefined
            ? {}
            : { skippedLive: details.skippedLive }),
          ...(details.scanLimitReached === undefined
            ? {}
            : { scanLimitReached: details.scanLimitReached }),
          finishedAt: now,
          leaseToken: null,
          leaseExpiresAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(bountyRun.organizationId, organizationId),
            eq(bountyRun.id, runId),
            eq(bountyRun.status, "running"),
            eq(bountyRun.leaseToken, leaseToken),
            gt(bountyRun.leaseExpiresAt, now),
            gt(bountyRun.deadlineAt, now),
          ),
        )
        .returning()) as BountyRunRow[];
      return rows[0] === undefined ? null : toDto(rows[0]);
    },

    async failExpired(organizationId, now) {
      const rows = (await db
        .update(bountyRun)
        .set({
          status: "failed",
          fatalErrorCode: "worker_lost",
          finishedAt: now,
          leaseToken: null,
          leaseExpiresAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(bountyRun.organizationId, organizationId),
            or(
              and(
                eq(bountyRun.status, "running"),
                lt(bountyRun.leaseExpiresAt, now),
              ),
              and(
                eq(bountyRun.status, "queued"),
                lt(bountyRun.createdAt, new Date(now.getTime() - 60_000)),
              ),
            ),
          ),
        )
        .returning()) as BountyRunRow[];
      return rows.length;
    },

    async organizationsWithExpiredRuns(now) {
      const rows = await db
        .select({ organizationId: bountyRun.organizationId })
        .from(bountyRun)
        .where(
          or(
            and(
              eq(bountyRun.status, "running"),
              lt(bountyRun.leaseExpiresAt, now),
            ),
            and(
              eq(bountyRun.status, "queued"),
              lt(bountyRun.createdAt, new Date(now.getTime() - 60_000)),
            ),
          ),
        );
      return [...new Set(rows.map((row) => row.organizationId))];
    },
  };
}
