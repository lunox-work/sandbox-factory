import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  DEFAULT_WORKSPACE_SETTINGS,
  type RunCount,
  type WorkspaceSettingsStore,
} from "@sandbox-factory/db";
import { OAUTH_ACCESS_TOKEN_PREFIX } from "sandbox-factory";

import { generateSecret, hashSecret } from "../src/api-tokens/secret.js";
import { MCP_INSTRUCTIONS } from "../src/mcp/routes.js";
import {
  registerTools,
  toolError,
  TOOLSETS,
  type ApiCall,
  type ApiCallInit,
} from "../src/mcp/tools.js";
import { hashOAuthToken } from "../src/oauth/provider.js";
import { createApp } from "../src/routes.js";
import {
  ada,
  fakeAuth,
  memoryGrants,
  memoryTokens,
  ORG,
  roleStore,
} from "./token-fakes.js";

/**
 * The MCP server through the SDK's own client, over an in-process fetch
 * against the app: sign-in challenges, the toolsets, and tools that call
 * the public API as the caller and pass its refusals through.
 */

const BASE = "http://localhost:4000";

const settingsStore: WorkspaceSettingsStore = {
  get: () => Promise.resolve(DEFAULT_WORKSPACE_SETTINGS),
  update: (_owner, change) =>
    Promise.resolve({ ...DEFAULT_WORKSPACE_SETTINGS, ...change }),
};

function setup(runCounts: RunCount[] = []) {
  const tokens = memoryTokens();
  const grants = memoryGrants();
  const usageCalls: Array<{ organizationId: string }> = [];
  const server = createApp({
    corsOrigins: [],
    auth: fakeAuth(),
    organizations: roleStore({ [`${ada.id}:${ORG}`]: "owner" }),
    settings: { settings: settingsStore },
    apiTokens: tokens,
    oauthGrants: grants,
    usage: {
      runCounts: (organizationId) => {
        usageCalls.push({ organizationId });
        return Promise.resolve(runCounts);
      },
    },
    publicUrl: BASE,
  });

  /** An OAuth access token for a grant in ORG with `scopes`. */
  function oauth(scopes: string[]): string {
    const raw = randomBytes(24).toString("base64url");
    grants.issue({
      organizationId: ORG,
      scopes,
      hash: hashOAuthToken(raw),
      expiresAt: new Date(Date.now() + 15 * 60_000),
    });
    return `${OAUTH_ACCESS_TOKEN_PREFIX}${raw}`;
  }

  /** A workspace API token in ORG with `scopes`. */
  async function apiToken(scopes: Array<"workspace:read" | "bounties:write">) {
    const secret = generateSecret();
    await tokens.create(ORG, {
      createdBy: ada.id,
      name: "MCP",
      prefix: secret.slice(0, 12),
      hash: hashSecret(secret),
      scopes,
      expiresAt: null,
    });
    return secret;
  }

  async function connect(path: string, bearer: string) {
    const client = new Client({ name: "test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`${BASE}${path}`),
      {
        requestInit: { headers: { authorization: `Bearer ${bearer}` } },
        fetch: (url, init) =>
          Promise.resolve(server.request(String(url), init)),
      },
    );
    await client.connect(transport);
    return client;
  }

  return {
    request: (path: string, init: RequestInit = {}) =>
      server.request(path, init),
    oauth,
    apiToken,
    connect,
    usageCalls,
  };
}

const WRITE_TOOLS = new Set([
  "post_bounty",
  "import_github_issue",
  "import_jira_issue",
  "size_bounty",
  "respec",
]);

function textOf(result: unknown): string {
  const [first] = (result as { content: Array<{ text: string }> }).content;
  return first?.text ?? "";
}

test("each endpoint lists exactly its toolset", async () => {
  const { oauth, connect } = setup();
  const token = oauth(["workspace:read", "offline_access"]);
  const expected: Record<string, string[]> = {
    "/mcp": [
      "list_workspaces",
      "get_usage",
      "list_bounties",
      "get_bounty",
      "get_proposal",
      "get_decisions",
      "confirm_link",
      "list_repositories",
      "get_snapshot",
      "list_boards",
      "search_issues",
      "list_sandboxes",
      "get_sandbox",
      "get_run",
      "post_bounty",
      "import_github_issue",
      "import_jira_issue",
      "size_bounty",
      "respec",
      "connect_github",
      "connect_jira",
    ],
    "/mcp/duediligence": [
      "list_workspaces",
      "list_bounties",
      "get_bounty",
      "get_proposal",
      "get_run",
      "get_usage",
      "post_bounty",
      "import_github_issue",
      "import_jira_issue",
      "size_bounty",
      "get_decisions",
      "confirm_link",
    ],
    "/mcp/carveout": [
      "list_workspaces",
      "list_repositories",
      "get_snapshot",
      "list_sandboxes",
      "get_sandbox",
      "get_run",
    ],
  };
  assert.deepEqual(Object.keys(TOOLSETS), Object.keys(expected));
  for (const [path, names] of Object.entries(expected)) {
    const client = await connect(path, token);
    assert.equal(client.getInstructions(), MCP_INSTRUCTIONS);
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      [...names].sort(),
      path,
    );
    for (const tool of tools) {
      assert.ok((tool.description ?? "").length > 20, tool.name);
      assert.equal(tool.inputSchema.type, "object");
      // Posting work writes; everything else, connect links too, reads.
      assert.equal(
        tool.annotations?.readOnlyHint,
        !WRITE_TOOLS.has(tool.name),
        tool.name,
      );
      if (WRITE_TOOLS.has(tool.name))
        assert.equal(tool.annotations?.destructiveHint, false, tool.name);
    }
    await client.close();
  }
});

