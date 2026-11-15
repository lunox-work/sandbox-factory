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

import {
  generateContributorSecret,
  generateSecret,
  hashSecret,
} from "../src/api-tokens/secret.js";
import {
  challengeScope,
  CONTRIBUTOR_MCP_INSTRUCTIONS,
  MCP_INSTRUCTIONS,
} from "../src/mcp/routes.js";
import {
  CONTRIBUTOR_TOOLS,
  handoffCommands,
  registerTools,
  shellWord,
  toolError,
  TOOLS,
  TOOLSETS,
  toolsetScopes,
  type ApiCall,
  type ApiCallInit,
} from "../src/mcp/tools.js";
import { hashOAuthToken } from "../src/oauth/provider.js";
import { quotaExceededBody } from "../src/quota.js";
import { PUBLIC_ROUTES } from "../src/public-api/registry.js";
import { createApp } from "../src/routes.js";
import {
  ada,
  fakeAuth,
  memoryContributorTokens,
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
  const contributorTokens = memoryContributorTokens();
  const usageCalls: Array<{ organizationId: string }> = [];
  const server = createApp({
    corsOrigins: [],
    auth: fakeAuth(),
    organizations: roleStore({ [`${ada.id}:${ORG}`]: "owner" }),
    settings: { settings: settingsStore },
    apiTokens: tokens,
    oauthGrants: grants,
    contributorTokens,
    usage: {
      runCounts: (organizationId) => {
        usageCalls.push({ organizationId });
        return Promise.resolve(runCounts);
      },
      modelTokens: () =>
        Promise.resolve({
          inputTokens: 1_000,
          outputTokens: 500,
          cacheReadTokens: 8_000,
          cacheWriteTokens: 500,
        }),
      evaluator: () => Promise.resolve({ seconds: 90, jobs: 2, byKind: [] }),
      submissionsAndUploads: () =>
        Promise.resolve({
          gradingAttempts: 1,
          contributorGradingAttempts: 0,
          uploads: 0,
        }),
    },
    monthlyModelTokens: 50_000,
    publicUrl: BASE,
  });

  /** An OAuth access token for a grant in ORG (null: a contributor's) with `scopes`. */
  function oauth(
    scopes: string[],
    organizationId: string | null = ORG,
  ): string {
    const raw = randomBytes(24).toString("base64url");
    grants.issue({
      organizationId,
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

  /** Ada's own contributor token. */
  async function contributorToken() {
    const secret = generateContributorSecret();
    await contributorTokens.create(ada.id, {
      name: "Editor",
      prefix: secret.slice(0, 13),
      hash: hashSecret(secret),
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
    contributorToken,
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
  "plan_slice",
  "start_sandbox",
  "cut_slice",
  "prepare",
  "submit_patch",
  "judge",
  "retry",
  "regrade",
  "create_contributor_invite",
  "submit",
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
      "plan_slice",
      "start_sandbox",
      "cut_slice",
      "prepare",
      "get_handout",
      "get_project_files",
      "upload_handoff",
      "create_contributor_invite",
      "submit_patch",
      "judge",
      "retry",
      "regrade",
      "get_verdict",
      "get_submission_files",
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
      "respec",
      "get_decisions",
      "confirm_link",
      "list_sandboxes",
      "get_sandbox",
      "start_sandbox",
      "prepare",
      "get_handout",
      "get_project_files",
      "create_contributor_invite",
      "judge",
      "retry",
      "regrade",
      "get_verdict",
      "get_submission_files",
    ],
    "/mcp/carveout": [
      "list_workspaces",
      "get_usage",
      "list_bounties",
      "get_bounty",
      "get_proposal",
      "get_decisions",
      "confirm_link",
      "post_bounty",
      "import_github_issue",
      "import_jira_issue",
      "size_bounty",
      "list_repositories",
      "get_snapshot",
      "list_sandboxes",
      "get_sandbox",
      "get_run",
      "plan_slice",
      "start_sandbox",
      "cut_slice",
      "prepare",
      "upload_handoff",
      "get_handout",
      "get_project_files",
      "create_contributor_invite",
      "submit_patch",
      "judge",
      "retry",
      "regrade",
      "get_verdict",
      "get_submission_files",
    ],
    "/mcp/contribute": [
      "list_contributions",
      "get_contribution",
      "get_project_files",
      "preview_submission",
      "submit",
      "list_my_submissions",
      "get_my_submission",
      "retry",
      "regrade",
    ],
  };
  assert.deepEqual(Object.keys(TOOLSETS), Object.keys(expected));
  assert.deepEqual(
    [...(TOOLSETS["/mcp"] ?? [])].sort(),
    TOOLS.map((entry) => entry.name).sort(),
  );
  assert.deepEqual(
    [...(TOOLSETS["/mcp/contribute"] ?? [])].sort(),
    CONTRIBUTOR_TOOLS.map((entry) => entry.name).sort(),
  );
  for (const [path, names] of Object.entries(expected)) {
    // Listing reaches no route: any valid credential lists any toolset.
    const client = await connect(path, token);
    assert.equal(
      client.getInstructions(),
      path === "/mcp/contribute"
        ? CONTRIBUTOR_MCP_INSTRUCTIONS
        : MCP_INSTRUCTIONS,
    );
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

/** What signing in at each endpoint asks for: every scope its tools need. */
const SIGN_IN_SCOPES: Record<string, string> = {
  "/mcp":
    "workspace:read integrations:write bounties:write pricing:write specs:write sandboxes:write submissions:write offline_access",
  "/mcp/duediligence":
    "workspace:read bounties:write pricing:write specs:write sandboxes:write submissions:write offline_access",
  "/mcp/carveout":
    "workspace:read bounties:write pricing:write sandboxes:write submissions:write offline_access",
  "/mcp/contribute": "contributions:write offline_access",
};

test("each endpoint asks for the scopes its tools need", () => {
  for (const [path, scope] of Object.entries(SIGN_IN_SCOPES)) {
    assert.equal(challengeScope(path), scope, path);
    assert.deepEqual(
      [...toolsetScopes(path), "offline_access"],
      scope.split(" "),
      path,
    );
  }
});

test("each tool declares the scope and audience of the public route it calls", () => {
  // Every argument a route is built from reads as "x"; the query is dropped.
  const args = new Proxy({}, { get: () => "x" }) as Record<string, unknown>;
  const pattern = (route: string) =>
    new RegExp(`^${route.replace(/:[A-Za-z]+/g, "[^/]+")}$`);
  for (const entry of [...TOOLS, ...CONTRIBUTOR_TOOLS]) {
    const path = entry.route(args, "org_x").split("?")[0] ?? "";
    const declared = PUBLIC_ROUTES.find(
      (route) =>
        route.method === entry.method && pattern(route.path).test(path),
    );
    assert.ok(declared, `${entry.name}: ${entry.method} ${path}`);
    assert.equal(entry.scope, declared.scope, entry.name);
    assert.equal(
      entry.audience,
      declared.audience ?? "workspace",
      `${entry.name}: ${path}`,
    );
  }
  for (const entry of TOOLS) assert.equal(entry.audience, "workspace");
  for (const entry of CONTRIBUTOR_TOOLS)
    assert.equal(entry.audience, "contributor");
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
    modelTokens: { used: number; limit: number; remaining: number };
    evaluatorSeconds: { used: number };
  };
  assert.equal(parsed.window.days, 7);
  assert.equal(parsed.evaluatorSeconds.used, 90);
  assert.equal(parsed.runs[0]?.count, 2);
  // This month's model tokens, against the workspace's monthly limit.
  assert.equal(parsed.modelTokens.used, 10_000);
  assert.equal(parsed.modelTokens.limit, 50_000);
  assert.equal(parsed.modelTokens.remaining, 40_000);
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
    hint: "Sign in to this MCP server again (in Claude Code: /mcp, then re-authenticate) and keep this scope ticked on the consent page.",
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
  for (const path of [
    "/mcp",
    "/mcp/duediligence",
    "/mcp/carveout",
    "/mcp/contribute",
  ]) {
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
      `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource${path}", scope="${SIGN_IN_SCOPES[path]}"`,
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

test("a run refused at the monthly token limit is a tool error saying so and when it resets", async () => {
  const refusal = quotaExceededBody({
    used: 10_000_250,
    limit: 10_000_000,
    resetsAt: new Date("2026-12-01T00:00:00.000Z"),
  });
  const { client } = await overFakeApi(() => ({ status: 429, body: refusal }));
  for (const [name, args] of [
    ["size_bounty", { bountyId: "bty_1" }],
    ["prepare", { versionId: "sbv_1" }],
  ] as const) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, name);
    const error = JSON.parse(textOf(result)) as {
      error: string;
      code: string;
      status: number;
    };
    assert.equal(error.code, "quota_exceeded", name);
    assert.equal(error.status, 429, name);
    assert.match(error.error, /monthly model-token limit/, name);
    assert.match(error.error, /2026-12-01T00:00:00\.000Z/, name);
  }
  await client.close();
});

/** The tools over a fake API that records each call and answers `reply`. */
async function overFakeApi(
  reply: (path: string, init: ApiCallInit) => { status: number; body: unknown },
  path = "/mcp",
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
  registerTools(server, path, call, { baseUrl: BASE });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientSide);
  const routed = () =>
    calls.filter((entry) => entry.path !== "/api/v1/me/orgs");
  return { client, routed, calls };
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

test("slice, sandbox, prepare and handout tools call their one route each", async () => {
  const { client, routed } = await overFakeApi(() => ({
    status: 202,
    body: { ok: true },
  }));
  const cases: Array<{
    name: string;
    arguments: Record<string, unknown>;
    path: string;
    method?: string;
    body?: unknown;
  }> = [
    {
      name: "plan_slice",
      arguments: {
        repositoryId: "ghr_1",
        entryPoints: ["src/b.ts", "src/a.ts", "src/a.ts"],
      },
      path: `/api/v1/orgs/${ORG}/github/repositories/ghr_1/slices`,
      method: "POST",
      body: { entryPoints: ["src/a.ts", "src/b.ts"] },
    },
    {
      name: "plan_slice",
      arguments: {
        repositoryId: "ghr_1",
        entryPoints: ["src/a.ts"],
        maxDepth: 1,
      },
      path: `/api/v1/orgs/${ORG}/github/repositories/ghr_1/slices`,
      method: "POST",
      body: {
        entryPoints: ["src/a.ts"],
        budget: { maxFiles: 40, maxDepth: 1 },
      },
    },
    {
      name: "plan_slice",
      arguments: {
        repositoryId: "ghr_1",
        entryPoints: ["src/a.ts"],
        carryTests: false,
      },
      path: `/api/v1/orgs/${ORG}/github/repositories/ghr_1/slices`,
      method: "POST",
      body: { entryPoints: ["src/a.ts"], carryTests: false },
    },
    {
      name: "start_sandbox",
      arguments: { bountyId: "bty_1" },
      path: `/api/v1/orgs/${ORG}/sandboxes/start`,
      method: "POST",
      body: { bountyId: "bty_1" },
    },
    {
      name: "cut_slice",
      arguments: {
        sandboxId: "sbx_1",
        sliceRunId: "arn_1",
        proposalId: "bpr_1",
        title: "Retry payouts",
        specSummary: "Retry failed payouts.",
        complexity: "M",
      },
      path: `/api/v1/orgs/${ORG}/sandboxes/sbx_1/versions`,
      method: "POST",
      body: {
        sliceRunId: "arn_1",
        proposalId: "bpr_1",
        title: "Retry payouts",
        specSummary: "Retry failed payouts.",
        complexity: "M",
      },
    },
    {
      name: "prepare",
      arguments: { versionId: "sbv_1" },
      path: `/api/v1/orgs/${ORG}/sandboxes/versions/sbv_1/build`,
      method: "POST",
    },
    {
      name: "get_handout",
      arguments: { versionId: "sbv_1" },
      path: `/api/v1/orgs/${ORG}/sandboxes/versions/sbv_1/handout`,
    },
    {
      name: "get_project_files",
      arguments: { versionId: "sbv_1" },
      path: `/api/v1/orgs/${ORG}/sandboxes/versions/sbv_1/handout/files`,
    },
    {
      name: "get_project_files",
      arguments: { versionId: "sbv_1", cursor: "abc.2", maxBytes: 5_000 },
      path: `/api/v1/orgs/${ORG}/sandboxes/versions/sbv_1/handout/files?cursor=abc.2&maxBytes=5000`,
    },
    ...(["submit_patch", "judge"] as const).map((name) => ({
      name,
      arguments: {
        versionId: "sbv_1",
        files: [{ path: "src/a.ts", text: "a" }],
      },
      path: `/api/v1/orgs/${ORG}/sandboxes/versions/sbv_1/submissions`,
      method: "POST",
      body: { files: [{ path: "src/a.ts", text: "a" }] },
    })),
    {
      name: "get_verdict",
      arguments: { submissionId: "sbm_1" },
      path: `/api/v1/orgs/${ORG}/sandboxes/submissions/sbm_1`,
    },
  ];
  for (const [index, entry] of cases.entries()) {
    const result = await client.callTool({
      name: entry.name,
      arguments: entry.arguments,
    });
    assert.notEqual(result.isError, true, entry.name);
    const sent = routed()[index];
    assert.equal(sent?.path, entry.path, entry.name);
    assert.equal(sent?.init.method, entry.method, entry.name);
    if (entry.body !== undefined)
      assert.deepEqual(sent?.init.body, entry.body, entry.name);
  }
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

test("upload_handoff checks the bounty and answers the carveout commands, sending no folder", async () => {
  const { client, routed } = await overFakeApi(() => ({
    status: 200,
    body: { bounty: { id: "bty_1" } },
  }));
  const result = await client.callTool({
    name: "upload_handoff",
    arguments: {
      bountyId: "bty_1",
      entryPoints: ["src/fees.ts", "src/fees.ts"],
      accept: ["tests/fee minimum.test.ts"],
      title: "Statement fees",
    },
  });
  assert.notEqual(result.isError, true);
  // One read: the bounty, in the credential's workspace.
  assert.deepEqual(
    routed().map(({ path, init }) => [path, init.method]),
    [[`/api/v1/orgs/${ORG}/bounties/bty_1`, undefined]],
  );
  const lines = textOf(result).split("\n");
  assert.ok(
    lines.includes(
      `npx -y carveout@latest login --platform ${BASE} --org ${ORG}`,
    ),
    textOf(result),
  );
  assert.ok(
    lines.includes(
      `npx -y carveout@latest handoff src/fees.ts --out handoff --accept 'tests/fee minimum.test.ts' --platform ${BASE} --bounty bty_1 --title 'Statement fees'`,
    ),
    textOf(result),
  );
  assert.match(textOf(result), /receipt stays on this machine/);
  // A bounty the workspace does not hold: the API's refusal, no command.
  const { client: missing } = await overFakeApi(() => ({
    status: 404,
    body: { error: "Not found." },
  }));
  const refused = await missing.callTool({
    name: "upload_handoff",
    arguments: {
      bountyId: "bty_9",
      entryPoints: ["a.ts"],
      accept: ["a.test.ts"],
    },
  });
  assert.equal(refused.isError, true);
  assert.doesNotMatch(textOf(refused), /carveout/);
  await client.close();
  await missing.close();
});

test("handoff commands quote what a shell would split", () => {
  assert.equal(shellWord("src/a.ts"), "src/a.ts");
  assert.equal(shellWord("it's"), `'it'\\''s'`);
  assert.deepEqual(
    handoffCommands({
      platform: "https://platform.lunox.work",
      organizationId: "org_1",
      bountyId: "bty_1",
      entryPoints: ["src/a.ts"],
      accept: ["tests/a.test.ts"],
      out: "out dir",
      task: "TASK.md",
    }),
    [
      "npx -y carveout@latest login --platform https://platform.lunox.work --org org_1",
      "npx -y carveout@latest handoff src/a.ts --out 'out dir' --task TASK.md --accept tests/a.test.ts --platform https://platform.lunox.work --bounty bty_1",
    ],
  );
});

test("invite, regrade and take-back tools call their one route each", async () => {
  const { client, routed } = await overFakeApi(() => ({
    status: 201,
    body: { ok: true },
  }));
  const cases: Array<{
    name: string;
    arguments: Record<string, unknown>;
    path: string;
    method?: string;
    body?: unknown;
  }> = [
    {
      name: "create_contributor_invite",
      arguments: { versionId: "sbv_1", label: "Grace", maxClaims: 2 },
      path: `/api/v1/orgs/${ORG}/sandboxes/versions/sbv_1/invites`,
      method: "POST",
      body: { label: "Grace", maxClaims: 2 },
    },
    {
      name: "regrade",
      arguments: { submissionId: "sbm_1" },
      path: `/api/v1/orgs/${ORG}/sandboxes/submissions/sbm_1/regrade`,
      method: "POST",
    },
    {
      name: "get_submission_files",
      arguments: { submissionId: "sbm_1" },
      path: `/api/v1/orgs/${ORG}/sandboxes/submissions/sbm_1/files`,
    },
  ];
  for (const [index, entry] of cases.entries()) {
    const result = await client.callTool({
      name: entry.name,
      arguments: entry.arguments,
    });
    assert.notEqual(result.isError, true, entry.name);
    const sent = routed()[index];
    assert.equal(sent?.path, entry.path, entry.name);
    assert.equal(sent?.init.method, entry.method, entry.name);
    if (entry.body !== undefined)
      assert.deepEqual(sent?.init.body, entry.body, entry.name);
  }
  await client.close();
});

test("contributor tools call their own routes, naming no workspace", async () => {
  const { client, calls } = await overFakeApi(
    () => ({ status: 202, body: { ok: true } }),
    "/mcp/contribute",
  );
  const files = [{ path: "src/fees.ts", text: "export const fee = () => 25;" }];
  const C = "/api/v1/contributions/sbv_1";
  const cases: Array<{
    name: string;
    arguments: Record<string, unknown>;
    path: string;
    method?: string;
    body?: unknown;
  }> = [
    {
      name: "list_contributions",
      arguments: {},
      path: "/api/v1/contributions",
    },
    { name: "get_contribution", arguments: { versionId: "sbv_1" }, path: C },
    {
      name: "get_project_files",
      arguments: { versionId: "sbv_1", cursor: "c.2", maxBytes: 5_000 },
      path: `${C}/handout/files?cursor=c.2&maxBytes=5000`,
    },
    {
      name: "preview_submission",
      arguments: { versionId: "sbv_1", files },
      path: `${C}/submissions?dryRun=1`,
      method: "POST",
      body: { files },
    },
    {
      name: "preview_submission",
      arguments: { versionId: "sbv_1", files, retryOf: "sbm_1" },
      path: `${C}/submissions/sbm_1/retry?dryRun=1`,
      method: "POST",
      body: { files },
    },
    {
      name: "submit",
      arguments: { versionId: "sbv_1", files },
      path: `${C}/submissions`,
      method: "POST",
      body: { files },
    },
    {
      name: "list_my_submissions",
      arguments: { versionId: "sbv_1" },
      path: `${C}/submissions`,
    },
    {
      name: "get_my_submission",
      arguments: { versionId: "sbv_1", submissionId: "sbm_1" },
      path: `${C}/submissions/sbm_1`,
    },
    {
      name: "retry",
      arguments: { versionId: "sbv_1", submissionId: "sbm_1", files },
      path: `${C}/submissions/sbm_1/retry`,
      method: "POST",
      body: { files },
    },
    {
      name: "regrade",
      arguments: { versionId: "sbv_1", submissionId: "sbm_1" },
      path: `${C}/submissions/sbm_1/regrade`,
      method: "POST",
    },
  ];
  for (const [index, entry] of cases.entries()) {
    const result = await client.callTool({
      name: entry.name,
      arguments: entry.arguments,
    });
    assert.notEqual(result.isError, true, entry.name);
    const sent = calls[index];
    assert.equal(sent?.path, entry.path, entry.name);
    assert.equal(sent?.init.method, entry.method, entry.name);
    if (entry.body !== undefined)
      assert.deepEqual(sent?.init.body, entry.body, entry.name);
  }
  // Never the workspace lookup: a contributor credential has none.
  assert.equal(calls.length, cases.length);
  // The rules ride in the descriptions an agent reads.
  const { tools } = await client.listTools();
  const submit = tools.find((tool) => tool.name === "submit");
  assert.match(submit?.description ?? "", /one retry/);
  assert.match(submit?.description ?? "", /not spent/);
  assert.match(submit?.description ?? "", /never change tests\//);
  assert.match(submit?.description ?? "", /submissions\/zip/);
  const preview = tools.find((tool) => tool.name === "preview_submission");
  assert.equal(preview?.annotations?.readOnlyHint, true);
  await client.close();
});

test("a contributor token signs in at /mcp/contribute and reaches no workspace tool", async () => {
  const { request, contributorToken, connect, apiToken, oauth } = setup();
  const secret = await contributorToken();
  // Valid, so no challenge: the endpoint lists its tools.
  const own = await connect("/mcp/contribute", secret);
  const { tools } = await own.listTools();
  assert.ok(tools.some((tool) => tool.name === "submit"));
  await own.close();
  // At a workspace endpoint, each tool's call is refused by the guard.
  const elsewhere = await connect("/mcp", secret);
  const workspaces = await elsewhere.callTool({
    name: "list_workspaces",
    arguments: {},
  });
  assert.equal(workspaces.isError, true);
  assert.equal(
    (JSON.parse(textOf(workspaces)) as { code: string }).code,
    "contributor_credential",
  );
  await elsewhere.close();
  // A contributor OAuth grant is the same kind of credential.
  const granted = await connect(
    "/mcp/carveout",
    oauth(["contributions:write", "offline_access"], null),
  );
  const bounties = await granted.callTool({
    name: "list_bounties",
    arguments: {},
  });
  assert.equal(
    (JSON.parse(textOf(bounties)) as { code: string }).code,
    "contributor_credential",
  );
  await granted.close();
  // A workspace token at the contributor endpoint: no contribution answers it.
  const workspace = await connect(
    "/mcp/contribute",
    await apiToken(["workspace:read"]),
  );
  const listed = await workspace.callTool({
    name: "list_contributions",
    arguments: {},
  });
  assert.equal(listed.isError, true);
  await workspace.close();
  // An unknown lnxc_ value is a 401 that says where to sign in again.
  const res = await request("/mcp/contribute", {
    method: "POST",
    headers: {
      authorization: `Bearer ${generateContributorSecret()}`,
      "content-type": "application/json",
    },
    body: "{}",
  });
  assert.equal(res.status, 401);
  assert.match(
    res.headers.get("www-authenticate") ?? "",
    /oauth-protected-resource\/mcp\/contribute", scope="contributions:write offline_access", error="invalid_token"/,
  );
});
