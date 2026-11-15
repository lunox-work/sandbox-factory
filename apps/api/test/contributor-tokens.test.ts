import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

import {
  contributorTokenListSchema,
  createdContributorTokenResponseSchema,
  oauthGrantListSchema,
} from "@sandbox-factory/shared";
import {
  CONTRIBUTOR_TOKEN_PREFIX,
  OAUTH_ACCESS_TOKEN_PREFIX,
} from "sandbox-factory";

import {
  bearerApiToken,
  bearerContributorToken,
  displayPrefix,
  generateContributorSecret,
  generateSecret,
  hashSecret,
} from "../src/api-tokens/secret.js";
import { protectedResource } from "../src/oauth/discovery.js";
import { hashOAuthToken } from "../src/oauth/provider.js";
import { createApp } from "../src/routes.js";
import {
  ada,
  deviceSession,
  fakeAuth,
  memoryContributorTokens,
  memoryGrants,
  memoryTokens,
  ORG,
  roleStore,
  signedIn,
} from "./token-fakes.js";

/**
 * Contributor credentials through the real guard and routes: a person's
 * own `lnxc_` tokens, made from their session, and OAuth grants made as a
 * contributor. Both belong to no workspace and reach only the contributor
 * routes; `contributor-routes.test.ts` follows one through a version, and
 * `public-api.test.ts` pins the isolation over every registry route.
 */

const BASE = "http://localhost:4000";
const NOW = new Date("2026-11-15T10:00:00.000Z");

function setup() {
  let now = NOW;
  const tokens = memoryContributorTokens();
  const grants = memoryGrants();
  const server = createApp({
    corsOrigins: [],
    auth: fakeAuth(),
    // Ada administers no workspace: a contributor needs none.
    organizations: roleStore({}),
    apiTokens: memoryTokens(),
    oauthGrants: grants,
    contributorTokens: tokens,
    publicUrl: BASE,
    now: () => now,
  });
  const request = (path: string, init: RequestInit = {}) =>
    server.request(path, init);
  async function mint(body: unknown = { name: "Claude Code" }) {
    const res = await request("/api/v1/me/contributor-tokens", {
      method: "POST",
      headers: { ...signedIn, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 201, await res.clone().text());
    assert.equal(res.headers.get("cache-control"), "no-store");
    return createdContributorTokenResponseSchema.parse(await res.json());
  }
  /** A contributor OAuth grant's access token (no workspace). */
  function grant(scopes = ["contributions:write", "offline_access"]) {
    const raw = randomBytes(24).toString("base64url");
    const grantId = grants.issue({
      organizationId: null,
      scopes,
      hash: hashOAuthToken(raw),
      expiresAt: new Date(NOW.getTime() + 15 * 60_000),
    });
    return {
      grantId,
      headers: { authorization: `Bearer ${OAUTH_ACCESS_TOKEN_PREFIX}${raw}` },
    };
  }
  return {
    request,
    mint,
    grant,
    tokens,
    grants,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });

async function codeOf(res: Response): Promise<string | undefined> {
  return ((await res.json()) as { code?: string }).code;
}

test("a contributor secret is lnxc_ and 40 base62 characters, read only as itself", () => {
  const secret = generateContributorSecret();
  assert.match(secret, /^lnxc_[0-9A-Za-z]{40}$/);
  assert.equal(displayPrefix(secret), secret.slice(0, 13));
  assert.equal(bearerContributorToken(`Bearer ${secret}`), secret);
  // Neither kind is read as the other.
  assert.equal(bearerApiToken(`Bearer ${secret}`), undefined);
  assert.equal(bearerContributorToken(`Bearer ${generateSecret()}`), undefined);
  assert.equal(bearerContributorToken("Bearer lnxat_abc"), undefined);
});

test("a person makes a contributor token from their session; its secret is answered once", async () => {
  const { request, mint, tokens } = setup();
  const { token, secret } = await mint({ name: " Cursor ", expiresInDays: 30 });
  assert.ok(secret.startsWith(CONTRIBUTOR_TOKEN_PREFIX));
  assert.equal(token.name, "Cursor");
  assert.equal(token.prefix, displayPrefix(secret));
  assert.equal(token.expiresAt, "2026-12-15T10:00:00.000Z");
  // Only the hash is kept, under the person.
  assert.equal(tokens.rows[0]?.hash, hashSecret(secret));
  assert.equal(tokens.rows[0]?.userId, ada.id);
  const listed = await request("/api/v1/me/contributor-tokens", {
    headers: signedIn,
  });
  const text = await listed.text();
  assert.doesNotMatch(text, new RegExp(secret));
  assert.deepEqual(
    contributorTokenListSchema
      .parse(JSON.parse(text))
      .tokens.map(({ id }) => id),
    [token.id],
  );
  // Ninety days unless said; never when null.
  assert.equal(
    (await mint({ name: "CLI" })).token.expiresAt,
    "2027-02-13T10:00:00.000Z",
  );
  assert.equal(
    (await mint({ name: "Forever", expiresInDays: null })).token.expiresAt,
    null,
  );
  const bad = await request("/api/v1/me/contributor-tokens", {
    method: "POST",
    headers: { ...signedIn, "content-type": "application/json" },
    body: JSON.stringify({ name: "" }),
  });
  assert.equal(bad.status, 400);
  assert.equal(await codeOf(bad), "invalid_token_request");
});

test("a contributor token is a person with no workspace, reaching no workspace route", async () => {
  const { request, mint, tokens } = setup();
  const { secret } = await mint();
  // Who am I is a workspace route: refused, but as a valid credential.
  const me = await request("/api/v1/me", { headers: bearer(secret) });
  assert.equal(me.status, 403);
  assert.equal(await codeOf(me), "contributor_credential");
  assert.equal(
    await codeOf(
      await request(`/api/v1/orgs/${ORG}`, { headers: bearer(secret) }),
    ),
    "contributor_credential",
  );
  // Routes outside the registry stay closed, its own management included.
  for (const path of ["/api/v1/me/contributor-tokens", "/api/v1/me/emails"]) {
    const res = await request(path, { headers: bearer(secret) });
    assert.equal(res.status, 403, path);
    assert.equal(await codeOf(res), "not_public", path);
  }
  // Its use is recorded, at most once a minute.
  assert.equal(tokens.touches.length, 1);
  await request("/api/v1/me", { headers: bearer(secret) });
  assert.equal(tokens.touches.length, 1);
});

test("a revoked, expired or unknown contributor token is a 401 pointing where to sign in", async () => {
  const { request, mint, advance } = setup();
  const short = await mint({ name: "Short", expiresInDays: 1 });
  const kept = await mint({ name: "Kept" });
  const revoked = await request(
    `/api/v1/me/contributor-tokens/${kept.token.id}/revoke`,
    { method: "POST", headers: signedIn },
  );
  assert.equal(revoked.status, 200);
  for (const secret of [kept.secret, generateContributorSecret()]) {
    const res = await request("/api/v1/me", { headers: bearer(secret) });
    assert.equal(res.status, 401);
    assert.equal(await codeOf(res), "invalid_token");
    assert.match(
      res.headers.get("www-authenticate") ?? "",
      /oauth-protected-resource", error="invalid_token"/,
    );
  }
  advance(24 * 60 * 60_000);
  assert.equal(
    (await request("/api/v1/me", { headers: bearer(short.secret) })).status,
    401,
  );
  // Another person's token, or one that never was: 404.
  assert.equal(
    (
      await request("/api/v1/me/contributor-tokens/ctk_9/revoke", {
        method: "POST",
        headers: signedIn,
      })
    ).status,
    404,
  );
});

test("a contributor token revokes itself, as a client's logout does", async () => {
  const { request, mint } = setup();
  const { secret } = await mint();
  const res = await request("/api/v1/tokens/self/revoke", {
    method: "POST",
    headers: bearer(secret),
  });
  assert.equal(res.status, 204);
  assert.equal(
    (await request("/api/v1/me", { headers: bearer(secret) })).status,
    401,
  );
});

test("contributor tokens are managed from a session, never a device sign-in or another token", async () => {
  const { request, mint } = setup();
  const { secret } = await mint();
  for (const headers of [deviceSession("carveout"), bearer(secret)]) {
    const res = await request("/api/v1/me/contributor-tokens", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "More" }),
    });
    assert.equal(res.status, 403);
  }
});

