import { approveProposal } from "./approve-proposal.js";
import type { BountyRouteOptions } from "./options.js";
import { reviewOptions, siteOf } from "./review-deps.js";
import {
  boardOf,
  startRun,
  startTicketRun,
  type StartRunResult,
} from "./start-run.js";
export type { BountyRouteOptions } from "./options.js";
export { sizeIfNeverSized, startRun, startTicketRun } from "./start-run.js";
export type { StartRunResult, StartTicketRunResult } from "./start-run.js";

import { type BountyProposalStore } from "@sandbox-factory/db";
import { JiraApiError, JiraAuthError } from "@sandbox-factory/jira";
import type {
  JiraIssueDto,
  ProposalCategoriesDto,
  ProposalSpecRevisionsResponse,
} from "@sandbox-factory/shared";
import {
  addIssueSchema,
  boardSelectionSchema,
  createRunSchema,
  proposalMutationSchema,
  proposalProfileResponseSchema,
  proposeTicketSchema,
  putRateCardSchema,
  repriceProposalSchema,
  resizeProposalSchema,
  respecProposalSchema,
} from "@sandbox-factory/shared";
import type { Context, Hono } from "hono";
import { stream } from "hono/streaming";
import {
  CATEGORIES,
  checkRespec,
  priceFor,
  rebaseStep,
  SPEC_LIMITS,
  UNCATEGORIZED,
  validateRateCard,
  type RespecRefusal,
} from "sandbox-factory";

import { isAtLeastAdmin } from "../access.js";
import { boundedLimit, rowCursor } from "../paging.js";
import { REVISE_SPEC_PROMPT_VERSION } from "../sizing/tools/revise-spec.js";
import type { RunClientResult } from "./executor.js";
import { freshProposal, mapConcurrent, proposalTitle } from "./review.js";

export interface BountyAppEnv {
  Variables: {
    user: { id: string };
    member: { organizationId: string; role: string };
  };
}

