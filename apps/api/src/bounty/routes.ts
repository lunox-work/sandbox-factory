import { randomUUID } from "node:crypto";

import type {
  BountyProposalStore,
  BountyRunStore,
  BountyWritebackStore,
  JiraBoardStore,
  JiraConnectionStore,
  JiraIssueStore,
  RateCardStore,
  StoredBountyRun,
  StoredRateCard,
} from "@sandbox-factory/db";
import { JiraApiError, JiraAuthError } from "@sandbox-factory/jira";
import {
  addIssueSchema,
  boardSelectionSchema,
  createRunSchema,
  putRateCardSchema,
  proposalMutationSchema,
  repriceProposalSchema,
  resizeProposalSchema,
} from "@sandbox-factory/shared";
import type {
  BountyRunPlannedIssue,
  JiraIssueDto,
} from "@sandbox-factory/shared";
import type { Hono } from "hono";
import {
  DEFAULT_RATE_CARD,
  priceFor,
  validateRateCard,
  type PricedComplexity,
} from "sandbox-factory";

import type {
  BountyExecutor,
  RunClientResult,
  RunJiraClient,
} from "./executor.js";
import type { BountyDelivery } from "./delivery.js";
import { freshProposal, mapConcurrent } from "./review.js";

export interface BountyRouteOptions {
  readonly rateCards: RateCardStore;
  readonly runs: BountyRunStore;
  readonly boards: JiraBoardStore;
  readonly proposals: BountyProposalStore;
  readonly issues: JiraIssueStore;
  readonly connections?: JiraConnectionStore;
  readonly writebacks?: BountyWritebackStore;
  readonly delivery?: BountyDelivery;
  readonly appUrl?: string;
  readonly organizationSlug?: (
    organizationId: string,
  ) => Promise<string | undefined>;
  readonly executor?: BountyExecutor;
  readonly clientFor?: (
    organizationId: string,
    connectionId: string,
  ) => Promise<RunClientResult>;
  readonly requestedModel?: string;
  readonly promptVersion?: string;
  readonly supportedCurrencies?: ReadonlySet<string>;
}

interface BountyAppEnv {
  Variables: {
    user: { id: string };
    member: { organizationId: string; role: string };
  };
}

/** Why a run did not start, for the route to answer and a caller to skip. */
export type StartRunResult =
  | { readonly ok: true; readonly run: StoredBountyRun }
  | { readonly ok: false; readonly reason: "active"; readonly runId: string }
  | {
      readonly ok: false;
      readonly reason: "live-proposal";
      readonly proposalId: string;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "sizing-unavailable"
        | "not-found"
        | "reconnect"
        | "rate-card-required"
        | "request-conflict";
    };

/**
 * Start sizing one board: the run row, then the executor in the background.
 *
 * Shared by the board's run endpoint and the Jira callback, which sizes the
 * boards a newly connected site brings. The checks are the same either way —
 * a run needs a sizer, a usable connection and a rate card to price with —
 * and so is the idempotency: `requestId` names the run, and a board with a
 * run already in flight gets no second one.
 *
 * Does not check the caller's role. The route does, and the callback has
 * already re-read it.
 */
/**
 * Start sizing a board unless it has been sized before.
 *
 * What a Jira sync calls for every board it sees. "Before" means any run,
 * whatever it ended as: a board is sized automatically once, and after that
 * only when someone asks. A board whose first attempt could not start — no
 * sizer yet, a connection needing a reconnect — has no run, so the next sync
 * tries again.
 */
export async function sizeIfNeverSized(
  options: BountyRouteOptions,
  input: {
    readonly organizationId: string;
    readonly boardId: string;
    readonly startedBy: string;
  },
): Promise<StartRunResult | null> {
  const previous = await options.runs.listForBoard(
    input.organizationId,
    input.boardId,
    { limit: 1 },
  );
  if (previous.length > 0) return null;
  return startRun(options, { ...input, requestId: randomUUID() });
}

/**
 * The organization's rate card, saving the default the first time a run
 * needs one.
 *
 * The editor shows `DEFAULT_RATE_CARD` to an organization that never saved a
 * card, so that is the card the organization has as far as anyone can see.
 * Pricing with it without saving it would snapshot a revision no row holds;
 * saving it makes the run's snapshot and the editor agree. A save that loses
 * a race to a person's own first save takes theirs.
 */
async function rateCardFor(
  rateCards: RateCardStore,
  organizationId: string,
  input: { readonly startedBy: string },
): Promise<StoredRateCard | null> {
  const saved = await rateCards.get(organizationId);
  if (saved !== null) return saved;
  const put = await rateCards.put(
    organizationId,
    input.startedBy,
    DEFAULT_RATE_CARD,
    0,
  );
  return put.ok ? put.rateCard : put.current;
}

