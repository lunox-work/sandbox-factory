import { approveProposal } from "./approve-proposal.js";
import type { PricingRouteOptions } from "./options.js";
import { reviewOptions, siteOf, writebackBusy } from "./review-deps.js";
import {
  boardOf,
  startRun,
  startBountyRun,
  type StartRunResult,
} from "./start-run.js";
export type { PricingRouteOptions } from "./options.js";

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
  proposeBountySchema,
  putRateCardSchema,
  repriceProposalSchema,
  resizeProposalSchema,
  respecProposalSchema,
} from "@sandbox-factory/shared";
import type { Context, Hono } from "hono";
import {
  CATEGORIES,
  checkRespec,
  priceFor,
  resetStep,
  SPEC_LIMITS,
  UNCATEGORIZED,
  validateRateCard,
  type RespecRefusal,
} from "sandbox-factory";

import { isAtLeastAdmin } from "../access.js";
import { boundedLimit, rowCursor } from "../paging.js";
import { REVISE_SPEC_PROMPT_VERSION } from "../sizing/tools/revise-spec.js";
import { describesProposal } from "./delivery.js";
import { freshProposal } from "./review.js";
import { rubricPrice } from "./rubric.js";
import { externalBoardId, InvalidBoardIdError } from "./selection.js";

export interface PricingAppEnv {
  Variables: {
    user: { id: string };
    member: { organizationId: string; role: string };
  };
}

/** How many issues the search shows. */
const SEARCH_RESULTS = 10;

/**
 * JQL for what a person typed into the board's issue search.
 *
 * A key (`APP-12`) is looked up as a key; anything else is a text search on
 * what is left once JQL's reserved characters are removed — they would
 * otherwise make Jira refuse the query rather than search for them.
 */
