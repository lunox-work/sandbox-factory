import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_WORKSPACE_SETTINGS,
  NO_MODEL_TOKENS,
  type ModelTokens,
  type RunCount,
  type WorkspaceSettingsStore,
} from "@sandbox-factory/db";
import {
  apiTokenListSchema,
  createdApiTokenResponseSchema,
  usageResponseSchema,
} from "@sandbox-factory/shared";
import { API_SCOPES, type ApiScope } from "sandbox-factory";

import {
  bearerApiToken,
  displayPrefix,
  generateSecret,
  hashSecret,
} from "../src/api-tokens/secret.js";
import { CLI_TOKEN_DAYS } from "../src/api-tokens/routes.js";
import { createApp } from "../src/routes.js";
import {
  ada,
  deviceSession,
  fakeAuth,
  memoryTokens,
  ORG,
  OTHER_ORG,
  roleStore,
  signedIn,
} from "./token-fakes.js";

/**
 * Workspace API tokens end to end, through the real guard and routes:
 * made from a session, used as a bearer, refused wherever the scope, the
 * workspace, the registry or the creator's standing says no.
 */

const settingsStore: WorkspaceSettingsStore = {
  get: () => Promise.resolve(DEFAULT_WORKSPACE_SETTINGS),
  update: (_owner, change) =>
    Promise.resolve({ ...DEFAULT_WORKSPACE_SETTINGS, ...change }),
};

function setup(
  options: {
    roles?: Record<string, string>;
    now?: () => Date;
    runCounts?: RunCount[];
    /** Ledger rows, as the usage store sums them since a date. */
    ledger?: Array<{ organizationId: string; at: Date; tokens: ModelTokens }>;
    monthlyModelTokens?: number;
  } = {},
) {
  const roles = options.roles ?? {
    [`${ada.id}:${ORG}`]: "owner",
    [`${ada.id}:${OTHER_ORG}`]: "owner",
  };
  const tokens = memoryTokens();
  const signOuts: Headers[] = [];
  const usageCalls: Array<{ organizationId: string; since: Date }> = [];
  const tokenCalls: Array<{ organizationId: string; since: Date }> = [];
  const server = createApp({
    corsOrigins: ["http://localhost:5173"],
    auth: fakeAuth(signOuts),
    organizations: roleStore(roles),
    settings: { settings: settingsStore },
    apiTokens: tokens,
    usage: {
      runCounts: (organizationId, since) => {
        usageCalls.push({ organizationId, since });
        return Promise.resolve(options.runCounts ?? []);
      },
      modelTokens: (organizationId, since) => {
        tokenCalls.push({ organizationId, since });
        return Promise.resolve(
          (options.ledger ?? [])
            .filter(
              (row) => row.organizationId === organizationId && row.at >= since,
            )
            .reduce(
              (sum, { tokens }) => ({
                inputTokens: sum.inputTokens + tokens.inputTokens,
                outputTokens: sum.outputTokens + tokens.outputTokens,
                cacheReadTokens: sum.cacheReadTokens + tokens.cacheReadTokens,
                cacheWriteTokens:
                  sum.cacheWriteTokens + tokens.cacheWriteTokens,
              }),
              NO_MODEL_TOKENS,
            ),
        );
      },
    },
    monthlyModelTokens: options.monthlyModelTokens,
    now: options.now,
  });
  const request = (path: string, init: RequestInit = {}) =>
    server.request(path, init);
  /** A token made from Ada's session, with `scopes`. */
  async function mint(
    scopes: readonly ApiScope[] = ["workspace:read"],
    extra: Record<string, unknown> = {},
  ): Promise<string> {
    const res = await request(`/api/v1/orgs/${ORG}/tokens`, {
      method: "POST",
      headers: { ...signedIn, "content-type": "application/json" },
      body: JSON.stringify({ name: "CI", scopes, ...extra }),
    });
    assert.equal(res.status, 201);
    return createdApiTokenResponseSchema.parse(await res.json()).secret;
  }
  const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });
  return {
    request,
    mint,
    bearer,
    tokens,
    roles,
    signOuts,
    usageCalls,
    tokenCalls,
  };
}

async function bodyOf(
  res: Response,
): Promise<{ error?: string; code?: string }> {
  return (await res.json()) as { error?: string; code?: string };
}