/** How many tickets the search shows, and how many it asks Jira for. */
const SEARCH_RESULTS = 10;
const SEARCH_CANDIDATES = 50;

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
      // Only a run for one picked ticket meets these.
      case "not-found":
      case "live-proposal":
      case "has-subtasks":
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
          // Listed so a person finds it, but it cannot be added: see
          // `startRun`.
          subtaskCount: issue.subtaskCount ?? 0,
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
      case "has-subtasks":
        return c.json(
          {
            code: "has_subtasks",
            error: `${started.issueKey} is split into sub-tasks. Size its sub-tasks instead.`,
          },
          409,
        );
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

  /**
   * Size one of the organization's tickets and propose a bounty for it, in
   * the background: the same answer as adding a board's ticket. 202 with the
   * run, which the page follows until the proposal lands; 200 with the
   * proposal's id when the ticket already has a live one.
   */
  app.post("/api/v1/orgs/:orgId/tickets/:id/propose", async (c) => {
    const { organizationId, role } = c.get("member");
    if (!isAtLeastAdmin(role)) {
      return c.json(
        { error: "Only an owner or admin may propose a bounty." },
        403,
      );
    }
    const parsed = proposeTicketSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json({ error: "Provide a valid requestId." }, 400);
    }
    const started = await startTicketRun(options, {
      organizationId,
      ticketId: c.req.param("id"),
      startedBy: c.get("user").id,
      requestId: parsed.data.requestId,
    });
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
            error: "This ticket's Jira connection needs reconnecting.",
          },
          409,
        );
      case "rate-card-required":
        return c.json(
          {
            code: "rate_card_required",
            error: "Set a rate card before proposing.",
          },
          409,
        );
      case "active":
        return c.json(
          {
            code: "run_active",
            error: "This ticket is already being sized.",
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

  /*
    The live title of each listed proposal, a line of NDJSON per proposal,
    written as Jira answers for it rather than when the last one does, so
    the rows fill in one by one. Titles are relayed, never stored.

    Under the board rather than beside `/proposals/:id`, which would match
    it. One client serves the whole board, as every row shares its
    connection; five reads at a time, not the three sizing uses, because
    these skip the description and a person is waiting on them.
  */
  app.get("/api/v1/orgs/:orgId/jira/boards/:id/proposal-titles", async (c) => {
    const { organizationId } = c.get("member");
    const boardId = c.req.param("id");
    const ids = [
      ...new Set(
        (c.req.query("ids") ?? "").split(",").filter((id) => id !== ""),
      ),
    ];
    // The list's largest page.
    if (ids.length === 0 || ids.length > 50) {
      return c.json({ error: "Ask for 1 to 50 proposals." }, 400);
    }
    const board = await options.boards.get(organizationId, boardId);
    if (board === null) return c.json({ error: "Not found" }, 404);
    const targets = await options.proposals.issuesForProposals(
      organizationId,
      boardId,
      ids,
    );
    const ready: RunClientResult =
      options.clientFor === undefined
        ? { ok: false, reason: "reconnect" }
        : targets.size === 0
          ? { ok: false, reason: "not-found" }
          : await options.clientFor(organizationId, board.connectionId);
    c.header("content-type", "application/x-ndjson; charset=utf-8");
    c.header("cache-control", "no-store");
    return stream(c, async (out) => {
      await mapConcurrent(ids, 5, async (id) => {
        // The browser left: nothing is waiting for the rest.
        if (out.aborted) return;
        const line = await proposalTitle(
          options.issues,
          organizationId,
          id,
          targets.get(id),
          ready,
        );
        await out.write(`${JSON.stringify(line)}\n`);
      });
    });
  });

  app.get("/api/v1/orgs/:orgId/runs/:id", async (c) => {
    const { organizationId } = c.get("member");
    const run = await options.runs.get(organizationId, c.req.param("id"));
    return run === null ? c.json({ error: "Not found" }, 404) : c.json({ run });
  });

  /*
    A board's proposals by category, for the view above the list.

    Counted in the store rather than by the page from the rows it has,
    because the list is paged: a board a run sized three hundred tickets on
    shows fifty at a time. The six categories, their order, their labels and
    the why-text all come from the registry here, so the page names none of
    them and a category added to the registry appears without a change to
    it. The proposals in no category are counted beside them, so the page
    can offer those as a view too. Any member may read it, as any member
    may read the list.
  */
  app.get(
    "/api/v1/orgs/:orgId/jira/boards/:id/proposal-categories",
    async (c) => {
      const { organizationId } = c.get("member");
      const boardId = c.req.param("id");
      if ((await options.boards.get(organizationId, boardId)) === null) {
        return c.json({ error: "Not found" }, 404);
      }
      return c.json(
        categoriesBody(
          await options.proposals.categoryCounts(organizationId, { boardId }),
        ),
      );
    },
  );

  /* The same, for every proposal the organization has, from any source. */
  app.get("/api/v1/orgs/:orgId/proposal-categories", async (c) => {
    const { organizationId } = c.get("member");
    return c.json(
      categoriesBody(await options.proposals.categoryCounts(organizationId)),
    );
  });

  /*
    The organization's proposals, newest first, from every source: a
    board's, with `?boardId=`, or all of them, the tickets written here
    among them.
  */
  app.get("/api/v1/orgs/:orgId/proposals", async (c) => {
    const { organizationId } = c.get("member");
    const boardId = c.req.query("boardId");
    if (
      boardId !== undefined &&
      (await options.boards.get(organizationId, boardId)) === null
    ) {
      return c.json({ error: "Not found" }, 404);
    }
    const status = proposalStatus(c.req.query("status"));
    if (status === null) return c.json({ error: "Invalid status." }, 400);
    const category = proposalCategory(c.req.query("category"));
    if (category === null) return c.json({ error: "Invalid category." }, 400);
    const limit = boundedLimit(c.req.query("limit"));
    const cursor = rowCursor(c.req.query("cursor"));
    if (cursor === null) return c.json({ error: "Invalid cursor." }, 400);
    /*
      Stored rows only, so the list answers at once. What a row cannot show
      without Jira — its live title — streams in from `proposal-titles`, and
      the open proposal's freshness and delivery come from its detail read.
      Checking every row against Jira here held the whole list back for
      the slowest ticket on the page.
    */
    const proposals = await options.proposals.list(organizationId, {
      ...(boardId === undefined ? {} : { boardId }),
      limit,
      ...(status === undefined ? {} : { status }),
      // The reserved id asks for the tickets in no category, which is a
      // different question of the store than any category's.
      ...(category === undefined
        ? {}
        : category === UNCATEGORIZED
          ? { uncategorized: true }
          : { category }),
      ...(cursor === undefined ? {} : { cursor }),
    });
    return c.json({
      proposals,
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
    // Asked for on a board's page: only a ticket that came through it.
    const expectedBoardId = c.req.query("boardId");
    if (expectedBoardId !== undefined) {
      const ticket = await options.tickets.get(
        organizationId,
        proposal.ticketId,
      );
      if (ticket?.jira?.boardId !== expectedBoardId) {
        return c.json({ error: "Not found" }, 404);
      }
    }
    const live = await freshProposal(
      reviewOptions(options),
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

  /*
    The proposal's spec: the revision its size goes with. A stored read, so
    it answers without Jira, which is why it is not part of the proposal's
    own read above. Any member may read it, as any member may read the
    proposal. `spec` is null for a proposal with none, which is an answer
    and not an error: a proposal from before specs, or a ticket too large or
    too thin to draft from.

    `?revision=` reads an earlier revision of the same proposal's spec.
  */
  app.get("/api/v1/orgs/:orgId/proposals/:id/spec", async (c) => {
    const { organizationId } = c.get("member");
    const proposal = await options.proposals.get(
      organizationId,
      c.req.param("id"),
    );
    if (proposal === null) return c.json({ error: "Not found" }, 404);
    const revision = specRevision(c.req.query("revision"));
    if (revision === null) return c.json({ error: "Invalid revision." }, 400);
    const wanted = revision ?? proposal.specRevision;
    const spec =
      wanted === null
        ? null
        : await options.specs.get(organizationId, proposal.id, wanted);
    // A revision that was asked for by number and is not there is a miss;
    // a proposal that simply has no spec is not.
    if (spec === null && revision !== undefined) {
      return c.json({ error: "Not found" }, 404);
    }
    return c.json({ spec });
  });

  /*
    The complexity profile of the proposal's newest profiled spec revision,
    with where it stands while its runs are in flight. Null when it was
    never profiled: neither its ticket nor its board named a repository
    when it was sized, or this deployment has no repository analysis.
  */
  app.get("/api/v1/orgs/:orgId/proposals/:id/profile", async (c) => {
    const { organizationId } = c.get("member");
    const proposal = await options.proposals.get(
      organizationId,
      c.req.param("id"),
    );
    if (proposal === null) return c.json({ error: "Not found" }, 404);
    const stored =
      options.profiles === undefined
        ? null
        : await options.profiles.latest(organizationId, proposal.id);
    return c.json(
      proposalProfileResponseSchema.parse({
        profile:
          stored === null
            ? null
            : {
                id: stored.id,
                proposalId: stored.proposalId,
                specRevision: stored.specRevision,
                status: stored.status,
                errorCode: stored.errorCode,
                runErrorCode: stored.runErrorCode,
                snapshotId: stored.snapshotId,
                scopeRunId: stored.scopeRunId,
                sliceRunId: stored.sliceRunId,
                profile: stored.profile,
                createdAt: stored.createdAt,
                updatedAt: stored.updatedAt,
              },
      }),
    );
  });

  /* Every revision the spec has had, newest first, without the scenarios. */
  app.get("/api/v1/orgs/:orgId/proposals/:id/spec/revisions", async (c) => {
    const { organizationId } = c.get("member");
    const proposal = await options.proposals.get(
      organizationId,
      c.req.param("id"),
    );
    if (proposal === null) return c.json({ error: "Not found" }, 404);
    const revisions = await options.specs.listRevisions(
      organizationId,
      proposal.id,
    );
    const body: ProposalSpecRevisionsResponse = {
      revisions: revisions.map((revision) => ({
        ...revision,
        current: revision.revision === proposal.specRevision,
      })),
    };
    return c.json(body);
  });

  app.post("/api/v1/orgs/:orgId/proposals/:id/approve", async (c) => {
    const parsed = proposalMutationSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      return c.json({ error: "Invalid proposal revision." }, 400);
    const denied = requireAdmin(c.get("member").role);
    if (denied !== null) return c.json(denied, 403);
    const result = await approveProposal(options, {
      organizationId: c.get("member").organizationId,
      proposalId: c.req.param("id"),
      actorId: c.get("user").id,
      expectedRevision: parsed.data.expectedRevision,
    });
    return c.json(
      result.body,
      result.kind === "not-found"
        ? 404
        : result.kind === "conflict"
          ? 409
          : 200,
    );
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
    /*
      The reviewer's size is the base, and the step stays on top: weight a
      reviewer added to the spec is never silently absorbed by a manual
      size. The revision check above is what makes the step read here the
      one being replaced.
    */
    const step =
      proposal.step === null
        ? null
        : rebaseStep(proposal.step, parsed.data.complexity);
    const complexity = step?.complexity ?? parsed.data.complexity;
    const amountMinor = priceFor(complexity, proposal.rateCard);
    return proposalMutationResponse(
      c,
      await options.proposals.resize(
        organizationId,
        proposal.id,
        parsed.data.expectedRevision,
        c.get("user").id,
        complexity,
        amountMinor!,
        proposal.rateCard.currency,
        step,
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
      const site = (await siteOf(options, organizationId, proposal.ticketId))
        ?.connection;
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
    const ticket = await options.tickets.get(organizationId, proposal.ticketId);
    if (ticket === null) return c.json({ error: "Not found" }, 404);
    const board = await boardOf(options, organizationId, ticket);
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
      boardId: board?.id ?? null,
      ticketId: ticket.id,
      startedBy: c.get("user").id,
      kind: "reprice",
      sourceProposalId: proposal.id,
      sourceRevision: proposal.revision,
      requestId: parsed.data.requestId,
      // A re-price sizes the one ticket its proposal names; the selection
      // is snapshotted for `minSpecChars`, and nothing is selected with it.
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

  /**
   * A change to a proposal's spec: more scenarios, answers to its open
   * questions, or scenarios taken out. Every change is a run, as a re-price
   * is, so it is followed the same way and fenced by the same lease; a
   * trim asks no model but is still one, for the lease.
   *
   * Refused before the run when it could only fail: an approved proposal
   * (unapprove first: an approval is made on a size), a proposal with no
   * weighed spec (nothing for the step to move; re-analyze first), a
   * request the current revision cannot take, or a ticket that changed
   * since it was sized, whose spec the next re-price would replace.
   */
  app.post("/api/v1/orgs/:orgId/proposals/:id/respec", async (c) => {
    const parsed = respecProposalSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) return c.json({ error: "Invalid spec change." }, 400);
    const { organizationId, role } = c.get("member");
    const denied = requireAdmin(role);
    if (denied !== null) return c.json(denied, 403);
    if (
      options.executor === undefined ||
      options.requestedModel === undefined
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
    if (proposal.status !== "proposed") {
      return c.json(
        {
          code: "proposal_approved",
          error: "Unapprove the proposal before changing its scenarios.",
        },
        409,
      );
    }
    const current =
      proposal.step === null || proposal.specRevision === null
        ? null
        : await options.specs.get(
            organizationId,
            proposal.id,
            proposal.specRevision,
          );
    if (current === null) {
      return c.json(
        {
          code: "respec_unavailable",
          error:
            "This proposal has no weighed scenarios to change. Re-analyze it first.",
        },
        409,
      );
    }
    const { request } = parsed.data;
    const refusal = checkRespec(request, current.draft);
    if (refusal !== null) {
      return c.json({ code: refusal, error: RESPEC_REFUSALS[refusal] }, 409);
    }
    const fresh = await freshProposal(
      reviewOptions(options),
      organizationId,
      proposal,
    );
    if (fresh.freshness !== "current") {
      const stale = fresh.freshness === "stale";
      return c.json(
        {
          code: stale ? "proposal_stale" : "spec_unavailable",
          error: stale
            ? "The ticket changed since it was sized. Re-analyze it before changing its scenarios."
            : "The ticket could not be checked.",
          freshness: fresh.freshness,
        },
        409,
      );
    }
    const ticket = await options.tickets.get(organizationId, proposal.ticketId);
    if (ticket === null) return c.json({ error: "Not found" }, 404);
    const board = await boardOf(options, organizationId, ticket);
    const created = await options.runs.create(organizationId, {
      boardId: board?.id ?? null,
      ticketId: ticket.id,
      startedBy: c.get("user").id,
      kind: "respec",
      sourceProposalId: proposal.id,
      sourceRevision: proposal.revision,
      respec: request,
      requestId: parsed.data.requestId,
      // Nothing is selected; the column holds every run's snapshot.
      selection: boardSelectionSchema.parse(board?.selection ?? {}),
      // The proposal's own card: a spec change moves the size, not the
      // rates, as a resize does.
      rateCard: proposal.rateCard,
      requestedModel: options.requestedModel,
      promptVersion: REVISE_SPEC_PROMPT_VERSION,
    });
    if (!created.ok) {
      return c.json(
        created.reason === "active"
          ? {
              code: "run_active",
              error: "This proposal is already being changed.",
              runId: created.runId,
            }
          : {
              code: "proposal_changed",
              error: "Could not change the scenarios.",
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

/**
 * Proposals by category, for the view above a list. The categories, their
 * order, labels and why-text come from the registry, so the page names
 * none of them; the proposals in no category are counted beside them.
 */
function categoriesBody(counted: {
  readonly total: number;
  readonly uncategorized: number;
  readonly counts: Readonly<Record<string, number>>;
}): ProposalCategoriesDto {
  return {
    total: counted.total,
    uncategorized: counted.uncategorized,
    categories: CATEGORIES.map(({ id, label, why }) => ({
      id,
      label,
      why,
      // `Object.hasOwn`: the ids are keys of stored JSON's making.
      count: Object.hasOwn(counted.counts, id) ? (counted.counts[id] ?? 0) : 0,
    })),
  };
}

/** What each refused spec change is told. */
const RESPEC_REFUSALS: Readonly<Record<RespecRefusal, string>> = {
  spec_full: `The spec already has ${SPEC_LIMITS.scenarios} scenarios. Remove some before adding more.`,
  unknown_question:
    "That question is no longer open. Reload the scenarios and try again.",
  unknown_scenario:
    "That scenario is no longer in the spec. Reload the scenarios and try again.",
  spec_emptied:
    "A spec needs a scenario or an open question. Keep at least one.",
};

function proposalMutationResponse<Env extends BountyAppEnv>(
  c: Context<Env>,
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

/**
 * The `category` filter: a category id, or undefined for none. The id
 * may be `UNCATEGORIZED`, which has a category id's shape by design.
 *
 * Checked for shape only. An id no category has is not an error: it is a
 * category with nothing in it, which is what a retired one looks like to a
 * link that still names it.
 */
function proposalCategory(
  value: string | undefined,
): string | undefined | null {
  if (value === undefined || value === "") return undefined;
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(value) && value.length <= 64
    ? value
    : null;
}

/**
 * The `revision` of a spec read: a positive whole number, or undefined for
 * the revision the proposal points at. Null for anything else.
 */
function specRevision(value: string | undefined): number | undefined | null {
  if (value === undefined || value === "") return undefined;
  return /^[1-9]\d{0,8}$/.test(value) ? Number(value) : null;
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

function pageCursor(value: string | undefined): string | undefined | null {
  if (value === undefined || value === "") return undefined;
  return Number.isFinite(Date.parse(value)) ? value : null;
}
