/**
 * The organization's tickets: written here, or imported from Jira by a run.
 *
 * Every route sits behind the membership guard and takes the owner from the
 * path. Any member may read, write and edit a ticket, which costs nothing;
 * proposing one asks a model and is an owner's or admin's
 * (`POST .../tickets/:id/propose`, with the other bounty routes), and so is
 * deleting one.
 */

import type {
  BountyProposalStore,
  ListedTicket,
  StoredTicket,
  TicketMutationResult,
  TicketStore,
} from "@sandbox-factory/db";
import {
  createTicketSchema,
  ticketDtoSchema,
  ticketListResponseSchema,
  updateTicketSchema,
  type TicketDto,
  type TicketJiraLinkDto,
  type TicketProposalSummaryDto,
  type TicketSummaryDto,
} from "@sandbox-factory/shared";
import type { Hono } from "hono";

import { isAtLeastAdmin } from "../access.js";
import { boundedLimit, rowCursor } from "../paging.js";

export interface TicketRouteOptions {
  readonly tickets: TicketStore;
  readonly proposals: Pick<BountyProposalStore, "get" | "liveForTicket">;
}

interface TicketAppEnv {
  Variables: {
    user: { id: string };
    member: { organizationId: string; role: string };
  };
}

export function mountTicketRoutes<Env extends TicketAppEnv>(
  app: Hono<Env>,
  options: TicketRouteOptions,
): void {
  const base = "/api/v1/orgs/:orgId/tickets";

  /** Newest first, a page at a time, each with its live proposal. */
  app.get(base, async (c) => {
    const { organizationId } = c.get("member");
    const limit = boundedLimit(c.req.query("limit"));
    const cursor = rowCursor(c.req.query("cursor"));
    if (cursor === null) return c.json({ error: "Invalid cursor." }, 400);
    const tickets = await options.tickets.list(organizationId, {
      limit,
      ...(cursor === undefined ? {} : { cursor }),
    });
    const last = tickets.at(-1);
    return c.json(
      ticketListResponseSchema.parse({
        tickets: tickets.map(summaryDto),
        nextCursor:
          tickets.length === limit && last !== undefined
            ? `${last.createdAt}|${last.id}`
            : null,
      }),
    );
  });

  app.post(base, async (c) => {
    const { organizationId } = c.get("member");
    const parsed = createTicketSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json(
        {
          code: "invalid_ticket",
          error: parsed.error.issues[0]?.message ?? "Invalid ticket.",
        },
        400,
      );
    }
    const created = await options.tickets.create(
      organizationId,
      c.get("user").id,
      parsed.data,
    );
    if (!created.ok) return repoNotFound(c);
    return c.json(
      { ticket: ticketDtoSchema.parse(ticketDto(created.ticket, null)) },
      201,
    );
  });

  app.get(`${base}/:id`, async (c) => {
    const { organizationId } = c.get("member");
    const ticket = await options.tickets.get(organizationId, c.req.param("id"));
    if (ticket === null) return c.json({ error: "Not found" }, 404);
    return c.json({ ticket: await detail(options, ticket) });
  });

  /**
   * A change, against the revision the editor saw. A ticket still following
   * its Jira issue takes its text from Jira, so only its repository can be
   * set here; its title and description are changed in Jira.
   */
  app.patch(`${base}/:id`, async (c) => {
    const { organizationId } = c.get("member");
    const parsed = updateTicketSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json(
        {
          code: "invalid_ticket",
          error: parsed.error.issues[0]?.message ?? "Invalid change.",
        },
        400,
      );
    }
    const { expectedRevision, ...change } = parsed.data;
    const result: TicketMutationResult = await options.tickets.update(
      organizationId,
      c.req.param("id"),
      expectedRevision,
      change,
    );
    if (result.ok) {
      return c.json({ ticket: await detail(options, result.ticket) });
    }
    switch (result.reason) {
      case "not-found":
        return c.json({ error: "Not found" }, 404);
      case "repo-not-found":
        return repoNotFound(c);
      case "jira-owned":
        return c.json(
          {
            code: "jira_owned",
            error:
              "This ticket follows its Jira issue. Change its text in Jira.",
          },
          409,
        );
      case "changed":
        return c.json(
          {
            code: "ticket_changed",
            error: "The ticket changed. Reload it before saving.",
            ...(result.current === undefined
              ? {}
              : { ticket: await detail(options, result.current) }),
          },
          409,
        );
    }
  });

  /**
   * Only a ticket nothing has been built on: no proposal, no sandbox, and
   * no run sizing it now.
   */
  app.delete(`${base}/:id`, async (c) => {
    const { organizationId, role } = c.get("member");
    if (!isAtLeastAdmin(role)) {
      return c.json(
        { error: "Only an owner or admin may delete a ticket." },
        403,
      );
    }
    const removed = await options.tickets.remove(
      organizationId,
      c.req.param("id"),
    );
    if (removed === "removed") return c.body(null, 204);
    return removed === "not-found"
      ? c.json({ error: "Not found" }, 404)
      : c.json(
          {
            code: "ticket_in_use",
            error:
              "This ticket has a proposal or a sandbox, or is being sized, so it cannot be deleted.",
          },
          409,
        );
  });
}

async function detail(
  options: TicketRouteOptions,
  ticket: StoredTicket,
): Promise<TicketDto> {
  const liveId = await options.proposals.liveForTicket(
    ticket.organizationId,
    ticket.id,
  );
  const live =
    liveId === null
      ? null
      : await options.proposals.get(ticket.organizationId, liveId);
  return ticketDtoSchema.parse(
    ticketDto(
      ticket,
      live === null ||
        (live.status !== "proposed" && live.status !== "approved")
        ? null
        : {
            id: live.id,
            status: live.status,
            complexity: live.complexity,
            amountMinor: live.amountMinor,
            currency: live.currency,
          },
    ),
  );
}

function linkDto(ticket: Pick<StoredTicket, "jira">): TicketJiraLinkDto | null {
  const { jira } = ticket;
  return jira === null
    ? null
    : {
        issueId: jira.issueId,
        boardId: jira.boardId,
        connectionId: jira.connectionId,
        key: jira.key,
        url: `${jira.siteUrl}/browse/${encodeURIComponent(jira.key)}`,
        removedAt: jira.removedAt,
      };
}

function summaryDto(ticket: ListedTicket): TicketSummaryDto {
  return {
    id: ticket.id,
    organizationId: ticket.organizationId,
    number: ticket.number,
    key: ticket.key,
    title: ticket.title,
    issueType: ticket.issueType,
    priority: ticket.priority,
    labels: [...ticket.labels],
    origin: ticket.origin,
    repoId: ticket.repoId,
    revision: ticket.revision,
    jira: linkDto(ticket),
    proposal: ticket.proposal,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
  };
}

function ticketDto(
  ticket: StoredTicket,
  proposal: TicketProposalSummaryDto | null,
): TicketDto {
  return {
    ...summaryDto({ ...ticket, proposal }),
    description: ticket.description,
    components: [...ticket.components],
    inputTruncated: ticket.inputTruncated,
    createdBy: ticket.createdBy,
  };
}

function repoNotFound(c: { json: (body: unknown, status: 404) => Response }) {
  return c.json(
    {
      code: "repo_not_found",
      error: "That repository is not connected to this workspace.",
    },
    404,
  );
}
