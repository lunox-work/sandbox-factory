import assert from "node:assert/strict";
import test from "node:test";

import {
  announceChange,
  parseRunChange,
  RUN_CHANGED_CHANNEL,
  runChangePayload,
} from "../src/run-events.js";
import { createFakeDb } from "./fake-db.js";

test("a change round-trips through its payload", () => {
  const change = {
    organizationId: "org_1",
    kind: "analysis",
    id: "arn_1",
  } as const;
  assert.deepEqual(parseRunChange(runChangePayload(change)), change);
  assert.equal(RUN_CHANGED_CHANNEL, "run_changed");
});

test("a payload this build cannot read is no change", () => {
  for (const payload of [
    "not json",
    "null",
    "3",
    JSON.stringify({ o: "org_1", k: "analysis" }),
    JSON.stringify({ o: 1, k: "analysis", i: "arn_1" }),
    JSON.stringify({ o: "org_1", k: "snapshot", i: "snp_1" }),
  ])
    assert.equal(parseRunChange(payload), null, payload);
});

test("announcing a change is one raw statement", async () => {
  const fake = createFakeDb([]);
  await announceChange(fake.db, {
    organizationId: "org_1",
    kind: "profile",
    id: "bpp_1",
  });
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0]?.kind, "execute");
});
