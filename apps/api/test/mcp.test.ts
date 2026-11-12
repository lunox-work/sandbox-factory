import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  DEFAULT_WORKSPACE_SETTINGS,
  type RunCount,
  type WorkspaceSettingsStore,
} from "@sandbox-factory/db";
import { OAUTH_ACCESS_TOKEN_PREFIX } from "sandbox-factory";

import { generateSecret, hashSecret } from "../src/api-tokens/secret.js";
import { MCP_INSTRUCTIONS } from "../src/mcp/routes.js";
import { toolError, TOOLSETS } from "../src/mcp/tools.js";
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
      "list_repositories",
      "get_snapshot",
      "list_boards",
      "search_issues",
      "list_sandboxes",
      "get_sandbox",
      "get_run",
    ],
    "/mcp/duediligence": [
      "list_workspaces",
      "list_bounties",
      "get_bounty",
      "get_proposal",
      "get_run",
      "get_usage",
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
      assert.equal(tool.annotations?.readOnlyHint, true);
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
