import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildInfoSchema,
  unknownBuildInfo,
  type BuildInfoDto,
} from "@sandbox-factory/shared";

import type { Auth } from "../src/auth.js";
import { createApp } from "../src/routes.js";
import { createInMemoryStore } from "../src/store.js";

const sessionUser = {
  id: "user_1",
  email: "signed-in@example.test",
  name: "Signed In",
};

/** A second account, for the cross-user tests near the bottom of this file. */
const otherUser = {
  id: "user_2",
  email: "someone-else@example.test",
  name: "Someone Else",
};

// Owned by `sessionUser`, which is who the fake session below signs in as.
// Every todo now has an owner, and the store will not return a row to anyone
// other than the user who owns it.
const seed = [
  {
    id: "todo_1",
    userId: sessionUser.id,
    title: "write tests",
    done: false,
    createdAt: "2026-09-16T00:00:00.000Z",
  },
];

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
 * A stand-in for Better Auth.
 *
 * Only the two members the routes actually touch are implemented —
 * `api.getSession` and `handler` — because building a real `Auth` here would
 * mean an OAuth client and a database, and no test in this repo may depend on
 * a container.
 *
 * `getSession` reads the request headers exactly as the real one does, so the
 * middleware under test is the real middleware: a request with the header gets
 * a session, one without gets null. The cast is contained to this helper.
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
    // Stands in for the mounted Better Auth handler so the /api/auth/* route
    // can be asserted on without a provider round trip.
    handler: (request: Request) =>
      Promise.resolve(
        Response.json({ handled: new URL(request.url).pathname }),
      ),
  } as unknown as Auth;
}

/** Headers the fake above accepts as a signed-in browser session. */
const signedIn = { cookie: "better-auth.session_token=test-token" };

/**
 * A signed-in app.
 *
 * `request` injects the session cookie so the tests below stay about todo
 * behaviour rather than repeating auth setup twenty times. Tests that are
 * *about* auth call `createApp` directly, or pass their own headers, which
 * still win because the caller's spread comes last.
 */
function app(todos = seed) {
  const server = createApp({
    store: createInMemoryStore(todos),
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
  // Defaults to the unknown record: `app()` passes no buildInfo, which is the
  // same situation as a container built without the build args.
  assert.deepEqual(await res.json(), {
    status: "ok",
    version: "0.0.0",
    sha: "unknown",
  });
});

test("GET /health carries the injected build", async () => {
  const server = createApp({
    store: createInMemoryStore(seed),
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
    store: createInMemoryStore(seed),
    corsOrigins: ["http://localhost:5173"],
    auth: fakeAuth(),
    buildInfo: build,
  });
  const res = await server.request("/version");
  assert.equal(res.status, 200);
  // Parsed with the shared schema rather than compared field by field: this is
  // the contract the web app and the extension read, and a response that no
  // longer satisfies it is the failure worth catching here.
  assert.deepEqual(buildInfoSchema.parse(await res.json()), build);
});

test("GET /version falls back to the unknown record", async () => {
  const res = await app().request("/version");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), unknownBuildInfo);
});

// The sign-in screen renders before there is a session, and deploy tooling
// reads this without credentials — so a session must not be required.
test("GET /version needs no session", async () => {
  const server = createApp({
    store: createInMemoryStore(seed),
    corsOrigins: ["http://localhost:5173"],
    auth: fakeAuth({ signedIn: false }),
    buildInfo: build,
  });
  assert.equal((await server.request("/version")).status, 200);
});

// A server that cannot serve data can still say which build it is, which is the
// first thing worth knowing when diagnosing why it is misconfigured.
test("GET /version answers even with no auth configured", async () => {
  const server = createApp({
    store: createInMemoryStore(seed),
    corsOrigins: ["http://localhost:5173"],
    buildInfo: build,
  });
  const res = await server.request("/version");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), build);
});

