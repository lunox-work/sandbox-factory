import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  EnqueueAnalysisResult,
  StoredAnalysisRun,
  StoredBounty,
  StoredBountyProfile,
  StoredBountyProposal,
} from "@sandbox-factory/db";
import type { FixturesParams } from "sandbox-factory";

import {
  PREPARATION_DEADLINE_MINUTES,
  SandboxPreparer,
} from "../src/sandbox/preparer.js";

const at = "2026-10-16T00:00:00.000Z";

function profile(
  overrides: Partial<StoredBountyProfile> = {},
): StoredBountyProfile {
  return {
    id: "bpf_1",
    organizationId: "org_1",
    proposalId: "bpr_1",
    specRevision: 2,
    specHash: "a".repeat(64),
    snapshotId: "rsn_1",
    repository: "acme/widgets",
    status: "ready",
    errorCode: null,
    runErrorCode: null,
    scopeRunId: "arn_scope",
    sliceRunId: "arn_slice",
    preparedRunId: null,
    profile: null,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

const run = (status: StoredAnalysisRun["status"]) =>
  ({ id: "arn_prep", status }) as StoredAnalysisRun;

function harness(
  rows: StoredBountyProfile[],
  answer: () => EnqueueAnalysisResult = () => ({
    ok: true,
    created: true,
    run: run("queued"),
  }),
) {
  const enqueued: { snapshotId: string; input: unknown }[] = [];
  const recorded: unknown[] = [];
  const errors: string[] = [];
  const removed: string[] = [];
  let launches = 0;
  const preparer = new SandboxPreparer({
    profiles: {
      organizationsWithUnprepared: async () => ["org_1"],
      unprepared: async () => rows,
      recordPrepared: async (owner, profileId, runId) => {
        recorded.push({ owner, profileId, runId });
        return true;
      },
    },
    runs: {
      enqueue: async (_owner, snapshotId, input) => {
        enqueued.push({ snapshotId: snapshotId ?? "", input });
        return answer();
      },
      latestSucceeded: async (_owner, _snapshot, tool) =>
        tool === "data_model"
          ? ({ id: "arn_model" } as StoredAnalysisRun)
          : null,
    },
    proposals: {
      get: async (_owner, id) =>
        id === "bpr_1"
          ? ({ id, bountyId: "bty_1" } as StoredBountyProposal)
          : null,
    },
    bounties: {
      get: async (_owner, id) =>
        id === "bty_1"
          ? ({
              id,
              title: "  Fix   the Acme export ",
              description: "",
            } as StoredBounty)
          : null,
    },
    organizationNames: async () => ["Acme Corp", "acme"],
    ensureWorker: async () => {
      launches += 1;
    },
    removeObject: async (key) => {
      removed.push(key);
    },
    maxActive: 4,
    onError: (code) => errors.push(code),
  });
  return {
    preparer,
    enqueued,
    recorded,
    errors,
    removed,
    launches: () => launches,
  };
}

test("a ready, approved profile's preparation is queued on its slice and named on it", async () => {
  const h = harness([profile()]);
  await h.preparer.sweep();
  assert.equal(h.enqueued.length, 1);
  const { snapshotId, input } = h.enqueued[0] ?? {};
  assert.equal(snapshotId, "rsn_1");
  const queued = input as {
    tool: string;
    params: FixturesParams;
    requestedBy: null;
    maxActive: number;
  };
  assert.equal(queued.tool, "fixtures");
  assert.equal(queued.requestedBy, null);
  // One slot short of the cap, kept for a person.
  assert.equal(queued.maxActive, 3);
  assert.deepEqual(queued.params, {
    deadlineMinutes: PREPARATION_DEADLINE_MINUTES,
    agent: "fixtures",
    proposalId: "bpr_1",
    specRevision: 2,
    specHash: "a".repeat(64),
    sliceRunId: "arn_slice",
    dataModelRunId: "arn_model",
    pseudonyms: {
      // The organization's names and the repository's, as a build checks.
      vocabulary: ["acme-corp", "acme", "widgets"],
      // The listing a cut gives the version.
      title: "Fix the Acme export",
      summary: "Fix the Acme export",
    },
  });
  assert.deepEqual(h.recorded, [
    { owner: "org_1", profileId: "bpf_1", runId: "arn_prep" },
  ]);
  assert.equal(h.launches(), 1);
});

test("a preparation found in the cache is named without waking a worker", async () => {
  const h = harness([profile()], () => ({
    ok: true,
    created: false,
    run: run("succeeded"),
    obsoleteLogKey: "logs/old.txt",
  }));
  await h.preparer.sweep();
  assert.equal(h.recorded.length, 1);
  assert.equal(h.launches(), 0);
  assert.deepEqual(h.removed, ["logs/old.txt"]);
});

test("the cap stops the pass, and a refusal or a gone bounty skips one row", async () => {
  const full = harness([profile(), profile({ id: "bpf_2" })], () => ({
    ok: false,
    reason: "run_limit",
  }));
  await full.preparer.sweep();
  assert.equal(full.enqueued.length, 1);
  assert.deepEqual(full.recorded, []);

  const refused = harness([profile(), profile({ id: "bpf_2" })], () => ({
    ok: false,
    reason: "slice_mismatch",
  }));
  await refused.preparer.sweep();
  assert.equal(refused.enqueued.length, 2);
  assert.deepEqual(refused.errors, [
    "sandbox_prepare_slice_mismatch",
    "sandbox_prepare_slice_mismatch",
  ]);

  const gone = harness([
    profile({ proposalId: "bpr_gone" }),
    profile({ snapshotId: null }),
    profile({ sliceRunId: null }),
  ]);
  await gone.preparer.sweep();
  assert.deepEqual(gone.enqueued, []);
});

test("one organization's trouble is reported and the pass goes on; the timer starts once and stops", async () => {
  const h = harness([profile()]);
  let passes = 0;
  const preparer = new SandboxPreparer({
    profiles: {
      organizationsWithUnprepared: async () => {
        passes += 1;
        return ["org_1"];
      },
      unprepared: async () => {
        throw new Error("database blip");
      },
      recordPrepared: async () => true,
    },
    runs: {
      enqueue: async () => ({ ok: false, reason: "not-found" }),
      latestSucceeded: async () => null,
    },
    proposals: { get: async () => null },
    bounties: { get: async () => null },
    organizationNames: async () => [],
    ensureWorker: async () => {},
    removeObject: async () => {},
    intervalMs: 60_000,
    onError: (code) => h.errors.push(code),
  });
  await preparer.sweep();
  assert.deepEqual(h.errors, ["sandbox_prepare_failed"]);
  // A kick mid-pass runs once more after it.
  preparer.start();
  preparer.start();
  preparer.kick();
  await preparer.stop();
  assert.ok(passes >= 2);
  // Stopped, a kick starts nothing.
  const before = passes;
  preparer.kick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(passes, before);
});
