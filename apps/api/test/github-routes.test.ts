import assert from "node:assert/strict";
import { test } from "node:test";

import {
  githubAvailableInstallationDtoSchema,
  githubConnectionDtoSchema,
  githubInstallationRepositoryDtoSchema,
  githubRepoDtoSchema,
} from "@sandbox-factory/shared";

import { RepositoryInUseError } from "@sandbox-factory/db";

import type { Auth } from "../src/auth.js";
import { signState, verifyState } from "../src/connect-state.js";
import { createApp } from "../src/routes.js";
import {
  fakeGithub,
  installationTokens,
  memoryGithub,
  NOW,
  SHA_A,
  SHA_B,
  seedConnection,
  seedRepo,
  world,
  type GithubWorld,
  type MemoryGithub,
} from "./github-fakes.js";

/**
 * The GitHub connection routes.
 *
 * What is tested is the boundary: that an installation is linked only when
 * the person's own GitHub token lists it, that one held by another
 * organization is never moved, that only owners and admins connect, and that
 * every way the flow can end is a redirect the web app can explain.
 */

const dana = { id: "user_1", email: "dana@example.test", name: "Dana" };
const SECRET = "0123456789abcdef0123456789abcdef";
const signedIn = { cookie: "session=1" };

function fakeAuth(): Auth {
  return {
    api: {
      getSession: ({ headers }: { headers: Headers }) =>
        Promise.resolve(
          headers.get("cookie") !== null
            ? { user: dana, session: { id: "session_1" } }
            : null,
        ),
    },
    handler: () => Promise.resolve(new Response(null, { status: 404 })),
  } as unknown as Auth;
}

function appWith(
  options: {
    world?: GithubWorld;
    stores?: MemoryGithub;
    role?: string;
    roleNow?: () => string | undefined;
  } = {},
) {
  const state = options.world ?? world();
  const fetch = fakeGithub(state);
  const stores = options.stores ?? memoryGithub();
  const app = createApp({
    corsOrigins: ["https://app.test"],
    auth: fakeAuth(),
    organizations: {
      roleOf: (_userId: string, organizationId: string) => {
        if (organizationId !== "org_1") return Promise.resolve(undefined);
        return Promise.resolve(
          options.roleNow !== undefined
            ? options.roleNow()
            : (options.role ?? "owner"),
        );
      },
    } as never,
    github: {
      ...stores,
      installations: installationTokens(fetch),
      appSlug: "sandbox-factory",
      clientId: "Iv1.app",
      clientSecret: "app-secret",
      webhookSecret: "webhook-secret",
      secret: SECRET,
      apiUrl: "https://platform.test",
      appUrl: "https://platform.test",
      fetch,
      now: () => NOW,
    },
  });
  return { app, stores, fetch, state };
}

/**
 * The same app with every request to `host` failing as undici's does when
 * nothing answers. Rebuilt rather than patched, since `fetch` is an option.
 */
function appFailingAt(
  host: string,
  stores: MemoryGithub = memoryGithub(),
): ReturnType<typeof appWith>["app"] {
  const inner = fakeGithub(world());
  const failing = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    if (new URL(String(input)).host === host) {
      throw new TypeError("fetch failed");
    }
    return inner(input, init);
  }) as typeof globalThis.fetch;
  return createApp({
    corsOrigins: ["https://app.test"],
    auth: fakeAuth(),
    organizations: {
      roleOf: () => Promise.resolve("owner"),
    } as never,
    github: {
      ...stores,
      installations: installationTokens(failing),
      appSlug: "sandbox-factory",
      clientId: "Iv1.app",
      clientSecret: "app-secret",
      webhookSecret: "webhook-secret",
      secret: SECRET,
      apiUrl: "https://platform.test",
      appUrl: "https://platform.test",
      fetch: failing,
      now: () => NOW,
    },
  });
}

function stateFor(
  organizationId = "org_1",
  returnTo = "/o/acme/settings?connection=github",
) {
  return signState(SECRET, "github", {
    organizationId,
    userId: dana.id,
    returnTo,
    issuedAt: NOW,
  });
}

/** Calls the callback and reads where it sent the browser. */
async function callback(
  app: ReturnType<typeof appWith>["app"],
  query: Record<string, string>,
): Promise<URL> {
  const response = await app.request(
    `/api/v1/github/callback?${new URLSearchParams(query).toString()}`,
    { headers: signedIn },
  );
  assert.equal(response.status, 302);
  return new URL(response.headers.get("location") ?? "");
}

/* ---- connect ------------------------------------------------------------- */

