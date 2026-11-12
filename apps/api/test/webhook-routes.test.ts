import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  StoredWebhookDelivery,
  StoredWebhookEndpoint,
  WebhookStore,
} from "@sandbox-factory/db";
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

/**
 * The webhook routes through the real guard: owners and admins, tokens by
 * scope, the secret shown once, URLs checked, and deliveries listed, sent
 * again and pinged.
 */

const NOW = new Date("2026-11-12T00:00:00.000Z");

/** Endpoints and deliveries in memory, secrets in the clear (as decrypted). */
function memoryWebhooks(): WebhookStore & {
  endpoints: Array<StoredWebhookEndpoint & { secret: string }>;
  deliveries: StoredWebhookDelivery[];
} {
  const endpoints: Array<StoredWebhookEndpoint & { secret: string }> = [];
  const deliveries: StoredWebhookDelivery[] = [];
  const shown = ({
    secret: _secret,
    ...endpoint
  }: StoredWebhookEndpoint & { secret: string }) => endpoint;
  const find = (owner: string, id: string) =>
    endpoints.findIndex(
      (endpoint) => endpoint.organizationId === owner && endpoint.id === id,
    );
  const unused = () => Promise.reject(new Error("not used here"));
  return {
    endpoints,
    deliveries,
    createEndpoint(owner, input) {
      const endpoint = {
        id: `whk_${endpoints.length + 1}`,
        organizationId: owner,
        url: input.url,
        description: input.description,
        eventTypes: [...input.eventTypes],
        enabled: true,
        createdBy: { id: input.createdBy, name: ada.name },
        consecutiveFailures: 0,
        disabledReason: null,
        disabledAt: null,
        createdAt: NOW,
        updatedAt: NOW,
        secret: input.secret,
      };
      endpoints.push(endpoint);
      return Promise.resolve(shown(endpoint));
    },
    listEndpoints: (owner) =>
      Promise.resolve(
        endpoints
          .filter((endpoint) => endpoint.organizationId === owner)
          .map(shown),
      ),
    getEndpoint(owner, id) {
      const endpoint = endpoints[find(owner, id)];
      return Promise.resolve(endpoint === undefined ? null : shown(endpoint));
    },
    updateEndpoint(owner, id, change) {
      const index = find(owner, id);
      const endpoint = endpoints[index];
      if (endpoint === undefined) return Promise.resolve(null);
      const next = {
        ...endpoint,
        ...(change.url === undefined ? {} : { url: change.url }),
        ...(change.description === undefined
          ? {}
          : { description: change.description }),
        ...(change.eventTypes === undefined
          ? {}
          : { eventTypes: [...change.eventTypes] }),
        ...(change.enabled === undefined ? {} : { enabled: change.enabled }),
      };
      endpoints[index] = next;
      return Promise.resolve(shown(next));
    },
    deleteEndpoint(owner, id) {
      const index = find(owner, id);
      if (index === -1) return Promise.resolve(false);
      endpoints.splice(index, 1);
      return Promise.resolve(true);
    },
    rotateSecret(owner, id, secret) {
      const index = find(owner, id);
      const endpoint = endpoints[index];
      if (endpoint === undefined) return Promise.resolve(null);
      endpoints[index] = { ...endpoint, secret };
      return Promise.resolve(shown(endpoint));
    },
    enqueue(owner, event, at, only) {
      const made = endpoints
        .filter(
          (endpoint) =>
            endpoint.organizationId === owner &&
            (only === undefined
              ? endpoint.enabled && endpoint.eventTypes.includes(event.type)
              : endpoint.id === only),
        )
        .map((endpoint): StoredWebhookDelivery => ({
          id: `whd_${deliveries.length + 1}`,
          organizationId: owner,
          endpointId: endpoint.id,
          eventId: event.id,
          type: event.type,
          payload: event.payload,
          attemptCount: 0,
          nextAttemptAt: at,
          lastStatusCode: null,
          lastError: null,
          deliveredAt: null,
          createdAt: at,
        }));
      deliveries.push(...made);
      return Promise.resolve(made);
    },
    listDeliveries: (owner, endpointId, { limit }) =>
      Promise.resolve(
        deliveries
          .filter(
            (delivery) =>
              delivery.organizationId === owner &&
              delivery.endpointId === endpointId,
          )
          .slice(0, limit),
      ),
    redeliver(owner, endpointId, deliveryId, at) {
      const index = deliveries.findIndex(
        (delivery) =>
          delivery.organizationId === owner &&
          delivery.endpointId === endpointId &&
          delivery.id === deliveryId,
      );
      const delivery = deliveries[index];
      if (delivery === undefined) return Promise.resolve(null);
      const next = {
        ...delivery,
        attemptCount: 0,
        nextAttemptAt: at,
        deliveredAt: null,
      };
      deliveries[index] = next;
      return Promise.resolve(next);
    },
    claimDue: unused,
    recordAttempt: unused,
    pruneDeliveries: unused,
  };
}

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
