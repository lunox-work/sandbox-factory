/**
 * A bounty's Jira issue, picked for it after it was written: the search a
 * person picks it from, across every board the workspace has, and the link
 * itself, made and removed.
 *
 * A link is enrichment, as everywhere: the bounty is the platform's record
 * with or without one. While it has one it follows the issue, as an
 * imported bounty does, so linking writes Jira's text over the bounty's.
 * Removing the link leaves the bounty with the text it last had, the
 * platform's to change again.
 *
 * Any member may search and link, as any member may edit a bounty.
 */

import type {
  BountyProposalStore,
  BountyStore,
  JiraBoardStore,
  JiraIssueStore,
} from "@sandbox-factory/db";
import { JiraApiError, JiraAuthError } from "@sandbox-factory/jira";
import {
  jiraWorkspaceIssueSearchSchema,
  linkBountyJiraSchema,
  type JiraIssueDto,
} from "@sandbox-factory/shared";
import type { Context, Hono } from "hono";
import { overviewApproved } from "sandbox-factory";

import type { RunClientResult } from "../pricing/executor.js";
import { mapConcurrent } from "../pricing/review.js";
import { issueSearchJql } from "../pricing/routes.js";
import { detail, OVERVIEW_APPROVED } from "./routes.js";

export interface BountyJiraRouteOptions {
  readonly bounties: BountyStore;
  readonly proposals: Pick<BountyProposalStore, "get" | "liveForBounty">;
  readonly boards: Pick<JiraBoardStore, "list" | "forRun">;
  readonly issues: Pick<JiraIssueStore, "link" | "unlink" | "bountiesFor">;
  /** A Jira site's client; absent, Jira is not configured here. */
  readonly clientFor?: (
    organizationId: string,
    connectionId: string,
  ) => Promise<RunClientResult>;
}

interface BountyJiraAppEnv {
  Variables: {
    user: { id: string };
    member: { organizationId: string; role: string };
  };
}

/** How many issues the search shows, and how many each board is asked for. */
const SEARCH_RESULTS = 20;
const BOARD_CANDIDATES = 10;
/** How many boards are searched at once. */
const BOARD_CONCURRENCY = 4;

type Found = JiraIssueDto & {
  readonly boardId: string;
  readonly boardName: string;
  readonly bountyId: string | null;
};

/** What one board's search came to: its issues, or why it had none. */
type BoardSearch =
  | { readonly ok: true; readonly issues: readonly Found[] }
  | { readonly ok: false; readonly reconnect: boolean };

