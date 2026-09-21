import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildInfoSchema,
  unknownBuildInfo,
  type BuildInfoDto,
} from "@sandbox-factory/shared";

import type { Auth } from "../src/auth.js";
import { createApp } from "../src/routes.js";

const sessionUser = {
  id: "user_1",
  email: "signed-in@example.test",
  name: "Signed In",
};

/** A build record with every field populated, for the version routes below. */
const build: BuildInfoDto = {
  version: "1.4.2",
  gitSha: "7f3a9c1e5b2d8a4f6c0e9b3a1d7f5c2e8a4b6d09",
  gitShortSha: "7f3a9c1",
  buildTime: "2026-09-17T09:14:00.000Z",
  gitRef: "main",
  dirty: false,
};

/**
 * A stand-in for Better Auth with only the two members the routes touch. A
 * real `Auth` would need an OAuth client and a database. `getSession` reads
 * the request headers, so the middleware under test is the real one: a cookie
 * gets a session, no cookie gets null.
 */
function fakeAuth(
  options: { signedIn?: boolean; as?: typeof sessionUser } = {},
): Auth {
  const { signedIn = true, as: user = sessionUser } = options;
  return {
    api: {
      getSession: ({ headers }: { headers: Headers }) =>
        Promise.resolve(
          signedIn && headers.get("cookie") !== null
            ? { user, session: { id: `session_${user.id}` } }
            : null,
        ),
    },
    // Echoes the path so the /api/auth/* mount can be asserted on.
    handler: (request: Request) =>
      Promise.resolve(
        Response.json({ handled: new URL(request.url).pathname }),
      ),
  } as unknown as Auth;
}

/** Headers the fake above accepts as a signed-in browser session. */
const signedIn = { cookie: "better-auth.session_token=test-token" };

/**
 * A signed-in app: `request` injects the session cookie. Tests about auth call
 * `createApp` directly or pass their own headers, which win.
 */
function app() {
  const server = createApp({
    corsOrigins: ["http://localhost:5173"],
    auth: fakeAuth(),
  });
  return {
    request(path: string, init?: RequestInit) {
      return server.request(path, {
        ...init,
        headers: { ...signedIn, ...init?.headers },
      });
    },
  };
}

function json(body: unknown) {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

test("GET /health reports ok, with the build it is running", async () => {
  const res = await app().request("/health");
  assert.equal(res.status, 200);
  // `app()` passes no buildInfo, like a container built without build args.
  assert.deepEqual(await res.json(), {
    status: "ok",
    version: "0.0.0",
    sha: "unknown",
  });
});

test("GET /health carries the injected build", async () => {
  const server = createApp({
    corsOrigins: ["http://localhost:5173"],
    auth: fakeAuth(),
    buildInfo: build,
  });
  assert.deepEqual(await (await server.request("/health")).json(), {
    status: "ok",
    version: build.version,
    sha: build.gitSha,
  });
});

test("GET /version returns the build record verbatim", async () => {
  const server = createApp({
    corsOrigins: ["http://localhost:5173"],
    auth: fakeAuth(),
    buildInfo: build,
  });
  const res = await server.request("/version");
  assert.equal(res.status, 200);
  // Parsed with the shared schema: the contract the web app and extension
  // read.
  assert.deepEqual(buildInfoSchema.parse(await res.json()), build);
});

test("GET /version falls back to the unknown record", async () => {
  const res = await app().request("/version");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), unknownBuildInfo);
});

// The sign-in screen and deploy tooling read this without a session.
test("GET /version needs no session", async () => {
  const server = createApp({
    corsOrigins: ["http://localhost:5173"],
    auth: fakeAuth({ signedIn: false }),
    buildInfo: build,
  });
  assert.equal((await server.request("/version")).status, 200);
});

// A misconfigured server can still say which build it is.
test("GET /version answers even with no auth configured", async () => {
  const server = createApp({
    corsOrigins: ["http://localhost:5173"],
    buildInfo: build,
  });
  const res = await server.request("/version");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), build);
});

