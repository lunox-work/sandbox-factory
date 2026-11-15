import assert from "node:assert/strict";
import { test } from "node:test";

import {
  billedSeconds,
  createEvaluatorUsageStore,
  EVALUATOR_TOOLS,
  evaluatorQuotaExceeded,
  evaluatorSecondsSince,
  evaluatorUseSince,
} from "../src/evaluator-usage.js";
import {
  gradingAttemptsSince,
  gradingBrakeRefusal,
  recordGradingAttempt,
} from "../src/grading-attempts.js";
import { createUsageStore } from "../src/usage.js";
import { createFakeDb, createSequencedFakeDb } from "./fake-db.js";

/**
 * The evaluator ledger and its monthly cap, and the grading attempts the
 * contributor brakes count. The run store's refusals are tested beside it,
 * in `analysis-runs.test.ts`.
 */

const november = () => new Date("2026-11-12T08:30:00.000Z");

test("a job's seconds are one ledger row against the workspace and the run", async () => {
  const fake = createFakeDb([]);
  await createEvaluatorUsageStore(fake.db).record("org_1", {
    runId: "arn_1",
    kind: "submission_grade",
    provider: "e2b",
    seconds: 42,
  });
  const values = fake.calls[0]?.values ?? {};
  assert.equal(fake.calls[0]?.kind, "insert");
  assert.match(String(values["id"]), /^evu_/);
  assert.deepEqual(
    { ...values, id: undefined },
    {
      id: undefined,
      organizationId: "org_1",
      runId: "arn_1",
      kind: "submission_grade",
      provider: "e2b",
      seconds: 42,
    },
  );
});

test("a job is billed whole seconds, rounded up, at least one", () => {
  assert.equal(billedSeconds(0), 1);
  assert.equal(billedSeconds(1), 1);
  assert.equal(billedSeconds(1_000), 1);
  assert.equal(billedSeconds(1_001), 2);
  assert.equal(billedSeconds(61_500), 62);
});

test("only the tools that create evaluation jobs are held to the evaluator cap", () => {
  assert.deepEqual([...EVALUATOR_TOOLS].sort(), [
    "sandbox_build",
    "sandbox_import",
    "sandbox_starter",
    "submission_grade",
  ]);
});

test("a month under its evaluator cap admits; one at or over it is refused with its kind until it resets", async () => {
  const quota = { monthlySeconds: 3_600, now: november };
  assert.equal(
    await evaluatorQuotaExceeded(
      createFakeDb([{ seconds: 3_599 }]).db,
      "org_1",
      quota,
    ),
    null,
  );
  assert.deepEqual(
    await evaluatorQuotaExceeded(
      createFakeDb([{ seconds: 3_600 }]).db,
      "org_1",
      quota,
    ),
    {
      ok: false,
      reason: "quota_exceeded",
      kind: "evaluator_seconds",
      used: 3_600,
      limit: 3_600,
      resetsAt: new Date("2026-12-01T00:00:00.000Z"),
    },
  );
  assert.equal(
    await evaluatorSecondsSince(createFakeDb([]).db, "org_1", new Date()),
    0,
  );
});

test("the month's evaluator use is summed by kind", async () => {
  const fake = createFakeDb([
    { kind: "submission_grade", seconds: 30, jobs: 3 },
    { kind: "sandbox_build", seconds: 200, jobs: 4 },
  ]);
  assert.deepEqual(await evaluatorUseSince(fake.db, "org_1", new Date()), {
    seconds: 230,
    jobs: 7,
    byKind: [
      { kind: "sandbox_build", seconds: 200, jobs: 4 },
      { kind: "submission_grade", seconds: 30, jobs: 3 },
    ],
  });
  assert.equal(fake.calls[0]?.filtered, true);
});

test("an assignment's attempts, then its workspace's contributors', are braked over a rolling day", async () => {
  const brakes = {
    perAssignmentDaily: 10,
    perOrganizationDaily: 50,
    now: november,
  };
  const oldest = new Date("2026-11-11T12:00:00.000Z");
  // Under both: two counts read, no refusal.
  const under = createSequencedFakeDb([
    [{ count: 9, oldest }],
    [{ count: 49, oldest }],
  ]);
  assert.equal(
    await gradingBrakeRefusal(under.db, "org_1", "cas_1", brakes),
    null,
  );
  assert.equal(under.calls.length, 2);
  assert.ok(under.calls.every((call) => call.filtered));
  // The assignment's ten: refused until its oldest attempt is a day old.
  assert.deepEqual(
    await gradingBrakeRefusal(
      createSequencedFakeDb([[{ count: 10, oldest }]]).db,
      "org_1",
      "cas_1",
      brakes,
    ),
    {
      ok: false,
      reason: "rate_limited",
      scope: "assignment",
      limit: 10,
      retryAt: new Date("2026-11-12T12:00:00.000Z"),
    },
  );
  // The workspace's contributors together.
  const full = await gradingBrakeRefusal(
    createSequencedFakeDb([
      [{ count: 1, oldest }],
      [{ count: 50, oldest: null }],
    ]).db,
    "org_1",
    "cas_1",
    brakes,
  );
  assert.equal(full?.scope, "organization");
  assert.equal(full?.limit, 50);
  // A count with no oldest row still says to wait a moment, never the past.
  assert.ok((full?.retryAt.getTime() ?? 0) > november().getTime());
});

test("a grading attempt is one row, and the month's are counted with the contributors' share", async () => {
  const fake = createFakeDb([]);
  await recordGradingAttempt(fake.db, "org_1", {
    submissionId: "sbm_1",
    assignmentId: "cas_1",
    runId: "arn_1",
  });
  assert.match(String(fake.calls[0]?.values?.["id"]), /^gat_/);
  assert.equal(fake.calls[0]?.values?.["assignmentId"], "cas_1");
  assert.deepEqual(
    await gradingAttemptsSince(
      createFakeDb([{ attempts: 5, contributor: 3 }]).db,
      "org_1",
      new Date(),
    ),
    { attempts: 5, contributor: 3 },
  );
  assert.deepEqual(
    await gradingAttemptsSince(createFakeDb([]).db, "org_1", new Date()),
    { attempts: 0, contributor: 0 },
  );
});

test("the usage store reports evaluator use, grading attempts and uploads", async () => {
  const usage = createUsageStore(
    createSequencedFakeDb([[{ kind: "sandbox_build", seconds: 9, jobs: 1 }]])
      .db,
  );
  assert.deepEqual(await usage.evaluator("org_1", new Date()), {
    seconds: 9,
    jobs: 1,
    byKind: [{ kind: "sandbox_build", seconds: 9, jobs: 1 }],
  });
  const counts = createUsageStore(
    createSequencedFakeDb([[{ attempts: 4, contributor: 2 }], [{ count: 1 }]])
      .db,
  );
  assert.deepEqual(await counts.submissionsAndUploads("org_1", new Date()), {
    gradingAttempts: 4,
    contributorGradingAttempts: 2,
    uploads: 1,
  });
  assert.deepEqual(
    await createUsageStore(createFakeDb([]).db).submissionsAndUploads(
      "org_1",
      new Date(),
    ),
    { gradingAttempts: 0, contributorGradingAttempts: 0, uploads: 0 },
  );
});
