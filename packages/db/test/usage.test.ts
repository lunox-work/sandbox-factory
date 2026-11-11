import assert from "node:assert/strict";
import { test } from "node:test";

import { createUsageStore } from "../src/usage.js";
import { createSequencedFakeDb } from "./fake-db.js";

test("run counts come from both run tables, sizing first, each sorted", async () => {
  const fake = createSequencedFakeDb([
    [
      { kind: "single", status: "succeeded", count: 2 },
      { kind: "backlog", status: "failed", count: 1 },
      { kind: "backlog", status: "cancelled", count: 4 },
    ],
    [{ kind: "graphify", status: "succeeded", count: 3 }],
  ]);
  const counts = await createUsageStore(fake.db).runCounts(
    "org_1",
    new Date("2026-10-13T00:00:00.000Z"),
  );
  assert.deepEqual(counts, [
    { family: "sizing", kind: "backlog", status: "cancelled", count: 4 },
    { family: "sizing", kind: "backlog", status: "failed", count: 1 },
    { family: "sizing", kind: "single", status: "succeeded", count: 2 },
    { family: "analysis", kind: "graphify", status: "succeeded", count: 3 },
  ]);
  // Both queries are scoped to the workspace and the window.
  assert.deepEqual(
    fake.calls.map((call) => [call.kind, call.filtered]),
    [
      ["select", true],
      ["select", true],
    ],
  );
});
