import assert from "node:assert/strict";
import { test } from "node:test";

import { ApiError, DeveloperClient } from "../src/index.js";

const at = "2026-11-01T00:00:00.000Z";
const token = {
  id: "tok_1",
  name: "CI",
  prefix: "lnx_ab12cd",
  scopes: ["workspace:read"],
  createdBy: { id: "user_1", name: "Ada Lovelace" },
  createdAt: at,
  expiresAt: null,
  lastUsedAt: null,
  revokedAt: null,
};
const grant = {
  id: "grt_1",
  client: { id: "client_1", name: "Claude Code" },
  user: { id: "user_1", name: "Ada Lovelace" },
  scopes: ["workspace:read", "offline_access"],
  createdAt: at,
  updatedAt: at,
  lastUsedAt: null,
};

/** A client answering each request with `answer(url, init)`, recording them. */
function fake(answer: (url: string, init?: RequestInit) => unknown) {
  const asked: Array<{ url: string; method: string; body?: unknown }> = [];
  const client = new DeveloperClient({
    baseUrl: "",
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      asked.push({
        url,
        method: init?.method ?? "GET",
        ...(typeof init?.body === "string"
          ? { body: JSON.parse(init.body) as unknown }
          : {}),
      });
      const body = answer(url, init);
      return body instanceof Response ? body : Response.json(body);
    }) as typeof fetch,
  });
  return { client, asked };
}

test("tokens are listed, made and revoked under the workspace", async () => {
  const { client, asked } = fake((url, init) =>
    init?.method === "POST" && url.endsWith("/tokens")
      ? { token, secret: "lnx_secret" }
      : url.endsWith("/revoke")
        ? { token: { ...token, revokedAt: at } }
        : { tokens: [token] },
  );
  assert.deepEqual(await client.tokens("org /1"), [token]);
  const created = await client.createToken("org /1", {
    name: "CI",
    scopes: ["workspace:read"],
    expiresInDays: 30,
  });
  assert.equal(created.secret, "lnx_secret");
  const revoked = await client.revokeToken("org /1", "tok /1");
  assert.equal(revoked.revokedAt, at);
  assert.deepEqual(asked, [
    { url: "/api/v1/orgs/org%20%2F1/tokens", method: "GET" },
    {
      url: "/api/v1/orgs/org%20%2F1/tokens",
      method: "POST",
      body: { name: "CI", scopes: ["workspace:read"], expiresInDays: 30 },
    },
    {
      url: "/api/v1/orgs/org%20%2F1/tokens/tok%20%2F1/revoke",
      method: "POST",
    },
  ]);
});

test("a created token's answer must carry an lnx_ secret", async () => {
  const { client } = fake(() => ({ token, secret: "plain" }));
  await assert.rejects(
    client.createToken("org_1", { name: "CI", scopes: ["workspace:read"] }),
  );
});

test("grants are listed and revoked; a missing route stays a 404", async () => {
  const { client, asked } = fake((url) =>
    url.endsWith("/revoke") ? { grant } : { grants: [grant] },
  );
  assert.deepEqual(await client.grants("org_1"), [grant]);
  assert.deepEqual(await client.revokeGrant("org_1", "grt_1"), grant);
  assert.deepEqual(
    asked.map((entry) => `${entry.method} ${entry.url}`),
    [
      "GET /api/v1/orgs/org_1/oauth/grants",
      "POST /api/v1/orgs/org_1/oauth/grants/grt_1/revoke",
    ],
  );

  const missing = fake(
    () => new Response(JSON.stringify({ error: "Not found" }), { status: 404 }),
  );
  await assert.rejects(
    missing.client.grants("org_1"),
    (error: unknown) => error instanceof ApiError && error.isNotFound,
  );
});

test("usage asks for the window it is given", async () => {
  const usage = {
    window: { from: at, to: at, days: 7 },
    runs: [
      { family: "sizing", kind: "backlog", status: "succeeded", count: 3 },
    ],
  };
  const { client, asked } = fake(() => usage);
  assert.deepEqual(await client.usage("org_1", 7), usage);
  assert.equal(asked[0]?.url, "/api/v1/orgs/org_1/usage?days=7");
});

test("the OpenAPI document is read as an object, and refused otherwise", async () => {
  const { client, asked } = fake(() => ({ openapi: "3.1.0", paths: {} }));
  assert.deepEqual(await client.openApi(), { openapi: "3.1.0", paths: {} });
  assert.equal(asked[0]?.url, "/api/v1/openapi.json");
  for (const body of [[], null, "text"]) {
    await assert.rejects(fake(() => body).client.openApi(), TypeError);
  }
});