test("connect sends an owner to the App's OAuth authorize URL, not the install page", async () => {
  const { app } = appWith();

  const response = await app.request(
    "/api/v1/orgs/org_1/github/connect?returnTo=/o/acme/settings?connection=github",
    { headers: signedIn },
  );

  assert.equal(response.status, 302);
  const location = new URL(response.headers.get("location") ?? "");
  assert.equal(
    location.origin + location.pathname,
    "https://github.com/login/oauth/authorize",
  );
  // The App's own client id: the sign-in OAuth app is a different app.
  assert.equal(location.searchParams.get("client_id"), "Iv1.app");
  assert.equal(
    location.searchParams.get("redirect_uri"),
    "https://platform.test/api/v1/github/callback",
  );
  const verified = verifyState(
    SECRET,
    "github",
    location.searchParams.get("state") ?? "",
    dana.id,
    NOW,
  );
  assert.equal(verified.ok && verified.state.organizationId, "org_1");
  assert.equal(
    verified.ok && verified.state.returnTo,
    "/o/acme/settings?connection=github",
  );
});

test("a plain member may not start the flow", async () => {
  const { app } = appWith({ role: "member" });

  const response = await app.request("/api/v1/orgs/org_1/github/connect", {
    headers: signedIn,
  });

  assert.equal(response.status, 403);
});

test("an off-site returnTo is reduced to the app's root", async () => {
  const { app } = appWith();

  const response = await app.request(
    `/api/v1/orgs/org_1/github/connect?returnTo=${encodeURIComponent("https://evil.test/")}`,
    { headers: signedIn },
  );

  const state =
    new URL(response.headers.get("location") ?? "").searchParams.get("state") ??
    "";
  const verified = verifyState(SECRET, "github", state, dana.id, NOW);
  assert.equal(verified.ok && verified.state.returnTo, "/");
});

/* ---- callback ------------------------------------------------------------ */

test("one free installation in the person's list is linked, and the grant kept", async () => {
  const { app, stores } = appWith();

  const target = await callback(app, { code: "c", state: stateFor() });

  assert.equal(target.pathname, "/o/acme/settings");
  assert.equal(target.searchParams.get("connection"), "github");
  assert.equal(target.searchParams.get("github"), "connected");
  const [connection] = await stores.connections.list("org_1");
  assert.equal(connection?.installationId, "9");
  assert.equal(connection?.accountLogin, "acme");
  const grant = await stores.grants.get("org_1", dana.id);
  assert.equal(grant?.githubLogin, "dana");
});

test("an installation id in the query is linked only when the person's list has it", async () => {
  // The untrusted id: small integers anyone can type.
  const { app, stores } = appWith();

  const target = await callback(app, {
    code: "c",
    state: stateFor(),
    installation_id: "777",
    setup_action: "install",
  });

  assert.equal(target.searchParams.get("github"), "not-visible");
  assert.equal(stores.connections.rows.size, 0);
});

test("an installation linked to another organization is claimed, and nothing is written", async () => {
  const stores = memoryGithub();
  await seedConnection(stores, "org_2", "9");
  const { app } = appWith({ stores });

  const named = await callback(app, {
    code: "c",
    state: stateFor(),
    installation_id: "9",
  });

  assert.equal(named.searchParams.get("github"), "claimed");
  assert.deepEqual(await stores.connections.list("org_1"), []);
  assert.equal(
    (await stores.connections.ownerOf("9"))?.organizationId,
    "org_2",
  );
});

test("a listed installation named in the query is linked, and an update refreshes it", async () => {
  const { app, stores, state } = appWith({
    world: world({
      installations: [
        { id: 9, login: "acme" },
        { id: 10, login: "beta" },
      ],
    }),
  });

  const first = await callback(app, {
    code: "c",
    state: stateFor(),
    installation_id: "10",
    setup_action: "install",
  });
  state.installations = [{ id: 10, login: "beta", selection: "all" }];
  const again = await callback(app, {
    code: "c",
    state: stateFor(),
    installation_id: "10",
    setup_action: "update",
  });

  assert.equal(first.searchParams.get("github"), "connected");
  assert.equal(again.searchParams.get("github"), "connected");
  const listed = await stores.connections.list("org_1");
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.repositorySelection, "all");
});

test("several free installations send the person to the picker", async () => {
  const { app, stores } = appWith({
    world: world({
      installations: [
        { id: 9, login: "acme" },
        { id: 10, login: "beta" },
      ],
    }),
  });

  const target = await callback(app, { code: "c", state: stateFor() });

  assert.equal(target.searchParams.get("github"), "pick");
  assert.equal(stores.connections.rows.size, 0);
});

test("nothing to link goes to the install page with a fresh state", async () => {
  const { app } = appWith({ world: world({ installations: [] }) });
  const original = stateFor();

  const target = await callback(app, { code: "c", state: original });

  assert.equal(
    target.origin + target.pathname,
    "https://github.com/apps/sandbox-factory/installations/new",
  );
  const fresh = target.searchParams.get("state") ?? "";
  assert.notEqual(fresh, original);
  const verified = verifyState(SECRET, "github", fresh, dana.id, NOW);
  assert.equal(verified.ok && verified.state.organizationId, "org_1");
});

