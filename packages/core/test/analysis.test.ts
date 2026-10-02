import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalJson, expiredAnalysis } from "../src/analysis.js";

test("cache parameters use recursively stable object order", () => {
  assert.equal(
    canonicalJson({ b: [2, { z: null, a: true }], a: "x" }),
    canonicalJson({ a: "x", b: [2, { a: true, z: null }] }),
  );
  assert.throws(() => canonicalJson(undefined));
});
test("an expired lease retries only within the configured allowance", () => {
  assert.deepEqual(expiredAnalysis(0, 2), { status: "queued", attempt: 1 });
  assert.deepEqual(expiredAnalysis(2, 2), { status: "failed", attempt: 2 });
});
