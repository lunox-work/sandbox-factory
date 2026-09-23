import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createRunSchema,
  resizeProposalSchema,
  putRateCardSchema,
  rateCardSnapshotSchema,
  sizingResultSchema,
} from "../src/bounty.js";

test("rate cards normalize currency and require monotonic safe amounts", () => {
  const parsed = putRateCardSchema.parse({
    expectedRevision: 0,
    currency: "usd",
    xsMinor: 100,
    sMinor: 100,
    mMinor: 200,
    lMinor: 300,
    xlMinor: 400,
  });
  assert.equal(parsed.currency, "USD");
  assert.equal(
    putRateCardSchema.safeParse({ ...parsed, sMinor: 500 }).success,
    false,
  );
  assert.equal(
    putRateCardSchema.safeParse({ ...parsed, sMinor: Number.MAX_VALUE })
      .success,
    false,
  );
});

test("unsized sizing results require a reason and sized results reject one", () => {
  assert.equal(
    sizingResultSchema.safeParse({
      complexity: "unsized",
      confidence: "low",
      rationale: "The requirements are incomplete.",
    }).success,
    false,
  );
  assert.equal(
    sizingResultSchema.safeParse({
      complexity: "S",
      confidence: "high",
      rationale: "A localized change.",
      unsizedReason: "missing requirements",
    }).success,
    false,
  );
});

test("run request ids are UUIDs", () => {
  assert.equal(
    createRunSchema.safeParse({
      requestId: "28bb313f-252a-4a1d-b656-558a215b604b",
    }).success,
    true,
  );
  assert.equal(
    createRunSchema.safeParse({ requestId: "retry-me" }).success,
    false,
  );
});

test("XS is required on rate writes and accepted in sizing and review", () => {
  const card = {
    currency: "USD",
    xsMinor: 50,
    sMinor: 100,
    mMinor: 200,
    lMinor: 300,
    xlMinor: 400,
    expectedRevision: 0,
  };
  for (const xsMinor of [undefined, 0, 101]) {
    assert.equal(
      putRateCardSchema.safeParse({ ...card, xsMinor }).success,
      false,
    );
  }
  assert.equal(putRateCardSchema.parse(card).xsMinor, 50);
  assert.equal(
    sizingResultSchema.parse({
      complexity: "XS",
      confidence: "high",
      rationale: "One label correction.",
    }).complexity,
    "XS",
  );
  assert.equal(
    resizeProposalSchema.parse({ complexity: "XS", expectedRevision: 1 })
      .complexity,
    "XS",
  );
});

test("USD write limits preserve historical rate-card snapshots", () => {
  const card = {
    currency: "usd",
    xsMinor: 1000,
    sMinor: 5800,
    mMinor: 10500,
    lMinor: 15300,
    xlMinor: 100000,
    expectedRevision: 0,
  };
  assert.equal(putRateCardSchema.safeParse(card).success, true);
  assert.equal(
    putRateCardSchema.safeParse({ ...card, xlMinor: 100001 }).success,
    false,
  );
  assert.equal(
    putRateCardSchema.safeParse({ ...card, currency: "JPY", xlMinor: 200000 })
      .success,
    true,
  );
  assert.equal(
    rateCardSnapshotSchema.safeParse({ ...card, xlMinor: 200000, revision: 1 })
      .success,
    true,
  );
});
