import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

import { getTableConfig } from "drizzle-orm/pg-core";

import { createTokenCipher } from "../src/cipher.js";
import {
  organization,
  user,
  webhookDelivery,
  webhookEndpoint,
} from "../src/schema.js";
import { createWebhookStore, deliveryState } from "../src/webhooks.js";
import { createFakeDb, createSequencedFakeDb } from "./fake-db.js";

const cipher = createTokenCipher(randomBytes(32).toString("base64"));
const at = new Date("2026-11-12T00:00:00.000Z");

const endpointRow = {
  id: "whk_1",
  organizationId: "org_1",
  url: "https://hooks.example.test/lunox",
  description: "CI",
  eventTypes: ["run.finished"],
  enabled: true,
  createdById: "user_1",
  createdByName: "Ada Lovelace",
  consecutiveFailures: 0,
  disabledReason: null,
  disabledAt: null,
  createdAt: at,
  updatedAt: at,
};
const endpoint = {
  id: "whk_1",
  organizationId: "org_1",
  url: "https://hooks.example.test/lunox",
  description: "CI",
  eventTypes: ["run.finished"],
  enabled: true,
  createdBy: { id: "user_1", name: "Ada Lovelace" },
  consecutiveFailures: 0,
  disabledReason: null,
  disabledAt: null,
  createdAt: at,
  updatedAt: at,
};
const deliveryRow = {
  id: "whd_1",
  organizationId: "org_1",
  endpointId: "whk_1",
  eventId: "evt_1",
  type: "run.finished",
  payload: { id: "evt_1" },
  attemptCount: 0,
  nextAttemptAt: at,
  lastStatusCode: null,
  lastError: null,
  deliveredAt: null,
  createdAt: at,
};

test("an endpoint keeps its secret encrypted; deliveries go with it", () => {
  const endpointColumns = getTableConfig(webhookEndpoint).columns.map(
    (column) => column.name,
  );
  assert.ok(endpointColumns.includes("secret_enc"));
  assert.ok(endpointColumns.includes("key_id"));
  assert.equal(endpointColumns.includes("secret"), false);
  const endpointKeys = getTableConfig(webhookEndpoint).foreignKeys;
  const onDelete = (keys: typeof endpointKeys, table: unknown) =>
    keys.find((key) => key.reference().foreignTable === table)?.onDelete;
  assert.equal(onDelete(endpointKeys, organization), "cascade");
  assert.equal(onDelete(endpointKeys, user), "set null");
  const deliveryConfig = getTableConfig(webhookDelivery);
  assert.equal(
    onDelete(deliveryConfig.foreignKeys, webhookEndpoint),
    "cascade",
  );
  assert.deepEqual(
    deliveryConfig.uniqueConstraints[0]?.columns.map((column) => column.name),
    ["endpoint_id", "event_id"],
  );
});

test("createEndpoint stores ciphertext under its key, never the secret", async () => {
  const fake = createSequencedFakeDb([[], [endpointRow]]);
  const created = await createWebhookStore(fake.db, cipher).createEndpoint(
    "org_1",
    {
      url: endpoint.url,
      description: "CI",
      eventTypes: ["run.finished"],
      secret: "whsec_plain",
      createdBy: "user_1",
    },
  );
  assert.deepEqual(created, endpoint);
  const values = fake.calls[0]?.values ?? {};
  assert.match(String(values["id"]), /^whk_/);
  assert.equal(values["keyId"], cipher.keyId);
  assert.notEqual(values["secretEnc"], "whsec_plain");
  assert.equal(cipher.decrypt(String(values["secretEnc"])), "whsec_plain");
  assert.doesNotMatch(JSON.stringify(values), /whsec_plain/);
});

test("createEndpoint refuses when the row cannot be read back", async () => {
  const fake = createSequencedFakeDb([[], []]);
  await assert.rejects(
    createWebhookStore(fake.db, cipher).createEndpoint("org_1", {
      url: endpoint.url,
      description: "",
      eventTypes: ["run.finished"],
      secret: "whsec_plain",
      createdBy: "user_1",
    }),
    /no row/,
  );
});