test("a secret is lnx_ and 40 base62 characters, hashed and shown by its prefix", () => {
  const secret = generateSecret();
  assert.match(secret, /^lnx_[0-9A-Za-z]{40}$/);
  assert.notEqual(generateSecret(), secret);
  assert.match(hashSecret(secret), /^[0-9a-f]{64}$/);
  assert.equal(displayPrefix(secret), secret.slice(0, 12));
  // Bytes past the unbiased range are skipped, not folded onto the alphabet.
  let calls = 0;
  const skewed = generateSecret((size) => {
    calls += 1;
    return new Uint8Array(size).fill(calls === 1 ? 255 : 61);
  });
  assert.equal(skewed, `lnx_${"z".repeat(40)}`);
  assert.equal(calls, 2);
});

test("only a Bearer lnx_ header is read as an API token", () => {
  assert.equal(bearerApiToken("Bearer lnx_abc"), "lnx_abc");
  assert.equal(bearerApiToken("bearer  lnx_abc "), "lnx_abc");
  for (const header of [
    undefined,
    "Bearer session-token",
    "Basic lnx_abc",
    "Bearer lnx_a lnx_b",
  ])
    assert.equal(bearerApiToken(header), undefined);
});

test("creating a token answers its secret once; listing never does", async () => {
  const { request, tokens } = setup();
  const res = await request(`/api/v1/orgs/${ORG}/tokens`, {
    method: "POST",
    headers: { ...signedIn, "content-type": "application/json" },
    body: JSON.stringify({
      name: "CI",
      scopes: ["workspace:read", "bounties:write"],
      expiresInDays: 30,
    }),
  });
  assert.equal(res.status, 201);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const created = createdApiTokenResponseSchema.parse(await res.json());
  assert.equal(created.token.prefix, created.secret.slice(0, 12));
  assert.deepEqual(created.token.scopes, ["workspace:read", "bounties:write"]);
  assert.notEqual(created.token.expiresAt, null);
  // Stored as a hash: the secret is in no row.
  assert.equal(tokens.rows[0]?.hash, hashSecret(created.secret));
  assert.equal(JSON.stringify(tokens.rows).includes(created.secret), false);

  const listed = await request(`/api/v1/orgs/${ORG}/tokens`, {
    headers: signedIn,
  });
  assert.equal(listed.status, 200);
  const text = await listed.text();
  assert.equal(text.includes(created.secret), false);
  assert.equal(text.includes('"secret"'), false);
  const list = apiTokenListSchema.parse(JSON.parse(text));
  assert.deepEqual(
    list.tokens.map(({ id, name }) => ({ id, name })),
    [{ id: created.token.id, name: "CI" }],
  );
});

test("a malformed token request is refused with the reason", async () => {
  const { request } = setup();
  const res = await request(`/api/v1/orgs/${ORG}/tokens`, {
    method: "POST",
    headers: { ...signedIn, "content-type": "application/json" },
    body: JSON.stringify({ name: "CI", scopes: ["tokens:write"] }),
  });
  assert.equal(res.status, 400);
  assert.equal((await bodyOf(res)).code, "invalid_token_request");
});

test("only owners and admins manage tokens; a member is refused", async () => {
  const { request } = setup({ roles: { [`${ada.id}:${ORG}`]: "member" } });
  for (const [path, init] of [
    [`/api/v1/orgs/${ORG}/tokens`, { headers: signedIn }],
    [
      `/api/v1/orgs/${ORG}/tokens`,
      {
        method: "POST",
        headers: { ...signedIn, "content-type": "application/json" },
        body: JSON.stringify({ name: "CI", scopes: ["judge"] }),
      },
    ],
    [
      `/api/v1/orgs/${ORG}/tokens/tok_1/revoke`,
      { method: "POST", headers: signedIn },
    ],
  ] as const) {
    const res = await request(path, init);
    assert.equal(res.status, 403, path);
  }
  // A non-member learns nothing.
  const res = await request(`/api/v1/orgs/org_9/tokens`, { headers: signedIn });
  assert.equal(res.status, 404);
});