test("an unknown route is a 404 in JSON, not HTML", async () => {
  const res = await app().request("/api/v1/nope");
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "Not found." });
});

test("CORS allows the configured origin", async () => {
  const res = await app().request("/api/v1/me", {
    headers: { Origin: "http://localhost:5173" },
  });
  assert.equal(
    res.headers.get("Access-Control-Allow-Origin"),
    "http://localhost:5173",
  );
});

test("an unauthenticated request to a data route is a 401", async () => {
  // Not the `app` helper, which would inject the session.
  const server = createApp({
    corsOrigins: ["http://localhost:5173"],
    auth: fakeAuth(),
  });

  const res = await server.request("/api/v1/me");

  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "Authentication required." });
});

test("an unauthenticated write is a 401 before it reaches a handler", async () => {
  // The guard is the middleware, so the method does not matter: a write with
  // no session is refused without the handler ever running.
  const server = createApp({
    corsOrigins: ["http://localhost:5173"],
    auth: fakeAuth(),
  });

  const res = await server.request("/api/v1/me/username", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "sneaky" }),
  });

  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "Authentication required." });
});

test("health stays public when auth is configured", async () => {
  const server = createApp({
    corsOrigins: ["http://localhost:5173"],
    auth: fakeAuth(),
  });

  // Container and uptime checks have no session and must not be asked for one.
  assert.equal((await server.request("/health")).status, 200);
});

test("GET /api/v1/me returns both identifiers", async () => {
  // `id` is the immutable account; `username` is the mutable handle.
  const res = await appWithProfiles(fakeProfiles("feversoul")).request(
    "/api/v1/me",
  );

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    user: {
      id: "user_1",
      email: "signed-in@example.test",
      name: "Signed In",
      username: "feversoul",
    },
  });
});

test("GET /api/v1/me reports a null handle when none is configured", async () => {
  const res = await app().request("/api/v1/me");

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    user: {
      id: "user_1",
      email: "signed-in@example.test",
      name: "Signed In",
      username: null,
    },
  });
});

test("/api/auth/* is handled by Better Auth and needs no session", async () => {
  const server = createApp({
    corsOrigins: ["http://localhost:5173"],
    auth: fakeAuth(),
  });

  // Signing in cannot require already being signed in.
  const res = await server.request("/api/auth/sign-in/social");

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { handled: "/api/auth/sign-in/social" });
});

test("a bearer token is accepted where a cookie would be", async () => {
  // For the VS Code extension, which has no cookie jar. The middleware passes
  // every header to Better Auth, so there is no second code path.
  const server = createApp({
    corsOrigins: ["http://localhost:5173"],
    auth: {
      api: {
        getSession: ({ headers }: { headers: Headers }) =>
          Promise.resolve(
            headers.get("authorization") === "Bearer test-token"
              ? { user: sessionUser, session: { id: "session_1" } }
              : null,
          ),
      },
      handler: () => Promise.resolve(new Response(null, { status: 404 })),
    } as unknown as Auth,
  });

  const res = await server.request("/api/v1/me", {
    headers: { authorization: "Bearer test-token" },
  });

  assert.equal(res.status, 200);
});

test("with no auth configured the data routes are 503, not open", async () => {
  // A deploy that forgets the auth env must serve no data, not everyone's.
  const server = createApp({
    corsOrigins: ["http://localhost:5173"],
  });

  const res = await server.request("/api/v1/me");

  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), {
    error: "Authentication is not configured.",
  });
  // Health still answers, so the container can report why it is unhealthy.
  assert.equal((await server.request("/health")).status, 200);
});

test("with no auth configured an unknown route is still a JSON 404", async () => {
  const server = createApp({
    corsOrigins: ["http://localhost:5173"],
  });

  const res = await server.request("/nope");

  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "Not found." });
});

// ---- proven emails --------------------------------------------------------

/**
 * A stand-in for the email store, whose own logic is tested in `packages/db`.
 * These tests cover the routes in front of it.
 */