/** How many tickets the search shows, and how many it asks Jira for. */
const SEARCH_RESULTS = 10;
const SEARCH_CANDIDATES = 50;

/**
 * One ticket, if it is on the board.
 *
 * Read through the board rather than by issue id alone, so a run on one board
 * cannot be pointed at a ticket that belongs to another — or to a project the
 * board does not show.
 */
async function ticketOnBoard(
  client: RunJiraClient,
  boardExternalId: string,
  issueId: string,
): Promise<JiraIssueDto | null> {
  try {
    const page = await client.boardIssues(Number(boardExternalId), {
      jql: `issue = ${issueId}`,
      startAt: 0,
      maxResults: 1,
    });
    return page.issues[0] ?? null;
  } catch (error) {
    // Jira answers 400 for an issue id that does not exist.
    if (error instanceof JiraApiError && error.status === 400) return null;
    throw error;
  }
}

/**
 * JQL for what a person typed into the board's ticket search.
 *
 * A key (`APP-12`) is looked up as a key; anything else is a text search on
 * what is left once JQL's reserved characters are removed — they would
 * otherwise make Jira refuse the query rather than search for them.
 */
export function ticketSearchJql(query: string): string | null {
  const text = query.trim().slice(0, 100);
  if (/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(text)) {
    return `key = "${text.toUpperCase()}"`;
  }
  const words = text
    .replace(/[+\-&|!(){}[\]^~*?\\:"'/]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return words === "" ? null : `text ~ "${words}*"`;
}

export async function startRun(
  options: BountyRouteOptions,
  input: {
    readonly organizationId: string;
    readonly boardId: string;
    readonly startedBy: string;
    readonly requestId: string;
    /**
     * Size this one ticket rather than the board's backlog. It must be on
     * the board, and a ticket that already has a live proposal gets that
     * proposal back instead of a run.
     */
    readonly issueId?: string;
  },
): Promise<StartRunResult> {
  const { organizationId } = input;
  if (
    options.executor === undefined ||
    options.clientFor === undefined ||
    options.requestedModel === undefined ||
    options.promptVersion === undefined
  ) {
    return { ok: false, reason: "sizing-unavailable" };
  }

  const board = await options.boards.forRun(organizationId, input.boardId);
  if (board === null) return { ok: false, reason: "not-found" };
  const ready = await options.clientFor(organizationId, board.connectionId);
  if (!ready.ok) {
    return {
      ok: false,
      reason: ready.reason === "not-found" ? "not-found" : "reconnect",
    };
  }
  let planned: BountyRunPlannedIssue | undefined;
  if (input.issueId !== undefined) {
    const found = await ticketOnBoard(
      ready.client,
      board.board.externalId,
      input.issueId,
    );
    if (found === null) return { ok: false, reason: "not-found" };
    const live = await options.proposals.liveProposalIds(
      organizationId,
      board.board.id,
      [found.id],
    );
    const proposalId = live.get(found.id);
    if (proposalId !== undefined) {
      return { ok: false, reason: "live-proposal", proposalId };
    }
    planned = {
      externalIssueId: found.id,
      issueKey: found.key,
      summary: found.summary,
    };
  }

  const card = await rateCardFor(options.rateCards, organizationId, input);
  if (card === null) return { ok: false, reason: "rate-card-required" };

  const created = await options.runs.create(organizationId, {
    ...(planned === undefined ? {} : { kind: "issue", planned: [planned] }),
    boardId: board.board.id,
    startedBy: input.startedBy,
    requestId: input.requestId,
    selection: boardSelectionSchema.parse(board.board.selection),
    rateCard: {
      currency: card.currency,
      xsMinor: card.xsMinor,
      sMinor: card.sMinor,
      mMinor: card.mMinor,
      lMinor: card.lMinor,
      xlMinor: card.xlMinor,
      revision: card.revision,
    },
    requestedModel: options.requestedModel,
    promptVersion: options.promptVersion,
  });
  if (!created.ok) {
    return created.reason === "active"
      ? { ok: false, reason: "active", runId: created.runId }
      : {
          ok: false,
          reason:
            created.reason === "request-conflict"
              ? "request-conflict"
              : "not-found",
        };
  }
  if (created.created) options.executor.start(organizationId, created.run.id);
  return { ok: true, run: created.run };
}

export function mountBountyRoutes<Env extends BountyAppEnv>(
  app: Hono<Env>,
  options: BountyRouteOptions,
): void {
  const supportedCurrencies =
    options.supportedCurrencies ?? new Set(Intl.supportedValuesOf("currency"));

  app.get("/api/v1/orgs/:orgId/rate-card", async (c) => {
    const { organizationId } = c.get("member");
    return c.json({ rateCard: await options.rateCards.get(organizationId) });
  });

  app.put("/api/v1/orgs/:orgId/rate-card", async (c) => {
    const { organizationId, role } = c.get("member");
    if (!isAtLeastAdmin(role)) {
      return c.json(
        { error: "Only an owner or admin may edit the rate card." },
        403,
      );
    }
    const parsed = putRateCardSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json(
        { code: "invalid_rate_card", error: "Invalid rate card." },
        400,
      );
    }
    const validated = validateRateCard(parsed.data, supportedCurrencies);
    if (!validated.ok) {
      return c.json(
        { code: "invalid_rate_card", error: validated.reason },
        400,
      );
    }
    const saved = await options.rateCards.put(
      organizationId,
      c.get("user").id,
      validated.rateCard,
      parsed.data.expectedRevision,
    );
    if (!saved.ok) {
      return c.json(
        {
          code: "rate_card_changed",
          error: "The rate card changed. Reload it before saving.",
          rateCard: saved.current,
        },
        409,
      );
    }
    return c.json({ rateCard: saved.rateCard });
  });

  app.post("/api/v1/orgs/:orgId/jira/boards/:id/runs", async (c) => {
    const { organizationId, role } = c.get("member");
    if (!isAtLeastAdmin(role)) {
      return c.json({ error: "Only an owner or admin may start a run." }, 403);
    }
    const parsed = createRunSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json({ error: "Provide a valid requestId." }, 400);
    }

    const started = await startRun(options, {
      organizationId,
      boardId: c.req.param("id"),
      startedBy: c.get("user").id,
      requestId: parsed.data.requestId,
    });
    if (started.ok) return c.json({ run: started.run }, 202);
    switch (started.reason) {
      case "sizing-unavailable":
        return c.json(
          {
            code: "sizing_unavailable",
            error: "Sizing is not configured for this deployment.",
          },
          503,
        );
      case "reconnect":
        return c.json(
          {
            code: "reconnect",
            error: "This Jira connection needs reconnecting.",
          },
          409,
        );
      case "rate-card-required":
        return c.json(
          {
            code: "rate_card_required",
            error: "Set a rate card before running.",
          },
          409,
        );
      case "active":
        return c.json(
          {
            code: "run_active",
            error: "A run is already active for this board.",
            runId: started.runId,
          },
          409,
        );
      case "request-conflict":
        return c.json(
          {
            code: "request_conflict",
            error: "That requestId was already used for another run.",
          },
          409,
        );
      case "not-found":
      case "live-proposal":
        return c.json({ error: "Not found" }, 404);
    }
  });

  /**
   * Search the board's tickets, for picking one to size.
   *
   * Read live through the board, so it finds what the board shows and
   * nothing else. A ticket already on the platform — one with a live
   * proposal, proposed or approved — is left out: the list is for adding,
   * and that ticket is already in the proposals below. Jira is asked for a
   * page of candidates so that dropping those still leaves a full list.
   * Any member may search; only an owner or admin may add.
   */
  app.get("/api/v1/orgs/:orgId/jira/boards/:id/search", async (c) => {
    const { organizationId } = c.get("member");
    if (options.clientFor === undefined) {
      return c.json(
        {
          code: "sizing_unavailable",
          error: "Sizing is not configured for this deployment.",
        },
        503,
      );
    }
    const board = await options.boards.forRun(
      organizationId,
      c.req.param("id"),
    );
    if (board === null) return c.json({ error: "Not found" }, 404);
    const jql = ticketSearchJql(c.req.query("q") ?? "");
    if (jql === null) return c.json({ issues: [] });
    const ready = await options.clientFor(organizationId, board.connectionId);
    if (!ready.ok) {
      return ready.reason === "not-found"
        ? c.json({ error: "Not found" }, 404)
        : c.json(
            {
              code: "reconnect",
              error: "This Jira connection needs reconnecting.",
            },
            409,
          );
    }

    let issues: JiraIssueDto[];
    try {
      issues = (
        await ready.client.boardIssues(Number(board.board.externalId), {
          jql,
          startAt: 0,
          maxResults: SEARCH_CANDIDATES,
        })
      ).issues;
    } catch (error) {
      // A key that does not exist is a 400 from Jira, not an error to show.
      if (error instanceof JiraApiError && error.status === 400) {
        return c.json({ issues: [] });
      }
      if (
        (error instanceof JiraAuthError && error.needsReconnect) ||
        (error instanceof JiraApiError && error.isUnauthorized)
      ) {
        return c.json(
          {
            code: "reconnect",
            error: "This Jira connection needs reconnecting.",
          },
          409,
        );
      }
      return c.json({ error: "Jira could not be searched." }, 502);
    }

    const live = await options.proposals.liveProposalIds(
      organizationId,
      board.board.id,
      issues.map(({ id }) => id),
    );
    return c.json({
      issues: issues
        .filter(({ id }) => !live.has(id))
        .slice(0, SEARCH_RESULTS)
        .map((issue) => ({
          id: issue.id,
          key: issue.key,
          summary: issue.summary,
          status: issue.status,
          issueType: issue.issueType,
        })),
    });
  });

  /**
   * Size one ticket someone picked, in the background.
   *
   * 202 with the run, which the page polls until the proposal lands and
   * then opens it. A ticket that already has a live proposal is 200 with
   * that proposal's id, so the page opens it without sizing anything.
   */
  app.post("/api/v1/orgs/:orgId/jira/boards/:id/issues", async (c) => {
    const { organizationId, role } = c.get("member");
    if (!isAtLeastAdmin(role)) {
      return c.json({ error: "Only an owner or admin may add a ticket." }, 403);
    }
    const parsed = addIssueSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json({ error: "Provide a requestId and an issueId." }, 400);
    }

    let started: StartRunResult;
    try {
      started = await startRun(options, {
        organizationId,
        boardId: c.req.param("id"),
        startedBy: c.get("user").id,
        requestId: parsed.data.requestId,
        issueId: parsed.data.issueId,
      });
    } catch (error) {
      // Only Jira's own failures are Jira's. Anything else — a database
      // refusing the row — is a server fault, left to the error handler so
      // it is logged rather than reported as a Jira problem.
      if (error instanceof JiraApiError || error instanceof JiraAuthError) {
        return c.json({ error: "Jira could not be read." }, 502);
      }
      throw error;
    }
    if (started.ok) return c.json({ run: started.run }, 202);
    switch (started.reason) {
      case "live-proposal":
        return c.json({ proposalId: started.proposalId });
      case "sizing-unavailable":
        return c.json(
          {
            code: "sizing_unavailable",
            error: "Sizing is not configured for this deployment.",
          },
          503,
        );
      case "reconnect":
        return c.json(
          {
            code: "reconnect",
            error: "This Jira connection needs reconnecting.",
          },
          409,
        );
      case "request-conflict":
        return c.json(
          {
            code: "request_conflict",
            error: "That requestId was already used for another run.",
          },
          409,
        );
      default:
        return c.json({ error: "Not found" }, 404);
    }
  });

  app.get("/api/v1/orgs/:orgId/jira/boards/:id/runs", async (c) => {
    const { organizationId } = c.get("member");
    const boardId = c.req.param("id");
    if ((await options.boards.get(organizationId, boardId)) === null) {
      return c.json({ error: "Not found" }, 404);
    }
    const limit = boundedLimit(c.req.query("limit"));
    const cursor = pageCursor(c.req.query("cursor"));
    if (cursor === null) return c.json({ error: "Invalid cursor." }, 400);
    const runs = await options.runs.listForBoard(organizationId, boardId, {
      limit,
      ...(cursor === undefined ? {} : { cursor }),
    });
    return c.json({
      runs,
      nextCursor:
        runs.length === limit ? (runs.at(-1)?.createdAt ?? null) : null,
      sizingAvailable:
        options.executor !== undefined && options.clientFor !== undefined,
    });
  });

  app.get("/api/v1/orgs/:orgId/runs/:id", async (c) => {
    const { organizationId } = c.get("member");
    const run = await options.runs.get(organizationId, c.req.param("id"));
    return run === null ? c.json({ error: "Not found" }, 404) : c.json({ run });
  });

  app.get("/api/v1/orgs/:orgId/proposals", async (c) => {
    const { organizationId } = c.get("member");
    const boardId = c.req.query("boardId");
    if (
      boardId === undefined ||
      (await options.boards.get(organizationId, boardId)) === null
    ) {
      return c.json({ error: "Not found" }, 404);
    }
    const status = proposalStatus(c.req.query("status"));
    if (status === null) return c.json({ error: "Invalid status." }, 400);
    const limit = boundedLimit(c.req.query("limit"));
    const cursor = proposalCursor(c.req.query("cursor"));
    if (cursor === null) return c.json({ error: "Invalid cursor." }, 400);
    const proposals = await options.proposals.listForBoard(
      organizationId,
      boardId,
      {
        limit,
        ...(status === undefined ? {} : { status }),
        ...(cursor === undefined ? {} : { cursor }),
      },
    );
    const enriched =
      options.clientFor === undefined
        ? proposals.map((proposal) => ({
            ...proposal,
            freshness: "unknown" as const,
            checkedAt: new Date().toISOString(),
            code: "reconnect",
          }))
        : await mapConcurrent(proposals, 3, async (proposal) => {
            const live = await freshProposal(
              {
                proposals: options.proposals,
                issues: options.issues,
                boards: options.boards,
                clientFor: options.clientFor!,
              },
              organizationId,
              proposal,
            );
            const { liveSpec: _discard, proposal: stored, ...freshness } = live;
            return { ...stored, ...freshness };
          });
    const withDelivery =
      options.writebacks === undefined
        ? enriched
        : await Promise.all(
            enriched.map(async (proposal) => ({
              ...proposal,
              writebackOperations: await options.writebacks!.listForProposal(
                organizationId,
                proposal.id,
              ),
            })),
          );
    return c.json({
      proposals: withDelivery,
      nextCursor:
        proposals.length === limit && proposals.at(-1) !== undefined
          ? `${proposals.at(-1)!.createdAt}|${proposals.at(-1)!.id}`
          : null,
    });
  });

  app.get("/api/v1/orgs/:orgId/proposals/:id", async (c) => {
    const { organizationId } = c.get("member");
    const proposal = await options.proposals.get(
      organizationId,
      c.req.param("id"),
    );
    if (proposal === null) return c.json({ error: "Not found" }, 404);
    const pointer = await options.issues.get(
      organizationId,
      proposal.jiraIssueId,
    );
    const expectedBoardId = c.req.query("boardId");
    if (
      pointer === null ||
      (expectedBoardId !== undefined && pointer.boardId !== expectedBoardId)
    ) {
      return c.json({ error: "Not found" }, 404);
    }
    if (options.clientFor === undefined) {
      return c.json({
        proposal,
        liveSpec: null,
        freshness: {
          freshness: "unknown",
          checkedAt: new Date().toISOString(),
          code: "reconnect",
        },
        writebackOperations: [],
      });
    }
    const live = await freshProposal(
      {
        proposals: options.proposals,
        issues: options.issues,
        boards: options.boards,
        clientFor: options.clientFor,
      },
      organizationId,
      proposal,
    );
    const { proposal: stored, liveSpec, ...freshness } = live;
    return c.json({
      proposal: stored,
      liveSpec: liveSpec ?? null,
      freshness,
      writebackOperations:
        options.writebacks === undefined
          ? []
          : await options.writebacks.listForProposal(
              organizationId,
              proposal.id,
            ),
    });
  });

  app.post("/api/v1/orgs/:orgId/proposals/:id/approve", async (c) => {
    const parsed = proposalMutationSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      return c.json({ error: "Invalid proposal revision." }, 400);
    const denied = requireAdmin(c.get("member").role);
    if (denied !== null) return c.json(denied, 403);
    return approveWithFreshSpec(c, options, parsed.data.expectedRevision);
  });

  app.post("/api/v1/orgs/:orgId/proposals/:id/resize", async (c) => {
    const parsed = resizeProposalSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      return c.json({ error: "Invalid resize request." }, 400);
    const { organizationId, role } = c.get("member");
    const denied = requireAdmin(role);
    if (denied !== null) return c.json(denied, 403);
    // A resize is a reviewer's own call on the size, and changes nothing
    // but the size and the amount it prices to. It does not read Jira: the
    // ticket is checked when the proposal is approved, which is the
    // decision that depends on it.
    const proposal = await options.proposals.get(
      organizationId,
      c.req.param("id"),
    );
    if (proposal === null) return c.json({ error: "Not found" }, 404);
    if (proposal.revision !== parsed.data.expectedRevision) {
      return c.json(
        {
          code: "proposal_changed",
          error: "The proposal changed. Reload it before continuing.",
          proposal,
        },
        409,
      );
    }
    const amountMinor = priceFor(parsed.data.complexity, proposal.rateCard);
    return proposalMutationResponse(
      c,
      await options.proposals.resize(
        organizationId,
        proposal.id,
        parsed.data.expectedRevision,
        c.get("user").id,
        parsed.data.complexity,
        amountMinor!,
        proposal.rateCard.currency,
      ),
    );
  });

  /**
   * An approved proposal back to proposed, without re-sizing.
   *
   * If the approval's comment reached Jira and the site still holds the
   * write grant, the withdrawal is queued in the same transaction as the
   * status change, so the ticket is never left saying "approved" for a
   * proposal this app no longer calls approved.
   */
  app.post("/api/v1/orgs/:orgId/proposals/:id/unapprove", async (c) => {
    const parsed = proposalMutationSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      return c.json({ error: "Invalid proposal revision." }, 400);
    const { organizationId, role } = c.get("member");
    const denied = requireAdmin(role);
    if (denied !== null) return c.json(denied, 403);
    const proposal = await options.proposals.get(
      organizationId,
      c.req.param("id"),
    );
    if (proposal === null) return c.json({ error: "Not found" }, 404);
    if (options.writebacks !== undefined && proposal.status === "approved") {
      const operations = await options.writebacks.listForProposal(
        organizationId,
        proposal.id,
      );
      if (writebackBusy(operations)) {
        return c.json(
          {
            code: "writeback_busy",
            error: "Resolve the Jira update before changing this approval.",
          },
          409,
        );
      }
      const announced = operations.find(
        (operation) =>
          operation.kind === "approved" && operation.jiraCommentId !== null,
      );
      const pointer = await options.issues.get(
        organizationId,
        proposal.jiraIssueId,
      );
      const registered =
        pointer === null
          ? null
          : await options.boards.forRun(organizationId, pointer.boardId);
      const site =
        registered === null || options.connections === undefined
          ? null
          : await options.connections.get(
              organizationId,
              registered.connectionId,
            );
      if (announced !== undefined && site?.writeGranted === true) {
        if (options.delivery === undefined)
          return c.json(
            {
              code: "write_consent_required",
              error: "Jira delivery is not configured.",
            },
            409,
          );
        const result = await options.writebacks.withdrawWithIntent(
          organizationId,
          proposal.id,
          parsed.data.expectedRevision,
          c.get("user").id,
          announced.payload,
        );
        if (result.status !== "created") {
          return c.json(
            {
              code: "proposal_changed",
              error: "The proposal changed. Reload it before continuing.",
            },
            result.status === "not-found" ? 404 : 409,
          );
        }
        options.delivery.start(organizationId, result.operation.id);
        return c.json({
          proposal: await options.proposals.get(organizationId, proposal.id),
          writebackOperation: result.operation,
        });
      }
    }
    return proposalMutationResponse(
      c,
      await options.proposals.withdraw(
        organizationId,
        c.req.param("id"),
        parsed.data.expectedRevision,
      ),
    );
  });

  /**
   * Deletes a proposed proposal, so the next run may propose the ticket
   * again. An approved one is unapproved or re-priced first — that is what
   * owes Jira a withdrawal, and a write-back is delivered by loading its
   * proposal, so the row must outlive any withdrawal still pending.
   */
  app.post("/api/v1/orgs/:orgId/proposals/:id/remove", async (c) => {
    const parsed = proposalMutationSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      return c.json({ error: "Invalid proposal revision." }, 400);
    const { organizationId, role } = c.get("member");
    const denied = requireAdmin(role);
    if (denied !== null) return c.json(denied, 403);
    if (options.writebacks !== undefined) {
      const operations = await options.writebacks.listForProposal(
        organizationId,
        c.req.param("id"),
      );
      if (writebackBusy(operations)) {
        return c.json(
          {
            code: "writeback_busy",
            error: "Resolve the Jira update before removing this proposal.",
          },
          409,
        );
      }
    }
    return proposalMutationResponse(
      c,
      await options.proposals.remove(
        organizationId,
        c.req.param("id"),
        parsed.data.expectedRevision,
      ),
    );
  });

  app.post("/api/v1/orgs/:orgId/proposals/:id/reprice", async (c) => {
    const parsed = repriceProposalSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      return c.json({ error: "Invalid re-price request." }, 400);
    const { organizationId, role } = c.get("member");
    const denied = requireAdmin(role);
    if (denied !== null) return c.json(denied, 403);
    if (
      options.executor === undefined ||
      options.requestedModel === undefined ||
      options.promptVersion === undefined
    ) {
      return c.json(
        {
          code: "sizing_unavailable",
          error: "Sizing is not configured for this deployment.",
        },
        503,
      );
    }
    const proposal = await options.proposals.get(
      organizationId,
      c.req.param("id"),
    );
    if (proposal === null) return c.json({ error: "Not found" }, 404);
    if (
      proposal.revision !== parsed.data.expectedRevision ||
      !["proposed", "approved"].includes(proposal.status)
    ) {
      return c.json(
        {
          code: "proposal_changed",
          error: "The proposal changed. Reload it before continuing.",
          proposal,
        },
        409,
      );
    }
    if (options.writebacks !== undefined && proposal.status === "approved") {
      const operations = await options.writebacks.listForProposal(
        organizationId,
        proposal.id,
      );
      if (writebackBusy(operations)) {
        return c.json(
          {
            code: "writeback_busy",
            error: "Resolve the Jira update before re-pricing.",
          },
          409,
        );
      }
    }
    const pointer = await options.issues.get(
      organizationId,
      proposal.jiraIssueId,
    );
    if (pointer === null) return c.json({ error: "Not found" }, 404);
    const board = await options.boards.get(organizationId, pointer.boardId);
    if (board === null) return c.json({ error: "Not found" }, 404);
    const card = await options.rateCards.get(organizationId);
    if (card === null)
      return c.json(
        {
          code: "rate_card_required",
          error: "Set a rate card before re-pricing.",
        },
        409,
      );
    const created = await options.runs.create(organizationId, {
      boardId: board.id,
      startedBy: c.get("user").id,
      kind: "reprice",
      sourceProposalId: proposal.id,
      sourceRevision: proposal.revision,
      requestId: parsed.data.requestId,
      selection: {
        ...boardSelectionSchema.parse(board.selection),
        maxTickets: 1,
      },
      rateCard: {
        currency: card.currency,
        xsMinor: card.xsMinor,
        sMinor: card.sMinor,
        mMinor: card.mMinor,
        lMinor: card.lMinor,
        xlMinor: card.xlMinor,
        revision: card.revision,
      },
      requestedModel: options.requestedModel,
      promptVersion: options.promptVersion,
    });
    if (!created.ok) {
      return c.json(
        {
          code: created.reason === "active" ? "run_active" : "proposal_changed",
          error: "Could not start re-pricing.",
        },
        409,
      );
    }
    if (created.created) options.executor.start(organizationId, created.run.id);
    return c.json({ run: created.run }, 202);
  });

  app.post("/api/v1/orgs/:orgId/writebacks/:id/retry", async (c) => {
    const { organizationId, role } = c.get("member");
    const denied = requireAdmin(role);
    if (denied !== null) return c.json(denied, 403);
    if (options.delivery === undefined || options.writebacks === undefined) {
      return c.json({ error: "Not found" }, 404);
    }
    const operation = await options.writebacks.get(
      organizationId,
      c.req.param("id"),
    );
    if (operation === null) return c.json({ error: "Not found" }, 404);
    if (operation.status === "uncertain") {
      return c.json(
        {
          code: "writeback_uncertain",
          error: "Check Jira before retrying this comment.",
        },
        409,
      );
    }
    options.delivery.start(organizationId, operation.id);
    return c.json({ operation }, 202);
  });

  app.post("/api/v1/orgs/:orgId/writebacks/:id/reconcile", async (c) => {
    const { organizationId, role } = c.get("member");
    const denied = requireAdmin(role);
    if (denied !== null) return c.json(denied, 403);
    if (options.delivery === undefined)
      return c.json({ error: "Not found" }, 404);
    const result = await options.delivery.reconcile(
      organizationId,
      c.req.param("id"),
    );
    if (result.operation === null) return c.json({ error: "Not found" }, 404);
    return c.json(result, result.status === "adopted" ? 200 : 409);
  });

  app.post("/api/v1/orgs/:orgId/writebacks/:id/cancel", async (c) => {
    const { organizationId, role } = c.get("member");
    const denied = requireAdmin(role);
    if (denied !== null) return c.json(denied, 403);
    if (options.writebacks === undefined)
      return c.json({ error: "Not found" }, 404);
    const operation = await options.writebacks.cancel(
      organizationId,
      c.req.param("id"),
    );
    return operation === null
      ? c.json(
          {
            code: "writeback_busy",
            error: "That write cannot be cancelled safely.",
          },
          409,
        )
      : c.json({ operation });
  });
}

