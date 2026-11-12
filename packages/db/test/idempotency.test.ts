import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

import { getTableConfig } from "drizzle-orm/pg-core";

import { createTokenCipher } from "../src/cipher.js";
import {
  createIdempotencyStore,
  IDEMPOTENCY_TTL_MS,
} from "../src/idempotency.js";
import { idempotencyKey, organization } from "../src/schema.js";
import { createFakeDb, createSequencedFakeDb } from "./fake-db.js";

const cipher = createTokenCipher(randomBytes(32).toString("base64"));
const at = new Date("2026-11-12T00:00:00.000Z");
const abandoned = new Date(at.getTime() - 5 * 60_000);
const claim = {
  organizationId: "org_1",
  route: "POST /api/v1/orgs/:orgId/bounties",
  key: "k1",
};

test("a key is one per workspace, route and key, and goes with the workspace", () => {
  const config = getTableConfig(idempotencyKey);
  assert.deepEqual(
    config.primaryKeys[0]?.columns.map((column) => column.name),
    ["organization_id", "route", "key"],
  );
  assert.equal(
    config.foreignKeys.find(
      (key) => key.reference().foreignTable === organization,
    )?.onDelete,
    "cascade",
  );
});

test("the first request claims the key, for a day", async () => {
  const fake = createSequencedFakeDb([[{ key: "k1" }]]);
  assert.deepEqual(
    await createIdempotencyStore(fake.db, cipher).begin(
      claim,
      "h1",
      at,
      abandoned,
    ),
    { state: "claimed" },
  );
  const values = fake.calls[0]?.values ?? {};
  assert.equal(values["requestHash"], "h1");
  assert.equal(
    (values["expiresAt"] as Date).getTime(),
    at.getTime() + IDEMPOTENCY_TTL_MS,
  );
  assert.equal(fake.calls[0]?.ignoredConflict, true);
});

test("a retry finds the answer, decrypted, or the request still running", async () => {
  const answered = createSequencedFakeDb([
    [],
    [],
    [{ requestHash: "h1", status: 201, bodyEnc: cipher.encrypt('{"a":1}') }],
  ]);
  assert.deepEqual(
    await createIdempotencyStore(answered.db, cipher).begin(
      claim,
      "h1",
      at,
      abandoned,
    ),
    { state: "answered", requestHash: "h1", status: 201, body: '{"a":1}' },
  );
  assert.equal(answered.calls[1]?.kind, "delete");
  assert.equal(answered.calls[2]?.filtered, true);
  const running = createSequencedFakeDb([
    [],
    [],
    [{ requestHash: "h1", status: null, bodyEnc: null }],
  ]);
  assert.deepEqual(
    await createIdempotencyStore(running.db, cipher).begin(
      claim,
      "h2",
      at,
      abandoned,
    ),
    { state: "running", requestHash: "h1" },
  );
  const blank = createSequencedFakeDb([
    [],
    [],
    [{ requestHash: "h1", status: 204, bodyEnc: null }],
  ]);
  assert.equal(
    (
      (await createIdempotencyStore(blank.db, cipher).begin(
        claim,
        "h1",
        at,
        abandoned,
      )) as { body: string }
    ).body,
    "",
  );
});

test("an expired or abandoned key is cleared and claimed afresh", async () => {
  const fake = createSequencedFakeDb([[], [{ key: "k1" }], [{ key: "k1" }]]);
  assert.deepEqual(
    await createIdempotencyStore(fake.db, cipher).begin(
      claim,
      "h2",
      at,
      abandoned,
    ),
    { state: "claimed" },
  );
  assert.deepEqual(
    fake.calls.map((call) => call.kind),
    ["insert", "delete", "insert"],
  );
});

test("a key released between the statements is claimed, or found running", async () => {
  const freed = createSequencedFakeDb([[], [], [], [{ key: "k1" }]]);
  assert.deepEqual(
    await createIdempotencyStore(freed.db, cipher).begin(
      claim,
      "h1",
      at,
      abandoned,
    ),
    { state: "claimed" },
  );
  const lost = createSequencedFakeDb([[], [], [], []]);
  assert.deepEqual(
    await createIdempotencyStore(lost.db, cipher).begin(
      claim,
      "h1",
      at,
      abandoned,
    ),
    { state: "running", requestHash: "h1" },
  );
  const cleared = createSequencedFakeDb([
    [],
    [{ key: "k1" }],
    [],
    [{ requestHash: "h9", status: null, bodyEnc: null }],
  ]);
  assert.deepEqual(
    await createIdempotencyStore(cleared.db, cipher).begin(
      claim,
      "h1",
      at,
      abandoned,
    ),
    { state: "running", requestHash: "h9" },
  );
});

test("complete keeps the answer encrypted; release and prune delete", async () => {
  const fake = createFakeDb([{ key: "k1" }]);
  const store = createIdempotencyStore(fake.db, cipher);
  await store.complete(claim, 201, '{"secret":"lnx_x"}');
  const set = fake.calls[0]?.values ?? {};
  assert.equal(set["status"], 201);
  assert.doesNotMatch(String(set["bodyEnc"]), /lnx_x/);
  assert.equal(cipher.decrypt(String(set["bodyEnc"])), '{"secret":"lnx_x"}');
  assert.equal(set["keyId"], cipher.keyId);
  await store.release(claim);
  assert.equal(fake.calls[1]?.kind, "delete");
  assert.equal(fake.calls[1]?.filtered, true);
  assert.equal(await store.prune(at), 1);
});