test("GET /api/v1/todos returns the seeded todos", async () => {
  const res = await app().request("/api/v1/todos");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { todos: unknown[] };
  assert.equal(body.todos.length, 1);
});

test("GET one todo by id", async () => {
  const res = await app().request("/api/v1/todos/todo_1");
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { title: string }).title, "write tests");
});

test("GET an unknown id is a 404 with a message", async () => {
  const res = await app().request("/api/v1/todos/nope");
  assert.equal(res.status, 404);
  assert.match(((await res.json()) as { error: string }).error, /No todo/);
});

test("POST creates a todo, not done, and returns 201", async () => {
  const res = await app().request("/api/v1/todos", json({ title: "buy milk" }));

  assert.equal(res.status, 201);
  const body = (await res.json()) as { title: string; done: boolean };
  assert.equal(body.title, "buy milk");
  assert.equal(body.done, false);
});

test("POST trims the title", async () => {
  const res = await app().request(
    "/api/v1/todos",
    json({ title: "  padded  " }),
  );
  assert.equal(((await res.json()) as { title: string }).title, "padded");
});

test("POST with an empty title is a 400 carrying the schema's message", async () => {
  const res = await app().request("/api/v1/todos", json({ title: "   " }));

  assert.equal(res.status, 400);
  assert.match(
    ((await res.json()) as { error: string }).error,
    /needs a title/,
  );
});

test("POST with an overlong title is a 400", async () => {
  const res = await app().request(
    "/api/v1/todos",
    json({ title: "x".repeat(201) }),
  );
  assert.equal(res.status, 400);
});

test("POST with a malformed body is a 400, not a crash", async () => {
  const res = await app().request("/api/v1/todos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{{{",
  });

  assert.equal(res.status, 400);
});

test("PATCH marks a todo done", async () => {
  const res = await app().request("/api/v1/todos/todo_1", {
    ...json({ done: true }),
    method: "PATCH",
  });

  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { done: boolean }).done, true);
});

test("PATCH renames a todo", async () => {
  const res = await app().request("/api/v1/todos/todo_1", {
    ...json({ title: "renamed" }),
    method: "PATCH",
  });

  assert.equal(((await res.json()) as { title: string }).title, "renamed");
});

test("PATCH can change title and done together", async () => {
  const res = await app().request("/api/v1/todos/todo_1", {
    ...json({ title: "both", done: true }),
    method: "PATCH",
  });

  const body = (await res.json()) as { title: string; done: boolean };
  assert.equal(body.title, "both");
  assert.equal(body.done, true);
});

test("PATCH with an empty body is a 400", async () => {
  const res = await app().request("/api/v1/todos/todo_1", {
    ...json({}),
    method: "PATCH",
  });

  assert.equal(res.status, 400);
  assert.match(
    ((await res.json()) as { error: string }).error,
    /Provide a title/,
  );
});

test("PATCH an unknown id is a 404", async () => {
  const res = await app().request("/api/v1/todos/nope", {
    ...json({ done: true }),
    method: "PATCH",
  });

  assert.equal(res.status, 404);
});

test("DELETE removes the todo and returns 204 with no body", async () => {
  const server = app();

  const res = await server.request("/api/v1/todos/todo_1", {
    method: "DELETE",
  });
  assert.equal(res.status, 204);
  assert.equal(await res.text(), "");

  const after = await server.request("/api/v1/todos");
  assert.deepEqual(await after.json(), { todos: [] });
});

test("DELETE an unknown id is a 404", async () => {
  const res = await app().request("/api/v1/todos/nope", { method: "DELETE" });
  assert.equal(res.status, 404);
});

test("DELETE twice is a 404 the second time", async () => {
  const server = app();
  await server.request("/api/v1/todos/todo_1", { method: "DELETE" });
  const res = await server.request("/api/v1/todos/todo_1", {
    method: "DELETE",
  });

  assert.equal(res.status, 404);
});

test("an unknown route is a 404 in JSON, not HTML", async () => {
  const res = await app().request("/api/v1/nope");
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "Not found." });
});

