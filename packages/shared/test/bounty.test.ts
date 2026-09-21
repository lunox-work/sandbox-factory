import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createRunSchema,
  putRateCardSchema,
  sizingResultSchema,
} from "../src/bounty.js";

test("rate cards normalize currency and require monotonic safe amounts", () => {
  const parsed = putRateCardSchema.parse({
    expectedRevision: 0,
    currency: "usd",
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