test("list and get read the workspace's own, with who made them", async () => {
  const fake = createFakeDb([
    endpointRow,
    { ...endpointRow, createdById: null },
  ]);
  const store = createWebhookStore(fake.db, cipher);
  const listed = await store.listEndpoints("org_1");
  assert.deepEqual(listed[0], endpoint);
  assert.equal(listed[1]?.createdBy, null);
  assert.equal(fake.calls[0]?.filtered, true);
  assert.equal(fake.calls[0]?.ordered, true);
  assert.deepEqual(await store.getEndpoint("org_1", "whk_1"), endpoint);
  const gone = createFakeDb([{ ...endpointRow, createdByName: null }]);
  assert.deepEqual(
    (await createWebhookStore(gone.db, cipher).getEndpoint("org_1", "whk_1"))
      ?.createdBy,
    { id: "user_1", name: "" },
  );
  assert.equal(
    await createWebhookStore(createFakeDb([]).db, cipher).getEndpoint(
      "org_1",
      "whk_9",
    ),
    null,
  );
});

test("update writes only what changed; enabling clears an automatic disable", async () => {
  const enable = createSequencedFakeDb([[{ id: "whk_1" }], [endpointRow]]);
  await createWebhookStore(enable.db, cipher).updateEndpoint("org_1", "whk_1", {
    enabled: true,
    url: "https://other.example.test",
    description: "x",
    eventTypes: ["sandbox.published"],
  });
  const set = enable.calls[0]?.values ?? {};
  assert.equal(set["enabled"], true);
  assert.equal(set["consecutiveFailures"], 0);
  assert.equal(set["disabledReason"], null);
  assert.deepEqual(set["eventTypes"], ["sandbox.published"]);
  assert.equal(enable.calls[0]?.filtered, true);

  const disable = createSequencedFakeDb([[{ id: "whk_1" }], [endpointRow]]);
  await createWebhookStore(disable.db, cipher).updateEndpoint(
    "org_1",
    "whk_1",
    { enabled: false },
  );
  assert.equal(disable.calls[0]?.values?.["enabled"], false);
  assert.equal("url" in (disable.calls[0]?.values ?? {}), false);

  const miss = createSequencedFakeDb([[]]);
  assert.equal(
    await createWebhookStore(miss.db, cipher).updateEndpoint("org_2", "whk_1", {
      description: "x",
    }),
    null,
  );
  assert.equal(miss.calls.length, 1);
});

test("delete and rotate act on the workspace's endpoint only", async () => {
  assert.equal(
    await createWebhookStore(
      createFakeDb([{ id: "whk_1" }]).db,
      cipher,
    ).deleteEndpoint("org_1", "whk_1"),
    true,
  );
  assert.equal(
    await createWebhookStore(createFakeDb([]).db, cipher).deleteEndpoint(
      "org_2",
      "whk_1",
    ),
    false,
  );
  const rotate = createSequencedFakeDb([[{ id: "whk_1" }], [endpointRow]]);
  await createWebhookStore(rotate.db, cipher).rotateSecret(
    "org_1",
    "whk_1",
    "whsec_new",
  );
  assert.equal(
    cipher.decrypt(String(rotate.calls[0]?.values?.["secretEnc"])),
    "whsec_new",
  );
});

test("enqueue owes the event to subscribed endpoints, once each", async () => {
  const fake = createSequencedFakeDb([
    [{ id: "whk_1" }, { id: "whk_2" }],
    [deliveryRow],
  ]);
  const made = await createWebhookStore(fake.db, cipher).enqueue(
    "org_1",
    { id: "evt_1", type: "run.finished", payload: { id: "evt_1" } },
    at,
  );
  assert.deepEqual(made, [deliveryRow]);
  assert.equal(fake.calls[0]?.filtered, true);
  const insert = fake.calls[1];
  assert.equal(insert?.kind, "insert");
  assert.deepEqual(insert?.conflictTarget, ["endpoint_id", "event_id"]);
  const rows = insert?.values as unknown as Array<Record<string, unknown>>;
  assert.deepEqual(
    rows.map((row) => row["endpointId"]),
    ["whk_1", "whk_2"],
  );
  assert.ok(rows.every((row) => String(row["id"]).startsWith("whd_")));

  const none = createSequencedFakeDb([[]]);
  assert.deepEqual(
    await createWebhookStore(none.db, cipher).enqueue(
      "org_1",
      { id: "evt_2", type: "ping", payload: {} },
      at,
      "whk_1",
    ),
    [],
  );
  assert.equal(none.calls.length, 1);
});

