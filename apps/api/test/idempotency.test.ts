import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  IdempotencyBegin,
  IdempotencyClaim,
  IdempotencyStore,
} from "@sandbox-factory/db";
import { createdApiTokenResponseSchema } from "@sandbox-factory/shared";

import { IDEMPOTENT_ROUTES } from "../src/idempotency.js";
import { buildOpenApiDocument } from "../src/public-api/openapi.js";
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
import { memoryWebhooks } from "./webhook-fakes.js";

/**
 * `Idempotency-Key` through the real guard and routes: a machine
 * credential's retry gets the first answer, a different request under the
 * key is refused, and sessions and other routes are untouched.
 */

/** Keys in memory, as the store keeps them (answers in the clear). */
function memoryKeys(): IdempotencyStore & {
  rows: Map<
    string,
    { requestHash: string; status: number | null; body: string | null }
  >;
  failing: boolean;
} {
  const rows = new Map<
    string,
    { requestHash: string; status: number | null; body: string | null }
  >();
  const id = (claim: IdempotencyClaim) =>
    `${claim.organizationId} ${claim.route} ${claim.key}`;
  const store = {
    rows,
    failing: false,
    begin(
      claim: IdempotencyClaim,
      requestHash: string,
    ): Promise<IdempotencyBegin> {
      const held = rows.get(id(claim));
      if (held === undefined) {
        rows.set(id(claim), { requestHash, status: null, body: null });
        return Promise.resolve({ state: "claimed" });
      }
      return Promise.resolve(
        held.status === null
          ? { state: "running", requestHash: held.requestHash }
          : {
              state: "answered",
              requestHash: held.requestHash,
              status: held.status,
              body: held.body ?? "",
            },
      );
    },
    complete(claim: IdempotencyClaim, status: number, body: string) {
      if (store.failing) return Promise.reject(new Error("db"));
      rows.set(id(claim), {
        requestHash: rows.get(id(claim))?.requestHash ?? "",
        status,
        body,
      });
      return Promise.resolve();
    },
    release(claim: IdempotencyClaim) {
      rows.delete(id(claim));
      return Promise.resolve();
    },
    prune: () => Promise.resolve(0),
  };
  return store;
}

function setup() {
  const tokens = memoryTokens();
  const keys = memoryKeys();
  const webhooks = memoryWebhooks();
  const server = createApp({
    corsOrigins: [],
    auth: fakeAuth(),
    organizations: roleStore({ [`${ada.id}:${ORG}`]: "owner" }),
    apiTokens: tokens,
    idempotencyKeys: keys,
    webhooks: { webhooks, policy: { allowLocalHttp: false } },
  });
  const request = (path: string, init: RequestInit = {}) =>
    server.request(path, init);
  async function bearer(): Promise<Record<string, string>> {
    const res = await request(`/api/v1/orgs/${ORG}/tokens`, {
      method: "POST",
      headers: { ...signedIn, "content-type": "application/json" },
      body: JSON.stringify({ name: "CI", scopes: ["webhooks:write"] }),
    });
    const { secret } = createdApiTokenResponseSchema.parse(await res.json());
    return { authorization: `Bearer ${secret}` };
  }
  const hook = (
    headers: Record<string, string>,
    url = "https://a.example.test/hook",
  ) =>
    request(`/api/v1/orgs/${ORG}/webhooks`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ url, eventTypes: ["run.finished"] }),
    });
  return { request, bearer, hook, keys, webhooks, tokens };
}

test("a retry under the same key answers the first create, once", async () => {
  const { bearer, hook, webhooks, keys } = setup();
  const headers = { ...(await bearer()), "idempotency-key": "create-1" };
  const first = await hook(headers);
  assert.equal(first.status, 201);
  const firstBody = await first.text();
  const again = await hook(headers);
  assert.equal(again.status, 201);
  assert.equal(again.headers.get("idempotent-replayed"), "true");
  assert.equal(await again.text(), firstBody);
  assert.equal(webhooks.endpoints.length, 1);
  assert.equal(
    [...keys.rows.keys()][0],
    `${ORG} POST /api/v1/orgs/:orgId/webhooks create-1`,
  );
});

test("the same key on a different request is idempotency_key_reused", async () => {
  const { bearer, hook, webhooks } = setup();
  const headers = { ...(await bearer()), "idempotency-key": "create-1" };
  await hook(headers);
  const reused = await hook(headers, "https://b.example.test/hook");
  assert.equal(reused.status, 422);
  assert.equal(
    ((await reused.json()) as { code: string }).code,
    "idempotency_key_reused",
  );
  assert.equal(webhooks.endpoints.length, 1);
});

