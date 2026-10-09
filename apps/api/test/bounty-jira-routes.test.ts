import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  JiraIssueInput,
  JiraIssueLinkResult,
  StoredBounty,
} from "@sandbox-factory/db";
import { JiraApiError } from "@sandbox-factory/jira";
import type { BountyContent } from "sandbox-factory";
import { Hono } from "hono";

import {
  mountBountyJiraRoutes,
  type BountyJiraRouteOptions,
} from "../src/bounties/jira.js";
import type { RunClientResult } from "../src/pricing/executor.js";
import type { AuthVariables } from "../src/routes.js";

const stamp = "2026-10-06T00:00:00.000Z";

function bountyOf(overrides: Partial<StoredBounty> = {}): StoredBounty {
  return {
    id: "bty_7",
    organizationId: "org_1",
    title: "Invitations are not sent",
    description: "Written here.",
    components: [],
    inputTruncated: false,
    origin: "manual",
    stack: [],
    categories: [],
    createdBy: "user_1",
    revision: 1,
    version: 1,
    approval: null,
    jira: null,
    sandbox: null,
    createdAt: stamp,
    updatedAt: stamp,
    ...overrides,
  };
}

function issueOf(id: string, key: string, summary = "Invitations") {
  return {
    id,
    key,
    summary,
    status: "To Do",
    statusCategory: "new",
    issueType: "Task",
    created: stamp,
    updated: stamp,
  };
}

function boardOf(id: string, name: string, connectionId = "jrc_1") {
  return { id, name, connectionId, externalId: id.replace(/\D/g, "") };
}

interface Setup {
  boards?: ReturnType<typeof boardOf>[];
  /** A board's issues, by its id. */
  found?: Record<string, ReturnType<typeof issueOf>[] | Error>;
  /** The bounty each board's issues are, by Jira's id. */
  imported?: Record<string, Record<string, string>>;
  client?: RunClientResult | null;
  link?: JiraIssueLinkResult;
  /** The bounty as it is before any request. */
  bounty?: Partial<StoredBounty>;
}

