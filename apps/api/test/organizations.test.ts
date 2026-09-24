import assert from "node:assert/strict";
import { test } from "node:test";

import type { OrganizationStore } from "@sandbox-factory/db";

import type { Auth } from "../src/auth.js";
import { createApp, rankAtLeast } from "../src/routes.js";

/**
 * The organization routes.
 *
 * What is tested here is the boundary, not the plugin: that the organization
 * comes from the path rather than the session, that a non-member is told
 * nothing, and that inviting by handle reaches the right address. The plugin's
 * own endpoints (create, rename, remove, accept) are its to test; `auth.ts`
 * pins the configuration they run under.
 */

const dana = {
  id: "user_1",
  email: "dana@example.test",
  name: "Dana",
};

/** A second account, in no organization, for the cross-tenant tests. */
const stranger = {
  id: "user_2",
  email: "stranger@example.test",
  name: "Stranger",
};

const acme = {
  id: "org_1",
  name: "Acme",
  slug: "acme",
  kind: "team" as const,
};

function fakeAuth(
  options: {
    as?: typeof dana;
    onInvite?: (body: Record<string, unknown>) => unknown;
  } = {},
): Auth {
  const { as: user = dana } = options;
  return {
    api: {
      getSession: ({ headers }: { headers: Headers }) =>
        Promise.resolve(
          headers.get("cookie") !== null
            ? { user, session: { id: `session_${user.id}` } }
            : null,
        ),
      createInvitation: ({ body }: { body: Record<string, unknown> }) =>
        Promise.resolve(
          options.onInvite?.(body) ?? {
            id: "inv_1",
            email: body["email"],
            role: body["role"],
            organizationId: body["organizationId"],
            status: "pending",
          },
        ),
    },
    handler: (request: Request) =>
      Promise.resolve(
        Response.json({ handled: new URL(request.url).pathname }),
      ),
  } as unknown as Auth;
}

/** Records what the routes asked the store for, so scoping can be asserted. */
interface Recorded {
  readonly roleOf: Array<[string, string]>;
  readonly listMembers: string[];
  readonly pendingFor: string[];
  /** `[userId, name]` per rename, for the display-name route. */
  readonly renamePersonal: Array<[string, string]>;
}

function fakeStore(
  options: {
    /** Role per `${userId}:${organizationId}`; absent means not a member. */
    roles?: Record<string, string>;
    handles?: Record<string, { id: string; email: string }>;
    organizations?: Array<{
      id: string;
      name: string;
      slug: string;
      kind: "personal" | "team";
    }>;
  } = {},
): { store: OrganizationStore; calls: Recorded } {
  const roles = options.roles ?? { [`${dana.id}:${acme.id}`]: "owner" };
  const organizations = options.organizations ?? [acme];
  const calls: Recorded = {
    roleOf: [],
    listMembers: [],
    pendingFor: [],
    renamePersonal: [],
  };

  const store: OrganizationStore = {
    // Never called by a route: the signup hook is the only caller, and its
    // own behaviour is covered in `packages/db`.
    createPersonal: () => Promise.reject(new Error("not used in these tests")),
    renamePersonal: (userId, name) => {
      calls.renamePersonal.push([userId, name]);
      return Promise.resolve();
    },
    listForUser: (userId) =>
      Promise.resolve(
        organizations
          .filter((org) => roles[`${userId}:${org.id}`] !== undefined)
          .map((org) => ({
            ...org,
            role: roles[`${userId}:${org.id}`] ?? "member",
          })),
      ),
    roleOf: (userId, organizationId) => {
      calls.roleOf.push([userId, organizationId]);
      return Promise.resolve(roles[`${userId}:${organizationId}`]);
    },
    get: (organizationId) =>
      Promise.resolve(organizations.find((org) => org.id === organizationId)),
    findBySlug: (slug) =>
      Promise.resolve(
        organizations.find((org) => org.slug === slug.toLowerCase()),
      ),
    slugOwner: (slug) =>
      Promise.resolve(
        organizations.find((org) => org.slug === slug.toLowerCase())?.id,
      ),
    listMembers: (organizationId) => {
      calls.listMembers.push(organizationId);
      return Promise.resolve([
        {
          id: "mem_1",
          userId: dana.id,
          role: "owner",
          name: "Dana",
          username: "dana",
          image: null,
        },
      ]);
    },
    pendingFor: (email) => {
      calls.pendingFor.push(email);
      return Promise.resolve([
        {
          id: "inv_1",
          organization: acme,
          role: "member",
          expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        },
      ]);
    },
    findUserByHandle: (handle) =>
      Promise.resolve((options.handles ?? {})[handle.toLowerCase()]),
    touch: () => Promise.resolve(),
    setLogo: () => Promise.resolve(),
  };

  return { store, calls };
}

