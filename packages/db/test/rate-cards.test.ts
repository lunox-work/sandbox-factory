import assert from "node:assert/strict";
import { test } from "node:test";

import { createRateCardStore } from "../src/rate-cards.js";
import type { RateCardRow } from "../src/schema.js";
import { createFakeDb, createSequencedFakeDb } from "./fake-db.js";

function row(overrides: Partial<RateCardRow> = {}): RateCardRow {
  return {
    organizationId: "org_1",
    currency: "USD",
    sMinor: 100,
    mMinor: 200,
    lMinor: 300,
    xlMinor: 400,
    revision: 1,
    updatedBy: "usr_1",
    createdAt: new Date("2026-09-22T00:00:00Z"),
    updatedAt: new Date("2026-09-22T00:00:00Z"),
    ...overrides,
  };
}

test("reads a rate card through an owner filter", async () => {
  const fake = createFakeDb([row()]);
  const card = await createRateCardStore(fake.db).get("org_1");
  assert.equal(card?.revision, 1);
  assert.equal(fake.calls[0]?.filtered, true);
});

test("creates revision one only when expected revision is zero", async () => {
  const fake = createFakeDb([row()]);
  const result = await createRateCardStore(fake.db).put(
    "org_1",
    "usr_1",
    { currency: "USD", sMinor: 100, mMinor: 200, lMinor: 300, xlMinor: 400 },
    0,
  );
  assert.equal(result.ok, true);
  assert.equal(fake.calls[0]?.ignoredConflict, true);
  assert.equal(fake.calls[0]?.values?.["organizationId"], "org_1");
});

test("updates through organization and expected revision filters", async () => {
  const fake = createFakeDb([row({ revision: 2 })]);
  const result = await createRateCardStore(fake.db).put(
    "org_1",
    "usr_1",
    { currency: "USD", sMinor: 150, mMinor: 250, lMinor: 350, xlMinor: 450 },
    1,
  );
  assert.equal(result.ok, true);
  assert.equal(fake.calls[0]?.filtered, true);
  assert.equal(fake.calls[0]?.values?.["currency"], "USD");
});

test("a missed write returns the current value as a conflict", async () => {
  const fake = createFakeDb([]);
  const result = await createRateCardStore(fake.db).put(
    "org_1",
    "usr_1",
    { currency: "USD", sMinor: 1, mMinor: 2, lMinor: 3, xlMinor: 4 },
    1,
  );
  assert.deepEqual(result, { ok: false, current: null });
});

test("an insert conflict returns the current revision", async () => {
  const fake = createSequencedFakeDb([[], [row({ revision: 3 })]]);
  const result = await createRateCardStore(fake.db).put(
    "org_1",
    "usr_1",
    { currency: "USD", sMinor: 1, mMinor: 2, lMinor: 3, xlMinor: 4 },
    0,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.current?.revision, 3);
});