function harness(setup: Setup = {}) {
  let bounty = bountyOf(setup.bounty);
  const searched: { boardId: number; jql: string }[] = [];
  const links: {
    boardId: string;
    bountyId: string;
    input: JiraIssueInput;
    content: BountyContent;
  }[] = [];
  const unlinks: string[] = [];
  const boardByExternal = (externalId: number) =>
    (setup.boards ?? []).find(
      (board) => Number(board.externalId) === externalId,
    );
  const client: RunClientResult = setup.client ?? {
    ok: true,
    client: {
      boardIssues: (boardId: number, options: { jql: string }) => {
        searched.push({ boardId, jql: options.jql });
        const found = setup.found?.[boardByExternal(boardId)?.id ?? ""] ?? [];
        return found instanceof Error
          ? Promise.reject(found)
          : Promise.resolve({ issues: found });
      },
      issue: (id: string) => Promise.resolve(issueOf(id, "APP-9", "From Jira")),
      issueSpec: () =>
        Promise.resolve({
          summary: "From Jira",
          descriptionText: "Jira's steps.",
          components: [],
          inputTruncated: false,
        }),
    } as never,
  };
  const options: BountyJiraRouteOptions = {
    bounties: {
      get: (_org: string, id: string) =>
        Promise.resolve(id === bounty.id ? bounty : null),
    } as never,
    proposals: {
      liveForBounty: () => Promise.resolve(null),
      get: () => Promise.resolve(null),
    },
    boards: {
      list: () => Promise.resolve(setup.boards ?? []),
      forRun: (_org: string, id: string) =>
        Promise.resolve(
          id === "jrb_1"
            ? {
                board: boardOf("jrb_1", "App"),
                connectionId: "jrc_1",
                cloudId: "cloud",
                siteUrl: "https://acme.atlassian.net",
              }
            : null,
        ),
    } as never,
    issues: {
      bountiesFor: (_org: string, boardId: string) =>
        Promise.resolve(
          new Map(Object.entries(setup.imported?.[boardId] ?? {})),
        ),
      link: (
        _org: string,
        boardId: string,
        bountyId: string,
        input: JiraIssueInput,
        content: BountyContent,
      ) => {
        links.push({ boardId, bountyId, input, content });
        const result = setup.link ?? {
          ok: true as const,
          pointer: {} as never,
        };
        if (result.ok) {
          bounty = bountyOf({
            title: content.title,
            description: content.description,
            jira: {
              issueId: "jri_1",
              boardId,
              connectionId: "jrc_1",
              externalId: input.externalId,
              key: input.key,
              siteUrl: "https://acme.atlassian.net",
              removedAt: null,
            },
          });
        }
        return Promise.resolve(result);
      },
      unlink: (_org: string, bountyId: string) => {
        unlinks.push(bountyId);
        bounty = bountyOf({ ...bounty, jira: null });
        return Promise.resolve(true);
      },
    },
    ...(setup.client === null
      ? {}
      : { clientFor: () => Promise.resolve(client) }),
  };
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("user", { id: "user_1" } as never);
    c.set("member", { organizationId: "org_1", role: "member" });
    await next();
  });
  mountBountyJiraRoutes(app, options);
  const request = (method: string, path: string, body?: unknown) =>
    app.request(`/api/v1/orgs/org_1/${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { request, searched, links, unlinks };
}

interface SearchBody {
  issues: {
    id: string;
    key: string;
    boardId: string;
    boardName: string;
    bountyId: string | null;
  }[];
  code?: string;
}

test("searches every board in the workspace and names each issue's board", async () => {
  const { request, searched } = harness({
    boards: [boardOf("jrb_1", "App"), boardOf("jrb_2", "Web", "jrc_2")],
    found: {
      jrb_1: [issueOf("100", "APP-1")],
      jrb_2: [issueOf("200", "WEB-4")],
    },
    imported: { jrb_2: { "200": "bty_other" } },
  });
  const response = await request("GET", "jira/search?q=invite");
  assert.equal(response.status, 200);
  const body = (await response.json()) as SearchBody;
  assert.deepEqual(
    body.issues.map(({ key, boardName, bountyId }) => [
      key,
      boardName,
      bountyId,
    ]),
    [
      ["APP-1", "App", null],
      ["WEB-4", "Web", "bty_other"],
    ],
  );
  assert.deepEqual(searched.map(({ boardId }) => boardId).sort(), [1, 2]);
  assert.equal(searched[0]?.jql, 'text ~ "invite*"');
});

test("an issue on two boards is listed once, from the board it is a bounty on", async () => {
  const { request } = harness({
    boards: [boardOf("jrb_1", "App"), boardOf("jrb_2", "Kanban")],
    found: {
      jrb_1: [issueOf("100", "APP-1")],
      jrb_2: [issueOf("100", "APP-1")],
    },
    imported: { jrb_2: { "100": "bty_7" } },
  });
  const body = (await (
    await request("GET", "jira/search?q=APP-1")
  ).json()) as SearchBody;
  assert.equal(body.issues.length, 1);
  assert.equal(body.issues[0]?.boardId, "jrb_2");
  assert.equal(body.issues[0]?.bountyId, "bty_7");
});

test("an empty search asks Jira nothing", async () => {
  const { request, searched } = harness({ boards: [boardOf("jrb_1", "App")] });
  const body = (await (
    await request("GET", "jira/search?q=%20")
  ).json()) as SearchBody;
  assert.deepEqual(body.issues, []);
  assert.equal(searched.length, 0);
});

test("a board that cannot be searched is passed over", async () => {
  const { request } = harness({
    boards: [boardOf("jrb_1", "App"), boardOf("jrb_2", "Web")],
    found: {
      jrb_1: new JiraApiError(500, "boom"),
      jrb_2: [issueOf("200", "WEB-4")],
    },
  });
  const response = await request("GET", "jira/search?q=web");
  assert.equal(response.status, 200);
  const body = (await response.json()) as SearchBody;
  assert.deepEqual(
    body.issues.map(({ key }) => key),
    ["WEB-4"],
  );
});

test("a search no board can answer for want of a connection asks to reconnect", async () => {
  const { request } = harness({
    boards: [boardOf("jrb_1", "App")],
    client: { ok: false, reason: "reconnect" },
  });
  const response = await request("GET", "jira/search?q=web");
  assert.equal(response.status, 409);
  assert.equal(((await response.json()) as SearchBody).code, "reconnect");
});

test("linking reads the issue from Jira and returns the bounty following it", async () => {
  const { request, links } = harness();
  const response = await request("PUT", "bounties/bty_7/jira", {
    boardId: "jrb_1",
    issueId: "100",
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    bounty: { title: string; description: string; jira: { key: string } };
  };
  assert.equal(body.bounty.jira.key, "APP-9");
  assert.equal(body.bounty.title, "From Jira");
  assert.equal(body.bounty.description, "Jira's steps.");
  assert.equal(links[0]?.boardId, "jrb_1");
  assert.equal(links[0]?.bountyId, "bty_7");
  assert.equal(links[0]?.input.externalId, "100");
  assert.equal(links[0]?.content.description, "Jira's steps.");
});

test("an issue already another bounty's is not linked", async () => {
  const { request } = harness({
    link: { ok: false, reason: "issue-linked", bountyId: "bty_other" },
  });
  const response = await request("PUT", "bounties/bty_7/jira", {
    boardId: "jrb_1",
    issueId: "100",
  });
  assert.equal(response.status, 409);
  const body = (await response.json()) as { code: string; bountyId: string };
  assert.equal(body.code, "issue_linked");
  assert.equal(body.bountyId, "bty_other");
});

test("a link to another workspace's board, or another's bounty, is not found", async () => {
  const { request, links } = harness();
  assert.equal(
    (
      await request("PUT", "bounties/bty_7/jira", {
        boardId: "jrb_9",
        issueId: "100",
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await request("PUT", "bounties/bty_9/jira", {
        boardId: "jrb_1",
        issueId: "100",
      })
    ).status,
    404,
  );
  assert.equal(links.length, 0);
});

test("an issue Jira does not have is not linked", async () => {
  const { request, links } = harness({
    client: {
      ok: true,
      client: {
        issue: () => Promise.reject(new JiraApiError(404, "gone")),
        issueSpec: () => Promise.reject(new JiraApiError(404, "gone")),
      } as never,
    },
  });
  const response = await request("PUT", "bounties/bty_7/jira", {
    boardId: "jrb_1",
    issueId: "100",
  });
  assert.equal(response.status, 404);
  assert.equal(links.length, 0);
});

test("a link without a board or an issue is refused", async () => {
  const { request } = harness();
  const response = await request("PUT", "bounties/bty_7/jira", {
    boardId: "jrb_1",
  });
  assert.equal(response.status, 400);
});

test("removing the link returns the bounty without one", async () => {
  const { request, unlinks } = harness();
  const response = await request("DELETE", "bounties/bty_7/jira");
  assert.equal(response.status, 200);
  const body = (await response.json()) as { bounty: { jira: unknown } };
  assert.equal(body.bounty.jira, null);
  assert.deepEqual(unlinks, ["bty_7"]);
});

test("an approved overview's Jira link is neither changed nor removed", async () => {
  const { request, links, unlinks } = harness({
    bounty: {
      approval: { version: 1, approvedBy: "user_1", approvedAt: stamp },
    },
  });
  for (const [method, body] of [
    ["PUT", { boardId: "jrb_1", issueId: "10009" }],
    ["DELETE", undefined],
  ] as const) {
    const response = await request(method, "bounties/bty_7/jira", body);
    assert.equal(response.status, 409);
    assert.equal(
      ((await response.json()) as { code: string }).code,
      "overview_approved",
    );
  }
  assert.deepEqual(links, []);
  assert.deepEqual(unlinks, []);
  // Removing the link of a bounty not found is not found.
  assert.equal(
    (await harness().request("DELETE", "bounties/bty_x/jira")).status,
    404,
  );
});
