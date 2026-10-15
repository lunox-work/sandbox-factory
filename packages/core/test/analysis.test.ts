import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalJson,
  expiredAnalysis,
  snapshotBuilt,
} from "../src/analysis.js";

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
test("a snapshot is built once its map succeeded and every context builder finished", () => {
  const done = [
    { tool: "graphify", status: "succeeded" },
    { tool: "abstractions", status: "failed" },
    { tool: "data_model", status: "succeeded" },
  ] as const;
  assert.equal(snapshotBuilt(done), true);
  // Other tools' runs are not read, nor are runs of a tool this build does
  // not know.
  assert.equal(
    snapshotBuilt([
      ...done,
      { tool: "deepwiki", status: "running" },
      { tool: "slice", status: "queued" },
    ]),
    true,
  );
  // A builder still at work holds it back; so does a missing one.
  assert.equal(
    snapshotBuilt([
      ...done.slice(0, 2),
      { tool: "data_model", status: "running" },
    ]),
    false,
  );
  assert.equal(snapshotBuilt(done.slice(0, 2)), false);
  // Without a map there is nothing a slice or a scope could read.
  assert.equal(
    snapshotBuilt([{ tool: "graphify", status: "failed" }, ...done.slice(1)]),
    false,
  );
  assert.equal(snapshotBuilt([]), false);
});