function fakeEmails(
  seed: Array<{
    id: string;
    email: string;
    providers: string[];
    isPrimary: boolean;
  }> = [
    {
      id: "email_1",
      email: "first@example.test",
      providers: ["google"],
      isPrimary: true,
    },
  ],
) {
  let rows = [...seed];
  return {
    calls: [] as string[],
    primaryFor: () => Promise.resolve("first@example.test"),
    revokeProvider: () => Promise.resolve(),
    list: () => Promise.resolve(rows),
    record: () => Promise.resolve(null),
    setPrimary: (_userId: string, id: string) =>
      Promise.resolve(
        rows.find((row) => row.id === id) === undefined
          ? undefined
          : { ...rows.find((row) => row.id === id)!, isPrimary: true },
      ),
    remove: (_userId: string, id: string) => {
      const target = rows.find((row) => row.id === id);
      if (target === undefined) {
        return Promise.resolve("not-found" as const);
      }
      if (target.isPrimary) {
        return Promise.resolve("is-primary" as const);
      }
      rows = rows.filter((row) => row.id !== id);
      return Promise.resolve("removed" as const);
    },
  };
}

function appWithEmails(emails = fakeEmails()) {
  const server = createApp({
    corsOrigins: ["http://localhost:5173"],
    auth: fakeAuth(),
    emails: emails as unknown as Parameters<typeof createApp>[0]["emails"],
  });
  return {
    request: (path: string, init?: RequestInit) =>
      server.request(path, {
        ...init,
        headers: { ...signedIn, ...init?.headers },
      }),
  };
}

test("GET /api/v1/me/emails lists the proven addresses", async () => {
  const res = await appWithEmails().request("/api/v1/me/emails");

  assert.equal(res.status, 200);
  const body = (await res.json()) as { emails: Array<{ email: string }> };
  assert.equal(body.emails[0]?.email, "first@example.test");
});

test("the email routes require a session like any other /api/v1 route", async () => {
  const server = createApp({
    corsOrigins: ["http://localhost:5173"],
    auth: fakeAuth(),
    emails: fakeEmails() as unknown as Parameters<
      typeof createApp
    >[0]["emails"],
  });

  assert.equal((await server.request("/api/v1/me/emails")).status, 401);
});

test("POST promotes an address to primary", async () => {
  const res = await appWithEmails().request(
    "/api/v1/me/emails/email_1/primary",
    { method: "POST" },
  );

  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { isPrimary: boolean }).isPrimary, true);
});

test("promoting an unknown address is a 404", async () => {
  // Another user's id is indistinguishable from a nonexistent one.
  const res = await appWithEmails().request(
    "/api/v1/me/emails/email_nope/primary",
    { method: "POST" },
  );

  assert.equal(res.status, 404);
});

test("DELETE removes a secondary address", async () => {
  const emails = fakeEmails([
    {
      id: "email_1",
      email: "first@example.test",
      providers: ["google"],
      isPrimary: true,
    },
    {
      id: "email_2",
      email: "second@example.test",
      providers: ["github"],
      isPrimary: false,
    },
  ]);

  const res = await appWithEmails(emails).request("/api/v1/me/emails/email_2", {
    method: "DELETE",
  });

  assert.equal(res.status, 204);
});

test("DELETE on the primary address is a 409 with a usable message", async () => {
  const res = await appWithEmails().request("/api/v1/me/emails/email_1", {
    method: "DELETE",
  });

  assert.equal(res.status, 409);
  assert.match(
    ((await res.json()) as { error: string }).error,
    /primary address/i,
  );
});

test("the email routes are absent when no store is configured", async () => {
  // Same fail-closed posture as the auth guard: no store, no endpoint.
  const res = await app().request("/api/v1/me/emails");

  assert.equal(res.status, 404);
});

// ---- username -------------------------------------------------------------

function fakeProfiles(initial: string | null = null) {
  let username = initial;
  return {
    get: () => Promise.resolve({ username }),
    setUsername: (_userId: string, raw: string) => {
      const next = raw.trim().toLowerCase();
      if (next.length < 3) {
        return Promise.resolve({
          status: "invalid" as const,
          reason: "Username must be between 3 and 30 characters.",
        });
      }
      if (next === "taken") {
        return Promise.resolve({ status: "taken" as const });
      }
      username = next;
      return Promise.resolve({
        status: "ok" as const,
        username: next,
        displayUsername: raw.trim(),
      });
    },
  };
}

