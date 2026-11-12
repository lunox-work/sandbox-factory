import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_WORKSPACE_SETTINGS,
  type AuditEntry,
  type AuditStore,
  type NewAuditEntry,
  type WorkspaceSettingsStore,
} from "@sandbox-factory/db";
import {
  auditListResponseSchema,
  createdApiTokenResponseSchema,
} from "@sandbox-factory/shared";

import { pathResource } from "../src/audit/trail.js";
import { createApp } from "../src/routes.js";
import {
  ada,
  deviceSession,
  fakeAuth,
  memoryTokens,
  ORG,
  roleStore,
  signedIn,
} from "./token-fakes.js";

/**
 * The audit trail through the real guard and routes: what a machine
 * credential changes is recorded, refusals too, reads are not, a session
 * is recorded only managing credentials, and nothing of a body or a URL's
 * query is kept.
 */

const settingsStore: WorkspaceSettingsStore = {
  get: () => Promise.resolve(DEFAULT_WORKSPACE_SETTINGS),
  update: (_owner, change) =>
    Promise.resolve({ ...DEFAULT_WORKSPACE_SETTINGS, ...change }),
};

function memoryAudit(): AuditStore & {
  entries: Array<NewAuditEntry & { organizationId: string }>;
  failing: boolean;
} {
  const entries: Array<NewAuditEntry & { organizationId: string }> = [];
  const store = {
    entries,
    failing: false,
    record(organizationId: string, entry: NewAuditEntry) {
      if (store.failing) return Promise.reject(new Error("offline"));
      entries.push({ organizationId, ...entry });
      return Promise.resolve();
    },
    list(organizationId: string, options: { limit: number }) {
      return Promise.resolve(
        entries
          .filter((entry) => entry.organizationId === organizationId)
          .slice(0, options.limit)
          .map(({ userId, ...entry }, index): AuditEntry => ({
            ...entry,
            id: `aud_${index + 1}`,
            user: userId === null ? null : { id: userId, name: ada.name },
            at: new Date("2026-11-12T00:00:00.000Z"),
          })),
      );
    },
    prune: () => Promise.resolve(0),
  };
  return store;
}

function setup(
  roles: Record<string, string> = { [`${ada.id}:${ORG}`]: "owner" },
) {
  const tokens = memoryTokens();
  const audit = memoryAudit();
  const server = createApp({
    corsOrigins: [],
    auth: fakeAuth(),
    organizations: roleStore(roles),
    settings: { settings: settingsStore },
    apiTokens: tokens,
    audit,
  });
  const request = (path: string, init: RequestInit = {}) =>
    server.request(path, init);
  async function mint(): Promise<{ secret: string; id: string }> {
    const res = await request(`/api/v1/orgs/${ORG}/tokens`, {
      method: "POST",
      headers: { ...signedIn, "content-type": "application/json" },
      body: JSON.stringify({ name: "CI", scopes: ["workspace:read"] }),
    });
    const created = createdApiTokenResponseSchema.parse(await res.json());
    return { secret: created.secret, id: created.token.id };
  }
  return { request, mint, audit, tokens };
}

test("a token's change is recorded with its route, never its query or body", async () => {
  const { request, mint, audit } = setup();
  const { secret, id } = await mint();
  audit.entries.length = 0;
  const bearer = { authorization: `Bearer ${secret}` };
  assert.equal((await request("/api/v1/me", { headers: bearer })).status, 200);
  const res = await request("/api/v1/tokens/self/revoke?note=secret", {
    method: "POST",
    headers: { ...bearer, "x-request-id": "req-abc" },
    body: JSON.stringify({ secret: "do-not-keep" }),
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("x-request-id"), "req-abc");
  assert.deepEqual(audit.entries, [
    {
      organizationId: ORG,
      via: "token",
      credentialId: id,
      client: null,
      userId: ada.id,
      method: "POST",
      route: "/api/v1/tokens/self/revoke",
      resourceId: null,
      status: 204,
      requestId: "req-abc",
    },
  ]);
  assert.doesNotMatch(JSON.stringify(audit.entries), /secret|do-not-keep/);
});

test("a token's refusal is recorded too", async () => {
  const { request, mint, audit } = setup();
  const { secret } = await mint();
  audit.entries.length = 0;
  const res = await request(`/api/v1/orgs/${ORG}/settings`, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ prepareSandboxes: false }),
  });
  assert.equal(res.status, 403);
  assert.equal(audit.entries[0]?.route, "/api/v1/orgs/:orgId/settings");
  assert.equal(audit.entries[0]?.status, 403);
  assert.match(audit.entries[0]?.requestId ?? "", /^[\w-]+$/);
  // No credential the guard could read: nobody to name.
  await request(`/api/v1/orgs/${ORG}/settings`, { method: "PATCH" });
  await request(`/api/v1/orgs/${ORG}/settings`, {
    method: "PATCH",
    headers: { authorization: "Bearer lnx_unknown" },
  });
  assert.equal(audit.entries.length, 1);
});