async function approveWithFreshSpec(
  c: any,
  options: BountyRouteOptions,
  expectedRevision: number,
) {
  const { organizationId } = c.get("member");
  const proposal = await options.proposals.get(
    organizationId,
    c.req.param("id"),
  );
  if (proposal === null) return c.json({ error: "Not found" }, 404);
  if (proposal.revision !== expectedRevision) {
    return c.json(
      {
        code: "proposal_changed",
        error: "The proposal changed. Reload it before continuing.",
        proposal,
      },
      409,
    );
  }
  if (options.clientFor === undefined) {
    return c.json(
      { code: "spec_unavailable", error: "The ticket could not be checked." },
      503,
    );
  }
  const fresh = await freshProposal(
    {
      proposals: options.proposals,
      issues: options.issues,
      boards: options.boards,
      clientFor: options.clientFor,
    },
    organizationId,
    proposal,
  );
  if (fresh.freshness !== "current") {
    const code =
      fresh.freshness === "stale" ? "proposal_stale" : "spec_unavailable";
    return c.json(
      {
        code,
        error:
          code === "proposal_stale"
            ? "The Jira sizing inputs changed. Re-price before continuing."
            : "The ticket could not be checked.",
        freshness: fresh.freshness,
      },
      409,
    );
  }
  if (fresh.liveSpec?.inputTruncated || proposal.inputTruncated) {
    return c.json(
      {
        code: "spec_too_large",
        error: "Shorten or split the ticket, then re-price it.",
      },
      409,
    );
  }
  if (
    proposal.complexity === "unsized" ||
    proposal.amountMinor === null ||
    proposal.currency === null
  ) {
    return c.json(
      { code: "unsized", error: "Choose a size before approval." },
      409,
    );
  }
  const pointer = await options.issues.get(
    organizationId,
    proposal.jiraIssueId,
  );
  const registered =
    pointer === null
      ? null
      : await options.boards.forRun(organizationId, pointer.boardId);
  // Whether the approval is posted to the ticket is the site's grant: every
  // consent asks for the write scope, so a site holds it unless the person
  // withheld it. No grant means the approval is recorded here and nowhere
  // else, which is what a read-only site was connected for.
  const connection =
    registered === null || options.connections === undefined
      ? null
      : await options.connections.get(organizationId, registered.connectionId);
  if (registered !== null && connection?.writeGranted === true) {
    if (!connection.healthy) {
      // Not approved without the post: the site was connected to receive
      // it, and a reconnect is a minute's work. Approving now would leave
      // the ticket silent with nothing to say so later.
      return c.json(
        {
          code: "reconnect",
          error: "Reconnect this Jira site before approving.",
        },
        409,
      );
    }
    if (
      options.writebacks === undefined ||
      options.delivery === undefined ||
      options.appUrl === undefined ||
      options.organizationSlug === undefined
    ) {
      return c.json(
        {
          code: "write_consent_required",
          error: "Jira delivery is not configured.",
        },
        409,
      );
    }
    const slug = await options.organizationSlug(organizationId);
    if (slug === undefined) return c.json({ error: "Not found" }, 404);
    const proposalUrl = `${options.appUrl}/o/${encodeURIComponent(slug)}/jira/${encodeURIComponent(registered.connectionId)}/${encodeURIComponent(registered.board.id)}?tab=proposals&proposal=${encodeURIComponent(proposal.id)}`;
    const decision = await options.writebacks.approveWithIntent(
      organizationId,
      proposal.id,
      expectedRevision,
      c.get("user").id,
      {
        complexity: proposal.complexity as PricedComplexity,
        amountMinor: proposal.amountMinor,
        currency: proposal.currency,
        proposalUrl,
      },
    );
    if (decision.status !== "created") {
      return c.json(
        {
          code: "proposal_changed",
          error: "The proposal changed. Reload it before continuing.",
        },
        decision.status === "not-found" ? 404 : 409,
      );
    }
    options.delivery.start(organizationId, decision.operation.id);
    const approved = await options.proposals.get(organizationId, proposal.id);
    return c.json({
      proposal: approved,
      writebackOperation: decision.operation,
    });
  }
  return proposalMutationResponse(
    c,
    await options.proposals.approve(
      organizationId,
      proposal.id,
      expectedRevision,
      c.get("user").id,
      "off",
    ),
  );
}