test("a tool answers the route's data, in the credential's workspace", async () => {
  const { oauth, connect, usageCalls } = setup([
    { family: "analysis", kind: "graphify", status: "succeeded", count: 2 },
  ]);
  const client = await connect("/mcp", oauth(["workspace:read"]));
  const workspaces = await client.callTool({
    name: "list_workspaces",
    arguments: {},
  });
  assert.equal(workspaces.isError, undefined);
  assert.deepEqual(
    (
      JSON.parse(textOf(workspaces)) as { organizations: Array<{ id: string }> }
    ).organizations.map(({ id }) => id),
    [ORG],
  );
  const usage = await client.callTool({
    name: "get_usage",
    arguments: { days: 7 },
  });
  assert.equal(usage.isError, undefined);
  const parsed = JSON.parse(textOf(usage)) as {
    window: { days: number };
    runs: Array<{ count: number }>;
  };
  assert.equal(parsed.window.days, 7);
  assert.equal(parsed.runs[0]?.count, 2);
  assert.deepEqual(usageCalls, [{ organizationId: ORG }]);
  await client.close();
});

test("a workspace API token works the same way", async () => {
  const { apiToken, connect } = setup();
  const client = await connect(
    "/mcp/duediligence",
    await apiToken(["workspace:read"]),
  );
  const result = await client.callTool({ name: "get_usage", arguments: {} });
  assert.equal(result.isError, undefined);
  await client.close();
});

test("a missing scope is a tool error carrying the API's code", async () => {
  const { apiToken, connect } = setup();
  const client = await connect("/mcp", await apiToken(["bounties:write"]));
  const result = await client.callTool({
    name: "list_workspaces",
    arguments: {},
  });
  assert.equal(result.isError, true);
  assert.deepEqual(JSON.parse(textOf(result)), {
    error: "This credential lacks the workspace:read scope.",
    code: "insufficient_scope",
    status: 403,
  });
  await client.close();
});

test("an unmounted route is a tool error too, never a crash", async () => {
  const { oauth, connect } = setup();
  const client = await connect("/mcp", oauth(["workspace:read"]));
  // No sandbox routes in this app: the guard refuses what it cannot match.
  const result = await client.callTool({
    name: "get_sandbox",
    arguments: { sandboxId: "sbx_1" },
  });
  assert.equal(result.isError, true);
  assert.equal(
    (JSON.parse(textOf(result)) as { code: string }).code,
    "not_public",
  );
  const listed = await client.callTool({
    name: "list_bounties",
    arguments: { status: "priced", cursor: "c" },
  });
  assert.equal(listed.isError, true);
  await client.close();
});