test("reconnecting after deleting the connection links again without the install page", async () => {
  // The exit test's path: the App is still installed, so the authorize URL
  // comes straight back and the installation is free again.
  const { app, stores } = appWith();
  await callback(app, { code: "c", state: stateFor() });
  const [connection] = await stores.connections.list("org_1");
  await app.request(`/api/v1/orgs/org_1/github/connections/${connection?.id}`, {
    method: "DELETE",
    headers: signedIn,
  });

  const target = await callback(app, { code: "c", state: stateFor() });

  assert.equal(target.searchParams.get("github"), "connected");
  assert.equal(stores.connections.rows.size, 1);
});

test("connecting again re-links an installation already linked here, and clears its flag", async () => {
  // With nothing else free, the install page would only show GitHub's own
  // settings for an App already installed: the person was stranded there,
  // and a connection marked "Needs attention" could not be cleared.
  const { app, stores } = appWith();
  await callback(app, { code: "c", state: stateFor() });
  const [connection] = await stores.connections.list("org_1");
  assert.ok(connection !== undefined);
  await stores.connections.update("org_1", connection.id, { healthy: false });

  const target = await callback(app, { code: "c", state: stateFor() });

  assert.equal(target.searchParams.get("github"), "connected");
  const listed = await stores.connections.list("org_1");
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.id, connection.id);
  assert.equal(listed[0]?.healthy, true);
});

test("a person demoted mid-flow is refused before the code is spent", async () => {
  let role: string | undefined = "owner";
  const { app, fetch } = appWith({ roleNow: () => role });
  const state = stateFor();
  role = "member";

  const target = await callback(app, { code: "c", state });

  assert.equal(target.searchParams.get("github"), "forbidden");
  assert.equal(fetch.urls.length, 0);
});

test("a state minted for Jira, or none at all, is refused as state", async () => {
  // None at all is also how an install begun on GitHub's App page lands.
  const { app, stores } = appWith();
  const jira = signState(SECRET, "jira", {
    organizationId: "org_1",
    userId: dana.id,
    returnTo: "/",
    issuedAt: NOW,
  });

  const replayed = await callback(app, { code: "c", state: jira });
  const stateless = await callback(app, {
    code: "c",
    installation_id: "9",
    setup_action: "install",
  });

  assert.equal(replayed.searchParams.get("github"), "state");
  assert.equal(stateless.searchParams.get("github"), "state");
  assert.equal(stateless.pathname, "/");
  assert.equal(stores.connections.rows.size, 0);
});

test("pressing Cancel on GitHub is cancelled, not an error", async () => {
  const { app } = appWith();

  const cancelled = await callback(app, {
    error: "access_denied",
    state: stateFor(),
  });
  const failed = await callback(app, {
    error: "server_error",
    state: stateFor(),
  });

  assert.equal(cancelled.searchParams.get("github"), "cancelled");
  assert.equal(cancelled.pathname, "/o/acme/settings");
  assert.equal(failed.searchParams.get("github"), "error");
});

test("a missing code, a refused exchange and a GitHub failure each end as a redirect", async () => {
  const noCode = await callback(appWith().app, { state: stateFor() });
  const denied = await callback(
    appWith({ world: world({ exchangeError: "bad_verification_code" }) }).app,
    {
      code: "spent",
      state: stateFor(),
    },
  );
  const broken = await callback(
    appWith({ world: world({ restStatus: 500 }) }).app,
    {
      code: "c",
      state: stateFor(),
    },
  );

  assert.equal(noCode.searchParams.get("github"), "error");
  assert.equal(denied.searchParams.get("github"), "denied");
  assert.equal(broken.searchParams.get("github"), "error");
});

test("GitHub not answering the exchange is an error, not the person denied", async () => {
  const unreachable = appFailingAt("github.com");

  const target = await callback(unreachable, {
    code: "c",
    state: stateFor(),
  });

  assert.equal(target.searchParams.get("github"), "error");
});

/* ---- the picker ---------------------------------------------------------- */

test("available installations are marked linked, claimed, free, not theirs or unavailable", async () => {
  const stores = memoryGithub();
  const { app } = appWith({
    stores,
    world: world({
      installations: [
        { id: 9, login: "acme" },
        { id: 10, login: "beta" },
        // The person's own account: `/user` is 42.
        { id: 11, login: "dana", type: "User", accountId: 42 },
        // Somebody else's personal account, where Dana collaborates.
        { id: 12, login: "erin", type: "User", accountId: 7 },
        // An organization with repositories Dana cannot read herself.
        { id: 13, login: "gamma", reachable: 0 },
        // Suspended: GitHub will not mint a token to count with.
        { id: 14, login: "delta", suspended: true },
      ],
    }),
  });
  await callback(app, { code: "c", state: stateFor(), installation_id: "9" });
  await seedConnection(stores, "org_2", "10", "beta");

  const response = await app.request(
    "/api/v1/orgs/org_1/github/connections/available",
    {
      headers: signedIn,
    },
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    grant: { githubLogin: string };
    installations: unknown[];
  };
  assert.equal(body.grant.githubLogin, "dana");
  const installations = body.installations.map((entry) =>
    githubAvailableInstallationDtoSchema.parse(entry),
  );
  assert.deepEqual(
    installations.map(({ installationId, status }) => [installationId, status]),
    [
      ["9", "linked"],
      ["10", "claimed"],
      ["11", "free"],
      ["12", "not-authorized"],
      ["13", "not-authorized"],
      ["14", "unavailable"],
    ],
  );
});