function proposalMutationResponse(
  c: any,
  result: Awaited<ReturnType<BountyProposalStore["approve"]>>,
) {
  if (result.ok) return c.json({ proposal: result.proposal });
  if (result.reason === "not-found") return c.json({ error: "Not found" }, 404);
  return c.json(
    {
      code: "proposal_changed",
      error: "The proposal changed. Reload it before continuing.",
      ...(result.current === undefined ? {} : { proposal: result.current }),
    },
    409,
  );
}

function requireAdmin(role: string): { error: string } | null {
  return isAtLeastAdmin(role)
    ? null
    : { error: "Only an owner or admin may review proposals." };
}

function proposalStatus(
  value: string | undefined,
): "proposed" | "approved" | undefined | null {
  if (value === undefined || value === "") return undefined;
  return value === "proposed" || value === "approved" ? value : null;
}

/** Whether a Jira update for the proposal is still unresolved. */
function writebackBusy(
  operations: readonly { readonly status: string }[],
): boolean {
  return operations.some(
    ({ status }) =>
      status === "pending" || status === "running" || status === "uncertain",
  );
}

function boundedLimit(value: string | undefined): number {
  const parsed = Number(value ?? 25);
  return Number.isInteger(parsed) ? Math.min(Math.max(parsed, 1), 50) : 25;
}

function pageCursor(value: string | undefined): string | undefined | null {
  if (value === undefined || value === "") return undefined;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function proposalCursor(
  value: string | undefined,
): { createdAt: string; id: string } | undefined | null {
  if (value === undefined || value === "") return undefined;
  const separator = value.lastIndexOf("|");
  if (separator <= 0) return null;
  const createdAt = value.slice(0, separator);
  const id = value.slice(separator + 1);
  return Number.isFinite(Date.parse(createdAt)) && id !== ""
    ? { createdAt, id }
    : null;
}

function isAtLeastAdmin(role: string): boolean {
  return role.split(",").some((entry) => {
    const normalized = entry.trim();
    return normalized === "owner" || normalized === "admin";
  });
}