test("no credential is a 401 that says where to sign in", async () => {
  const { request } = setup();
  for (const path of ["/mcp", "/mcp/duediligence", "/mcp/carveout"]) {
    const res = await request(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    assert.equal(res.status, 401, path);
    assert.equal(
      res.headers.get("www-authenticate"),
      `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource${path}", scope="workspace:read offline_access"`,
    );
  }
  // A session cookie is not a credential here.
  const cookie = await request("/mcp", {
    method: "POST",
    headers: { cookie: "better-auth.session_token=test-token" },
  });
  assert.equal(cookie.status, 401);
});

test("a token the API refuses is a 401 asking for a new one", async () => {
  const { request } = setup();
  const res = await request("/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${OAUTH_ACCESS_TOKEN_PREFIX}expired`,
      "content-type": "application/json",
    },
    body: "{}",
  });
  assert.equal(res.status, 401);
  assert.match(
    res.headers.get("www-authenticate") ?? "",
    /error="invalid_token"/,
  );
});

test("GET and DELETE answer 405: there is no stream or session", async () => {
  const { request } = setup();
  for (const method of ["GET", "DELETE"]) {
    const res = await request("/mcp/carveout", { method });
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.get("allow"), "POST");
  }
});

test("a refusal without a code is named by its status", () => {
  assert.deepEqual(JSON.parse(textOf(toolError(404, { error: "Not found" }))), {
    error: "Not found",
    code: "not_found",
    status: 404,
  });
  assert.deepEqual(JSON.parse(textOf(toolError(500, null))), {
    error: "The API answered 500.",
    code: "http_500",
    status: 500,
  });
});

/** The tools over a fake API that records each call and answers `reply`. */
async function overFakeApi(
  reply: (path: string, init: ApiCallInit) => { status: number; body: unknown },
) {
  const calls: Array<{ path: string; init: ApiCallInit }> = [];
  const call: ApiCall = (path, init = {}) => {
    calls.push({ path, init });
    if (path === "/api/v1/me/orgs")
      return Promise.resolve({
        status: 200,
        body: { organizations: [{ id: ORG }] },
      });
    return Promise.resolve(reply(path, init));
  };
  const server = new McpServer({ name: "lunox", version: "1.0.0" });
  registerTools(server, TOOLSETS["/mcp"] ?? [], call);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientSide);
  const routed = () => calls.filter(({ path }) => path !== "/api/v1/me/orgs");
  return { client, routed };
}

test("each write tool posts to its one route, in the credential's workspace", async () => {
  const { client, routed } = await overFakeApi(() => ({
    status: 201,
    body: { bounty: { id: "bty_1" } },
  }));
  const cases: Array<{
    name: string;
    arguments: Record<string, unknown>;
    path: string;
    body: (sent: Record<string, unknown>) => void;
  }> = [
    {
      name: "post_bounty",
      arguments: { title: "Retry failed payouts", description: "Steps" },
      path: `/api/v1/orgs/${ORG}/bounties`,
      body: (sent) =>
        assert.deepEqual(sent, {
          title: "Retry failed payouts",
          description: "Steps",
        }),
    },
    {
      name: "import_github_issue",
      arguments: { url: "https://github.com/acme/app/issues/12" },
      path: `/api/v1/orgs/${ORG}/bounties`,
      body: (sent) =>
        assert.deepEqual(sent, {
          source: { githubIssue: "https://github.com/acme/app/issues/12" },
        }),
    },
    {
      name: "import_jira_issue",
      arguments: { boardId: "jrb_1", issueId: "10042" },
      path: `/api/v1/orgs/${ORG}/jira/boards/jrb_1/import`,
      body: (sent) => assert.deepEqual(sent, { issueId: "10042" }),
    },
    {
      name: "size_bounty",
      arguments: { bountyId: "bty_1" },
      path: `/api/v1/orgs/${ORG}/bounties/bty_1/propose`,
      body: (sent) =>
        assert.match(String(sent["requestId"]), /^[0-9a-f-]{36}$/),
    },
    {
      name: "respec",
      arguments: {
        proposalId: "bpr_1",
        expectedRevision: 3,
        request: { mode: "expand", instruction: "Cover refunds." },
      },
      path: `/api/v1/orgs/${ORG}/proposals/bpr_1/respec`,
      body: (sent) => {
        assert.equal(sent["expectedRevision"], 3);
        assert.deepEqual(sent["request"], {
          mode: "expand",
          instruction: "Cover refunds.",
        });
        assert.match(String(sent["requestId"]), /^[0-9a-f-]{36}$/);
      },
    },
  ];
  for (const each of cases) {
    const result = await client.callTool({
      name: each.name,
      arguments: each.arguments,
    });
    assert.equal(result.isError, undefined, each.name);
    const sent = routed().at(-1);
    assert.equal(sent?.path, each.path, each.name);
    assert.equal(sent?.init.method, "POST", each.name);
    each.body(sent?.init.body as Record<string, unknown>);
  }
  await client.close();
});