test("CORS allows the configured origin", async () => {
  const res = await app().request("/api/v1/todos", {
    headers: { Origin: "http://localhost:5173" },
  });
  assert.equal(
    res.headers.get("Access-Control-Allow-Origin"),
    "http://localhost:5173",
  );
});

// ---- ownership ------------------------------------------------------------
//
// Being signed in is not the same as being entitled to a row. These are the
// regression tests for a period in which the todo routes sat behind a session
// and still served the whole table to whoever asked: authenticated, and
// completely unscoped. A 401 test cannot catch that — both users here are
// signed in — so the boundary needs its own tests at the HTTP layer, not only
// in the store.

/** A signed-in app where the caller is somebody other than the seed's owner. */
function appAs(user: typeof sessionUser, todos = seed) {
  const server = createApp({
    store: createInMemoryStore(todos),
    corsOrigins: ["http://localhost:5173"],
    auth: fakeAuth({ as: user }),
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

test("a signed-in user does not see another user's todos", async () => {
  const res = await appAs(otherUser).request("/api/v1/todos");

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { todos: [] });
});

test("reading another user's todo by id is a 404, not a 403", async () => {
  // 404 deliberately: a 403 would confirm the id exists, which lets someone
  // enumerate ids they cannot read.
  const res = await appAs(otherUser).request("/api/v1/todos/todo_1");

  assert.equal(res.status, 404);
});

test("patching another user's todo is refused and changes nothing", async () => {
  const store = createInMemoryStore(seed);
  const server = createApp({
    store,
    corsOrigins: ["http://localhost:5173"],
    auth: fakeAuth({ as: otherUser }),
  });

  const res = await server.request("/api/v1/todos/todo_1", {
    method: "PATCH",
    headers: { ...signedIn, "Content-Type": "application/json" },
    body: JSON.stringify({ title: "hijacked" }),
  });

  assert.equal(res.status, 404);
  assert.equal(
    (await store.get(sessionUser.id, "todo_1"))?.title,
    "write tests",
  );
});

test("deleting another user's todo is refused and leaves it in place", async () => {
  const store = createInMemoryStore(seed);
  const server = createApp({
    store,
    corsOrigins: ["http://localhost:5173"],
    auth: fakeAuth({ as: otherUser }),
  });

  const res = await server.request("/api/v1/todos/todo_1", {
    method: "DELETE",
    headers: signedIn,
  });

  assert.equal(res.status, 404);
  assert.notEqual(await store.get(sessionUser.id, "todo_1"), undefined);
});

test("a created todo belongs to its creator and nobody else", async () => {
  const store = createInMemoryStore([]);
  function serverFor(user: typeof sessionUser) {
    return createApp({
      store,
      corsOrigins: ["http://localhost:5173"],
      auth: fakeAuth({ as: user }),
    });
  }

  const created = await serverFor(otherUser).request("/api/v1/todos", {
    method: "POST",
    headers: { ...signedIn, "Content-Type": "application/json" },
    body: JSON.stringify({ title: "theirs" }),
  });
  assert.equal(created.status, 201);

  // The owner comes from the session, so the other user's list stays empty
  // however the request was shaped.
  const mine = await serverFor(sessionUser).request("/api/v1/todos", {
    headers: signedIn,
  });
  assert.deepEqual(await mine.json(), { todos: [] });
});

test("an owner field in the request body cannot redirect a todo", async () => {
  // The body is parsed by a schema that has no owner field, and the route
  // reads the id off the session regardless. This pins that a caller cannot
  // write into someone else's list by asking.
  const store = createInMemoryStore([]);
  const server = createApp({
    store,
    corsOrigins: ["http://localhost:5173"],
    auth: fakeAuth({ as: otherUser }),
  });

  const res = await server.request("/api/v1/todos", {
    method: "POST",
    headers: { ...signedIn, "Content-Type": "application/json" },
    body: JSON.stringify({ title: "smuggled", userId: sessionUser.id }),
  });

  assert.equal(res.status, 201);
  assert.deepEqual(await store.list(sessionUser.id), []);
  assert.equal((await store.list(otherUser.id)).length, 1);
});

// ---- auth -----------------------------------------------------------------

test("an unauthenticated request to a todo route is a 401", async () => {
  // Uses createApp directly rather than the `app` helper above, because the
  // helper's whole job is to inject the session this test must not have.
  const server = createApp({
    store: createInMemoryStore(seed),
    corsOrigins: ["http://localhost:5173"],
    auth: fakeAuth(),
  });

  const res = await server.request("/api/v1/todos");

  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "Authentication required." });
});

