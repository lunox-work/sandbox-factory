import assert from "node:assert/strict";
import { test } from "node:test";
import type { AnalysisRunStore, StoredAnalysisRun } from "@sandbox-factory/db";
import { enqueueAnalysis } from "../src/analysis/enqueue.js";
test("queue coordination cleans obsolete logs and records a prerequisite wake-up before a later capacity refusal", async () => {
  const events: string[] = [];
  const run = { id: "run_1", status: "queued" } as StoredAnalysisRun;
  let count = 0;
  const enqueue: AnalysisRunStore["enqueue"] = async () =>
    ++count === 1
      ? { ok: true, created: true, run, obsoleteLogKey: "old" }
      : { ok: false, reason: "run_limit" };
  const deps = {
    runs: { enqueue },
    removeObject: async (key: string) => {
      events.push(key);
      throw new Error("gone");
    },
    onQueued: () => {
      events.push("wake");
    },
  };
  const input = {
    tool: "graphify" as const,
    params: { deadlineMinutes: 30 },
    requestedBy: null,
    maxActive: 2,
  };
  assert.equal(
    (await enqueueAnalysis(deps, "owner", "snapshot", input)).ok,
    true,
  );
  assert.equal(
    (await enqueueAnalysis(deps, "owner", "snapshot", input)).ok,
    false,
  );
  assert.deepEqual(events, ["old", "wake"]);
  const done: AnalysisRunStore["enqueue"] = async () => ({
    ok: true,
    created: false,
    run: { ...run, status: "succeeded" },
  });
  assert.equal(
    (
      await enqueueAnalysis(
        { runs: { enqueue: done }, removeObject: async () => {} },
        "owner",
        "snapshot",
        input,
      )
    ).ok,
    true,
  );
});
// Type-only boundaries also emit modules; load them so the coverage inventory
// checks the whole API source tree without excluding newly extracted seams.
import "../src/http-context.js";
import "../src/bounty/options.js";
import "../src/sandbox/options.js";