export function mountBountyJiraRoutes<Env extends BountyJiraAppEnv>(
  app: Hono<Env>,
  options: BountyJiraRouteOptions,
): void {
  /**
   * The workspace's issues matching what a person typed, from every board
   * it has, for picking one to link. An issue on two boards is listed once,
   * from the board it is a bounty on if it is one. A board that cannot be
   * searched is passed over, so one site needing reconnecting does not hide
   * another's issues; only when every board needs it is that the answer.
   */
  app.get("/api/v1/orgs/:orgId/jira/search", async (c) => {
    const { organizationId } = c.get("member");
    const clientFor = options.clientFor;
    if (clientFor === undefined) return c.json({ issues: [] });
    const jql = issueSearchJql(c.req.query("q") ?? "");
    if (jql === null) return c.json({ issues: [] });
    const boards = await options.boards.list(organizationId);
    if (boards.length === 0) return c.json({ issues: [] });

    // One client per site, however many of its boards are searched.
    const clients = new Map<string, Promise<RunClientResult>>();
    const clientOf = (connectionId: string) => {
      let client = clients.get(connectionId);
      if (client === undefined) {
        client = clientFor(organizationId, connectionId);
        clients.set(connectionId, client);
      }
      return client;
    };

    const searched = await mapConcurrent(
      boards,
      BOARD_CONCURRENCY,
      async (board): Promise<BoardSearch> => {
        const ready = await clientOf(board.connectionId);
        if (!ready.ok) {
          return { ok: false, reconnect: ready.reason === "reconnect" };
        }
        let issues: JiraIssueDto[];
        try {
          issues = (
            await ready.client.boardIssues(Number(board.externalId), {
              jql,
              startAt: 0,
              maxResults: BOARD_CANDIDATES,
            })
          ).issues;
        } catch (error) {
          // A key that does not exist is a 400 from Jira: nothing found.
          if (error instanceof JiraApiError && error.status === 400) {
            return { ok: true, issues: [] };
          }
          return { ok: false, reconnect: needsReconnect(error) };
        }
        const bounties = await options.issues.bountiesFor(
          organizationId,
          board.id,
          issues.map(({ id }) => id),
        );
        return {
          ok: true,
          issues: issues.map((issue) => ({
            ...issue,
            boardId: board.id,
            boardName: board.name,
            bountyId: bounties.get(issue.id) ?? null,
          })),
        };
      },
    );

    if (searched.every((result) => !result.ok)) {
      return searched.some((result) => !result.ok && result.reconnect)
        ? c.json(
            {
              code: "reconnect",
              error: "Jira needs reconnecting before it can be searched.",
            },
            409,
          )
        : c.json({ error: "Jira could not be searched." }, 502);
    }

    const byId = new Map<string, Found>();
    for (const result of searched) {
      if (!result.ok) continue;
      for (const issue of result.issues) {
        const seen = byId.get(issue.id);
        if (
          seen === undefined ||
          (seen.bountyId === null && issue.bountyId !== null)
        ) {
          byId.set(issue.id, issue);
        }
      }
    }
    return c.json(
      jiraWorkspaceIssueSearchSchema.parse({
        issues: [...byId.values()].slice(0, SEARCH_RESULTS).map((issue) => ({
          id: issue.id,
          key: issue.key,
          summary: issue.summary,
          status: issue.status,
          issueType: issue.issueType,
          boardId: issue.boardId,
          boardName: issue.boardName,
          bountyId: issue.bountyId,
        })),
      }),
    );
  });

  /**
   * Links the bounty to an issue on one of the workspace's boards, in place
   * of any it had. The issue is read from Jira now, so the bounty takes its
   * text at once rather than at the next run.
   */
  app.put("/api/v1/orgs/:orgId/bounties/:id/jira", async (c) => {
    const { organizationId } = c.get("member");
    const parsed = linkBountyJiraSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json({ error: "Provide a boardId and an issueId." }, 400);
    }
    const { boardId, issueId } = parsed.data;
    const bountyId = c.req.param("id");
    const current = await options.bounties.get(organizationId, bountyId);
    if (current === null) return c.json({ error: "Not found" }, 404);
    // Linking takes Jira's text, which an approved overview is held from.
    if (overviewApproved(current)) return c.json(OVERVIEW_APPROVED, 409);
    const board = await options.boards.forRun(organizationId, boardId);
    if (board === null) return c.json({ error: "Not found" }, 404);
    if (options.clientFor === undefined) return reconnect(c);
    const ready = await options.clientFor(organizationId, board.connectionId);
    if (!ready.ok) {
      return ready.reason === "not-found"
        ? c.json({ error: "Not found" }, 404)
        : reconnect(c);
    }

    let issue: JiraIssueDto;
    let spec: Awaited<ReturnType<typeof ready.client.issueSpec>>;
    try {
      [issue, spec] = await Promise.all([
        ready.client.issue(issueId),
        ready.client.issueSpec(issueId),
      ]);
    } catch (error) {
      if (error instanceof JiraApiError && error.isNotFound) {
        return c.json(
          { code: "issue_not_found", error: "That Jira issue was not found." },
          404,
        );
      }
      return needsReconnect(error)
        ? reconnect(c)
        : c.json({ error: "Jira could not be read." }, 502);
    }

    // A ticket's age is counted from these, so a run never imports one
    // without them; it is not linked here either.
    const { created, updated } = issue;
    if (created === null || updated === null) {
      return c.json(
        { code: "invalid_issue_dates", error: "Jira gave no dates for it." },
        502,
      );
    }

    const linked = await options.issues.link(
      organizationId,
      boardId,
      bountyId,
      {
        externalId: issue.id,
        key: issue.key,
      },
      {
        title: spec.summary,
        description: spec.descriptionText,
        components: spec.components,
        inputTruncated: spec.inputTruncated,
      },
    );
    if (!linked.ok) {
      return linked.reason === "not-found"
        ? c.json({ error: "Not found" }, 404)
        : c.json(
            {
              code: "issue_linked",
              error: `${issue.key} is already another bounty's.`,
              bountyId: linked.bountyId,
            },
            409,
          );
    }
    const bounty = await options.bounties.get(organizationId, bountyId);
    if (bounty === null) return c.json({ error: "Not found" }, 404);
    return c.json({ bounty: await detail(options, bounty) });
  });

  /** Takes the bounty's issue from it; its text stays as it last was. */
  app.delete("/api/v1/orgs/:orgId/bounties/:id/jira", async (c) => {
    const { organizationId } = c.get("member");
    const bountyId = c.req.param("id");
    const current = await options.bounties.get(organizationId, bountyId);
    if (current === null) return c.json({ error: "Not found" }, 404);
    if (overviewApproved(current)) return c.json(OVERVIEW_APPROVED, 409);
    await options.issues.unlink(organizationId, bountyId);
    const bounty = await options.bounties.get(organizationId, bountyId);
    if (bounty === null) return c.json({ error: "Not found" }, 404);
    return c.json({ bounty: await detail(options, bounty) });
  });
}

function needsReconnect(error: unknown): boolean {
  return (
    (error instanceof JiraAuthError && error.needsReconnect) ||
    (error instanceof JiraApiError && error.isUnauthorized)
  );
}

function reconnect(c: Context): Response {
  return c.json(
    { code: "reconnect", error: "This Jira connection needs reconnecting." },
    409,
  );
}