const signedIn = { cookie: "better-auth.session_token=test-token" };

function app(
  options: {
    as?: typeof dana;
    store?: OrganizationStore;
    onInvite?: (body: Record<string, unknown>) => unknown;
  } = {},
) {
  const organizations = options.store ?? fakeStore().store;
  const server = createApp({
    corsOrigins: ["http://localhost:5173"],
    auth: fakeAuth({
      ...(options.as === undefined ? {} : { as: options.as }),
      ...(options.onInvite === undefined ? {} : { onInvite: options.onInvite }),
    }),
    organizations,
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

// ---- the caller's own organizations ---------------------------------------

test("GET /api/v1/me/orgs lists the caller's organizations with roles", async () => {
  const res = await app().request("/api/v1/me/orgs");

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    organizations: [{ ...acme, role: "owner" }],
  });
});

test("someone in no organization gets an empty list", async () => {
  const res = await app({ as: stranger }).request("/api/v1/me/orgs");

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { organizations: [] });
});

test("the organization list needs a session", async () => {
  const server = createApp({
    corsOrigins: ["http://localhost:5173"],
    auth: fakeAuth(),
    organizations: fakeStore().store,
  });

  assert.equal((await server.request("/api/v1/me/orgs")).status, 401);
});

test("GET /api/v1/me/invitations reads the caller's primary address", async () => {
  // Better Auth matches an invitation against the session's primary address
  // on accept, so offering one addressed elsewhere would be a dead end.
  const { store, calls } = fakeStore();
  const res = await app({ store }).request("/api/v1/me/invitations");

  assert.equal(res.status, 200);
  assert.deepEqual(calls.pendingFor, [dana.email]);
  const body = (await res.json()) as {
    invitations: Array<{ id: string; expiresAt: string }>;
  };
  assert.equal(body.invitations[0]?.id, "inv_1");
  // Serialised as an ISO string, per the shared schema.
  assert.equal(body.invitations[0]?.expiresAt, "2099-01-01T00:00:00.000Z");
});

// ---- the membership guard -------------------------------------------------

test("a member reads their organization and their role in it", async () => {
  const res = await app().request(`/api/v1/orgs/${acme.id}`);

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { organization: acme, role: "owner" });
});

test("a non-member gets 404, not 403", async () => {
  // 403 would confirm the organization exists, which is how ids get
  // enumerated. The same rule as any other owner-scoped row.
  const res = await app({ as: stranger }).request(`/api/v1/orgs/${acme.id}`);

  assert.equal(res.status, 404);
});

test("the guard checks the organization named in the path", async () => {
  // Not `session.activeOrganizationId`: one value is shared by every tab and
  // by the extension's bearer session, so it cannot decide what may be read.
  const { store, calls } = fakeStore();
  await app({ store }).request(`/api/v1/orgs/${acme.id}/members`);

  assert.deepEqual(calls.roleOf, [[dana.id, acme.id]]);
});

test("a member of one organization cannot read another's members", async () => {
  const { store, calls } = fakeStore({
    roles: { [`${dana.id}:${acme.id}`]: "owner" },
    organizations: [
      acme,
      { id: "org_2", name: "Globex", slug: "globex", kind: "team" as const },
    ],
  });

  const res = await app({ store }).request("/api/v1/orgs/org_2/members");

  assert.equal(res.status, 404);
  // The member list was never reached.
  assert.deepEqual(calls.listMembers, []);
});

test("GET members returns the handle each member is known by", async () => {
  const res = await app().request(`/api/v1/orgs/${acme.id}/members`);

  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    members: Array<{ userId: string; username: string; role: string }>;
  };
  assert.deepEqual(body.members, [
    {
      id: "mem_1",
      userId: dana.id,
      role: "owner",
      name: "Dana",
      username: "dana",
      image: null,
    },
  ]);
});

// ---- the public handle route ----------------------------------------------

test("an organization is readable by handle without membership", async () => {
  // The public page: two names and nothing else.
  const res = await app({ as: stranger }).request(
    "/api/v1/orgs/by-handle/acme",
  );

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), acme);
});

test("an unknown handle is a 404", async () => {
  const res = await app().request("/api/v1/orgs/by-handle/ghost");

  assert.equal(res.status, 404);
});

test("the handle route is not shadowed by the id route", async () => {
  // `by-handle` is a literal segment that would otherwise be read as an
  // organization id and refused by the membership guard.
  const res = await app({ as: stranger }).request(
    "/api/v1/orgs/by-handle/acme",
  );

  assert.notEqual(res.status, 404);
});

