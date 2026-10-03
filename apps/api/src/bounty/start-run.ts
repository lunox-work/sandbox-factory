import { randomUUID } from "node:crypto";

import {
  followsJira,
  type RateCardStore,
  type StoredBountyRun,
  type StoredRateCard,
  type StoredTicket,
} from "@sandbox-factory/db";
import { JiraApiError } from "@sandbox-factory/jira";
import type {
  BountyRunPlannedIssue,
  JiraIssueDto,
} from "@sandbox-factory/shared";
import { boardSelectionSchema } from "@sandbox-factory/shared";
import { DEFAULT_RATE_CARD } from "sandbox-factory";

import type { RunJiraClient } from "./executor.js";

import type { BountyRouteOptions } from "./options.js";
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
      readonly reason: "has-subtasks";
      readonly issueKey: string;
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

/**
 * One ticket, if it is on the board.
 *
 * Read through the board rather than by issue id alone, so a run on one board
 * cannot be pointed at a ticket that belongs to another — or to a project the
 * board does not show.
 */
export async function ticketOnBoard(
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
    // The same rule as a backlog run: a ticket split into sub-tasks is
    // priced through them, never itself.
    if ((found.subtaskCount ?? 0) > 0) {
      return { ok: false, reason: "has-subtasks", issueKey: found.key };
    }
    planned = {
      externalIssueId: found.id,
      issueKey: found.key,
      summary: found.summary,
      // Picked by a person, not by a category.
      categories: [],
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

/** Why a ticket's sizing did not start. */
export type StartTicketRunResult =
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
 * Start sizing one of the organization's tickets: the run row, then the
 * executor in the background, as a board's run starts.
 *
 * Needs a sizer and a rate card, and nothing from Jira unless the ticket
 * still follows a Jira issue, whose text the run reads. A ticket with a
 * live proposal gets that proposal back instead of a run. A ticket that
 * came from a board is sized with that board's selection and pricing
 * settings; any other with the defaults.
 */
export async function startTicketRun(
  options: BountyRouteOptions,
  input: {
    readonly organizationId: string;
    readonly ticketId: string;
    readonly startedBy: string;
    readonly requestId: string;
  },
): Promise<StartTicketRunResult> {
  const { organizationId } = input;
  if (
    options.executor === undefined ||
    options.requestedModel === undefined ||
    options.promptVersion === undefined
  ) {
    return { ok: false, reason: "sizing-unavailable" };
  }
  const ticket = await options.tickets.get(organizationId, input.ticketId);
  if (ticket === null) return { ok: false, reason: "not-found" };
  const live = await options.proposals.liveForTicket(organizationId, ticket.id);
  if (live !== null) {
    return { ok: false, reason: "live-proposal", proposalId: live };
  }
  // Read through its site, as the run will: one that needs reconnecting is
  // said now, as for a board's run, rather than by a run that fails.
  if (ticket.jira !== null && followsJira(ticket)) {
    const ready =
      options.clientFor === undefined
        ? null
        : await options.clientFor(organizationId, ticket.jira.connectionId);
    if (ready === null || !ready.ok) return { ok: false, reason: "reconnect" };
  }
  const board = await boardOf(options, organizationId, ticket);
  const card = await rateCardFor(options.rateCards, organizationId, input);
  if (card === null) return { ok: false, reason: "rate-card-required" };

  const created = await options.runs.create(organizationId, {
    kind: "ticket",
    boardId: board?.id ?? null,
    ticketId: ticket.id,
    planned: [
      {
        externalIssueId: ticket.jira?.externalId ?? ticket.id,
        issueKey: ticket.key,
        summary: ticket.title,
        ticketId: ticket.id,
        // Picked by a person, not by a category.
        categories: [],
      },
    ],
    startedBy: input.startedBy,
    requestId: input.requestId,
    selection: boardSelectionSchema.parse(board?.selection ?? {}),
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

/** The board a ticket came through, while it is registered. */
export async function boardOf(
  options: Pick<BountyRouteOptions, "boards">,
  organizationId: string,
  ticket: StoredTicket,
) {
  return ticket.jira === null
    ? null
    : options.boards.get(organizationId, ticket.jira.boardId);
}
