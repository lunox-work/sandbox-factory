import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

import {
  DEFAULT_WORKSPACE_SETTINGS,
  type WorkspaceSettingsStore,
} from "@sandbox-factory/db";
import {
  membershipListSchema,
  oauthGrantListSchema,
  oauthGrantResponseSchema,
} from "@sandbox-factory/shared";
import { OAUTH_ACCESS_TOKEN_PREFIX } from "sandbox-factory";

import { LAST_USED_RESOLUTION_MS } from "../src/credentials.js";
import { protectedResource } from "../src/oauth/discovery.js";
import { bearerOAuthToken, hashOAuthToken } from "../src/oauth/provider.js";
import { createApp } from "../src/routes.js";
import {
  ada,
  deviceSession,
  fakeAuth,
  memoryGrants,
  memoryTokens,
  ORG,
  OTHER_ORG,
  roleStore,
  signedIn,
} from "./token-fakes.js";

/**
 * OAuth access tokens through the real guard and routes: what the provider
 * plugin issued (`oauth-flow.test.ts`) resolves to a principal bound to its
 * grant's workspace and scopes, refused wherever the registry, the scope,
 * the workspace, the grant or the person's standing says no.
 */

const BASE = "http://localhost:4000";
const NOW = new Date("2026-11-12T10:00:00.000Z");

const settingsStore: WorkspaceSettingsStore = {
  get: () => Promise.resolve(DEFAULT_WORKSPACE_SETTINGS),
  update: (_owner, change) =>
    Promise.resolve({ ...DEFAULT_WORKSPACE_SETTINGS, ...change }),
};

