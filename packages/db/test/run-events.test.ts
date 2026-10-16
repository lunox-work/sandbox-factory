import assert from "node:assert/strict";
import test from "node:test";

import {
  announceChange,
  parseRunChange,
  RUN_CHANGE_KINDS,
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

test("every kind round-trips, and the payload carries nothing else", () => {
  for (const kind of RUN_CHANGE_KINDS) {
    const change = { organizationId: "org_9", kind, id: `${kind}_1` };
    const payload = runChangePayload(change);
    assert.deepEqual(Object.keys(JSON.parse(payload) as object).sort(), [
      "i",
      "k",
      "o",
    ]);
    assert.deepEqual(parseRunChange(payload), change);
  }
});

test("garbage, a non-object, an unknown kind or a missing field is no change", () => {
  for (const payload of [
    "",
    "{",
    '"analysis"',
    "true",
    "[]",
    JSON.stringify(["org_1", "analysis", "arn_1"]),
    JSON.stringify({}),
    JSON.stringify({ k: "analysis", i: "arn_1" }),
    JSON.stringify({ o: "org_1", i: "arn_1" }),
    JSON.stringify({ o: "org_1", k: "analysis", i: 7 }),
    JSON.stringify({ o: "org_1", k: "ANALYSIS", i: "arn_1" }),
    JSON.stringify({ o: "org_1", k: null, i: "arn_1" }),
    JSON.stringify({
      organizationId: "org_1",
      kind: "analysis",
      id: "arn_1",
    }),
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