function appWithProfiles(profiles = fakeProfiles()) {
  const server = createApp({
    corsOrigins: ["http://localhost:5173"],
    auth: fakeAuth(),
    profiles: profiles as unknown as Parameters<
      typeof createApp
    >[0]["profiles"],
  });
  return {
    request: (path: string, init?: RequestInit) =>
      server.request(path, {
        ...init,
        headers: { ...signedIn, ...init?.headers },
      }),
  };
}

test("GET /api/v1/me/username returns null before one is claimed", async () => {
  const res = await appWithProfiles().request("/api/v1/me/username");

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { username: null });
});

test("PUT claims a username", async () => {
  const res = await appWithProfiles().request("/api/v1/me/username", {
    ...json({ username: "FeverSoul" }),
    method: "PUT",
  });

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    username: "feversoul",
    displayUsername: "FeverSoul",
  });
});

test("a taken username is a 409, not a 400", async () => {
  // So the form can tell a taken name from a malformed one.
  const res = await appWithProfiles().request("/api/v1/me/username", {
    ...json({ username: "taken" }),
    method: "PUT",
  });

  assert.equal(res.status, 409);
});

test("an invalid username is a 400 carrying the reason", async () => {
  const res = await appWithProfiles().request("/api/v1/me/username", {
    ...json({ username: "ab" }),
    method: "PUT",
  });

  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /characters/);
});

test("a PUT with no username is a 400", async () => {
  const res = await appWithProfiles().request("/api/v1/me/username", {
    ...json({}),
    method: "PUT",
  });

  assert.equal(res.status, 400);
});

test("the username routes require a session", async () => {
  const server = createApp({
    corsOrigins: ["http://localhost:5173"],
    auth: fakeAuth(),
    profiles: fakeProfiles() as unknown as Parameters<
      typeof createApp
    >[0]["profiles"],
  });

  assert.equal((await server.request("/api/v1/me/username")).status, 401);
});

test("the username routes are absent when no profile store is configured", async () => {
  assert.equal((await app().request("/api/v1/me/username")).status, 404);
});

// ---- origin verification ---------------------------------------------------
//
// In the CloudFront-to-Fargate deploy the task's port is open to the internet,
// and the shared header is all that separates a CDN request from a stranger.
// See `originVerify` in routes.ts.

/** An app with origin verification switched on. */
function guardedApp(secret = "s3cr3t-from-cloudfront") {
  return createApp({
    corsOrigins: ["http://localhost:5173"],
    auth: fakeAuth(),
    originVerify: secret,
  });
}

test("a request carrying the origin secret is served", async () => {
  const response = await guardedApp().request("/api/v1/me", {
    headers: { ...signedIn, "x-origin-verify": "s3cr3t-from-cloudfront" },
  });

  assert.equal(response.status, 200);
});

test("a request without the origin secret is refused", async () => {
  const response = await guardedApp().request("/api/v1/me", {
    headers: signedIn,
  });

  // 404 rather than 403: a scanner that finds the origin should learn nothing
  // about whether it guessed a real host.
  assert.equal(response.status, 404);
});

test("a request with the wrong origin secret is refused", async () => {
  const response = await guardedApp().request("/api/v1/me", {
    headers: { ...signedIn, "x-origin-verify": "wrong" },
  });

  assert.equal(response.status, 404);
});

test("/health answers without the origin secret", async () => {
  // Probes reach the task directly and never carry the header; without this
  // exemption ECS would see a permanently unhealthy task.
  const response = await guardedApp().request("/health");

  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { status: string }).status, "ok");
});

test("without originVerify configured no check is installed", async () => {
  // The local-development and behind-a-load-balancer case.
  const response = await app().request("/api/v1/me");

  assert.equal(response.status, 200);
});