test("deliveries list a page under the endpoint, and redeliver resets one", async () => {
  const fake = createFakeDb([deliveryRow]);
  const store = createWebhookStore(fake.db, cipher);
  assert.deepEqual(
    await store.listDeliveries("org_1", "whk_1", {
      limit: 25,
      cursor: { createdAt: at.toISOString(), id: "whd_9" },
    }),
    [deliveryRow],
  );
  assert.equal(fake.calls[0]?.limited, 25);
  assert.deepEqual(
    await store.redeliver("org_1", "whk_1", "whd_1", at),
    deliveryRow,
  );
  assert.deepEqual(fake.calls[1]?.values, {
    attemptCount: 0,
    nextAttemptAt: at,
    deliveredAt: null,
  });
  assert.equal(
    await createWebhookStore(createFakeDb([]).db, cipher).redeliver(
      "org_1",
      "whk_1",
      "whd_9",
      at,
    ),
    null,
  );
});

test("claimDue leases due deliveries with their url and secret", async () => {
  const lease = new Date(at.getTime() + 60_000);
  const fake = createSequencedFakeDb([
    [
      {
        ...deliveryRow,
        url: endpoint.url,
        secretEnc: cipher.encrypt("whsec_plain"),
      },
    ],
    [],
  ]);
  const claimed = await createWebhookStore(fake.db, cipher).claimDue(
    at,
    lease,
    10,
  );
  assert.equal(claimed[0]?.secret, "whsec_plain");
  assert.equal(claimed[0]?.url, endpoint.url);
  assert.equal(claimed[0]?.nextAttemptAt, lease);
  assert.equal("secretEnc" in (claimed[0] ?? {}), false);
  assert.equal(fake.calls[0]?.lock, "update");
  assert.deepEqual(fake.calls[1]?.values, { nextAttemptAt: lease });
  const idle = createSequencedFakeDb([[]]);
  assert.deepEqual(
    await createWebhookStore(idle.db, cipher).claimDue(at, lease, 10),
    [],
  );
  assert.equal(idle.calls.length, 1);
});

test("a success clears the endpoint's failures", async () => {
  const fake = createSequencedFakeDb([[], []]);
  const result = await createWebhookStore(fake.db, cipher).recordAttempt(
    deliveryRow,
    { at, ok: true, statusCode: 200, error: null, nextAttemptAt: null },
    20,
    "unused",
  );
  assert.deepEqual(result, { disabled: false });
  assert.equal(fake.calls[0]?.values?.["deliveredAt"], at);
  assert.deepEqual(fake.calls[1]?.values, { consecutiveFailures: 0 });
});

test("a failure counts, and at the limit disables an enabled endpoint", async () => {
  const attempt = {
    at,
    ok: false,
    statusCode: 500,
    error: "HTTP 500",
    nextAttemptAt: new Date(at.getTime() + 60_000),
  };
  const below = createSequencedFakeDb([[], [{ failures: 3, enabled: true }]]);
  assert.deepEqual(
    await createWebhookStore(below.db, cipher).recordAttempt(
      deliveryRow,
      attempt,
      20,
      "r",
    ),
    { disabled: false },
  );
  assert.equal(below.calls.length, 2);
  assert.equal("deliveredAt" in (below.calls[0]?.values ?? {}), false);

  const limit = createSequencedFakeDb([
    [],
    [{ failures: 20, enabled: true }],
    [],
  ]);
  assert.deepEqual(
    await createWebhookStore(limit.db, cipher).recordAttempt(
      deliveryRow,
      attempt,
      20,
      "20 failed attempts in a row; last: HTTP 500",
    ),
    { disabled: true },
  );
  assert.equal(limit.calls[2]?.values?.["enabled"], false);
  assert.equal(
    limit.calls[2]?.values?.["disabledReason"],
    "20 failed attempts in a row; last: HTTP 500",
  );

  for (const counted of [[], [{ failures: 25, enabled: false }]]) {
    const fake = createSequencedFakeDb([[], counted]);
    assert.deepEqual(
      await createWebhookStore(fake.db, cipher).recordAttempt(
        deliveryRow,
        attempt,
        20,
        "r",
      ),
      { disabled: false },
    );
    assert.equal(fake.calls.length, 2);
  }
});

test("prune deletes old deliveries; a delivery's state reads from its columns", async () => {
  const fake = createFakeDb([{ id: "whd_1" }]);
  assert.equal(
    await createWebhookStore(fake.db, cipher).pruneDeliveries(at),
    1,
  );
  assert.equal(fake.calls[0]?.kind, "delete");
  assert.equal(
    deliveryState({ deliveredAt: at, nextAttemptAt: null }),
    "delivered",
  );
  assert.equal(
    deliveryState({ deliveredAt: null, nextAttemptAt: at }),
    "pending",
  );
  assert.equal(
    deliveryState({ deliveredAt: null, nextAttemptAt: null }),
    "failed",
  );
});