/* ---- authority ------------------------------------------------------------ */

test("an installation the person can see but not read in full is refused, and nothing linked", async () => {
  // An outside collaborator on one repository sees the whole organization's
  // installation; linking it would let this workspace read the rest.
  const { app, stores } = appWith({
    world: world({ installations: [{ id: 9, login: "acme", reachable: 0 }] }),
  });

  const named = await callback(app, {
    code: "c",
    state: stateFor(),
    installation_id: "9",
    setup_action: "install",
  });
  const unnamed = await callback(app, { code: "c", state: stateFor() });

  assert.equal(named.searchParams.get("github"), "not-authorized");
  // Not linked without a choice: the picker says why it cannot be.
  assert.equal(unnamed.searchParams.get("github"), "pick");
  assert.equal(stores.connections.rows.size, 0);
});

test("a personal account's installation is linked only by that account", async () => {
  const theirs = appWith({
    world: world({
      installations: [{ id: 11, login: "erin", type: "User", accountId: 7 }],
    }),
  });
  const own = appWith({
    world: world({
      installations: [{ id: 11, login: "dana", type: "User", accountId: 42 }],
    }),
  });

  const refused = await callback(theirs.app, {
    code: "c",
    state: stateFor(),
    installation_id: "11",
  });
  const linked = await callback(own.app, {
    code: "c",
    state: stateFor(),
    installation_id: "11",
  });

  assert.equal(refused.searchParams.get("github"), "not-authorized");
  assert.equal(theirs.stores.connections.rows.size, 0);
  assert.equal(linked.searchParams.get("github"), "connected");
  // A personal account needs no token to decide: nothing was minted.
  assert.ok(!own.fetch.urls.some((url) => url.includes("/access_tokens")));
});

test("only the person's own installation is linked when others are visible too", async () => {
  const { app, stores } = appWith({
    world: world({
      installations: [
        { id: 9, login: "acme", reachable: 0 },
        { id: 10, login: "beta" },
      ],
    }),
  });

  const target = await callback(app, { code: "c", state: stateFor() });

  assert.equal(target.searchParams.get("github"), "connected");
  assert.deepEqual(
    (await stores.connections.list("org_1")).map(
      (entry) => entry.installationId,
    ),
    ["10"],
  );
});

test("a suspended organization installation cannot be checked, so it is unavailable", async () => {
  const { app, stores } = appWith({
    world: world({
      installations: [{ id: 9, login: "acme", suspended: true }],
    }),
  });

  const target = await callback(app, {
    code: "c",
    state: stateFor(),
    installation_id: "9",
  });

  assert.equal(target.searchParams.get("github"), "unavailable");
  assert.equal(stores.connections.rows.size, 0);
});

test("the picker refuses an installation that is not the person's to link", async () => {
  const stores = memoryGithub();
  const { app } = appWith({
    stores,
    world: world({
      installations: [
        { id: 9, login: "acme", reachable: 0 },
        { id: 10, login: "beta", suspended: true },
        { id: 11, login: "gamma" },
        { id: 12, login: "delta" },
      ],
    }),
  });
  await callback(app, { code: "c", state: stateFor() }); // pick: stores the grant
  const post = (installationId: string) =>
    app.request("/api/v1/orgs/org_1/github/connections", {
      method: "POST",
      headers: { ...signedIn, "content-type": "application/json" },
      body: JSON.stringify({ installationId }),
    });

  const notTheirs = await post("9");
  const suspended = await post("10");

  assert.equal(notTheirs.status, 403);
  assert.equal(
    ((await notTheirs.json()) as { code: string }).code,
    "not-authorized",
  );
  assert.equal(suspended.status, 409);
  assert.equal(
    ((await suspended.json()) as { code: string }).code,
    "unavailable",
  );
  assert.equal(stores.connections.rows.size, 0);
});

