import assert from "node:assert/strict";
import test from "node:test";

import { createFlowWaitStore } from "../src/flow-waits.js";
import { createFakeDb } from "./fake-db.js";

const since = new Date("2026-09-16T00:00:00Z");

test("a workspace's typical waits are its own medians", async () => {
  const fake = createFakeDb([
    { flow: "run:sandbox_build", p50: "92.5", samples: 4 },
    { flow: "sandbox_sliced", p50: 300, samples: 2 },
  ]);
  const typical = await createFlowWaitStore(fake.db).typical(
    "org_1",
    ["run:sandbox_build", "sandbox_sliced", "price"],
    since,
  );
  assert.deepEqual(typical.get("run:sandbox_build"), {
    p50: 92.5,
    samples: 4,
  });
  assert.equal(typical.get("sandbox_sliced")?.p50, 300);
  assert.equal(typical.has("price"), false);
  assert.equal(fake.calls[0]?.filtered, true);
});

test("asking for no flows reads nothing", async () => {
  const fake = createFakeDb([]);
  assert.equal(
    (await createFlowWaitStore(fake.db).typical("org_1", [], since)).size,
    0,
  );
  assert.equal(fake.calls.length, 0);
});
