import assert from "node:assert/strict";
import { test } from "node:test";

import type { StoredWebhookDelivery } from "@sandbox-factory/db";
import {
  createdApiTokenResponseSchema,
  webhookDeliveryListSchema,
  webhookDeliveryResponseSchema,
  webhookEndpointListSchema,
  webhookEndpointResponseSchema,
  webhookSecretResponseSchema,
} from "@sandbox-factory/shared";
import type { ApiScope } from "sandbox-factory";

import { createApp } from "../src/routes.js";
import {
  ada,
  fakeAuth,
  memoryTokens,
  ORG,
  OTHER_ORG,
  roleStore,
  signedIn,
} from "./token-fakes.js";
import { memoryWebhooks } from "./webhook-fakes.js";

/**
 * The webhook routes through the real guard: owners and admins, tokens by
 * scope, the secret shown once, URLs checked, and deliveries listed, sent
 * again and pinged.
 */

const NOW = new Date("2026-11-12T00:00:00.000Z");

function setup(
  roles: Record<string, string> = { [`${ada.id}:${ORG}`]: "owner" },
) {
  const webhooks = memoryWebhooks();
  let kicks = 0;
  const server = createApp({
    corsOrigins: [],
    auth: fakeAuth(),
    organizations: roleStore(roles),
    apiTokens: memoryTokens(),
    webhooks: {
      webhooks,
      policy: { allowLocalHttp: false },
      onEnqueued: () => {
        kicks += 1;
      },
      generate: () => `whsec_${"s".repeat(40)}`,
    },
    now: () => NOW,
  });
  const request = (path: string, init: RequestInit = {}) =>
    server.request(path, init);
  const json = (body: unknown, headers: Record<string, string> = signedIn) => ({
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  async function token(scopes: ApiScope[]): Promise<Record<string, string>> {
    const res = await request(`/api/v1/orgs/${ORG}/tokens`, {
      method: "POST",
      ...json({ name: "CI", scopes }),
    });
    const { secret } = createdApiTokenResponseSchema.parse(await res.json());
    return { authorization: `Bearer ${secret}` };
  }
  return { request, json, token, webhooks, kicks: () => kicks };
}

const base = `/api/v1/orgs/${ORG}/webhooks`;

test("creating an endpoint answers its secret once; reads never do", async () => {
  const { request, json, webhooks } = setup();
  const res = await request(base, {
    method: "POST",
    ...json({
      url: "https://hooks.example.test/lunox",
      description: "CI",
      eventTypes: ["run.finished", "proposal.priced"],
    }),
  });
  assert.equal(res.status, 201);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const created = webhookSecretResponseSchema.parse(await res.json());
  assert.equal(created.secret, `whsec_${"s".repeat(40)}`);
  assert.equal(webhooks.endpoints[0]?.secret, created.secret);
  const listed = await request(base, { headers: signedIn });
  const text = await listed.text();
  assert.doesNotMatch(text, /whsec_/);
  assert.equal(
    webhookEndpointListSchema.parse(JSON.parse(text)).endpoints[0]?.id,
    created.endpoint.id,
  );
  const one = await request(`${base}/${created.endpoint.id}`, {
    headers: signedIn,
  });
  assert.equal(
    webhookEndpointResponseSchema.parse(await one.json()).endpoint.url,
    "https://hooks.example.test/lunox",
  );
  assert.equal(
    (await request(`${base}/whk_9`, { headers: signedIn })).status,
    404,
  );
});

test("a URL that is not https, or names a private address, is refused", async () => {
  const { request, json } = setup();
  for (const url of [
    "http://hooks.example.test",
    "https://169.254.169.254/latest/meta-data",
    "https://10.0.0.1/hook",
    "https://[::1]/hook",
  ]) {
    const res = await request(base, {
      method: "POST",
      ...json({ url, eventTypes: ["run.finished"] }),
    });
    assert.equal(res.status, 400, url);
    assert.equal(((await res.json()) as { code: string }).code, "url_refused");
  }
  const malformed = await request(base, {
    method: "POST",
    ...json({ url: "https://hooks.example.test", eventTypes: ["nope"] }),
  });
  assert.equal(
    ((await malformed.json()) as { code: string }).code,
    "invalid_webhook",
  );
});

test("an endpoint is changed, rotated and deleted", async () => {
  const { request, json, webhooks } = setup();
  await request(base, {
    method: "POST",
    ...json({ url: "https://a.example.test", eventTypes: ["run.finished"] }),
  });
  const patched = await request(`${base}/whk_1`, {
    method: "PATCH",
    ...json({ enabled: false, eventTypes: ["sandbox.published"] }),
  });
  assert.equal(patched.status, 200);
  const endpoint = webhookEndpointResponseSchema.parse(
    await patched.json(),
  ).endpoint;
  assert.equal(endpoint.enabled, false);
  assert.deepEqual(endpoint.eventTypes, ["sandbox.published"]);
  for (const [body, status] of [
    [{}, 400],
    [{ url: "http://a.example.test" }, 400],
  ] as const) {
    const res = await request(`${base}/whk_1`, {
      method: "PATCH",
      ...json(body),
    });
    assert.equal(res.status, status);
  }
  assert.equal(
    (
      await request(`${base}/whk_9`, {
        method: "PATCH",
        ...json({ description: "x" }),
      })
    ).status,
    404,
  );
  webhooks.endpoints[0] = {
    ...(webhooks.endpoints[0] as (typeof webhooks.endpoints)[number]),
    secret: "whsec_old",
  };
  const rotated = await request(`${base}/whk_1/rotate-secret`, {
    method: "POST",
    headers: signedIn,
  });
  assert.equal(rotated.status, 200);
  assert.equal(
    webhookSecretResponseSchema.parse(await rotated.json()).secret,
    webhooks.endpoints[0]?.secret,
  );
  assert.notEqual(webhooks.endpoints[0]?.secret, "whsec_old");
  assert.equal(
    (
      await request(`${base}/whk_9/rotate-secret`, {
        method: "POST",
        headers: signedIn,
      })
    ).status,
    404,
  );
  assert.equal(
    (await request(`${base}/whk_1`, { method: "DELETE", headers: signedIn }))
      .status,
    204,
  );
  assert.equal(
    (await request(`${base}/whk_1`, { method: "DELETE", headers: signedIn }))
      .status,
    404,
  );
});

test("a ping is owed to its endpoint alone; a delivery can be sent again", async () => {
  const { request, json, webhooks, kicks } = setup();
  await request(base, {
    method: "POST",
    ...json({ url: "https://a.example.test", eventTypes: ["run.finished"] }),
  });
  const ping = await request(`${base}/whk_1/ping`, {
    method: "POST",
    headers: signedIn,
  });
  assert.equal(ping.status, 202);
  const { delivery } = webhookDeliveryResponseSchema.parse(await ping.json());
  assert.equal(delivery.type, "ping");
  assert.equal(delivery.state, "pending");
  assert.equal(delivery.payload.organizationId, ORG);
  assert.deepEqual(delivery.payload.data, { endpointId: "whk_1" });
  assert.equal(kicks(), 1);
  webhooks.deliveries[0] = {
    ...(webhooks.deliveries[0] as StoredWebhookDelivery),
    attemptCount: 8,
    nextAttemptAt: null,
    lastError: "HTTP 500",
  };
  const listed = webhookDeliveryListSchema.parse(
    await (
      await request(`${base}/whk_1/deliveries?limit=1`, { headers: signedIn })
    ).json(),
  );
  assert.equal(listed.deliveries[0]?.state, "failed");
  assert.equal(listed.nextCursor, `${NOW.toISOString()}|whd_1`);
  const again = await request(
    `${base}/whk_1/deliveries/${delivery.id}/redeliver`,
    { method: "POST", headers: signedIn },
  );
  assert.equal(again.status, 202);
  const resent = webhookDeliveryResponseSchema.parse(await again.json());
  assert.equal(resent.delivery.attemptCount, 0);
  assert.equal(resent.delivery.state, "pending");
  assert.equal(kicks(), 2);
  for (const path of [
    `${base}/whk_1/deliveries/whd_9/redeliver`,
    `${base}/whk_9/ping`,
  ])
    assert.equal(
      (await request(path, { method: "POST", headers: signedIn })).status,
      404,
    );
  assert.equal(
    (await request(`${base}/whk_9/deliveries`, { headers: signedIn })).status,
    404,
  );
  assert.equal(
    (await request(`${base}/whk_1/deliveries?cursor=x`, { headers: signedIn }))
      .status,
    400,
  );
  await request(`${base}/whk_1`, {
    method: "PATCH",
    ...json({ enabled: false }),
  });
  const disabled = await request(`${base}/whk_1/ping`, {
    method: "POST",
    headers: signedIn,
  });
  assert.equal(disabled.status, 409);
});

test("tokens read with workspace:read and write with webhooks:write; members never", async () => {
  const roles: Record<string, string> = { [`${ada.id}:${ORG}`]: "owner" };
  const { request, json, token } = setup(roles);
  const reader = await token(["workspace:read"]);
  const writer = await token(["webhooks:write"]);
  assert.equal((await request(base, { headers: reader })).status, 200);
  const refused = await request(base, {
    method: "POST",
    ...json(
      { url: "https://a.example.test", eventTypes: ["run.finished"] },
      reader,
    ),
  });
  assert.equal(refused.status, 403);
  assert.equal(
    ((await refused.json()) as { code: string }).code,
    "insufficient_scope",
  );
  const made = await request(base, {
    method: "POST",
    ...json(
      { url: "https://a.example.test", eventTypes: ["run.finished"] },
      writer,
    ),
  });
  assert.equal(made.status, 201);
  assert.equal(
    (await request(`/api/v1/orgs/${OTHER_ORG}/webhooks`, { headers: reader }))
      .status,
    404,
  );
  roles[`${ada.id}:${ORG}`] = "member";
  assert.equal((await request(base, { headers: signedIn })).status, 403);
});