test("an unauthenticated write is a 401 and does not reach the store", async () => {
  const store = createInMemoryStore(seed);
  const server = createApp({
    store,
    corsOrigins: ["http://localhost:5173"],
    auth: fakeAuth(),
  });

  const res = await server.request("/api/v1/todos", json({ title: "sneaky" }));

  assert.equal(res.status, 401);
  // The guard has to run before the handler, not alongside it: a 401 that
  // still wrote the row would be the bug worth catching here.
  assert.deepEqual(
    (await store.list(sessionUser.id)).map((todo) => todo.title),
    ["write tests"],
  );
});

test("health stays public when auth is configured", async () => {
  const server = createApp({
    store: createInMemoryStore(seed),
    corsOrigins: ["http://localhost:5173"],
    auth: fakeAuth(),
  });

  // Container and uptime checks have no session and must not be asked for one.
  assert.equal((await server.request("/health")).status, 200);
});

test("GET /api/v1/me returns both identifiers", async () => {
  // `id` is the immutable account; `username` is the mutable handle. Callers
  // need to be able to tell them apart, so both are returned.
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
    store: createInMemoryStore(seed),
    corsOrigins: ["http://localhost:5173"],
    auth: fakeAuth(),
  });

  // Signing in cannot require already being signed in, so this route must sit
  // in front of the guard.
  const res = await server.request("/api/auth/sign-in/social");

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { handled: "/api/auth/sign-in/social" });
});

test("a bearer token is accepted where a cookie would be", async () => {
  // The VS Code extension has no cookie jar. The middleware passes the whole
  // header set to Better Auth, so this works without a second code path.
  const server = createApp({
    store: createInMemoryStore(seed),
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

  const res = await server.request("/api/v1/todos", {
    headers: { authorization: "Bearer test-token" },
  });

  assert.equal(res.status, 200);
});

test("with no auth configured the todo routes are 503, not open", async () => {
  // The failure mode this guards against is a deploy that forgets the auth
  // env: the API must serve no data rather than everyone's.
  const server = createApp({
    store: createInMemoryStore(seed),
    corsOrigins: ["http://localhost:5173"],
  });

  const res = await server.request("/api/v1/todos");

  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), {
    error: "Authentication is not configured.",
  });
  // Health still answers, so the container can report why it is unhealthy.
  assert.equal((await server.request("/health")).status, 200);
});

test("with no auth configured an unknown route is still a JSON 404", async () => {
  const server = createApp({
    store: createInMemoryStore(seed),
    corsOrigins: ["http://localhost:5173"],
  });

  const res = await server.request("/nope");

  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "Not found." });
});

// ---- proven emails --------------------------------------------------------

/**
 * A stand-in for the email store. The store's own logic is tested against a
 * fake database in `packages/db`; these tests are about the routes in front of
 * it — status codes, ownership scoping, and the shape that reaches the client.
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
    store: createInMemoryStore(seed),
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
    store: createInMemoryStore(seed),
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
  // Scoped to the caller, so another user's id is indistinguishable from a
  // nonexistent one — the endpoint must not confirm which ids exist.
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
    store: createInMemoryStore(seed),
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
  // The request was well formed; the name is simply someone else's, and the
  // form wants to tell those two cases apart.
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
    store: createInMemoryStore(seed),
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
