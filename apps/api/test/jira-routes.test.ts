import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  JiraBoardStore,
  JiraBoardSummary,
  JiraConnectionInput,
  JiraConnectionStore,
  JiraConnectionSummary,
  RegisterBoardInput,
} from "@sandbox-factory/db";

import type { Auth } from "../src/auth.js";
import { signState } from "../src/jira/state.js";
import { createApp } from "../src/routes.js";

/**
 * The Jira connection routes.
 *
 * What is tested here is the boundary, not Atlassian: who may start the flow,
 * that the callback trusts only the signed state, and that a failure ends as a
 * redirect the user can act on rather than a 500.
 */

const dana = { id: "user_1", email: "dana@example.test", name: "Dana" };
const stranger = { id: "user_2", email: "stranger@example.test", name: "S" };

const SECRET = "0123456789abcdef0123456789abcdef";
const API_URL = "https://api.test";
const APP_URL = "https://app.test";

function fakeAuth(user = dana): Auth {
  return {
    api: {
      getSession: ({ headers }: { headers: Headers }) =>
        Promise.resolve(
          headers.get("cookie") !== null
            ? { user, session: { id: `session_${user.id}` } }
            : null,
        ),
    },
    handler: () => Promise.resolve(new Response(null, { status: 404 })),
  } as unknown as Auth;
}

/** Records what reached the store, so the tests can assert on it. */
function fakeConnections(
  overrides: Partial<JiraConnectionSummary> = {},
): JiraConnectionStore & {
  upserts: { organizationId: string; input: JiraConnectionInput }[];
  removed: string[];
  unhealthy: string[];
} {
  const upserts: { organizationId: string; input: JiraConnectionInput }[] = [];
  const removed: string[] = [];
  const unhealthy: string[] = [];
  const summary: JiraConnectionSummary = {
    id: "jrc_1",
    cloudId: "cloud-1",
    siteUrl: "https://acme.atlassian.net",
    siteName: "Acme",
    email: null,
    healthy: true,
    scopes: ["read:jira-work"],
    createdAt: "2026-09-21T00:00:00.000Z",
    ...overrides,
  };
  return {
    upserts,
    removed,
    unhealthy,
    list: () => Promise.resolve([summary]),
    get: () => Promise.resolve(summary),
    upsert: (organizationId, input) => {
      upserts.push({ organizationId, input });
      return Promise.resolve(summary);
    },
    tokens: () =>
      Promise.resolve({
        accessToken: "access-1",
        refreshToken: "refresh-1",
        // Far future, so no test accidentally exercises the refresh path.
        expiresAt: "2099-01-01T00:00:00.000Z",
        scopes: ["read:jira-work"],
      }),
    saveTokens: () => Promise.resolve(),
    markUnhealthy: (id) => {
      unhealthy.push(id);
      return Promise.resolve();
    },
    remove: (_organizationId, id) => {
      removed.push(id);
      return Promise.resolve(id === "jrc_1");
    },
  };
}

/** Atlassian, faked: one token response and one accessible-resources list. */
function fakeAtlassian(
  options: {
    tokenStatus?: number;
    tokenBody?: unknown;
    sites?: unknown;
    scope?: string;
  } = {},
): typeof globalThis.fetch {
  return (async (url: string | URL | Request) => {
    const href = String(url);
    // Checked before the token branch and by suffix, not substring: Atlassian
    // serves the site list from `/oauth/token/accessible-resources`, which
    // *contains* `/oauth/token`, so a substring test answers the site call
    // with a token payload and the exchange appears to fail.
    if (href.endsWith("/accessible-resources")) {
      return new Response(
        JSON.stringify(
          options.sites ?? [
            {
              id: "cloud-1",
              url: "https://acme.atlassian.net",
              name: "Acme",
              scopes: ["read:jira-work"],
            },
          ],
        ),
        { status: 200 },
      );
    }
    if (href.endsWith("/oauth/token")) {
      return new Response(
        JSON.stringify(
          options.tokenBody ?? {
            access_token: "access-1",
            refresh_token: "refresh-1",
            expires_in: 3600,
            scope:
              options.scope ??
              "read:jira-work read:jira-user read:board-scope:jira-software read:sprint:jira-software offline_access",
          },
        ),
        { status: options.tokenStatus ?? 200 },
      );
    }
    throw new Error(`unexpected request to ${href}`);
  }) as typeof globalThis.fetch;
}

