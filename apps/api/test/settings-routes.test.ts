import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import type { WorkspaceSettings } from "@sandbox-factory/db";

import type { AuthVariables } from "../src/http-context.js";
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
