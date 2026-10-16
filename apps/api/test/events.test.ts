import assert from "node:assert/strict";
import { test } from "node:test";

import type { OrganizationStore, RunChange } from "@sandbox-factory/db";

import type { Auth } from "../src/auth.js";
import { createRunChangeHub, type EventRouteOptions } from "../src/events.js";
import type { FlowRouteOptions } from "../src/flows.js";
import { createApp } from "../src/routes.js";

/**
 * The push channel and the typical waits: both behind the membership guard,
 * both the caller's workspace's only.
 */

const user = { id: "user_1", email: "dana@example.test", name: "Dana" };
const roles: Record<string, string> = { org_1: "member", org_2: "owner" };

const auth = {
  api: {
    getSession: ({ headers }: { headers: Headers }) =>
      Promise.resolve(
        headers.get("cookie") === null
          ? null
          : { user, session: { id: "session_1" } },
      ),
  },
  handler: () => Promise.resolve(new Response(null, { status: 404 })),
} as unknown as Auth;

const organizations = {
  roleOf: (_userId: string, organizationId: string) =>
    Promise.resolve(roles[organizationId]),
  listForUser: () => Promise.resolve([]),
} as unknown as OrganizationStore;

function app(options: {
  events?: EventRouteOptions;
  flows?: FlowRouteOptions;
}) {
  const server = createApp({
    corsOrigins: [],
    auth,
    organizations,
    ...options,
  });
  return (path: string) =>
    server.request(path, { headers: { cookie: "session=1" } });
}

/** Reads the stream until `pattern` has arrived, and returns all of it. */
async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  pattern: RegExp,
  sofar = "",
): Promise<string> {
  const decoder = new TextDecoder();
  let text = sofar;
  while (!pattern.test(text)) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  return text;
}

const change = (overrides: Partial<RunChange> = {}): RunChange => ({
  organizationId: "org_1",
  kind: "bounty",
  id: "brn_1",
  ...overrides,
});

test("a stream says it is ready, then each change in its workspace", async () => {
  const hub = createRunChangeHub();
  const get = app({
    events: {
      hub,
      // A member hears of a bounty run, never of a private build.
      visible: async (_owner, role, { kind }) =>
        kind !== "analysis" || role !== "member",
    },
  });
  const response = await get("/api/v1/orgs/org_1/events");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "text/event-stream");
  assert.equal(response.headers.get("X-Accel-Buffering"), "no");
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const ready = await readUntil(reader, /event: ready/);
  assert.match(ready, /retry: 3000/);
  assert.equal(hub.size(), 1);

  hub.publish(change({ organizationId: "org_2", id: "brn_other" }));
  hub.publish(change({ kind: "analysis", id: "arn_private" }));
  hub.publish(change({ id: "brn_1" }));
  const told = await readUntil(reader, /brn_1/);
  assert.match(told, /event: change\ndata: \{"kind":"bounty","id":"brn_1"\}/);
  // Another workspace's, and one the member may not read, were not told.
  assert.doesNotMatch(told, /brn_other|arn_private/);

  await reader.cancel();
  for (let tries = 0; hub.size() > 0 && tries < 50; tries += 1)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(hub.size(), 0);
});

test("an idle stream keeps itself open", async () => {
  const hub = createRunChangeHub();
  const response = await app({ events: { hub, keepaliveMs: 5 } })(
    "/api/v1/orgs/org_2/events",
  );
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  assert.match(await readUntil(reader, /: keepalive/), /event: ready/);
  await reader.cancel();
});

test("a stream is a member's only", async () => {
  const hub = createRunChangeHub();
  assert.equal(
    (await app({ events: { hub } })("/api/v1/orgs/org_3/events")).status,
    404,
  );
  assert.equal(hub.size(), 0);
});

test("the hub hands each change to its workspace's listeners alone", () => {
  const hub = createRunChangeHub();
  const heard: string[] = [];
  const stop = hub.subscribe("org_1", ({ id }) => heard.push(id));
  hub.subscribe("org_1", () => {
    throw new Error("one listener's failure is its own");
  });
  hub.publish(change({ id: "a" }));
  hub.publish(change({ organizationId: "org_2", id: "b" }));
  stop();
  hub.publish(change({ id: "c" }));
  assert.deepEqual(heard, ["a"]);
  assert.equal(hub.size(), 1);
});

test("typical waits are the workspace's own, for the flows asked", async () => {
  const asked: unknown[] = [];
  const get = app({
    flows: {
      waits: {
        typical: async (organizationId, flows, since) => {
          asked.push({ organizationId, flows, since: since.toISOString() });
          return new Map([["run:sandbox_build", { p50: 90, samples: 4 }]]);
        },
      },
      now: () => new Date("2026-10-16T00:00:00.000Z"),
    },
  });
  const response = await get(
    "/api/v1/orgs/org_1/flows/typical?flow=run:sandbox_build&flow=sandbox_sliced&flow=run:sandbox_build",
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    flows: { "run:sandbox_build": { p50: 90, samples: 4 } },
  });
  assert.deepEqual(asked, [
    {
      organizationId: "org_1",
      flows: ["run:sandbox_build", "sandbox_sliced"],
      since: "2026-09-16T00:00:00.000Z",
    },
  ]);
  for (const bad of ["flow=drop table", `flow=${"run:a&flow=".repeat(21)}x`])
    assert.equal(
      (await get(`/api/v1/orgs/org_1/flows/typical?${bad}`)).status,
      400,
    );
  assert.equal(
    (await get("/api/v1/orgs/org_3/flows/typical?flow=price")).status,
    404,
  );
});

test("a change is told as its kind and id alone, to its own workspace's stream", async () => {
  const hub = createRunChangeHub();
  const asked: unknown[] = [];
  const get = app({
    events: {
      hub,
      visible: async (owner, role, told) => {
        asked.push({ owner, role, id: told.id });
        return true;
      },
    },
  });
  const response = await get("/api/v1/orgs/org_2/events");
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  await readUntil(reader, /event: ready/);

  hub.publish(change({ organizationId: "org_1", id: "brn_member" }));
  hub.publish(
    change({ organizationId: "org_2", kind: "profile", id: "bpr_2" }),
  );
  const told = await readUntil(reader, /bpr_2/);
  const data = [...told.matchAll(/^data: (.*)$/gm)]
    .map(([, line]) => JSON.parse(line ?? "null") as Record<string, unknown>)
    .filter((each) => "id" in each);
  assert.deepEqual(data, [{ kind: "profile", id: "bpr_2" }]);
  assert.doesNotMatch(told, /org_[12]|organization|brn_member/);
  // Asked for the stream's own workspace and the caller's role there only.
  assert.deepEqual(asked, [{ owner: "org_2", role: "owner", id: "bpr_2" }]);

  await reader.cancel();
  for (let tries = 0; hub.size() > 0 && tries < 50; tries += 1)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(hub.size(), 0);
  // A change after the stream closed reaches no one.
  hub.publish(change({ organizationId: "org_2", id: "late" }));
  assert.equal(asked.length, 1);
});

test("a non-member's stream is 404 and subscribes to nothing", async () => {
  let subscribed = 0;
  const response = await app({
    events: {
      hub: {
        subscribe: () => {
          subscribed += 1;
          return () => {};
        },
      },
    },
  })("/api/v1/orgs/org_3/events");
  assert.equal(response.status, 404);
  assert.equal(subscribed, 0);
});