/** The board store, faked. Records registrations and settings edits. */
function fakeBoards(
  overrides: Partial<JiraBoardSummary> = {},
): JiraBoardStore & {
  registered: RegisterBoardInput[];
  updates: unknown[];
} {
  const registered: RegisterBoardInput[] = [];
  const updates: unknown[] = [];
  const board: JiraBoardSummary = {
    id: "jrb_1",
    connectionId: "jrc_1",
    externalId: "42",
    name: "Acme Board",
    boardType: "scrum",
    projectKey: "ACME",
    selection: {
      maxTickets: 10,
      excludeAssigned: true,
      issueTypes: [],
      minAgeDays: 0,
      minSpecChars: 0,
    },
    writebackEnabled: false,
    createdAt: "2026-09-21T00:00:00.000Z",
    ...overrides,
  };
  return {
    registered,
    updates,
    list: () => Promise.resolve([board]),
    get: (_organizationId, id) =>
      Promise.resolve(id === board.id ? board : null),
    register: (_organizationId, input) => {
      registered.push(input);
      return Promise.resolve({
        ...board,
        ...input,
        externalId: input.externalId,
      });
    },
    update: (_organizationId, id, input) => {
      if (id !== board.id) {
        return Promise.resolve(null);
      }
      updates.push(input);
      return Promise.resolve(board);
    },
    remove: () => Promise.resolve(true),
    forRun: (_organizationId, id) =>
      Promise.resolve(
        id === board.id
          ? {
              board,
              connectionId: board.connectionId,
              cloudId: "cloud-1",
              siteUrl: "https://acme.atlassian.net",
            }
          : null,
      ),
  };
}

/**
 * Jira's REST API, faked at the two endpoints these routes call.
 *
 * Records every URL so a test can assert on the JQL, which is the part of the
 * preview that decides which tickets a client is shown.
 */