test("a token reads its workspace as its creator, and records its use", async () => {
  const { request, mint, bearer, tokens } = setup();
  const secret = await mint();
  const me = await request("/api/v1/me", { headers: bearer(secret) });
  assert.equal(me.status, 200);
  assert.equal(((await me.json()) as { user: { id: string } }).user.id, ada.id);
  const settings = await request(`/api/v1/orgs/${ORG}/settings`, {
    headers: bearer(secret),
  });
  assert.equal(settings.status, 200);
  assert.deepEqual(await settings.json(), DEFAULT_WORKSPACE_SETTINGS);
  // Two uses within the minute: one write, from the first.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(tokens.touches.length, 1);
  assert.notEqual(tokens.rows[0]?.lastUsedAt, null);
});

test("a token sees only its own workspace in the list of workspaces", async () => {
  const { request, mint, bearer } = setup();
  const secret = await mint();
  const res = await request("/api/v1/me/orgs", { headers: bearer(secret) });
  const { organizations } = (await res.json()) as {
    organizations: Array<{ id: string }>;
  };
  assert.deepEqual(
    organizations.map(({ id }) => id),
    [ORG],
  );
  // The same person's session sees both.
  const session = await request("/api/v1/me/orgs", { headers: signedIn });
  assert.equal(
    ((await session.json()) as { organizations: unknown[] }).organizations
      .length,
    2,
  );
});

test("another workspace's id is 404 to a token, though its creator belongs there", async () => {
  const { request, mint, bearer } = setup();
  const secret = await mint();
  for (const path of [
    `/api/v1/orgs/${OTHER_ORG}`,
    `/api/v1/orgs/${OTHER_ORG}/settings`,
  ]) {
    const res = await request(path, { headers: bearer(secret) });
    assert.equal(res.status, 404, path);
  }
  const own = await request(`/api/v1/orgs/${ORG}`, { headers: bearer(secret) });
  assert.equal(own.status, 200);
  assert.equal(((await own.json()) as { role: string }).role, "owner");
});

test("a token without the route's scope is refused", async () => {
  const { request, mint, bearer } = setup();
  const secret = await mint(["bounties:write"]);
  const res = await request(`/api/v1/orgs/${ORG}/settings`, {
    headers: bearer(secret),
  });
  assert.equal(res.status, 403);
  assert.equal((await bodyOf(res)).code, "insufficient_scope");
});

test("a route the registry does not declare is refused to every token", async () => {
  const { request, mint, bearer } = setup();
  const secret = await mint([...API_SCOPES]);
  for (const [path, init] of [
    // Undeclared: changing settings.
    [
      `/api/v1/orgs/${ORG}/settings`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prepareSandboxes: false }),
      },
    ],
    // A token never manages tokens.
    [`/api/v1/orgs/${ORG}/tokens`, {}],
    [
      `/api/v1/orgs/${ORG}/tokens`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "more", scopes: ["judge"] }),
      },
    ],
    [`/api/v1/orgs/${ORG}/tokens/tok_1/revoke`, { method: "POST" }],
    [
      `/api/v1/orgs/${ORG}/tokens/cli`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client: "carveout" }),
      },
    ],
    // No route at all.
    [`/api/v1/orgs/${ORG}/nothing-here`, {}],
  ] as const) {
    const res = await request(path, {
      ...init,
      headers: { ...bearer(secret), ...init.headers },
    });
    assert.equal(res.status, 403, `${init.method ?? "GET"} ${path}`);
    assert.equal((await bodyOf(res)).code, "not_public", path);
  }
});

test("a revoked token is refused at once", async () => {
  const { request, mint, bearer, tokens } = setup();
  const secret = await mint();
  const id = tokens.rows[0]?.id ?? "";
  const revoked = await request(`/api/v1/orgs/${ORG}/tokens/${id}/revoke`, {
    method: "POST",
    headers: signedIn,
  });
  assert.equal(revoked.status, 200);
  assert.notEqual(
    ((await revoked.json()) as { token: { revokedAt: string | null } }).token
      .revokedAt,
    null,
  );
  const res = await request("/api/v1/me", { headers: bearer(secret) });
  assert.equal(res.status, 401);
  assert.equal(
    res.headers.get("www-authenticate"),
    'Bearer error="invalid_token"',
  );
  assert.equal((await bodyOf(res)).code, "invalid_token");
  // Another workspace's token id is 404 to revoke.
  const other = await request(`/api/v1/orgs/${OTHER_ORG}/tokens/${id}/revoke`, {
    method: "POST",
    headers: signedIn,
  });
  assert.equal(other.status, 404);
});

