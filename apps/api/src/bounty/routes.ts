import type {
  BountyProposalStore,
  BountyRunStore,
  BountyWritebackStore,
  JiraBoardStore,
  JiraConnectionStore,
  JiraIssueStore,
  RateCardStore,
} from "@sandbox-factory/db";
import {
  boardSelectionSchema,
  createRunSchema,
  putRateCardSchema,
  proposalMutationSchema,
  repriceProposalSchema,
  resizeProposalSchema,
} from "@sandbox-factory/shared";
import type { Hono } from "hono";
import {
  priceFor,
  validateRateCard,
  type PricedComplexity,
} from "sandbox-factory";

import type { BountyExecutor, RunClientResult } from "./executor.js";
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
    if (
      options.executor === undefined ||
      options.clientFor === undefined ||
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

    const board = await options.boards.forRun(
      organizationId,
      c.req.param("id"),
    );
    if (board === null) return c.json({ error: "Not found" }, 404);
    const ready = await options.clientFor(organizationId, board.connectionId);
    if (!ready.ok) {
      return c.json(
        ready.reason === "not-found"
          ? { error: "Not found" }
          : {
              code: "reconnect",
              error: "This Jira connection needs reconnecting.",
            },
        ready.reason === "not-found" ? 404 : 409,
      );
    }
    const card = await options.rateCards.get(organizationId);
    if (card === null) {
      return c.json(
        {
          code: "rate_card_required",
          error: "Set a rate card before running.",
        },
        409,
      );
    }

    const created = await options.runs.create(organizationId, {
      boardId: board.board.id,
      startedBy: c.get("user").id,
      requestId: parsed.data.requestId,
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
      if (created.reason === "active") {
        return c.json(
          {
            code: "run_active",
            error: "A run is already active for this board.",
            runId: created.runId,
          },
          409,
        );
      }
      return c.json(
        {
          code:
            created.reason === "request-conflict"
              ? "request_conflict"
              : "not_found",
          error:
            created.reason === "request-conflict"
              ? "That requestId was already used for another run."
              : "Not found",
        },
        created.reason === "request-conflict" ? 409 : 404,
      );
    }
    if (created.created) options.executor.start(organizationId, created.run.id);
    return c.json({ run: created.run }, 202);
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
    const history = await options.proposals.historyForIssue(
      organizationId,
      proposal.jiraIssueId,
    );
    if (options.clientFor === undefined) {
      return c.json({
        proposal,
        liveSpec: null,
        freshness: {
          freshness: "unknown",
          checkedAt: new Date().toISOString(),
          code: "reconnect",
        },
        history,
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
      history,
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
    return decideWithFreshSpec(
      c,
      options,
      "approve",
      parsed.data.expectedRevision,
    );
  });

  app.post("/api/v1/orgs/:orgId/proposals/:id/resize", async (c) => {
    const parsed = resizeProposalSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      return c.json({ error: "Invalid resize request." }, 400);
    const denied = requireAdmin(c.get("member").role);
    if (denied !== null) return c.json(denied, 403);
    return decideWithFreshSpec(
      c,
      options,
      "resize",
      parsed.data.expectedRevision,
      parsed.data.complexity,
    );
  });

  app.post("/api/v1/orgs/:orgId/proposals/:id/reject", async (c) => {
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
      if (
        operations.some(
          ({ status }) =>
            status === "pending" ||
            status === "running" ||
            status === "uncertain",
        )
      ) {
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
        const result = await options.writebacks.rejectWithIntent(
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
      await options.proposals.reject(
        organizationId,
        c.req.param("id"),
        parsed.data.expectedRevision,
        c.get("user").id,
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
      if (
        operations.some(
          ({ status }) =>
            status === "pending" ||
            status === "running" ||
            status === "uncertain",
        )
      ) {
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

async function decideWithFreshSpec(
  c: any,
  options: BountyRouteOptions,
  action: "approve" | "resize",
  expectedRevision: number,
  complexity?: PricedComplexity,
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
  if (action === "approve") {
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
        : await options.connections.get(
            organizationId,
            registered.connectionId,
          );
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
  const amountMinor = priceFor(complexity!, proposal.rateCard);
  return proposalMutationResponse(
    c,
    await options.proposals.resize(
      organizationId,
      proposal.id,
      expectedRevision,
      c.get("user").id,
      complexity!,
      amountMinor!,
      proposal.rateCard.currency,
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
): "proposed" | "approved" | "rejected" | "superseded" | undefined | null {
  if (value === undefined || value === "") return undefined;
  return ["proposed", "approved", "rejected", "superseded"].includes(value)
    ? (value as "proposed" | "approved" | "rejected" | "superseded")
    : null;
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