test("a GitHub failure while checking authority is a 502, not a 500", async () => {
  const state = world({
    installations: [
      { id: 9, login: "acme" },
      { id: 10, login: "beta" },
    ],
  });
  const { app } = appWith({ world: state });
  await callback(app, { code: "c", state: stateFor() }); // pick: stores the grant
  state.reachStatus = 500;
  const post = await app.request("/api/v1/orgs/org_1/github/connections", {
    method: "POST",
    headers: { ...signedIn, "content-type": "application/json" },
    body: JSON.stringify({ installationId: "9" }),
  });
  const listed = await app.request(
    "/api/v1/orgs/org_1/github/connections/available",
    { headers: signedIn },
  );

  assert.equal(post.status, 502);
  assert.equal(listed.status, 502);
});

test("the picker needs the person's own grant first", async () => {
  const { app } = appWith();

  const response = await app.request(
    "/api/v1/orgs/org_1/github/connections/available",
    {
      headers: signedIn,
    },
  );

  assert.equal(response.status, 409);
  assert.equal(((await response.json()) as { code: string }).code, "reconnect");
});

test("linking from the picker takes only an installation the person can see", async () => {
  const stores = memoryGithub();
  const { app } = appWith({
    stores,
    world: world({
      installations: [
        { id: 9, login: "acme" },
        { id: 10, login: "beta" },
      ],
    }),
  });
  await callback(app, { code: "c", state: stateFor() }); // pick: stores the grant
  await seedConnection(stores, "org_2", "10", "beta");
  const post = (installationId: unknown) =>
    app.request("/api/v1/orgs/org_1/github/connections", {
      method: "POST",
      headers: { ...signedIn, "content-type": "application/json" },
      body: JSON.stringify({ installationId }),
    });

  const unlisted = await post("777");
  const claimed = await post("10");
  const malformed = await post("../9");
  const linked = await post("9");

  assert.equal(unlisted.status, 404);
  assert.equal(claimed.status, 409);
  assert.equal(((await claimed.json()) as { code: string }).code, "claimed");
  assert.equal(malformed.status, 400);
  assert.equal(linked.status, 201);
  const { connection } = (await linked.json()) as { connection: unknown };
  assert.equal(githubConnectionDtoSchema.parse(connection).installationId, "9");
  assert.deepEqual(
    (await stores.connections.list("org_1")).map(
      (entry) => entry.installationId,
    ),
    ["9"],
  );
});

test("a revoked grant is flagged and answered as reconnect", async () => {
  const stores = memoryGithub();
  const { app, state } = appWith({
    stores,
    world: world({ installations: [] }),
  });
  await callback(app, { code: "c", state: stateFor() });
  state.restStatus = 401;

  const response = await app.request(
    "/api/v1/orgs/org_1/github/connections/available",
    {
      headers: signedIn,
    },
  );

  assert.equal(response.status, 409);
  assert.equal((await stores.grants.get("org_1", dana.id))?.healthy, false);
  // And the next call does not try GitHub again.
  const again = await app.request(
    "/api/v1/orgs/org_1/github/connections/available",
    {
      headers: signedIn,
    },
  );
  assert.equal(again.status, 409);
});

test("a token refresh GitHub refuses or never answers is said as such, not as a server fault", async () => {
  for (const [exchangeError, status, code] of [
    // A spent grant: connect again.
    ["bad_refresh_token", 409, "reconnect"],
    // Refused for this server's own credentials: connecting again would
    // fail the same way, so it is a server fault, thrown and logged.
    ["incorrect_client_credentials", 500, null],
  ] as const) {
    const stores = memoryGithub();
    const { app, state } = appWith({
      stores,
      world: world({ installations: [] }),
    });
    await callback(app, { code: "c", state: stateFor() });
    // The access token has lapsed, so the picker refreshes it first.
    const tokens = await stores.grants.tokens("org_1", dana.id);
    assert.ok(tokens !== null);
    await stores.grants.saveTokens(
      "org_1",
      dana.id,
      tokens.credentialRevision,
      {
        ...tokens,
        expiresAt: new Date(NOW - 60_000).toISOString(),
      } as never,
    );
    state.exchangeError = exchangeError;

    const response = await app.request(
      "/api/v1/orgs/org_1/github/connections/available",
      { headers: signedIn },
    );

    assert.equal(response.status, status, exchangeError);
    if (code !== null)
      assert.equal(((await response.json()) as { code: string }).code, code);
  }
  // Nothing answered at all is GitHub's trouble, worth a retry.
  const stores = memoryGithub();
  const { app } = appWith({ stores, world: world({ installations: [] }) });
  await callback(app, { code: "c", state: stateFor() });
  const tokens = await stores.grants.tokens("org_1", dana.id);
  assert.ok(tokens !== null);
  await stores.grants.saveTokens("org_1", dana.id, tokens.credentialRevision, {
    ...tokens,
    expiresAt: new Date(NOW - 60_000).toISOString(),
  } as never);
  const silent = appFailingAt("github.com", stores);
  const response = await silent.request(
    "/api/v1/orgs/org_1/github/connections/available",
    { headers: signedIn },
  );
  assert.equal(response.status, 502);
  assert.equal(((await response.json()) as { code: string }).code, "github");
});