export function issueSearchJql(query: string): string | null {
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

export function mountPricingRoutes<Env extends PricingAppEnv>(
  app: Hono<Env>,
  options: PricingRouteOptions,
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
      // Only a run for one picked bounty meets these.
      case "not-found":
      case "live-proposal":
      case "has-subtasks":
        return c.json({ error: "Not found" }, 404);
    }
  });

  /**
   * Search the board's issues, for picking one to add as a bounty.
   *
   * Read live through the board, so it finds what the board shows and
   * nothing else. Each issue says the bounty it already is on this board,
   * if it is one, so a person opens that rather than adding it twice. Any
   * member may search, and add.
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
    const jql = issueSearchJql(c.req.query("q") ?? "");
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
        await ready.client.boardIssues(externalBoardId(board.board), {
          jql,
          startAt: 0,
          maxResults: SEARCH_RESULTS,
        })
      ).issues;
    } catch (error) {
      // As the selection preview answers a board it cannot address.
      if (error instanceof InvalidBoardIdError) {
        return c.json({ error: error.message }, 422);
      }
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

    const shown = issues.slice(0, SEARCH_RESULTS);
    const bounties = await options.issues.bountiesFor(
      organizationId,
      board.board.id,
      shown.map(({ id }) => id),
    );
    return c.json({
      issues: shown.map((issue) => ({
        id: issue.id,
        key: issue.key,
        summary: issue.summary,
        status: issue.status,
        issueType: issue.issueType,
        // Listed so a person finds it, but it cannot be added: its
        // sub-tasks are the bounties.
        subtaskCount: issue.subtaskCount ?? 0,
        bountyId: bounties.get(issue.id) ?? null,
      })),
    });
  });

  /**
   * Size one bounty someone picked, in the background.
   *
   * 202 with the run, which the page polls until the proposal lands and
   * then opens it. A bounty that already has a live proposal is 200 with
   * that proposal's id, so the page opens it without sizing anything.
   */
  app.post("/api/v1/orgs/:orgId/jira/boards/:id/issues", async (c) => {
    const { organizationId, role } = c.get("member");
    if (!isAtLeastAdmin(role)) {
      return c.json({ error: "Only an owner or admin may add a bounty." }, 403);
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
      if (error instanceof InvalidBoardIdError) {
        return c.json({ error: error.message }, 422);
      }
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

  /*
    The run sizing a bounty for its first proposal, while one is in flight;
    null otherwise. What the bounty's page follows from a reload, as it
    follows the run its Propose started. Any member may read it, as any
    member may read the bounty.
  */
  app.get("/api/v1/orgs/:orgId/bounties/:id/sizing", async (c) => {
    const { organizationId } = c.get("member");
    const bountyId = c.req.param("id");
    if ((await options.bounties.get(organizationId, bountyId)) === null) {
      return c.json({ error: "Not found" }, 404);
    }
    return c.json({
      run: await options.runs.activeForBounty(organizationId, bountyId),
    });
  });

  /**
   * Size one of the organization's bounties and make its proposal, in
   * the background: the same answer as adding a board's issue. 202 with the
   * run, which the page follows until the proposal lands; 200 with the
   * proposal's id when the bounty already has a live one.
   */
  app.post("/api/v1/orgs/:orgId/bounties/:id/propose", async (c) => {
    const { organizationId, role } = c.get("member");
    if (!isAtLeastAdmin(role)) {
      return c.json(
        { error: "Only an owner or admin may propose a bounty." },
        403,
      );
    }
    const parsed = proposeBountySchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json({ error: "Provide a valid requestId." }, 400);
    }
    const started = await startBountyRun(options, {
      organizationId,
      bountyId: c.req.param("id"),
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
            error: "This bounty's Jira connection needs reconnecting.",
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
            error: "This bounty is already being sized.",
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
    // `createdAt|id`, as the proposal list pages: a time alone skips every
    // run made in the same millisecond as a page's last one.
    const cursor = rowCursor(c.req.query("cursor"));
    if (cursor === null) return c.json({ error: "Invalid cursor." }, 400);
    const runs = await options.runs.listForBoard(organizationId, boardId, {
      limit,
      ...(cursor === undefined ? {} : { cursor }),
    });
    const last = runs.at(-1);
    return c.json({
      runs,
      nextCursor:
        runs.length === limit && last !== undefined
          ? `${last.createdAt}|${last.id}`
          : null,
      sizingAvailable:
        options.executor !== undefined && options.clientFor !== undefined,
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
    because the list is paged: a board a run sized three hundred bounties on
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
    board's, with `?boardId=`, or all of them, the bounties written here
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
      Stored rows only, so the list answers at once. The open proposal's
      freshness and delivery come from its detail read.
      Checking every row against Jira here held the whole list back for
      the slowest bounty on the page.
    */
    const proposals = await options.proposals.list(organizationId, {
      ...(boardId === undefined ? {} : { boardId }),
      limit,
      ...(status === undefined ? {} : { status }),
      // The reserved id asks for the bounties in no category, which is a
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
    // Asked for on a board's page: only a bounty that came through it.
    const expectedBoardId = c.req.query("boardId");
    if (expectedBoardId !== undefined) {
      const bounty = await options.bounties.get(
        organizationId,
        proposal.bountyId,
      );
      if (bounty?.jira?.boardId !== expectedBoardId) {
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
      activeRun: await options.runs.activeForProposal(
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
    and not an error: a proposal from before specs, or a bounty too large or
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
    The complexity profiles of the proposal's newest profiled spec
    revision, one per repository its work touches, with where each stands
    while its runs are in flight. None when it was never profiled: its
    work touched no repository with a snapshot, or this deployment has no
    repository analysis.
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
        ? []
        : await options.profiles.latest(organizationId, proposal.id);
    return c.json(
      proposalProfileResponseSchema.parse({
        profiles: stored.map((profile) => ({
          id: profile.id,
          proposalId: profile.proposalId,
          specRevision: profile.specRevision,
          repository: profile.repository,
          status: profile.status,
          errorCode: profile.errorCode,
          runErrorCode: profile.runErrorCode,
          snapshotId: profile.snapshotId,
          scopeRunId: profile.scopeRunId,
          sliceRunId: profile.sliceRunId,
          profile: profile.profile,
          createdAt: profile.createdAt,
          updatedAt: profile.updatedAt,
        })),
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
    // but the size and the amount it prices to: the size chosen is the size. It does not read Jira: the
    // bounty is checked when the proposal is approved, which is the
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
      The reviewer's size covers the spec as it stands, so the step starts
      again from it: only what the spec gains after this moves the size.
      The revision check above is what makes the spec revision read here
      the one the reviewer saw.
    */
    const step =
      proposal.step === null || proposal.specRevision === null
        ? null
        : resetStep(
            proposal.step,
            parsed.data.complexity,
            proposal.specRevision,
          );
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
   * The rubric's size back in force: what a reviewer does to undo their
   * resize. The assessment is the proposal's own, kept current by every
   * spec change and by the code's measurement, so nothing is scored here;
   * an assessment with no size (the code not measured) is refused.
   */
  app.post("/api/v1/orgs/:orgId/proposals/:id/rubric", async (c) => {
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
    const price =
      proposal.rubric === null ? null : rubricPrice(proposal.rubric, proposal);
    if (proposal.rubric === null || price === null)
      return c.json(
        {
          code: "rubric_unsized",
          error: "The rubric has no size until the code is measured.",
          proposal,
        },
        409,
      );
    return proposalMutationResponse(
      c,
      await options.proposals.applyRubric(
        organizationId,
        proposal.id,
        parsed.data.expectedRevision,
        { rubric: proposal.rubric, price },
      ),
    );
  });

  /**
   * An approved proposal back to proposed, without re-sizing. A sandbox
   * published over the approval stays published, on the bounty version it
   * was built from.
   *
   * If the approval's comment reached Jira and the site still holds the
   * write grant, the withdrawal is queued in the same transaction as the
   * status change, so the bounty is never left saying "approved" for a
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
      const site = (await siteOf(options, organizationId, proposal.bountyId))
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
        if (result.status === "not-found") {
          return c.json({ error: "Not found" }, 404);
        }
        if (result.status !== "created") {
          return c.json(
            {
              code: "proposal_changed",
              error: "The proposal changed. Reload it before continuing.",
            },
            409,
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
   * Deletes a proposed proposal, so the next run may propose the bounty
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
    const bounty = await options.bounties.get(
      organizationId,
      proposal.bountyId,
    );
    if (bounty === null) return c.json({ error: "Not found" }, 404);
    const board = await boardOf(options, organizationId, bounty);
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
      bountyId: bounty.id,
      startedBy: c.get("user").id,
      kind: "reprice",
      sourceProposalId: proposal.id,
      sourceRevision: proposal.revision,
      requestId: parsed.data.requestId,
      // A re-price sizes the one bounty its proposal names; the selection
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
      // The run in the way, so the page can follow it rather than say no.
      return created.reason === "active"
        ? c.json(
            {
              code: "run_active",
              error: "Another run is already under way. Wait for it to finish.",
              runId: created.runId,
            },
            409,
          )
        : c.json(
            {
              code: "proposal_changed",
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
   * request the current revision cannot take, or a bounty that changed
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
            ? "The bounty changed since it was sized. Re-analyze it before changing its scenarios."
            : "The bounty could not be checked.",
          freshness: fresh.freshness,
        },
        409,
      );
    }
    const bounty = await options.bounties.get(
      organizationId,
      proposal.bountyId,
    );
    if (bounty === null) return c.json({ error: "Not found" }, 404);
    const board = await boardOf(options, organizationId, bounty);
    const created = await options.runs.create(organizationId, {
      boardId: board?.id ?? null,
      bountyId: bounty.id,
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
    /*
      Only a write that failed, or one queued that no worker took, is
      sent again. One running is already being sent, and one done or
      cancelled has nothing left to send: a 202 would say a retry started
      when none did.
    */
    if (operation.status !== "failed" && operation.status !== "pending") {
      return c.json(
        {
          code: "writeback_not_retryable",
          error: "That Jira update is not waiting to be retried.",
          operation,
        },
        409,
      );
    }
    /*
      And only while it still says what the proposal is. A failed approval
      retried after the proposal was unapproved and re-priced would post the
      old price as approved; it is cancelled instead, and the proposal's
      current decision is what reaches Jira. The worker checks the same
      when it runs.
    */
    const proposal = await options.proposals.get(
      organizationId,
      operation.proposalId,
    );
    if (proposal === null) return c.json({ error: "Not found" }, 404);
    if (!describesProposal(operation, proposal)) {
      return c.json(
        {
          code: "writeback_outdated",
          error:
            "The proposal changed after this Jira update was queued. Cancel it instead.",
          operation,
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
    if (result.status === "adopted") return c.json(result);
    // Said as every other refusal is, with a code and a sentence, so the
    // page shows why rather than the bare status.
    return c.json(
      {
        ...result,
        ...RECONCILE_REFUSALS[result.status],
      },
      409,
    );
  });

  app.post("/api/v1/orgs/:orgId/writebacks/:id/cancel", async (c) => {
    const { organizationId, role } = c.get("member");
    const denied = requireAdmin(role);
    if (denied !== null) return c.json(denied, 403);
    if (options.writebacks === undefined)
      return c.json({ error: "Not found" }, 404);
    // Read first, so another organization's write, or none, is a 404 and
    // only a write in a state that cannot be cancelled is a 409.
    const id = c.req.param("id");
    if ((await options.writebacks.get(organizationId, id)) === null) {
      return c.json({ error: "Not found" }, 404);
    }
    const operation = await options.writebacks.cancel(organizationId, id);
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

/** Why a Jira comment could not be adopted, as the page shows it. */
const RECONCILE_REFUSALS = {
  none: {
    code: "reconcile_none",
    error:
      "No matching comment was found in Jira. Retry the update to post it.",
  },
  multiple: {
    code: "reconcile_multiple",
    error:
      "More than one matching comment is in Jira. Remove the extra one, then check again.",
  },
  "not-uncertain": {
    code: "reconcile_not_uncertain",
    error: "This Jira update is not waiting to be checked.",
  },
} as const;

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

function proposalMutationResponse<Env extends PricingAppEnv>(
  c: Context<Env>,
  result: Awaited<ReturnType<BountyProposalStore["approve"]>>,
) {
  if (result.ok) return c.json({ proposal: result.proposal });
  if (result.reason === "not-found") return c.json({ error: "Not found" }, 404);
  const current =
    result.current === undefined ? {} : { proposal: result.current };
  /*
    At the revision the reviewer saw, so nothing changed under them: the
    proposal is simply not in the state this asks for. An approved one is
    unapproved before it is resized, re-sized by the rubric or removed; a
    proposed one has no approval to take back. Telling them to reload
    would show them the same proposal again.
  */
  if (result.reason === "invalid-state") {
    return c.json(
      result.current?.status === "approved"
        ? {
            code: "proposal_approved",
            error: "Unapprove the proposal before changing it.",
            ...current,
          }
        : {
            code: "proposal_not_approved",
            error: "The proposal is not approved.",
            ...current,
          },
      409,
    );
  }
  return c.json(
    {
      code: "proposal_changed",
      error: "The proposal changed. Reload it before continuing.",
      ...current,
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
