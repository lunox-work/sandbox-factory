import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import {
  DEFAULT_WORKSPACE_SETTINGS,
  type OrganizationStore,
  type WorkspaceSettings,
} from "@sandbox-factory/db";

import type { Auth } from "../src/auth.js";
import type { AuthVariables } from "../src/http-context.js";
import { createApp } from "../src/routes.js";
import { mountSettingsRoutes } from "../src/settings/routes.js";

function fixture(role = "owner") {
  const stored = new Map<string, WorkspaceSettings>();
  const changed: string[] = [];
  const updates: unknown[] = [];
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("user", { id: "user_1" } as never);
    c.set("member", { role, organizationId: "org_1" } as never);
    await next();
  });
  mountSettingsRoutes(app, {
    settings: {
      get: async (owner) => stored.get(owner) ?? { prepareSandboxes: true },
      update: async (owner, change, by) => {
        updates.push({ owner, change, by });
        const next = {
          ...(stored.get(owner) ?? { prepareSandboxes: true }),
          ...change,
        };
        stored.set(owner, next);
        return next;
      },
    },
    onChanged: (owner) => changed.push(owner),
  });
  const request = (method: "GET" | "PATCH", body?: unknown) =>
    app.request("/api/v1/orgs/org_1/settings", {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "Content-Type": "application/json" },
            body: typeof body === "string" ? body : JSON.stringify(body),
          }),
    });
  return { request, changed, updates };
}

test("any member reads the settings, defaults included", async () => {
  const response = await fixture("member").request("GET");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { prepareSandboxes: true });
});

test("an admin changes a setting, keeping the rest, and what it turns on starts", async () => {
  const f = fixture("admin");
  const response = await f.request("PATCH", { prepareSandboxes: false });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { prepareSandboxes: false });
  assert.deepEqual(f.updates, [
    { owner: "org_1", change: { prepareSandboxes: false }, by: "user_1" },
  ]);
  assert.deepEqual(f.changed, ["org_1"]);
  // Naming none changes none.
  assert.equal((await f.request("PATCH", {})).status, 200);
  assert.deepEqual((f.updates.at(-1) as { change: unknown }).change, {});
  assert.deepEqual(await (await f.request("GET")).json(), {
    prepareSandboxes: false,
  });
});

test("a member cannot change a setting, nor can a request that is not one", async () => {
  const member = fixture("member");
  assert.equal(
    (await member.request("PATCH", { prepareSandboxes: false })).status,
    403,
  );
  assert.deepEqual(member.updates, []);
  const owner = fixture("owner");
  for (const body of ["not json", { prepareSandboxes: "no" }, { other: 1 }])
    assert.equal((await owner.request("PATCH", body)).status, 400);
  assert.deepEqual(owner.updates, []);
  assert.deepEqual(owner.changed, []);
});

test("an owner's change persists, and the next read answers it", async () => {
  const f = fixture("owner");
  assert.deepEqual(await (await f.request("GET")).json(), {
    prepareSandboxes: true,
  });
  const patched = await f.request("PATCH", { prepareSandboxes: false });
  assert.equal(patched.status, 200);
  assert.deepEqual(await (await f.request("GET")).json(), {
    prepareSandboxes: false,
  });
  assert.equal(
    (await f.request("PATCH", { prepareSandboxes: true })).status,
    200,
  );
  assert.deepEqual(await (await f.request("GET")).json(), {
    prepareSandboxes: true,
  });
  assert.deepEqual(f.changed, ["org_1", "org_1"]);
});

test("the settings are behind the membership guard, a non-member's 404", async () => {
  const user = { id: "user_1", email: "dana@example.test", name: "Dana" };
  const roles: Record<string, string> = { org_1: "member", org_2: "owner" };
  const auth = {
    api: {
      getSession: () => Promise.resolve({ user, session: { id: "session_1" } }),
    },
    handler: () => Promise.resolve(new Response(null, { status: 404 })),
  } as unknown as Auth;
  const organizations = {
    roleOf: (_userId: string, organizationId: string) =>
      Promise.resolve(roles[organizationId]),
    listForUser: () => Promise.resolve([]),
  } as unknown as OrganizationStore;
  const read: string[] = [];
  const written: string[] = [];
  const server = createApp({
    corsOrigins: [],
    auth,
    organizations,
    settings: {
      settings: {
        // No row: the defaults.
        get: async (owner) => {
          read.push(owner);
          return { ...DEFAULT_WORKSPACE_SETTINGS };
        },
        update: async (owner, change) => {
          written.push(owner);
          return { ...DEFAULT_WORKSPACE_SETTINGS, ...change };
        },
      },
    },
  });
  const request = (orgId: string, method = "GET", body?: unknown) =>
    server.request(`/api/v1/orgs/${orgId}/settings`, {
      method,
      headers: { cookie: "session=1", "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const member = await request("org_1");
  assert.equal(member.status, 200);
  assert.deepEqual(await member.json(), { prepareSandboxes: true });
  assert.equal(
    (await request("org_1", "PATCH", { prepareSandboxes: false })).status,
    403,
  );
  assert.equal(
    (await request("org_2", "PATCH", { prepareSandboxes: false })).status,
    200,
  );
  assert.equal((await request("org_3")).status, 404);
  assert.equal(
    (await request("org_3", "PATCH", { prepareSandboxes: false })).status,
    404,
  );
  assert.deepEqual(read, ["org_1"]);
  assert.deepEqual(written, ["org_2"]);
});