test("a rate-limited picker says when to retry", async () => {
  const stores = memoryGithub();
  const { app, state } = appWith({
    stores,
    world: world({ installations: [] }),
  });
  await callback(app, { code: "c", state: stateFor() });
  state.restStatus = 429;

  const response = await app.request(
    "/api/v1/orgs/org_1/github/connections/available",
    {
      headers: signedIn,
    },
  );

  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get("retry-after")) >= 1);
});

test("picker routes are for owners and admins", async () => {
  const { app } = appWith({ role: "member" });

  const available = await app.request(
    "/api/v1/orgs/org_1/github/connections/available",
    {
      headers: signedIn,
    },
  );
  const link = await app.request("/api/v1/orgs/org_1/github/connections", {
    method: "POST",
    headers: { ...signedIn, "content-type": "application/json" },
    body: JSON.stringify({ installationId: "9" }),
  });

  assert.equal(available.status, 403);
  assert.equal(link.status, 403);
});

/* ---- connections --------------------------------------------------------- */

test("connections list as strict DTOs with the installation's settings page", async () => {
  const stores = memoryGithub();
  await seedConnection(stores, "org_1", "9");
  await seedConnection(stores, "org_2", "10", "beta");
  const { app } = appWith({ stores });

  const response = await app.request("/api/v1/orgs/org_1/github/connections", {
    headers: signedIn,
  });

  const { connections } = (await response.json()) as { connections: unknown[] };
  assert.equal(connections.length, 1);
  const connection = githubConnectionDtoSchema.parse(connections[0]);
  assert.equal(
    connection.settingsUrl,
    "https://github.com/organizations/acme/settings/installations/9",
  );
});

test("deleting a connection is for owners and admins, and takes its repositories", async () => {
  const stores = memoryGithub();
  const connectionId = await seedConnection(stores, "org_1", "9");
  await seedRepo(stores, "org_1", connectionId);
  const owner = appWith({ stores }).app;
  const member = appWith({ stores, role: "member" }).app;
  const remove = (app: typeof owner, id: string) =>
    app.request(`/api/v1/orgs/org_1/github/connections/${id}`, {
      method: "DELETE",
      headers: signedIn,
    });

  assert.equal((await remove(member, connectionId)).status, 403);
  assert.equal((await remove(owner, connectionId)).status, 204);
  assert.equal((await remove(owner, connectionId)).status, 404);
  assert.equal(stores.repos.rows.size, 0);
});

test("another organization's routes are a 404 at the membership guard", async () => {
  const { app } = appWith();

  const response = await app.request("/api/v1/orgs/org_2/github/connections", {
    headers: signedIn,
  });

  assert.equal(response.status, 404);
});