// ---- inviting -------------------------------------------------------------

test("inviting by handle addresses the invitation to their primary email", async () => {
  const { store } = fakeStore({
    handles: { sam: { id: "user_3", email: "sam@example.test" } },
  });
  let sent: Record<string, unknown> | undefined;

  const res = await app({
    store,
    onInvite: (body) => {
      sent = body;
      return { id: "inv_9", ...body };
    },
  }).request(`/api/v1/orgs/${acme.id}/invitations`, json({ handle: "sam" }));

  assert.equal(res.status, 201);
  assert.equal(sent?.["email"], "sam@example.test");
  assert.equal(sent?.["organizationId"], acme.id);
  assert.equal(sent?.["role"], "member");
});

test("inviting by address passes it through", async () => {
  let sent: Record<string, unknown> | undefined;

  const res = await app({
    onInvite: (body) => {
      sent = body;
      return { id: "inv_9", ...body };
    },
  }).request(
    `/api/v1/orgs/${acme.id}/invitations`,
    json({ email: "new@example.test" }),
  );

  assert.equal(res.status, 201);
  assert.equal(sent?.["email"], "new@example.test");
});

test("inviting a handle nobody holds is a 404", async () => {
  const res = await app().request(
    `/api/v1/orgs/${acme.id}/invitations`,
    json({ handle: "ghost" }),
  );

  assert.equal(res.status, 404);
  assert.match(((await res.json()) as { error: string }).error, /ghost/);
});

test("an invitation naming both a handle and an address is refused", async () => {
  const res = await app().request(
    `/api/v1/orgs/${acme.id}/invitations`,
    json({ handle: "sam", email: "sam@example.test" }),
  );

  assert.equal(res.status, 400);
});

test("an invitation naming neither is refused", async () => {
  const res = await app().request(
    `/api/v1/orgs/${acme.id}/invitations`,
    json({}),
  );

  assert.equal(res.status, 400);
});

test("a non-member cannot invite into an organization", async () => {
  // The guard runs before the body is read, so nothing reaches the plugin.
  let reached = false;
  const res = await app({
    as: stranger,
    onInvite: () => {
      reached = true;
      return {};
    },
  }).request(
    `/api/v1/orgs/${acme.id}/invitations`,
    json({ email: "new@example.test" }),
  );

  assert.equal(res.status, 404);
  assert.equal(reached, false);
});

test("the invitation goes to the organization in the path, not the body", async () => {
  // The escalation this guards: a member of Acme posting
  // `{ organizationId: "org_2" }` must not invite into Globex. The guard
  // verified the path segment; the body is not an input to that decision.
  const { store } = fakeStore({
    roles: { [`${dana.id}:${acme.id}`]: "owner" },
    organizations: [
      acme,
      { id: "org_2", name: "Globex", slug: "globex", kind: "team" as const },
    ],
  });
  let sent: Record<string, unknown> | undefined;

  const res = await app({
    store,
    onInvite: (body) => {
      sent = body;
      return { id: "inv_9", ...body };
    },
  }).request(
    `/api/v1/orgs/${acme.id}/invitations`,
    json({ email: "new@example.test", organizationId: "org_2" }),
  );

  assert.equal(res.status, 201);
  assert.equal(sent?.["organizationId"], acme.id);
});

test("a role the schema does not know is refused", async () => {
  // Reaches the plugin as a role it would reject anyway, but failing here
  // keeps an unknown role out of the invitation table.
  const res = await app().request(
    `/api/v1/orgs/${acme.id}/invitations`,
    json({ email: "new@example.test", role: "superuser" }),
  );

  assert.equal(res.status, 400);
});

test("an invitation may name a role deliberately", async () => {
  // So the default test below cannot pass by the route ignoring `role`.
  let sent: Record<string, unknown> | undefined;
  await app({
    onInvite: (body) => {
      sent = body;
      return { id: "inv_9", ...body };
    },
  }).request(
    `/api/v1/orgs/${acme.id}/invitations`,
    json({ email: "new@example.test", role: "admin" }),
  );

  assert.equal(sent?.["role"], "admin");
});

test("an invitation defaults to the member role", async () => {
  // Inviting an owner has to be deliberate.
  let sent: Record<string, unknown> | undefined;
  await app({
    onInvite: (body) => {
      sent = body;
      return { id: "inv_9", ...body };
    },
  }).request(
    `/api/v1/orgs/${acme.id}/invitations`,
    json({ email: "new@example.test" }),
  );

  assert.equal(sent?.["role"], "member");
});

// ---- not configured -------------------------------------------------------