test("a token revokes itself, and only itself, with no scope", async () => {
  const { request, mint, bearer, tokens } = setup();
  const self = await mint(["bounties:write"]);
  const other = await mint();
  // A body naming another token is not read: the presenting one is revoked.
  const res = await request("/api/v1/tokens/self/revoke", {
    method: "POST",
    headers: { ...bearer(self), "content-type": "application/json" },
    body: JSON.stringify({ id: tokens.rows[1]?.id }),
  });
  assert.equal(res.status, 204);
  assert.notEqual(tokens.rows[0]?.revokedAt, null);
  assert.equal(tokens.rows[1]?.revokedAt, null);
  const after = await request("/api/v1/tokens/self/revoke", {
    method: "POST",
    headers: bearer(self),
  });
  assert.equal(after.status, 401);
  assert.equal(
    (await request("/api/v1/me", { headers: bearer(self) })).status,
    401,
  );
  assert.equal(
    (await request("/api/v1/me", { headers: bearer(other) })).status,
    200,
  );
});

test("a session or device sign-in has no token to revoke", async () => {
  const { request } = setup();
  const session = await request("/api/v1/tokens/self/revoke", {
    method: "POST",
    headers: signedIn,
  });
  assert.equal(session.status, 403);
  assert.equal((await bodyOf(session)).code, "bound_credential_required");
  const device = await request("/api/v1/tokens/self/revoke", {
    method: "POST",
    headers: deviceSession("carveout"),
  });
  assert.equal(device.status, 403);
  assert.equal((await bodyOf(device)).code, "device_session");
});

test("an expired token is refused, and an unknown one too", async () => {
  let clock = new Date("2026-11-12T00:00:00.000Z");
  const { request, mint, bearer } = setup({ now: () => clock });
  const secret = await mint(["workspace:read"], { expiresInDays: 1 });
  assert.equal(
    (await request("/api/v1/me", { headers: bearer(secret) })).status,
    200,
  );
  clock = new Date("2026-11-13T00:00:00.000Z");
  assert.equal(
    (await request("/api/v1/me", { headers: bearer(secret) })).status,
    401,
  );
  assert.equal(
    (await request("/api/v1/me", { headers: bearer(generateSecret()) })).status,
    401,
  );
});

test("a token stops working when its creator is demoted or leaves", async () => {
  const { request, mint, bearer, roles } = setup();
  const secret = await mint();
  roles[`${ada.id}:${ORG}`] = "member";
  assert.equal(
    (await request("/api/v1/me", { headers: bearer(secret) })).status,
    401,
  );
  roles[`${ada.id}:${ORG}`] = "admin";
  assert.equal(
    (await request("/api/v1/me", { headers: bearer(secret) })).status,
    200,
  );
  delete roles[`${ada.id}:${ORG}`];
  assert.equal(
    (await request("/api/v1/me", { headers: bearer(secret) })).status,
    401,
  );
});

test("without a token store every token is refused, and sessions still work", async () => {
  const server = createApp({
    corsOrigins: [],
    auth: fakeAuth(),
    organizations: roleStore({ [`${ada.id}:${ORG}`]: "owner" }),
  });
  const res = await server.request("/api/v1/me", {
    headers: { authorization: `Bearer ${generateSecret()}` },
  });
  assert.equal(res.status, 401);
  assert.equal(
    (await server.request("/api/v1/me", { headers: signedIn })).status,
    200,
  );
  // Nor are the token routes mounted.
  assert.equal(
    (await server.request(`/api/v1/orgs/${ORG}/tokens`, { headers: signedIn }))
      .status,
    404,
  );
});

test("the session path is unchanged: every route, no scope check", async () => {
  const { request } = setup();
  const patch = await request(`/api/v1/orgs/${ORG}/settings`, {
    method: "PATCH",
    headers: { ...signedIn, "content-type": "application/json" },
    body: JSON.stringify({ prepareSandboxes: false }),
  });
  assert.equal(patch.status, 200);
  assert.deepEqual(await patch.json(), { prepareSandboxes: false });
  // No credential at all is still 401.
  assert.equal((await request("/api/v1/me")).status, 401);
});