test("another organization's connection or repository named in our path is a 404", async () => {
  // The membership guard passes, so only the stores' owner scoping stands
  // between org_1's path and org_2's rows.
  const stores = memoryGithub();
  const { app } = appWith({ stores });
  const theirs = await seedConnection(stores, "org_2", "10", "beta");
  const theirRepo = await seedRepo(stores, "org_2", theirs);
  const request = (method: string, path: string, body?: unknown) =>
    app.request(`/api/v1/orgs/org_1/github${path}`, {
      method,
      headers: { ...signedIn, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const responses = [
    await request("GET", `/connections/${theirs}/repositories`),
    await request("POST", `/connections/${theirs}/repositories`, {
      externalId: "1296269",
      role: "source",
    }),
    await request("DELETE", `/connections/${theirs}`),
    await request("DELETE", `/repositories/${theirRepo}`),
  ];

  assert.deepEqual(
    responses.map((response) => response.status),
    [404, 404, 404, 404],
  );
  assert.equal(stores.connections.rows.has(theirs), true);
  assert.equal(stores.repos.rows.has(theirRepo), true);
});

test("without the App, GitHub's routes say so with a 503 a member can read", async () => {
  const app = createApp({
    corsOrigins: ["https://app.test"],
    auth: fakeAuth(),
    organizations: {
      roleOf: (_userId: string, organizationId: string) =>
        Promise.resolve(organizationId === "org_1" ? "member" : undefined),
    } as never,
  });

  const member = await app.request("/api/v1/orgs/org_1/github/connections", {
    headers: signedIn,
  });
  const stranger = await app.request("/api/v1/orgs/org_2/github/connections", {
    headers: signedIn,
  });
  const webhook = await app.request("/api/github/webhook", { method: "POST" });

  assert.equal(member.status, 503);
  assert.equal(
    ((await member.json()) as { code: string }).code,
    "unconfigured",
  );
  assert.equal(stranger.status, 404);
  // No secret to check a delivery against, so no webhook either.
  assert.equal(webhook.status, 404);
});

/* ---- repositories -------------------------------------------------------- */

test("an installation's repositories are listed live and marked when registered", async () => {
  const stores = memoryGithub();
  const connectionId = await seedConnection(stores, "org_1", "9");
  const { app } = appWith({
    stores,
    world: world({
      repositories: [
        { id: 2, full_name: "acme/zebra", default_branch: "main" },
        {
          id: 1296269,
          full_name: "acme/widgets",
          default_branch: "main",
          private: false,
        },
      ],
    }),
  });
  const repoId = await seedRepo(stores, "org_1", connectionId);

  const response = await app.request(
    `/api/v1/orgs/org_1/github/connections/${connectionId}/repositories`,
    { headers: signedIn },
  );

  const { repositories } = (await response.json()) as {
    repositories: unknown[];
  };
  const listed = repositories.map((entry) =>
    githubInstallationRepositoryDtoSchema.parse(entry),
  );
  assert.deepEqual(
    listed.map(({ fullName, registeredId }) => [fullName, registeredId]),
    [
      ["acme/widgets", repoId],
      ["acme/zebra", null],
    ],
  );
  assert.equal(listed[0]?.isPrivate, false);
});

test("registering reads the head before answering, so the row comes back ok", async () => {
  const stores = memoryGithub();
  const connectionId = await seedConnection(stores, "org_1", "9");
  const { app } = appWith({ stores });

  const response = await app.request(
    `/api/v1/orgs/org_1/github/connections/${connectionId}/repositories`,
    {
      method: "POST",
      headers: { ...signedIn, "content-type": "application/json" },
      body: JSON.stringify({ externalId: "1296269", role: "source" }),
    },
  );

  assert.equal(response.status, 201);
  const { repository } = (await response.json()) as { repository: unknown };
  const repo = githubRepoDtoSchema.parse(repository);
  assert.equal(repo.syncStatus, "ok");
  assert.equal(repo.headSha, SHA_B);
  assert.equal(repo.fullName, "acme/widgets");

  const listed = await app.request("/api/v1/orgs/org_1/github/repositories", {
    headers: signedIn,
  });
  const { repositories } = (await listed.json()) as { repositories: unknown[] };
  assert.equal(githubRepoDtoSchema.parse(repositories[0]).id, repo.id);
});

test("a repository outside the installation cannot be registered by id", async () => {
  // Public repositories are readable with any token; the installation's own
  // listing is what decides.
  const stores = memoryGithub();
  const connectionId = await seedConnection(stores, "org_1", "9");
  const { app } = appWith({ stores });
  const register = (body: unknown) =>
    app.request(
      `/api/v1/orgs/org_1/github/connections/${connectionId}/repositories`,
      {
        method: "POST",
        headers: { ...signedIn, "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );

  assert.equal(
    (await register({ externalId: "424242", role: "source" })).status,
    404,
  );
  assert.equal(
    (await register({ externalId: "1296269", role: "sandbox" })).status,
    400,
  );
  assert.equal(stores.repos.rows.size, 0);
});

test("an empty repository registers with an error the table can show", async () => {
  const stores = memoryGithub();
  const connectionId = await seedConnection(stores, "org_1", "9");
  const { app } = appWith({
    stores,
    world: world({ heads: { "acme/widgets@main": "empty" } }),
  });

  const response = await app.request(
    `/api/v1/orgs/org_1/github/connections/${connectionId}/repositories`,
    {
      method: "POST",
      headers: { ...signedIn, "content-type": "application/json" },
      body: JSON.stringify({ externalId: "1296269", role: "source" }),
    },
  );

  const { repository } = (await response.json()) as {
    repository: { syncStatus: string; syncError: string };
  };
  assert.equal(repository.syncStatus, "error");
  assert.match(repository.syncError, /no commits/);
});

test("a missing default branch registers as an error too", async () => {
  const stores = memoryGithub();
  const connectionId = await seedConnection(stores, "org_1", "9");
  const { app } = appWith({ stores, world: world({ heads: {} }) });

  const response = await app.request(
    `/api/v1/orgs/org_1/github/connections/${connectionId}/repositories`,
    {
      method: "POST",
      headers: { ...signedIn, "content-type": "application/json" },
      body: JSON.stringify({ externalId: "1296269", role: "source" }),
    },
  );

  const { repository } = (await response.json()) as {
    repository: { syncError: string };
  };
  assert.match(repository.syncError, /default branch main was not found/);
});

test("registering and removing are for owners and admins", async () => {
  const stores = memoryGithub();
  const connectionId = await seedConnection(stores, "org_1", "9");
  const repoId = await seedRepo(stores, "org_1", connectionId);
  const { app } = appWith({ stores, role: "member" });

  const register = await app.request(
    `/api/v1/orgs/org_1/github/connections/${connectionId}/repositories`,
    {
      method: "POST",
      headers: { ...signedIn, "content-type": "application/json" },
      body: JSON.stringify({ externalId: "1296269", role: "source" }),
    },
  );
  const remove = await app.request(
    `/api/v1/orgs/org_1/github/repositories/${repoId}`,
    {
      method: "DELETE",
      headers: signedIn,
    },
  );
  // A member may still read the list.
  const listed = await app.request("/api/v1/orgs/org_1/github/repositories", {
    headers: signedIn,
  });

  assert.equal(register.status, 403);
  assert.equal(remove.status, 403);
  assert.equal(listed.status, 200);
});

test("removing a repository deletes the owner's row only", async () => {
  const stores = memoryGithub();
  const connectionId = await seedConnection(stores, "org_1", "9");
  const repoId = await seedRepo(stores, "org_1", connectionId);
  const { app } = appWith({ stores });
  const remove = () =>
    app.request(`/api/v1/orgs/org_1/github/repositories/${repoId}`, {
      method: "DELETE",
      headers: signedIn,
    });

  assert.equal((await remove()).status, 204);
  assert.equal((await remove()).status, 404);
});

test("a repository or connection a sandbox is built from answers 409, not 500", async () => {
  const stores = memoryGithub();
  const connectionId = await seedConnection(stores, "org_1", "9");
  const repoId = await seedRepo(stores, "org_1", connectionId);
  const inUse = async (): Promise<never> => {
    throw new RepositoryInUseError();
  };
  // Whichever removal the route picks, the store refuses the same way.
  stores.repos.remove = inUse;
  stores.repos.removeWithObjects = inUse;
  stores.connections.remove = inUse;
  stores.connections.removeWithTrees = inUse;
  const { app } = appWith({ stores });
  for (const path of [
    `repositories/${repoId}`,
    `connections/${connectionId}`,
  ]) {
    const response = await app.request(`/api/v1/orgs/org_1/github/${path}`, {
      method: "DELETE",
      headers: signedIn,
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: new RepositoryInUseError().message,
      code: "repository_in_use",
    });
  }
  assert.equal(stores.repos.rows.has(repoId), true);
});

test("an unknown or unhealthy connection is answered before GitHub is asked", async () => {
  const stores = memoryGithub();
  const connectionId = await seedConnection(stores, "org_1", "9");
  await stores.connections.update("org_1", connectionId, { healthy: false });
  const { app, fetch } = appWith({ stores });

  const missing = await app.request(
    "/api/v1/orgs/org_1/github/connections/ghc_x/repositories",
    {
      headers: signedIn,
    },
  );
  const unhealthy = await app.request(
    `/api/v1/orgs/org_1/github/connections/${connectionId}/repositories`,
    { headers: signedIn },
  );
  const register = await app.request(
    `/api/v1/orgs/org_1/github/connections/${connectionId}/repositories`,
    {
      method: "POST",
      headers: { ...signedIn, "content-type": "application/json" },
      body: JSON.stringify({ externalId: "1296269", role: "source" }),
    },
  );
  const registerMissing = await app.request(
    "/api/v1/orgs/org_1/github/connections/ghc_x/repositories",
    {
      method: "POST",
      headers: { ...signedIn, "content-type": "application/json" },
      body: JSON.stringify({ externalId: "1296269", role: "source" }),
    },
  );

  assert.equal(missing.status, 404);
  assert.equal(unhealthy.status, 409);
  assert.equal(register.status, 409);
  assert.equal(registerMissing.status, 404);
  assert.equal(fetch.urls.length, 0);
});

test("an installation GitHub no longer mints for is flagged unhealthy", async () => {
  const stores = memoryGithub();
  const connectionId = await seedConnection(stores, "org_1", "9");
  const { app } = appWith({ stores, world: world({ uninstalled: [9] }) });

  const response = await app.request(
    `/api/v1/orgs/org_1/github/connections/${connectionId}/repositories`,
    { headers: signedIn },
  );

  assert.equal(response.status, 409);
  assert.equal(
    (await stores.connections.get("org_1", connectionId))?.healthy,
    false,
  );
});

test("any other GitHub failure while listing is a 502, not a 500", async () => {
  const stores = memoryGithub();
  const connectionId = await seedConnection(stores, "org_1", "9");
  const { app } = appWith({ stores, world: world({ restStatus: 500 }) });

  const response = await app.request(
    `/api/v1/orgs/org_1/github/connections/${connectionId}/repositories`,
    { headers: signedIn },
  );

  assert.equal(response.status, 502);
  assert.equal(
    (await stores.connections.get("org_1", connectionId))?.healthy,
    true,
  );
});

test("the head a repository was registered at is the one GitHub reports", async () => {
  // Guards the seed helpers this suite leans on: a seeded repo is synced at A.
  const stores = memoryGithub();
  const connectionId = await seedConnection(stores, "org_1", "9");
  const repoId = await seedRepo(stores, "org_1", connectionId);

  assert.equal((await stores.repos.get("org_1", repoId))?.headSha, SHA_A);
});