test("without an organization store the routes are not mounted", async () => {
  // The same shape as the email routes: a deploy missing the wiring answers
  // 404 rather than pretending the caller belongs to nothing.
  const server = createApp({
    corsOrigins: ["http://localhost:5173"],
    auth: fakeAuth(),
  });

  const res = await server.request("/api/v1/me/orgs", { headers: signedIn });

  assert.equal(res.status, 404);
});

// ---- the role floor -------------------------------------------------------
//
// Nothing calls `rankAtLeast` yet; it is pinned so the first route that needs
// a floor inherits a comparison that has been checked rather than one written
// in a hurry. A permission helper that is wrong in the "grants access"
// direction is the expensive kind.

test("a role satisfies its own floor", () => {
  for (const role of ["member", "admin", "owner"] as const) {
    assert.equal(
      rankAtLeast(role, role),
      true,
      `${role} should satisfy ${role}`,
    );
  }
});

test("a stronger role satisfies a weaker floor", () => {
  assert.equal(rankAtLeast("owner", "admin"), true);
  assert.equal(rankAtLeast("owner", "member"), true);
  assert.equal(rankAtLeast("admin", "member"), true);
});

test("a weaker role does not satisfy a stronger floor", () => {
  assert.equal(rankAtLeast("member", "admin"), false);
  assert.equal(rankAtLeast("member", "owner"), false);
  assert.equal(rankAtLeast("admin", "owner"), false);
});

test("the strongest of several held roles counts", () => {
  // The plugin stores multiple roles comma-separated and splits on `,` when
  // it checks permissions, so this must read them the same way.
  assert.equal(rankAtLeast("member,owner", "admin"), true);
  assert.equal(rankAtLeast("owner, member", "owner"), true);
  assert.equal(rankAtLeast("member,admin", "owner"), false);
});

test("an unrecognised role grants nothing", () => {
  // The dangerous direction. A role added to the plugin's config but not to
  // `ROLE_RANK` must fail closed, not sail past every floor.
  assert.equal(rankAtLeast("superuser", "member"), false);
  assert.equal(rankAtLeast("", "member"), false);
  // Even beside a real one, the unknown must not lift the result.
  assert.equal(rankAtLeast("superuser,member", "admin"), false);
});

// ---- renaming yourself renames your personal organization -----------------

/*
 * `organization.name` on a personal organization is a copy of `user.name`
 * taken at signup, and no surface edits it directly. If the rename route did
 * not write both, that heading would keep a name its owner had abandoned —
 * with nothing anywhere to correct it.
 */

function appWithNameRoute(store: OrganizationStore) {
  const server = createApp({
    corsOrigins: ["http://localhost:5173"],
    auth: fakeAuth(),
    organizations: store,
    profiles: {
      get: () => Promise.resolve({ username: "dana" }),
      setName: (_userId: string, raw: string) =>
        Promise.resolve({ status: "ok" as const, name: raw.trim() }),
    } as unknown as Parameters<typeof createApp>[0]["profiles"],
  });
  return {
    request: (path: string, init?: RequestInit) =>
      server.request(path, {
        ...init,
        headers: { ...signedIn, ...init?.headers },
      }),
  };
}

test("renaming yourself renames your personal organization too", async () => {
  const { store, calls } = fakeStore();

  const res = await appWithNameRoute(store).request("/api/v1/me/name", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Charlie Ang" }),
  });

  assert.equal(res.status, 200);
  // The caller's own id, from the session — never one from the body.
  assert.deepEqual(calls.renamePersonal, [[dana.id, "Charlie Ang"]]);
});

test("a refused name renames nothing", async () => {
  const { store, calls } = fakeStore();
  const server = createApp({
    corsOrigins: ["http://localhost:5173"],
    auth: fakeAuth(),
    organizations: store,
    profiles: {
      get: () => Promise.resolve({ username: "dana" }),
      setName: () =>
        Promise.resolve({
          status: "invalid" as const,
          reason: "Name cannot be empty.",
        }),
    } as unknown as Parameters<typeof createApp>[0]["profiles"],
  });

  const res = await server.request("/api/v1/me/name", {
    method: "PUT",
    headers: { ...signedIn, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "   " }),
  });

  assert.equal(res.status, 400);
  assert.deepEqual(calls.renamePersonal, []);
});

test("a failed organization rename still saves the name", async () => {
  // Best-effort on purpose: failing the request would report a rename that
  // did in fact happen.
  const { store } = fakeStore();
  const failing: OrganizationStore = {
    ...store,
    renamePersonal: () => Promise.reject(new Error("database is down")),
  };

  const res = await appWithNameRoute(failing).request("/api/v1/me/name", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Charlie Ang" }),
  });

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { name: "Charlie Ang" });
});