test("a write the API refuses is a tool error with its code", async () => {
  const { client } = await overFakeApi(() => ({
    status: 403,
    body: {
      error: "This credential lacks the bounties:write scope.",
      code: "insufficient_scope",
    },
  }));
  const result = await client.callTool({
    name: "post_bounty",
    arguments: { title: "x" },
  });
  assert.equal(result.isError, true);
  assert.equal(
    (JSON.parse(textOf(result)) as { code: string }).code,
    "insufficient_scope",
  );
  await client.close();
});

test("connect tools ask for JSON and answer the link with what to do", async () => {
  const { client, routed } = await overFakeApi((path) => ({
    status: 200,
    body: path.endsWith("/github/connect")
      ? { url: "https://github.com/login/oauth/authorize?x=1" }
      : { other: true },
  }));
  const github = await client.callTool({
    name: "connect_github",
    arguments: {},
  });
  assert.match(
    textOf(github),
    /^To connect GitHub, open this link in a browser while signed in to Lunox.*https:\/\/github\.com\/login\/oauth\/authorize\?x=1$/,
  );
  const sent = routed()[0];
  assert.equal(sent?.path, `/api/v1/orgs/${ORG}/github/connect`);
  assert.equal(sent?.init.accept, "application/json");
  assert.equal(sent?.init.method, undefined);
  // No link in the answer is an error, not a sentence without one.
  const jira = await client.callTool({ name: "connect_jira", arguments: {} });
  assert.equal(jira.isError, true);
  await client.close();
});

test("decisions are read by a tool, and confirm_link hands the person the page, never confirming", async () => {
  let reply: unknown = {
    decisions: [{ key: "d1", text: "Retries stop after three." }],
    confirmation: null,
    confirmUrl: "https://app.test/bounties/acme/bty_1?tab=price#decisions",
  };
  const { client, routed } = await overFakeApi(() => ({
    status: 200,
    body: reply,
  }));
  const read = await client.callTool({
    name: "get_decisions",
    arguments: { proposalId: "bpr_1" },
  });
  assert.match(textOf(read), /Retries stop after three/);
  assert.equal(
    routed()[0]?.path,
    `/api/v1/orgs/${ORG}/proposals/bpr_1/decisions`,
  );
  const link = await client.callTool({
    name: "confirm_link",
    arguments: { proposalId: "bpr_1" },
  });
  assert.match(textOf(link), /^Ask the person to open this link.*#decisions$/);
  // Every call only read.
  assert.ok(routed().every(({ init }) => init.method === undefined));
  reply = { ...(reply as object), confirmation: { confirmedBy: "user_1" } };
  assert.match(
    textOf(
      await client.callTool({
        name: "confirm_link",
        arguments: { proposalId: "bpr_1" },
      }),
    ),
    /already confirmed/,
  );
  reply = {
    decisions: [],
    confirmation: null,
    confirmUrl: "https://app.test/x",
  };
  assert.match(
    textOf(
      await client.callTool({
        name: "confirm_link",
        arguments: { proposalId: "bpr_1" },
      }),
    ),
    /no decisions to confirm/,
  );
  reply = { decisions: [] };
  const broken = await client.callTool({
    name: "confirm_link",
    arguments: { proposalId: "bpr_1" },
  });
  assert.equal(broken.isError, true);
  await client.close();
});

test("a write tool calls the API in-process with its method, body and Accept", async () => {
  const { apiToken, connect } = setup();
  const client = await connect(
    "/mcp/duediligence",
    await apiToken(["workspace:read", "bounties:write"]),
  );
  // No bounty routes in this app: the guard refuses the POST it cannot match.
  const posted = await client.callTool({
    name: "post_bounty",
    arguments: { title: "Retry failed payouts", stack: ["PostgreSQL"] },
  });
  assert.equal(posted.isError, true);
  assert.equal(
    (JSON.parse(textOf(posted)) as { code: string }).code,
    "not_public",
  );
  await client.close();
  const all = await connect("/mcp", await apiToken(["workspace:read"]));
  const link = await all.callTool({ name: "connect_github", arguments: {} });
  assert.equal(link.isError, true);
  await all.close();
});