function fakeJiraApi(
  options: {
    boards?: unknown[];
    issues?: unknown[];
    status?: number;
  } = {},
): typeof globalThis.fetch & { urls: string[] } {
  const urls: string[] = [];
  const impl = (async (url: string | URL | Request) => {
    const href = String(url);
    urls.push(href);
    if (options.status !== undefined && options.status >= 400) {
      return new Response(JSON.stringify({ errorMessages: ["nope"] }), {
        status: options.status,
      });
    }
    if (href.includes("/rest/agile/1.0/board?")) {
      return new Response(
        JSON.stringify({
          values: options.boards ?? [
            {
              id: 42,
              name: "Acme Board",
              type: "scrum",
              location: { projectKey: "ACME", projectName: "Acme" },
            },
          ],
          isLast: true,
        }),
        { status: 200 },
      );
    }
    if (href.includes("/backlog") || href.includes("/board/42/issue")) {
      return new Response(
        JSON.stringify({
          issues: options.issues ?? [issueResponse(1), issueResponse(2)],
          total: 2,
          startAt: 0,
          maxResults: 10,
        }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected request to ${href}`);
  }) as typeof globalThis.fetch & { urls: string[] };
  impl.urls = urls;
  return impl;
}

/** One issue as Jira returns it, old enough to be a backlog candidate. */
function issueResponse(n: number): unknown {
  return {
    id: String(1000 + n),
    key: `ACME-${n}`,
    fields: {
      summary: `Ticket ${n}`,
      status: { name: "To Do", statusCategory: { key: "new" } },
      assignee: null,
      priority: { name: "Medium" },
      issuetype: { name: "Task" },
      labels: [],
      project: { key: "ACME" },
      created: `2023-0${n}-01T00:00:00.000+0000`,
      updated: `2024-0${n}-01T00:00:00.000+0000`,
    },
  };
}

function appWith(
  options: {
    role?: string;
    /** Read on every membership check, so a test can demote mid-flow. */
    roleNow?: () => string | undefined;
    user?: typeof dana;
    fetch?: typeof globalThis.fetch;
    connections?: ReturnType<typeof fakeConnections>;
    boards?: ReturnType<typeof fakeBoards>;
  } = {},
) {
  const connections = options.connections ?? fakeConnections();
  const boards = options.boards ?? fakeBoards();
  const app = createApp({
    corsOrigins: ["https://app.test"],
    auth: fakeAuth(options.user ?? dana),
    organizations: {
      roleOf: (_userId: string, organizationId: string) => {
        if (organizationId !== "org_1") {
          return Promise.resolve(undefined);
        }
        // `roleNow` wins outright when supplied, including when it answers
        // `undefined` — that is "removed from the organization", not "unset",
        // and a `??` chain here would swallow exactly the case under test.
        return Promise.resolve(
          options.roleNow !== undefined
            ? options.roleNow()
            : (options.role ?? "owner"),
        );
      },
      get: () => Promise.resolve({ id: "org_1", name: "Acme", slug: "acme" }),
      listForUser: () => Promise.resolve([]),
      listMembers: () => Promise.resolve([]),
      findBySlug: () => Promise.resolve(undefined),
      findUserByHandle: () => Promise.resolve(undefined),
      listInvitationsForEmail: () => Promise.resolve([]),
      touch: () => Promise.resolve(),
    } as never,
    jira: {
      connections,
      boards,
      clientId: "jira-client-id",
      clientSecret: "jira-client-secret",
      secret: SECRET,
      apiUrl: API_URL,
      appUrl: APP_URL,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    },
  });
  return { app, connections, boards };
}

const signedIn = { cookie: "session=1" };

test("connect redirects to Atlassian with the Jira scopes", async () => {
  const { app } = appWith();

  const response = await app.request("/api/v1/orgs/org_1/jira/connect", {
    headers: signedIn,
  });

  assert.equal(response.status, 302);
  const location = new URL(response.headers.get("location") ?? "");
  assert.equal(location.origin, "https://auth.atlassian.com");
  assert.equal(location.searchParams.get("client_id"), "jira-client-id");
  assert.equal(location.searchParams.get("audience"), "api.atlassian.com");
  // Without prompt=consent a returning user gets no refresh token and the
  // connection dies in an hour.
  assert.equal(location.searchParams.get("prompt"), "consent");
  assert.equal(
    location.searchParams.get("redirect_uri"),
    "https://api.test/api/v1/jira/callback",
  );
  const scopes = (location.searchParams.get("scope") ?? "").split(" ");
  assert.ok(scopes.includes("read:board-scope:jira-software"));
  assert.ok(scopes.includes("offline_access"));
});

test("connect uses the second app's client id, not the sign-in one", async () => {
  // The whole reason for two apps: sharing one would make each grant
  // overwrite the other's scopes.
  const { app } = appWith();

  const response = await app.request("/api/v1/orgs/org_1/jira/connect", {
    headers: signedIn,
  });

  const location = new URL(response.headers.get("location") ?? "");
  assert.equal(location.searchParams.get("client_id"), "jira-client-id");
});

test("a plain member may not connect", async () => {
  // Connecting grants read access to a client's tickets for as long as the
  // connection lives; that is not an ordinary member's decision to make.
  const { app } = appWith({ role: "member" });

  const response = await app.request("/api/v1/orgs/org_1/jira/connect", {
    headers: signedIn,
  });

  assert.equal(response.status, 403);
});

test("an admin may connect, and so may a multi-role member", async () => {
  for (const role of ["admin", "owner", "member,admin"]) {
    const { app } = appWith({ role });
    const response = await app.request("/api/v1/orgs/org_1/jira/connect", {
      headers: signedIn,
    });
    assert.equal(response.status, 302, `role ${role} should be allowed`);
  }
});

test("a non-member gets 404, not 403", async () => {
  // Consistent with every other organization route: 403 would confirm the
  // organization exists.
  const { app } = appWith({ user: stranger, role: "owner" });

  const response = await app.request("/api/v1/orgs/org_2/jira/connect", {
    headers: signedIn,
  });

  assert.equal(response.status, 404);
});

test("connect requires a session", async () => {
  const { app } = appWith();

  assert.equal(
    (await app.request("/api/v1/orgs/org_1/jira/connect")).status,
    401,
  );
});

test("an absolute returnTo cannot redirect off-site", async () => {
  // The open-redirect guard: returnTo arrives as a query parameter on a route
  // any signed-in user can call.
  for (const evil of [
    "https://evil.test/steal",
    "//evil.test",
    "/\\evil.test",
    "javascript:alert(1)",
  ]) {
    const { app } = appWith();
    const response = await app.request(
      `/api/v1/orgs/org_1/jira/connect?returnTo=${encodeURIComponent(evil)}`,
      { headers: signedIn },
    );

    const state = new URL(
      response.headers.get("location") ?? "",
    ).searchParams.get("state");
    const payload = JSON.parse(
      Buffer.from((state ?? "").split(".")[0] ?? "", "base64url").toString(
        "utf8",
      ),
    ) as { returnTo: string };

    assert.equal(payload.returnTo, "/settings/jira", `${evil} leaked through`);
  }
});

test("the callback stores a connection and reports success", async () => {
  const { app, connections } = appWith({ fetch: fakeAtlassian() });
  const state = signState(SECRET, {
    organizationId: "org_1",
    userId: dana.id,
    returnTo: "/settings/jira",
  });

  const response = await app.request(
    `/api/v1/jira/callback?code=code-1&state=${encodeURIComponent(state)}`,
    { headers: signedIn },
  );

  assert.equal(response.status, 302);
  const location = new URL(response.headers.get("location") ?? "");
  assert.equal(location.origin, APP_URL);
  assert.equal(location.searchParams.get("jira"), "connected");

  assert.equal(connections.upserts.length, 1);
  const [recorded] = connections.upserts;
  // The organization comes from the signed state, never from the request.
  assert.equal(recorded?.organizationId, "org_1");
  assert.equal(recorded?.input.cloudId, "cloud-1");
  assert.equal(recorded?.input.refreshToken, "refresh-1");
});

test("the callback takes the organization from the state, not the query", async () => {
  // The attack this prevents: swapping the organization for one the caller is
  // not a member of, after the membership check has already happened.
  const { app, connections } = appWith({ fetch: fakeAtlassian() });
  const state = signState(SECRET, {
    organizationId: "org_1",
    userId: dana.id,
    returnTo: "/settings/jira",
  });

  await app.request(
    `/api/v1/jira/callback?code=c&orgId=org_evil&organizationId=org_evil&state=${encodeURIComponent(state)}`,
    { headers: signedIn },
  );

  assert.equal(connections.upserts[0]?.organizationId, "org_1");
});

test("a state from another session is refused and stores nothing", async () => {
  const { app, connections } = appWith({ fetch: fakeAtlassian() });
  // Signed for a different user than the session the callback arrives on.
  const state = signState(SECRET, {
    organizationId: "org_1",
    userId: stranger.id,
    returnTo: "/settings/jira",
  });

  const response = await app.request(
    `/api/v1/jira/callback?code=c&state=${encodeURIComponent(state)}`,
    { headers: signedIn },
  );

  assert.equal(
    new URL(response.headers.get("location") ?? "").searchParams.get("jira"),
    "state",
  );
  assert.equal(connections.upserts.length, 0);
});

test("a forged state is refused", async () => {
  const { app, connections } = appWith({ fetch: fakeAtlassian() });
  const state = signState("a-different-secret-that-is-long-enough", {
    organizationId: "org_evil",
    userId: dana.id,
    returnTo: "/settings/jira",
  });

  await app.request(
    `/api/v1/jira/callback?code=c&state=${encodeURIComponent(state)}`,
    { headers: signedIn },
  );

  assert.equal(connections.upserts.length, 0);
});

test("a missing state is refused", async () => {
  const { app, connections } = appWith({ fetch: fakeAtlassian() });

  const response = await app.request("/api/v1/jira/callback?code=c", {
    headers: signedIn,
  });

  assert.equal(
    new URL(response.headers.get("location") ?? "").searchParams.get("jira"),
    "state",
  );
  assert.equal(connections.upserts.length, 0);
});

test("pressing Cancel on the consent screen is reported as cancelled", async () => {
  // A choice, not a fault: the UI should not show an error.
  const { app } = appWith();

  const response = await app.request(
    "/api/v1/jira/callback?error=access_denied&error_description=User+denied",
    { headers: signedIn },
  );

  assert.equal(
    new URL(response.headers.get("location") ?? "").searchParams.get("jira"),
    "cancelled",
  );
});

test("any other Atlassian error is reported as an error", async () => {
  const { app } = appWith();

  const response = await app.request(
    "/api/v1/jira/callback?error=invalid_scope",
    { headers: signedIn },
  );

  assert.equal(
    new URL(response.headers.get("location") ?? "").searchParams.get("jira"),
    "error",
  );
});

test("a failed token exchange redirects rather than throwing a 500", async () => {
  // Nothing is broken and the remedy is to try again, so this is not a 500.
  const { app, connections } = appWith({
    fetch: fakeAtlassian({
      tokenStatus: 400,
      tokenBody: { error: "invalid_grant" },
    }),
  });
  const state = signState(SECRET, {
    organizationId: "org_1",
    userId: dana.id,
    returnTo: "/settings/jira",
  });

  const response = await app.request(
    `/api/v1/jira/callback?code=spent&state=${encodeURIComponent(state)}`,
    { headers: signedIn },
  );

  assert.equal(response.status, 302);
  assert.equal(
    new URL(response.headers.get("location") ?? "").searchParams.get("jira"),
    "denied",
  );
  assert.equal(connections.upserts.length, 0);
});

test("a grant with no Jira site says so rather than appearing to succeed", async () => {
  // Usually consent on an account with no Jira product, or a Confluence-only
  // site, which accessibleSites filters out because it would 404 later.
  const { app, connections } = appWith({
    fetch: fakeAtlassian({ sites: [] }),
  });
  const state = signState(SECRET, {
    organizationId: "org_1",
    userId: dana.id,
    returnTo: "/settings/jira",
  });

  const response = await app.request(
    `/api/v1/jira/callback?code=c&state=${encodeURIComponent(state)}`,
    { headers: signedIn },
  );

  assert.equal(
    new URL(response.headers.get("location") ?? "").searchParams.get("jira"),
    "no-sites",
  );
  assert.equal(connections.upserts.length, 0);
});

test("missing granular scopes are named rather than left to be diagnosed", async () => {
  // The Jira Software scopes are granular, and a console still showing only
  // the classic list will not offer them. Without them the agile endpoints
  // answer 404, which reads like "no such board".
  const { app } = appWith({
    fetch: fakeAtlassian({
      scope: "read:jira-work read:jira-user offline_access",
    }),
  });
  const state = signState(SECRET, {
    organizationId: "org_1",
    userId: dana.id,
    returnTo: "/settings/jira",
  });

  const response = await app.request(
    `/api/v1/jira/callback?code=c&state=${encodeURIComponent(state)}`,
    { headers: signedIn },
  );

  const location = new URL(response.headers.get("location") ?? "");
  assert.equal(location.searchParams.get("jira"), "partial-scopes");
  const missing = (location.searchParams.get("missing") ?? "").split(",");
  assert.ok(missing.includes("read:board-scope:jira-software"));
  assert.ok(missing.includes("read:sprint:jira-software"));
});

test("the callback returns to where the flow started", async () => {
  const { app } = appWith({ fetch: fakeAtlassian() });
  const state = signState(SECRET, {
    organizationId: "org_1",
    userId: dana.id,
    returnTo: "/orgs/acme/jira",
  });

  const response = await app.request(
    `/api/v1/jira/callback?code=c&state=${encodeURIComponent(state)}`,
    { headers: signedIn },
  );

  const location = new URL(response.headers.get("location") ?? "");
  assert.equal(location.origin, APP_URL);
  assert.equal(location.pathname, "/orgs/acme/jira");
});

test("connections are listed without token material", async () => {
  const { app } = appWith();

  const response = await app.request("/api/v1/orgs/org_1/jira/connections", {
    headers: signedIn,
  });
  const body = (await response.json()) as { connections: unknown[] };

  assert.equal(response.status, 200);
  assert.equal(body.connections.length, 1);
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes("Token"));
  assert.ok(!serialized.includes("Enc"));
});

test("any member may list connections", async () => {
  // Reading which sites are connected is not privileged; connecting is.
  const { app } = appWith({ role: "member" });

  assert.equal(
    (
      await app.request("/api/v1/orgs/org_1/jira/connections", {
        headers: signedIn,
      })
    ).status,
    200,
  );
});

test("a plain member may not disconnect", async () => {
  const { app, connections } = appWith({ role: "member" });

  const response = await app.request(
    "/api/v1/orgs/org_1/jira/connections/jrc_1",
    { method: "DELETE", headers: signedIn },
  );

  assert.equal(response.status, 403);
  assert.equal(connections.removed.length, 0);
});

test("an owner disconnects, and an unknown id is a 404", async () => {
  const { app, connections } = appWith();

  const removed = await app.request(
    "/api/v1/orgs/org_1/jira/connections/jrc_1",
    { method: "DELETE", headers: signedIn },
  );
  assert.equal(removed.status, 204);
  assert.deepEqual(connections.removed, ["jrc_1"]);

  const missing = await app.request(
    "/api/v1/orgs/org_1/jira/connections/jrc_9",
    { method: "DELETE", headers: signedIn },
  );
  assert.equal(missing.status, 404);
});

test("the routes are not mounted without the Jira credentials", async () => {
  // A deployment with no second Atlassian app must still serve everything
  // else, rather than refusing to start.
  const app = createApp({
    corsOrigins: ["https://app.test"],
    auth: fakeAuth(),
    organizations: {
      roleOf: () => Promise.resolve("owner"),
      get: () => Promise.resolve({ id: "org_1", name: "Acme", slug: "acme" }),
      listForUser: () => Promise.resolve([]),
      listMembers: () => Promise.resolve([]),
      findBySlug: () => Promise.resolve(undefined),
      findUserByHandle: () => Promise.resolve(undefined),
      listInvitationsForEmail: () => Promise.resolve([]),
      touch: () => Promise.resolve(),
    } as never,
  });

  assert.equal(
    (
      await app.request("/api/v1/orgs/org_1/jira/connect", {
        headers: signedIn,
      })
    ).status,
    404,
  );
  // And an unrelated route still works.
  assert.equal(
    (await app.request("/api/v1/me", { headers: signedIn })).status,
    200,
  );
});

test("a callback with a valid state but no code is an error, not a crash", async () => {
  // Should not happen — Atlassian sends either `code` or `error` — but a
  // hand-built URL reaches this, and it must not throw out of the handler.
  const { app, connections } = appWith({ fetch: fakeAtlassian() });
  const state = signState(SECRET, {
    organizationId: "org_1",
    userId: dana.id,
    returnTo: "/settings/jira",
  });

  for (const query of ["", "&code="]) {
    const response = await app.request(
      `/api/v1/jira/callback?state=${encodeURIComponent(state)}${query}`,
      { headers: signedIn },
    );

    assert.equal(response.status, 302);
    assert.equal(
      new URL(response.headers.get("location") ?? "").searchParams.get("jira"),
      "error",
    );
  }
  assert.equal(connections.upserts.length, 0);
});

test("an unexpected failure is not swallowed as a failed connection", async () => {
  // Only Atlassian's own refusals become a `denied` redirect. A bug on our
  // side — the store throwing, say — must surface as a 500 rather than
  // telling the user Atlassian rejected them.
  const broken = fakeConnections();
  broken.upsert = () => Promise.reject(new Error("database is on fire"));
  const { app } = appWith({ fetch: fakeAtlassian(), connections: broken });
  const state = signState(SECRET, {
    organizationId: "org_1",
    userId: dana.id,
    returnTo: "/settings/jira",
  });

  const response = await app.request(
    `/api/v1/jira/callback?code=c&state=${encodeURIComponent(state)}`,
    { headers: signedIn },
  );

  assert.equal(response.status, 500);
});

/*
 * The callback re-checks membership. The signed state proves which
 * organization was chosen and who chose it, never that they are still
 * entitled to — and the window is ten minutes.
 */

test("a user demoted mid-flow cannot finish the connection", async () => {
  // Start as an owner, be demoted to member while on Atlassian's consent
  // screen, then return. Without the re-check the signature alone would carry
  // them through, which is an authorization bypass however narrow the window.
  let role: string | undefined = "owner";
  const { app, connections } = appWith({
    fetch: fakeAtlassian(),
    roleNow: () => role,
  });
  const state = signState(SECRET, {
    organizationId: "org_1",
    userId: dana.id,
    returnTo: "/settings/jira",
  });
  role = "member";

  const response = await app.request(
    `/api/v1/jira/callback?code=c&state=${encodeURIComponent(state)}`,
    { headers: signedIn },
  );

  assert.equal(
    new URL(response.headers.get("location") ?? "").searchParams.get("jira"),
    "forbidden",
  );
  assert.equal(connections.upserts.length, 0);
});

test("a user removed from the organization mid-flow is refused", async () => {
  let role: string | undefined = "owner";
  const { app, connections } = appWith({
    fetch: fakeAtlassian(),
    roleNow: () => role,
  });
  const state = signState(SECRET, {
    organizationId: "org_1",
    userId: dana.id,
    returnTo: "/settings/jira",
  });
  role = undefined;

  const response = await app.request(
    `/api/v1/jira/callback?code=c&state=${encodeURIComponent(state)}`,
    { headers: signedIn },
  );

  assert.equal(
    new URL(response.headers.get("location") ?? "").searchParams.get("jira"),
    "forbidden",
  );
  assert.equal(connections.upserts.length, 0);
});

test("the refusal happens before the authorization code is spent", async () => {
  // A code exchanged and then discarded would be wasted, and a token briefly
  // held for a connection that is never stored.
  const requested: string[] = [];
  const { app } = appWith({
    role: "member",
    fetch: (async (url: string | URL | Request) => {
      requested.push(String(url));
      return new Response("{}", { status: 200 });
    }) as typeof globalThis.fetch,
  });
  const state = signState(SECRET, {
    organizationId: "org_1",
    userId: dana.id,
    returnTo: "/settings/jira",
  });

  await app.request(
    `/api/v1/jira/callback?code=c&state=${encodeURIComponent(state)}`,
    { headers: signedIn },
  );

  assert.deepEqual(requested, []);
});

test("an admin who kept their role still completes the flow", async () => {
  // The re-check must not refuse the ordinary case.
  const { app, connections } = appWith({
    role: "admin",
    fetch: fakeAtlassian(),
  });
  const state = signState(SECRET, {
    organizationId: "org_1",
    userId: dana.id,
    returnTo: "/settings/jira",
  });

  const response = await app.request(
    `/api/v1/jira/callback?code=c&state=${encodeURIComponent(state)}`,
    { headers: signedIn },
  );

  assert.equal(
    new URL(response.headers.get("location") ?? "").searchParams.get("jira"),
    "connected",
  );
  assert.equal(connections.upserts.length, 1);
});

/* -------------------------------------------------------------------------- */
/* Boards and the backlog preview                                             */
/* -------------------------------------------------------------------------- */

test("listing a connection's boards reads them live from Jira", async () => {
  const jira = fakeJiraApi();
  const { app } = appWith({ fetch: jira });

  const response = await app.request(
    "/api/v1/orgs/org_1/jira/connections/jrc_1/boards",
    { headers: signedIn },
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as { boards: { id: number }[] };
  assert.deepEqual(
    body.boards.map((board) => board.id),
    [42],
  );
  // Through the gateway, addressed by cloud id — not the site's own host.
  assert.ok(
    jira.urls.some((url) =>
      url.startsWith("https://api.atlassian.com/ex/jira/cloud-1/"),
    ),
  );
});

test("a board list for another organization's connection is a 404", async () => {
  // `get` answering null is what an owner-scoped read does with a foreign id.
  const connections = fakeConnections();
  connections.get = () => Promise.resolve(null);
  const { app } = appWith({ connections, fetch: fakeJiraApi() });

  const response = await app.request(
    "/api/v1/orgs/org_1/jira/connections/jrc_other/boards",
    { headers: signedIn },
  );

  assert.equal(response.status, 404);
});

test("an unhealthy connection asks for a reconnect rather than retrying", async () => {
  const jira = fakeJiraApi();
  const { app } = appWith({
    connections: fakeConnections({ healthy: false }),
    fetch: jira,
  });

  const response = await app.request(
    "/api/v1/orgs/org_1/jira/connections/jrc_1/boards",
    { headers: signedIn },
  );

  assert.equal(response.status, 409);
  assert.equal(((await response.json()) as { code: string }).code, "reconnect");
  // The point of the check: no round trip is spent to learn what the row says.
  assert.deepEqual(jira.urls, []);
});

test("registering a board takes its name and type from Jira, not the body", async () => {
  const { app, boards } = appWith({ fetch: fakeJiraApi() });

  const response = await app.request("/api/v1/orgs/org_1/jira/boards", {
    method: "POST",
    headers: { ...signedIn, "content-type": "application/json" },
    body: JSON.stringify({
      connectionId: "jrc_1",
      externalId: "42",
      name: "Attacker's name",
      boardType: "kanban",
    }),
  });

  assert.equal(response.status, 201);
  const [registered] = boards.registered;
  assert.equal(registered?.name, "Acme Board");
  assert.equal(registered?.boardType, "scrum");
  assert.equal(registered?.projectKey, "ACME");
  // Defaults are filled in, so the row holds a complete set of settings.
  assert.equal(registered?.selection?.maxTickets, 10);
  assert.equal(registered?.selection?.excludeAssigned, true);
});

test("registering a board the grant cannot see is a 404", async () => {
  const { app, boards } = appWith({ fetch: fakeJiraApi({ boards: [] }) });

  const response = await app.request("/api/v1/orgs/org_1/jira/boards", {
    method: "POST",
    headers: { ...signedIn, "content-type": "application/json" },
    body: JSON.stringify({ connectionId: "jrc_1", externalId: "999" }),
  });

  assert.equal(response.status, 404);
  assert.deepEqual(boards.registered, []);
});

test("an ordinary member may not register a board", async () => {
  const { app, boards } = appWith({ role: "member", fetch: fakeJiraApi() });

  const response = await app.request("/api/v1/orgs/org_1/jira/boards", {
    method: "POST",
    headers: { ...signedIn, "content-type": "application/json" },
    body: JSON.stringify({ connectionId: "jrc_1", externalId: "42" }),
  });

  assert.equal(response.status, 403);
  assert.deepEqual(boards.registered, []);
});

test("editing a board passes only the settings that were sent", async () => {
  const { app, boards } = appWith();

  const response = await app.request("/api/v1/orgs/org_1/jira/boards/jrb_1", {
    method: "PATCH",
    headers: { ...signedIn, "content-type": "application/json" },
    body: JSON.stringify({ selection: { maxTickets: 5 } }),
  });

  assert.equal(response.status, 200);
  // Absent means "leave it alone": anything else would reset the rest to
  // their defaults, which is the trap `boardSelectionUpdateSchema` documents.
  assert.deepEqual(boards.updates, [{ selection: { maxTickets: 5 } }]);
});

test("clearing maxAgeDays survives as a null rather than being dropped", async () => {
  const { app, boards } = appWith();

  await app.request("/api/v1/orgs/org_1/jira/boards/jrb_1", {
    method: "PATCH",
    headers: { ...signedIn, "content-type": "application/json" },
    body: JSON.stringify({ selection: { maxAgeDays: null } }),
  });

  assert.deepEqual(boards.updates, [{ selection: { maxAgeDays: null } }]);
});

test("the preview returns the board's oldest backlog tickets", async () => {
  const jira = fakeJiraApi();
  const { app } = appWith({ fetch: jira });

  const response = await app.request(
    "/api/v1/orgs/org_1/jira/boards/jrb_1/backlog-preview",
    { headers: signedIn },
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    source: string;
    jql: string;
    issues: { key: string }[];
  };

  assert.equal(body.source, "backlog");
  assert.deepEqual(
    body.issues.map((issue) => issue.key),
    ["ACME-1", "ACME-2"],
  );
  // The ordering is the product claim: "the oldest still in the backlog".
  assert.ok(body.jql.includes("ORDER BY created ASC"));
  assert.ok(body.jql.includes("assignee is EMPTY"));
  assert.ok(jira.urls.some((url) => url.includes("/board/42/backlog")));
});

test("a Kanban board is previewed through the board-issues endpoint", async () => {
  // A plain Kanban board has no backlog endpoint at all; its first column is
  // the backlog, so the fallback has to restrict to To Do itself.
  const jira = fakeJiraApi();
  const { app } = appWith({
    boards: fakeBoards({ boardType: "kanban" }),
    fetch: jira,
  });

  const response = await app.request(
    "/api/v1/orgs/org_1/jira/boards/jrb_1/backlog-preview",
    { headers: signedIn },
  );

  const body = (await response.json()) as { source: string; jql: string };
  assert.equal(body.source, "board-issues");
  assert.ok(body.jql.includes('statusCategory = "To Do"'));
  assert.ok(jira.urls.some((url) => url.includes("/board/42/issue")));
});

test("the preview stores nothing", async () => {
  // Looking at a board must stay distinguishable from pricing it.
  const { app, boards, connections } = appWith({ fetch: fakeJiraApi() });

  await app.request("/api/v1/orgs/org_1/jira/boards/jrb_1/backlog-preview", {
    headers: signedIn,
  });

  assert.deepEqual(boards.registered, []);
  assert.deepEqual(boards.updates, []);
  assert.deepEqual(connections.upserts, []);
});

test("an ordinary member may preview a board", async () => {
  // Reading tickets the organization already has a grant for.
  const { app } = appWith({ role: "member", fetch: fakeJiraApi() });

  const response = await app.request(
    "/api/v1/orgs/org_1/jira/boards/jrb_1/backlog-preview",
    { headers: signedIn },
  );

  assert.equal(response.status, 200);
});

test("previewing another organization's board is a 404", async () => {
  const { app } = appWith({ fetch: fakeJiraApi() });

  const response = await app.request(
    "/api/v1/orgs/org_1/jira/boards/jrb_other/backlog-preview",
    { headers: signedIn },
  );

  assert.equal(response.status, 404);
});

test("a refused Jira call is a 502, not a 500", async () => {
  const { app } = appWith({ fetch: fakeJiraApi({ status: 400 }) });

  const response = await app.request(
    "/api/v1/orgs/org_1/jira/boards/jrb_1/backlog-preview",
    { headers: signedIn },
  );

  assert.equal(response.status, 502);
  assert.equal(((await response.json()) as { code: string }).code, "jira");
});

test("a revoked grant marks the connection unhealthy", async () => {
  const connections = fakeConnections();
  const { app } = appWith({
    connections,
    fetch: fakeJiraApi({ status: 401 }),
  });

  const response = await app.request(
    "/api/v1/orgs/org_1/jira/boards/jrb_1/backlog-preview",
    { headers: signedIn },
  );

  assert.equal(response.status, 409);
  // So the next page load says "reconnect" without spending a round trip.
  assert.deepEqual(connections.unhealthy, ["jrc_1"]);
});

test("a missing scope does not mark the connection unhealthy", async () => {
  // A 403 is a scope the grant never had. Reconnecting does not add it unless
  // the user consents to more, so flagging the row would mislabel a grant that
  // still works for everything else.
  const connections = fakeConnections();
  const { app } = appWith({
    connections,
    fetch: fakeJiraApi({ status: 403 }),
  });

  const response = await app.request(
    "/api/v1/orgs/org_1/jira/boards/jrb_1/backlog-preview",
    { headers: signedIn },
  );

  assert.equal(response.status, 502);
  assert.deepEqual(connections.unhealthy, []);
});