function setup() {
  const roles: Record<string, string> = {
    [`${ada.id}:${ORG}`]: "owner",
    [`${ada.id}:${OTHER_ORG}`]: "owner",
  };
  const grants = memoryGrants();
  let now = NOW;
  const server = createApp({
    corsOrigins: ["http://localhost:5173"],
    auth: fakeAuth(),
    organizations: roleStore(roles),
    settings: { settings: settingsStore },
    apiTokens: memoryTokens(),
    oauthGrants: grants,
    publicUrl: BASE,
    now: () => now,
  });
  /** An access token for a grant in `organizationId` with `scopes`. */
  function issue(
    scopes: string[] = ["workspace:read", "offline_access"],
    organizationId = ORG,
    ttlMs = 15 * 60_000,
  ) {
    const raw = randomBytes(24).toString("base64url");
    const grantId = grants.issue({
      organizationId,
      scopes,
      hash: hashOAuthToken(raw),
      expiresAt: new Date(NOW.getTime() + ttlMs),
    });
    return {
      grantId,
      headers: { authorization: `Bearer ${OAUTH_ACCESS_TOKEN_PREFIX}${raw}` },
    };
  }
  return {
    request: (path: string, init: RequestInit = {}) =>
      server.request(path, init),
    issue,
    grants,
    roles,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

async function codeOf(res: Response): Promise<string | undefined> {
  return ((await res.json()) as { code?: string }).code;
}

test("only a Bearer lnxat_ header is read as an OAuth access token", () => {
  assert.equal(bearerOAuthToken("Bearer lnxat_abc"), "abc");
  assert.equal(bearerOAuthToken("bearer  lnxat_abc "), "abc");
  for (const header of [
    undefined,
    "Bearer lnx_abc",
    "Bearer abc",
    "Basic lnxat_abc",
    "Bearer lnxat_a b",
  ])
    assert.equal(bearerOAuthToken(header), undefined, String(header));
});

test("an access token acts as its grant's person in its workspace", async () => {
  const { request, issue } = setup();
  const { headers } = issue();
  const me = await request("/api/v1/me", { headers });
  assert.equal(me.status, 200);
  assert.equal(((await me.json()) as { user: { id: string } }).user.id, ada.id);
  const listed = membershipListSchema.parse(
    await (await request("/api/v1/me/orgs", { headers })).json(),
  );
  assert.deepEqual(
    listed.organizations.map(({ id }) => id),
    [ORG],
  );
  assert.equal(
    (await request(`/api/v1/orgs/${ORG}/settings`, { headers })).status,
    200,
  );
});

test("an access token reaches only registry routes, with their scope", async () => {
  const { request, issue } = setup();
  const reader = issue();
  for (const path of [
    `/api/v1/orgs/${ORG}/tokens`,
    `/api/v1/orgs/${ORG}/oauth/grants`,
  ]) {
    const res = await request(path, { headers: reader.headers });
    assert.equal(res.status, 403, path);
    assert.equal(await codeOf(res), "not_public");
  }
  // Holding `offline_access` and a write scope, but not `workspace:read`.
  const writer = issue(["bounties:write", "offline_access"]);
  const res = await request(`/api/v1/orgs/${ORG}/settings`, {
    headers: writer.headers,
  });
  assert.equal(res.status, 403);
  assert.equal(await codeOf(res), "insufficient_scope");
});

test("another workspace is not found, though the person belongs to it", async () => {
  const { request, issue } = setup();
  const { headers } = issue();
  const res = await request(`/api/v1/orgs/${OTHER_ORG}/settings`, {
    headers,
  });
  assert.equal(res.status, 404);
});

test("a person no longer owner or admin there stops every token", async () => {
  const { request, issue, roles } = setup();
  const { headers } = issue();
  roles[`${ada.id}:${ORG}`] = "member";
  const res = await request("/api/v1/me", { headers });
  assert.equal(res.status, 401);
  assert.equal(await codeOf(res), "invalid_token");
  delete roles[`${ada.id}:${ORG}`];
  assert.equal((await request("/api/v1/me", { headers })).status, 401);
});

test("an expired or unknown access token is refused with a sign-in pointer", async () => {
  const { request, issue, advance } = setup();
  const { headers } = issue(undefined, ORG, 60_000);
  assert.equal((await request("/api/v1/me", { headers })).status, 200);
  advance(60_000);
  const expired = await request("/api/v1/me", { headers });
  assert.equal(expired.status, 401);
  assert.equal(
    expired.headers.get("www-authenticate"),
    `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource", error="invalid_token"`,
  );
  const unknown = await request("/api/v1/me", {
    headers: { authorization: `Bearer ${OAUTH_ACCESS_TOKEN_PREFIX}nope` },
  });
  assert.equal(unknown.status, 401);
  assert.equal(await codeOf(unknown), "invalid_token");
});

test("a revoked grant's tokens stop at once", async () => {
  const { request, issue } = setup();
  const { headers, grantId } = issue();
  assert.equal((await request("/api/v1/me", { headers })).status, 200);
  const revoked = await request(
    `/api/v1/orgs/${ORG}/oauth/grants/${grantId}/revoke`,
    { method: "POST", headers: signedIn },
  );
  assert.equal(revoked.status, 200);
  assert.equal(
    oauthGrantResponseSchema.parse(await revoked.json()).grant.id,
    grantId,
  );
  assert.equal((await request("/api/v1/me", { headers })).status, 401);
});

test("a use is recorded at most once a minute", async () => {
  const { request, issue, grants, advance } = setup();
  const { headers, grantId } = issue();
  await request("/api/v1/me", { headers });
  assert.deepEqual(grants.touches, [{ grantId, at: NOW }]);
  const [grant] = grants.grants;
  if (grant !== undefined) grants.grants[0] = { ...grant, lastUsedAt: NOW };
  advance(LAST_USED_RESOLUTION_MS - 1);
  await request("/api/v1/me", { headers });
  assert.equal(grants.touches.length, 1);
});

test("other bearers are still Better Auth's sessions", async () => {
  const { request } = setup();
  // The extension's and a device sign-in's session tokens carry no prefix.
  const device = await request("/api/v1/me", {
    headers: deviceSession("carveout"),
  });
  assert.equal(device.status, 200);
  const unknown = await request("/api/v1/me", {
    headers: { authorization: "Bearer someSessionToken" },
  });
  assert.equal(unknown.status, 401);
  assert.equal(await codeOf(unknown), undefined);
});

test("without a grant store every access token is refused", async () => {
  const server = createApp({
    corsOrigins: [],
    auth: fakeAuth(),
    organizations: roleStore({ [`${ada.id}:${ORG}`]: "owner" }),
  });
  const res = await server.request("/api/v1/me", {
    headers: { authorization: `Bearer ${OAUTH_ACCESS_TOKEN_PREFIX}abc` },
  });
  assert.equal(res.status, 401);
  assert.equal(
    res.headers.get("www-authenticate"),
    'Bearer error="invalid_token"',
  );
});

test("connected apps are listed and revoked by owners and admins, from a session", async () => {
  const { request, issue, roles } = setup();
  const { grantId } = issue();
  issue(undefined, OTHER_ORG);
  const listed = await request(`/api/v1/orgs/${ORG}/oauth/grants`, {
    headers: signedIn,
  });
  assert.equal(listed.status, 200);
  const { grants } = oauthGrantListSchema.parse(await listed.json());
  assert.deepEqual(
    grants.map(({ id, client }) => ({ id, client: client.name })),
    [{ id: grantId, client: "Claude Code" }],
  );

  assert.equal(
    (
      await request(`/api/v1/orgs/${ORG}/oauth/grants/missing/revoke`, {
        method: "POST",
        headers: signedIn,
      })
    ).status,
    404,
  );
  // Another workspace's grant is as missing as one that does not exist.
  assert.equal(
    (
      await request(`/api/v1/orgs/${ORG}/oauth/grants/consent_2/revoke`, {
        method: "POST",
        headers: signedIn,
      })
    ).status,
    404,
  );

  roles[`${ada.id}:${ORG}`] = "member";
  assert.equal(
    (await request(`/api/v1/orgs/${ORG}/oauth/grants`, { headers: signedIn }))
      .status,
    403,
  );
});

test("a device session cannot manage connected apps", async () => {
  const { request } = setup();
  const res = await request(`/api/v1/orgs/${ORG}/oauth/grants`, {
    headers: deviceSession("carveout"),
  });
  assert.equal(res.status, 403);
});

test("the protected-resource documents name the server and what to ask for", async () => {
  const { request } = setup();
  const res = await request(
    "/.well-known/oauth-protected-resource/mcp/carveout",
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.deepEqual(await res.json(), {
    resource: `${BASE}/mcp/carveout`,
    authorization_servers: [`${BASE}/api/auth`],
    scopes_supported: ["workspace:read", "offline_access"],
    bearer_methods_supported: ["header"],
    resource_name: "Lunox MCP",
  });
  const api = await request("/.well-known/oauth-protected-resource");
  assert.deepEqual(await api.json(), protectedResource(BASE, ""));
  assert.equal(protectedResource(BASE, "").resource, BASE);
  assert.ok(protectedResource(BASE, "").scopes_supported.includes("judge"));
});