test("a device sign-in mints its client's token, once, and reaches nothing else", async () => {
  let clock = new Date("2026-11-12T00:00:00.000Z");
  const { request, signOuts, bearer } = setup({ now: () => clock });
  const device = deviceSession("carveout");
  // It may see who it is and where, to choose a workspace.
  assert.equal(
    (await request("/api/v1/me/orgs", { headers: device })).status,
    200,
  );
  // Nothing else, not even a read.
  const read = await request(`/api/v1/orgs/${ORG}/settings`, {
    headers: device,
  });
  assert.equal(read.status, 403);
  assert.equal((await bodyOf(read)).code, "device_session");

  const res = await request(`/api/v1/orgs/${ORG}/tokens/cli`, {
    method: "POST",
    headers: { ...device, "content-type": "application/json" },
    body: JSON.stringify({ client: "carveout", label: "laptop" }),
  });
  assert.equal(res.status, 201);
  const created = createdApiTokenResponseSchema.parse(await res.json());
  assert.equal(created.token.name, "carveout CLI on laptop");
  assert.deepEqual(created.token.scopes, [
    "workspace:read",
    "sandboxes:write",
    "submissions:write",
  ]);
  assert.equal(
    created.token.expiresAt,
    new Date(clock.getTime() + CLI_TOKEN_DAYS * 86_400_000).toISOString(),
  );
  // The device session is ended with the headers it came with.
  assert.equal(signOuts.length, 1);
  assert.equal(signOuts[0]?.get("authorization"), "Bearer device-carveout");
  // The CLI goes on with the token.
  clock = new Date("2026-11-12T00:00:01.000Z");
  assert.equal(
    (
      await request(`/api/v1/orgs/${ORG}/settings`, {
        headers: bearer(created.secret),
      })
    ).status,
    200,
  );
});

test("a CLI token is refused for another client, extra scopes, or a session", async () => {
  const { request } = setup();
  const post = (headers: Record<string, string>, body: unknown) =>
    request(`/api/v1/orgs/${ORG}/tokens/cli`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const mismatch = await post(deviceSession("carveout"), {
    client: "duediligence",
  });
  assert.equal(mismatch.status, 403);
  assert.equal((await bodyOf(mismatch)).code, "client_mismatch");
  const extra = await post(deviceSession("carveout"), {
    client: "carveout",
    scopes: ["workspace:read", "webhooks:write"],
  });
  assert.equal(extra.status, 400);
  assert.equal((await bodyOf(extra)).code, "invalid_scope");
  const malformed = await post(deviceSession("carveout"), { client: 1 });
  assert.equal(malformed.status, 400);
  const fromSession = await post(signedIn, { client: "carveout" });
  assert.equal(fromSession.status, 403);
  assert.equal((await bodyOf(fromSession)).code, "device_session_required");
  // A device session may not use the session-only routes either.
  const list = await request(`/api/v1/orgs/${ORG}/tokens`, {
    headers: deviceSession("carveout"),
  });
  assert.equal(list.status, 403);
});

test("a device sign-in by a member mints nothing", async () => {
  const { request } = setup({ roles: { [`${ada.id}:${ORG}`]: "member" } });
  const res = await request(`/api/v1/orgs/${ORG}/tokens/cli`, {
    method: "POST",
    headers: {
      ...deviceSession("duediligence"),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      client: "duediligence",
      scopes: ["workspace:read"],
    }),
  });
  assert.equal(res.status, 403);
});

test("usage counts the window asked for, thirty days by default", async () => {
  const clock = new Date("2026-11-12T00:00:00.000Z");
  const counts: RunCount[] = [
    { family: "sizing", kind: "single", status: "succeeded", count: 2 },
  ];
  const { request, mint, bearer, usageCalls } = setup({
    now: () => clock,
    runCounts: counts,
  });
  const secret = await mint();
  const res = await request(`/api/v1/orgs/${ORG}/usage`, {
    headers: bearer(secret),
  });
  assert.equal(res.status, 200);
  const usage = usageResponseSchema.parse(await res.json());
  assert.deepEqual(usage.runs, counts);
  assert.equal(usage.window.days, 30);
  assert.equal(usage.window.from, "2026-10-13T00:00:00.000Z");
  assert.deepEqual(usageCalls[0], {
    organizationId: ORG,
    since: new Date("2026-10-13T00:00:00.000Z"),
  });
  const week = await request(`/api/v1/orgs/${ORG}/usage?days=7`, {
    headers: signedIn,
  });
  assert.equal(usageResponseSchema.parse(await week.json()).window.days, 7);
  const tooLong = await request(`/api/v1/orgs/${ORG}/usage?days=365`, {
    headers: signedIn,
  });
  assert.equal(tooLong.status, 400);
});

