/**
 * The organization's bounties: written here, or imported from Jira by a run.
 *
 * Every route but one sits behind the membership guard and takes the owner
 * from the path; the exception, `GET /api/v1/me/bounties`, lists across the
 * caller's own memberships (see `mountCallerBountyRoutes`). Any member may
 * read, write and edit a bounty, which costs nothing;
 * proposing one asks a model and is an owner's or admin's
 * (`POST .../bounties/:id/propose`, with the other bounty routes), and so is
 * deleting one.
 */

import type {
  BountyProposalStore,
  ListedBounty,
  StoredBounty,
  BountyMutationResult,
  BountyStore,
} from "@sandbox-factory/db";
import {
  createBountySchema,
  bountyDtoSchema,
  bountyListResponseSchema,
  updateBountySchema,
  type BountyDto,
  type BountyJiraLinkDto,
  type BountyProposalSummaryDto,
  type BountySummaryDto,
} from "@sandbox-factory/shared";
import type { Context, Hono } from "hono";

import { isAtLeastAdmin } from "../access.js";
import { boundedLimit, rowCursor } from "../paging.js";

export interface BountyRouteOptions {
  readonly bounties: BountyStore;
  readonly proposals: Pick<BountyProposalStore, "get" | "liveForBounty">;
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
  const base = "/api/v1/orgs/:orgId/bounties";

  /** Newest first, a page at a time, each with its live proposal. */
  app.get(base, async (c) => {
    const { organizationId } = c.get("member");
    return listPage(c, (page) => options.bounties.list(organizationId, page));
  });

  app.post(base, async (c) => {
    const { organizationId } = c.get("member");
    const parsed = createBountySchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json(
        {
          code: "invalid_bounty",
          error: parsed.error.issues[0]?.message ?? "Invalid bounty.",
        },
        400,
      );
    }
    const created = await options.bounties.create(
      organizationId,
      c.get("user").id,
      parsed.data,
    );
    if (!created.ok) return repoNotFound(c);
    return c.json(
      { bounty: bountyDtoSchema.parse(bountyDto(created.bounty, null)) },
      201,
    );
  });

  app.get(`${base}/:id`, async (c) => {
    const { organizationId } = c.get("member");
    const bounty = await options.bounties.get(
      organizationId,
      c.req.param("id"),
    );
    if (bounty === null) return c.json({ error: "Not found" }, 404);
    return c.json({ bounty: await detail(options, bounty) });
  });

  /**
   * A change, against the revision the editor saw. A bounty still following
   * its Jira issue takes its text from Jira, so only its repository and
   * stack can be set here; its title and description are changed in Jira.
   */
  app.patch(`${base}/:id`, async (c) => {
    const { organizationId } = c.get("member");
    const parsed = updateBountySchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json(
        {
          code: "invalid_bounty",
          error: parsed.error.issues[0]?.message ?? "Invalid change.",
        },
        400,
      );
    }
    const { expectedRevision, ...change } = parsed.data;
    const result: BountyMutationResult = await options.bounties.update(
      organizationId,
      c.req.param("id"),
      expectedRevision,
      change,
    );
    if (result.ok) {
      return c.json({ bounty: await detail(options, result.bounty) });
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
              "This bounty follows its Jira issue. Change its text in Jira.",
          },
          409,
        );
      case "changed":
        return c.json(
          {
            code: "bounty_changed",
            error: "The bounty changed. Reload it before saving.",
            ...(result.current === undefined
              ? {}
              : { bounty: await detail(options, result.current) }),
          },
          409,
        );
    }
  });

  /**
   * Only a bounty nothing has been built on: no proposal, no sandbox, and
   * no run sizing it now.
   */
  app.delete(`${base}/:id`, async (c) => {
    const { organizationId, role } = c.get("member");
    if (!isAtLeastAdmin(role)) {
      return c.json(
        { error: "Only an owner or admin may delete a bounty." },
        403,
      );
    }
    const removed = await options.bounties.remove(
      organizationId,
      c.req.param("id"),
    );
    if (removed === "removed") return c.body(null, 204);
    return removed === "not-found"
      ? c.json({ error: "Not found" }, 404)
      : c.json(
          {
            code: "bounty_in_use",
            error:
              "This bounty has a proposal or a sandbox, or is being sized, so it cannot be deleted.",
          },
          409,
        );
  });
}

/**
 * The caller's bounties across every organization they belong to, for the
 * one Bounties page that shows all of their work.
 *
 * Outside the membership guard, since no one organization is named: the
 * organizations are the caller's own memberships, read here, and nothing in
 * the request can add to them. Each bounty carries its organization's id,
 * and everything done to one after it is listed goes through that
 * organization's own routes.
 */
export function mountCallerBountyRoutes<Env extends BountyAppEnv>(
  app: Hono<Env>,
  options: {
    readonly bounties: Pick<BountyStore, "listAcross">;
    /** The ids of the organizations the user is a member of. */
    readonly organizationsOf: (userId: string) => Promise<readonly string[]>;
  },
): void {
  app.get("/api/v1/me/bounties", async (c) => {
    const organizationIds = await options.organizationsOf(c.get("user").id);
    return listPage(c, (page) =>
      options.bounties.listAcross(organizationIds, page),
    );
  });
}

/**
 * One page of a newest-first bounty list, read by `read` from the query's
 * `limit` and `cursor`, and the cursor for the page after it.
 */
async function listPage(
  c: Context,
  read: (page: {
    limit: number;
    cursor?: { createdAt: string; id: string };
  }) => Promise<ListedBounty[]>,
): Promise<Response> {
  const limit = boundedLimit(c.req.query("limit"));
  const cursor = rowCursor(c.req.query("cursor"));
  if (cursor === null) return c.json({ error: "Invalid cursor." }, 400);
  const bounties = await read({
    limit,
    ...(cursor === undefined ? {} : { cursor }),
  });
  const last = bounties.at(-1);
  return c.json(
    bountyListResponseSchema.parse({
      bounties: bounties.map(summaryDto),
      nextCursor:
        bounties.length === limit && last !== undefined
          ? `${last.createdAt}|${last.id}`
          : null,
    }),
  );
}

async function detail(
  options: BountyRouteOptions,
  bounty: StoredBounty,
): Promise<BountyDto> {
  const liveId = await options.proposals.liveForBounty(
    bounty.organizationId,
    bounty.id,
  );
  const live =
    liveId === null
      ? null
      : await options.proposals.get(bounty.organizationId, liveId);
  return bountyDtoSchema.parse(
    bountyDto(
      bounty,
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

function linkDto(bounty: Pick<StoredBounty, "jira">): BountyJiraLinkDto | null {
  const { jira } = bounty;
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

function summaryDto(bounty: ListedBounty): BountySummaryDto {
  return {
    id: bounty.id,
    organizationId: bounty.organizationId,
    title: bounty.title,
    origin: bounty.origin,
    repoId: bounty.repoId,
    stack: [...bounty.stack],
    revision: bounty.revision,
    jira: linkDto(bounty),
    proposal: bounty.proposal,
    sandbox: bounty.sandbox,
    createdAt: bounty.createdAt,
    updatedAt: bounty.updatedAt,
  };
}

function bountyDto(
  bounty: StoredBounty,
  proposal: BountyProposalSummaryDto | null,
): BountyDto {
  return {
    ...summaryDto({ ...bounty, proposal }),
    description: bounty.description,
    components: [...bounty.components],
    inputTruncated: bounty.inputTruncated,
    createdBy: bounty.createdBy,
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