test("a session is recorded managing credentials only, with the resource", async () => {
  const { request, mint, audit } = setup();
  const { id } = await mint();
  await request(`/api/v1/orgs/${ORG}/tokens/${id}/revoke`, {
    method: "POST",
    headers: signedIn,
  });
  await request(`/api/v1/orgs/${ORG}/settings`, {
    method: "PATCH",
    headers: { ...signedIn, "content-type": "application/json" },
    body: JSON.stringify({ prepareSandboxes: false }),
  });
  assert.deepEqual(
    audit.entries.map(({ via, route, resourceId, status }) => ({
      via,
      route,
      resourceId,
      status,
    })),
    [
      {
        via: "session",
        route: "/api/v1/orgs/:orgId/tokens",
        resourceId: id,
        status: 201,
      },
      {
        via: "session",
        route: "/api/v1/orgs/:orgId/tokens/:id/revoke",
        resourceId: id,
        status: 200,
      },
    ],
  );
});

test("a device sign-in's mint is recorded with its client", async () => {
  const { request, audit } = setup();
  const res = await request(`/api/v1/orgs/${ORG}/tokens/cli`, {
    method: "POST",
    headers: {
      ...deviceSession("carveout"),
      "content-type": "application/json",
    },
    body: JSON.stringify({ client: "carveout" }),
  });
  assert.equal(res.status, 201);
  assert.equal(audit.entries[0]?.via, "device");
  assert.equal(audit.entries[0]?.client, "carveout");
  assert.equal(audit.entries[0]?.credentialId, "session_carveout");
});

test("a failed audit write is logged, never the request's failure", async () => {
  const { request, mint, audit } = setup();
  const { secret } = await mint();
  audit.failing = true;
  const logged: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => logged.push(args[0]);
  try {
    const res = await request("/api/v1/tokens/self/revoke", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
    });
    assert.equal(res.status, 204);
  } finally {
    console.error = original;
  }
  assert.deepEqual(logged, ["audit_record_failed"]);
});

test("owners and admins read the log from a session, a page at a time", async () => {
  const roles: Record<string, string> = { [`${ada.id}:${ORG}`]: "owner" };
  const { request, mint } = setup(roles);
  const { secret } = await mint();
  await mint();
  const page = await request(`/api/v1/orgs/${ORG}/audit?limit=1`, {
    headers: signedIn,
  });
  assert.equal(page.status, 200);
  const parsed = auditListResponseSchema.parse(await page.json());
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.nextCursor, "2026-11-12T00:00:00.000Z|aud_1");
  const all = auditListResponseSchema.parse(
    await (
      await request(`/api/v1/orgs/${ORG}/audit`, { headers: signedIn })
    ).json(),
  );
  assert.equal(all.nextCursor, null);
  assert.equal(
    (
      await request(`/api/v1/orgs/${ORG}/audit?cursor=nope`, {
        headers: signedIn,
      })
    ).status,
    400,
  );
  // Not a token's to read.
  const token = await request(`/api/v1/orgs/${ORG}/audit`, {
    headers: { authorization: `Bearer ${secret}` },
  });
  assert.equal(token.status, 403);
  roles[`${ada.id}:${ORG}`] = "member";
  assert.equal(
    (await request(`/api/v1/orgs/${ORG}/audit`, { headers: signedIn })).status,
    403,
  );
});

test("the resource is the path's last parameter but the workspace", () => {
  assert.equal(
    pathResource(
      "/api/v1/orgs/:orgId/sandboxes/versions/:vid/build",
      "/api/v1/orgs/org_1/sandboxes/versions/ver_1/build",
    ),
    "ver_1",
  );
  assert.equal(
    pathResource("/api/v1/orgs/:orgId/bounties", "/api/v1/orgs/org_1/bounties"),
    null,
  );
});