test("usage reports this calendar month's model tokens against the limit", async () => {
  const tokens = (inputTokens: number): ModelTokens => ({
    inputTokens,
    outputTokens: 10,
    cacheReadTokens: 100,
    cacheWriteTokens: 1,
  });
  const ledger = [
    // The last instant of October: last month's, so not counted.
    {
      organizationId: ORG,
      at: new Date("2026-10-31T23:59:59.999Z"),
      tokens: tokens(5_000),
    },
    {
      organizationId: ORG,
      at: new Date("2026-11-01T00:00:00.000Z"),
      tokens: tokens(200),
    },
    {
      organizationId: ORG,
      at: new Date("2026-11-10T09:00:00.000Z"),
      tokens: tokens(300),
    },
    // Another workspace's.
    {
      organizationId: OTHER_ORG,
      at: new Date("2026-11-10T09:00:00.000Z"),
      tokens: tokens(9_000),
    },
  ];
  let clock = new Date("2026-11-12T08:30:00.000Z");
  const { request, tokenCalls } = setup({
    now: () => clock,
    ledger,
    monthlyModelTokens: 1_000,
  });
  const read = async () => {
    const res = await request(`/api/v1/orgs/${ORG}/usage?days=7`, {
      headers: signedIn,
    });
    assert.equal(res.status, 200);
    return usageResponseSchema.parse(await res.json()).modelTokens;
  };
  // Whatever window the runs are counted over, tokens are this month's.
  assert.deepEqual(await read(), {
    from: "2026-11-01T00:00:00.000Z",
    resetsAt: "2026-12-01T00:00:00.000Z",
    used: 500 + 20 + 200 + 2,
    limit: 1_000,
    remaining: 1_000 - 722,
    inputTokens: 500,
    outputTokens: 20,
    cacheReadTokens: 200,
    cacheWriteTokens: 2,
  });
  assert.deepEqual(tokenCalls[0], {
    organizationId: ORG,
    since: new Date("2026-11-01T00:00:00.000Z"),
  });
  // Past the limit, nothing is left; it is not negative.
  ledger.push({
    organizationId: ORG,
    at: new Date("2026-11-11T00:00:00.000Z"),
    tokens: tokens(5_000),
  });
  const spent = await read();
  assert.equal(spent.used, 722 + 5_111);
  assert.equal(spent.remaining, 0);
  // The month rolls over at midnight UTC on the first: the count starts
  // again, and the next reset is a month on.
  clock = new Date("2026-12-01T00:00:00.000Z");
  assert.deepEqual(await read(), {
    from: "2026-12-01T00:00:00.000Z",
    resetsAt: "2027-01-01T00:00:00.000Z",
    used: 0,
    limit: 1_000,
    remaining: 1_000,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
});

test("usage reports the default monthly limit when none is configured", async () => {
  const { request } = setup({ now: () => new Date("2026-11-12T00:00:00Z") });
  const res = await request(`/api/v1/orgs/${ORG}/usage`, {
    headers: signedIn,
  });
  const usage = usageResponseSchema.parse(await res.json());
  assert.equal(usage.modelTokens.limit, 10_000_000);
  assert.equal(usage.modelTokens.remaining, 10_000_000);
});

test("a failed use record and a failed sign-out are logged, not fatal", async () => {
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  try {
    const tokens = memoryTokens();
    tokens.touch = () => Promise.reject(new Error("database down"));
    const auth = fakeAuth();
    (auth.api as unknown as { signOut: () => Promise<never> }).signOut = () =>
      Promise.reject(new Error("gone"));
    const server = createApp({
      corsOrigins: [],
      auth,
      organizations: roleStore({ [`${ada.id}:${ORG}`]: "owner" }),
      apiTokens: tokens,
    });
    const minted = await server.request(`/api/v1/orgs/${ORG}/tokens/cli`, {
      method: "POST",
      headers: {
        ...deviceSession("carveout"),
        "content-type": "application/json",
      },
      body: JSON.stringify({ client: "carveout" }),
    });
    assert.equal(minted.status, 201);
    const { secret } = createdApiTokenResponseSchema.parse(await minted.json());
    const res = await server.request("/api/v1/me", {
      headers: { authorization: `Bearer ${secret}` },
    });
    assert.equal(res.status, 200);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(errors.length, 2);
  } finally {
    console.error = original;
  }
});