test("a retry while the first runs is idempotency_key_in_use", async () => {
  const { bearer, hook, keys } = setup();
  const headers = { ...(await bearer()), "idempotency-key": "create-1" };
  await hook(headers);
  const [name] = [...keys.rows.keys()];
  const row = keys.rows.get(name ?? "");
  if (row !== undefined) keys.rows.set(name ?? "", { ...row, status: null });
  const busy = await hook(headers);
  assert.equal(busy.status, 409);
  assert.equal(
    ((await busy.json()) as { code: string }).code,
    "idempotency_key_in_use",
  );
});

test("a refused create is kept; a failure lets the key go", async () => {
  const { bearer, hook } = setup();
  const headers = { ...(await bearer()), "idempotency-key": "create-1" };
  const refused = await hook(headers, "http://a.example.test/hook");
  assert.equal(refused.status, 400);
  assert.equal(
    (await hook(headers, "http://a.example.test/hook")).headers.get(
      "idempotent-replayed",
    ),
    "true",
  );
  // A 5xx is never kept: the server could not tell what happened.
  const broken = setup();
  broken.webhooks.createEndpoint = () => Promise.reject(new Error("db"));
  const original = console.error;
  console.error = () => {};
  try {
    const failed = await broken.hook({
      ...(await broken.bearer()),
      "idempotency-key": "create-2",
    });
    assert.equal(failed.status, 500);
  } finally {
    console.error = original;
  }
  assert.equal(broken.keys.rows.size, 0);
});

test("sessions, other routes and absent keys are untouched; a bad key is refused", async () => {
  const { bearer, hook, keys, request } = setup();
  await hook({ ...signedIn, "idempotency-key": "web-1" });
  await hook({ ...signedIn, "idempotency-key": "web-1" });
  assert.equal(keys.rows.size, 0);
  const token = await bearer();
  await hook(token);
  await hook(token);
  assert.equal(keys.rows.size, 0);
  // A route that creates nothing ignores the header.
  const revoked = await request("/api/v1/tokens/self/revoke", {
    method: "POST",
    headers: { ...token, "idempotency-key": "x" },
  });
  assert.equal(revoked.status, 204);
  const { bearer: mint, hook: post } = setup();
  const malformed = await post({
    ...(await mint()),
    "idempotency-key": "has space",
  });
  assert.equal(malformed.status, 400);
  assert.equal(
    ((await malformed.json()) as { code: string }).code,
    "invalid_idempotency_key",
  );
});

test("a device sign-in's mint is replayed, never minted twice", async () => {
  const { request, tokens } = setup();
  const mint = (label: string) =>
    request(`/api/v1/orgs/${ORG}/tokens/cli`, {
      method: "POST",
      headers: {
        ...deviceSession("carveout"),
        "content-type": "application/json",
        "idempotency-key": "login-1",
      },
      body: JSON.stringify({ client: "carveout", label }),
    });
  const first = await mint("laptop");
  assert.equal(first.status, 201);
  const secret = createdApiTokenResponseSchema.parse(await first.json()).secret;
  const again = await mint("laptop");
  assert.equal(
    createdApiTokenResponseSchema.parse(await again.json()).secret,
    secret,
  );
  assert.equal(tokens.rows.length, 1);
  assert.equal((await mint("desktop")).status, 422);
});

test("a key's answer that cannot be kept is logged, not the request's failure", async () => {
  const { bearer, hook, keys } = setup();
  const headers = { ...(await bearer()), "idempotency-key": "create-1" };
  keys.failing = true;
  const logged: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => logged.push(args[0]);
  try {
    assert.equal((await hook(headers)).status, 201);
  } finally {
    console.error = original;
  }
  assert.deepEqual(logged, ["idempotency_record_failed"]);
});

test("the creates take a key, and the document says so", () => {
  for (const route of [
    "POST /api/v1/orgs/:orgId/bounties",
    "POST /api/v1/orgs/:orgId/webhooks",
    "POST /api/v1/orgs/:orgId/sandboxes/start",
    "POST /api/v1/orgs/:orgId/sandboxes/:id/versions",
    "POST /api/v1/orgs/:orgId/github/repositories/:id/runs",
    "POST /api/v1/orgs/:orgId/tokens/cli",
  ])
    assert.ok(IDEMPOTENT_ROUTES.has(route), route);
  assert.equal(IDEMPOTENT_ROUTES.has("POST /api/v1/tokens/self/revoke"), false);
  const document = buildOpenApiDocument() as {
    paths: Record<
      string,
      Record<string, { parameters: Array<{ name: string; in: string }> }>
    >;
  };
  const post = document.paths["/api/v1/orgs/{orgId}/bounties"]?.["post"];
  assert.ok(
    post?.parameters.some(
      ({ name, in: where }) => name === "Idempotency-Key" && where === "header",
    ),
  );
});