test("a contributor OAuth grant needs no workspace role and holds the contributor scope alone", async () => {
  const { request, grant, grants } = setup();
  // Workspace scopes in a contributor grant count for nothing.
  const { headers, grantId } = grant([
    "contributions:write",
    "workspace:read",
    "offline_access",
  ]);
  const me = await request("/api/v1/me", { headers });
  assert.equal(me.status, 403);
  assert.equal(await codeOf(me), "contributor_credential");
  assert.equal(grants.touches[0]?.grantId, grantId);
  // The person lists and ends it from their session.
  const listed = oauthGrantListSchema.parse(
    await (
      await request("/api/v1/me/contributor-grants", { headers: signedIn })
    ).json(),
  );
  assert.deepEqual(
    listed.grants.map(({ id }) => id),
    [grantId],
  );
  const ended = await request(
    `/api/v1/me/contributor-grants/${grantId}/revoke`,
    { method: "POST", headers: signedIn },
  );
  assert.equal(ended.status, 200);
  assert.equal((await request("/api/v1/me", { headers })).status, 401);
  // A workspace's grants are not a contributor's to list or end.
  const workspaceGrant = grants.issue({
    organizationId: ORG,
    scopes: ["workspace:read"],
    hash: "unused",
    expiresAt: NOW,
  });
  assert.equal(
    (
      await request(`/api/v1/me/contributor-grants/${workspaceGrant}/revoke`, {
        method: "POST",
        headers: signedIn,
      })
    ).status,
    404,
  );
});

test("a contributor OAuth access token revokes itself and leaves its grant", async () => {
  const { request, grant, grants } = setup();
  const { headers } = grant();
  const res = await request("/api/v1/tokens/self/revoke", {
    method: "POST",
    headers,
  });
  assert.equal(res.status, 204);
  assert.equal(grants.grants.length, 1);
  assert.equal((await request("/api/v1/me", { headers })).status, 401);
});

test("the contributor endpoint's protected-resource document asks for the contributor scope", async () => {
  const { request } = setup();
  const res = await request(
    "/.well-known/oauth-protected-resource/mcp/contribute",
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    resource: `${BASE}/mcp/contribute`,
    authorization_servers: [`${BASE}/api/auth`],
    scopes_supported: ["contributions:write", "offline_access"],
    bearer_methods_supported: ["header"],
    resource_name: "Lunox MCP for contributors",
  });
  assert.ok(
    protectedResource(BASE, "").scopes_supported.includes(
      "contributions:write",
    ),
  );
});

test("without a contributor token store every lnxc_ token is refused", async () => {
  const server = createApp({
    corsOrigins: [],
    auth: fakeAuth(),
    organizations: roleStore({}),
  });
  const res = await server.request("/api/v1/me", {
    headers: bearer(generateContributorSecret()),
  });
  assert.equal(res.status, 401);
  // And the management routes are not mounted.
  assert.equal(
    (
      await server.request("/api/v1/me/contributor-tokens", {
        headers: signedIn,
      })
    ).status,
    404,
  );
});
