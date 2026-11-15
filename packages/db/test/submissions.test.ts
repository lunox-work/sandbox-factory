import assert from "node:assert/strict";
import { test } from "node:test";

import type { SubmissionRow } from "../src/schema.js";
import {
  createSubmissionStore,
  erroredSubmissions,
  reopenSubmission,
  settleSubmission,
} from "../src/submissions.js";
import { createFakeDb, createSequencedFakeDb } from "./fake-db.js";

const now = new Date("2026-10-04T00:00:00Z");
const frozen = [{ frozenAt: now }];
const input = {
  sandboxVersionId: "sbv_1",
  submittedBy: "user_1",
  patchKey: `patches/sbv_1/${"a".repeat(64)}.diff`,
  patchSha256: "a".repeat(64),
};
const row = (overrides: Partial<SubmissionRow> = {}): SubmissionRow => ({
  id: "sbm_1",
  organizationId: "owner",
  sandboxVersionId: "sbv_1",
  submittedBy: "user_1",
  patchKey: input.patchKey,
  patchSha256: input.patchSha256,
  status: "queued",
  result: null,
  errorCode: null,
  runId: null,
  retryOf: null,
  createdAt: now,
  updatedAt: now,
  ...overrides,
});
const duplicate = () =>
  Object.assign(new Error("duplicate"), { code: "23505" });

test("a submission is taken only against the owner's frozen version", async () => {
  const fake = createSequencedFakeDb([frozen, [], [row()]]);
  const result = await createSubmissionStore(fake.db).create("owner", input);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.created, true);
  assert.equal(result.submission.status, "queued");
  assert.equal(result.submission.createdAt, now.toISOString());
  assert.equal(fake.calls[0]?.filtered, true);
  assert.equal(fake.calls[2]?.kind, "insert");
  assert.match(String(fake.calls[2]?.values?.["id"]), /^sbm_/);
  assert.equal(fake.calls[2]?.values?.["organizationId"], "owner");
  assert.equal(fake.calls[2]?.values?.["patchSha256"], input.patchSha256);

  const store = (responses: readonly (readonly unknown[] | Error)[]) =>
    createSubmissionStore(createSequencedFakeDb(responses).db);
  assert.deepEqual(await store([[]]).create("owner", input), {
    ok: false,
    reason: "not-found",
  });
  // A draft can still change under a patch, so it takes none.
  assert.deepEqual(await store([[{ frozenAt: null }]]).create("owner", input), {
    ok: false,
    reason: "not_frozen",
  });
  await assert.rejects(
    store([frozen, [], []]).create("owner", input),
    /returned no row/,
  );
});

test("the same patch against the same version is the submission already made", async () => {
  const again = await createSubmissionStore(
    createSequencedFakeDb([frozen, [row({ status: "passed" })]]).db,
  ).create("owner", input);
  assert.deepEqual(again.ok && [again.created, again.submission.status], [
    false,
    "passed",
  ]);
  // Two uploads at once: the loser finds the winner's row.
  const raced = await createSubmissionStore(
    createSequencedFakeDb([frozen, [], duplicate(), [row()]]).db,
  ).create("owner", input);
  assert.deepEqual(raced.ok && [raced.created, raced.submission.id], [
    false,
    "sbm_1",
  ]);
  await assert.rejects(
    createSubmissionStore(
      createSequencedFakeDb([frozen, [], duplicate(), []]).db,
    ).create("owner", input),
    /duplicate/,
  );
  await assert.rejects(
    createSubmissionStore(
      createSequencedFakeDb([frozen, [], new Error("database down")]).db,
    ).create("owner", input),
    /down/,
  );
});

test("a version's submissions are listed under the owner, newest first", async () => {
  const fake = createFakeDb([row({ id: "sbm_2" }), row()]);
  const list = await createSubmissionStore(fake.db).list("owner", "sbv_1");
  assert.deepEqual(
    list.map((item) => item.id),
    ["sbm_2", "sbm_1"],
  );
  assert.equal(fake.calls[0]?.filtered, true);
  assert.equal(fake.calls[0]?.ordered, true);
});

test("a grading run's verdict settles a waiting submission with the counts it gives", async () => {
  const all = { passed: 3, total: 3 };
  const passed = createFakeDb([{ id: "sbm_1" }]);
  assert.equal(
    await settleSubmission(
      passed.tx,
      "owner",
      { id: "sbm_1", runId: "arn_1" },
      { public: all, hidden: all },
      now,
    ),
    true,
  );
  assert.deepEqual(passed.calls[0]?.values, {
    status: "passed",
    result: { public: all, hidden: all },
    errorCode: null,
    runId: "arn_1",
    updatedAt: now,
  });
  assert.equal(passed.calls[0]?.filtered, true);
  const failed = createFakeDb([{ id: "sbm_1" }]);
  await settleSubmission(
    failed.tx,
    "owner",
    { id: "sbm_1", runId: "arn_1" },
    { public: all, hidden: { passed: 1, total: 3 } },
    now,
  );
  assert.equal(failed.calls[0]?.values?.["status"], "failed");
  // One that is no longer waiting takes none.
  assert.equal(
    await settleSubmission(
      createFakeDb([]).tx,
      "owner",
      { id: "sbm_1", runId: "arn_1" },
      { public: all, hidden: all },
      now,
    ),
    false,
  );
});

test("a run that ended without a verdict errors its waiting submission; queued again, it waits again", async () => {
  const errored = createFakeDb([]);
  await erroredSubmissions(
    errored.tx,
    "owner",
    [
      { submissionId: "sbm_1", runId: "arn_1", errorCode: "grading_failed" },
      {
        submissionId: "sbm_2",
        runId: "arn_2",
        errorCode: "grading_interrupted",
      },
    ],
    now,
  );
  assert.deepEqual(
    errored.calls.map((call) => [call.kind, call.values, call.filtered]),
    [
      [
        "update",
        {
          status: "errored",
          errorCode: "grading_failed",
          runId: "arn_1",
          updatedAt: now,
        },
        true,
      ],
      [
        "update",
        {
          status: "errored",
          errorCode: "grading_interrupted",
          runId: "arn_2",
          updatedAt: now,
        },
        true,
      ],
    ],
  );
  // Counts are never written for an error.
  assert.equal(
    errored.calls.some((call) => call.values?.["result"] !== undefined),
    false,
  );
  const reopened = createFakeDb([]);
  await reopenSubmission(reopened.tx, "owner", "sbm_1", now);
  assert.deepEqual(reopened.calls[0]?.values, {
    status: "queued",
    errorCode: null,
    updatedAt: now,
  });
  assert.equal(reopened.calls[0]?.filtered, true);
});

test("one submission is read under its owner, with the key its files are under", async () => {
  const fake = createFakeDb([row()]);
  const found = await createSubmissionStore(fake.db).get("org_1", "sbm_1");
  assert.equal(found?.id, row().id);
  assert.equal(found?.patchKey, row().patchKey);
  assert.equal(fake.calls[0]?.filtered, true);
  assert.equal(fake.calls[0]?.limited, 1);
  assert.equal(
    await createSubmissionStore(createFakeDb([]).db).get("org_1", "sbm_x"),
    null,
  );
});

test("a failed or errored submission takes one retry, against the same version", async () => {
  const retryInput = {
    submittedBy: "user_1",
    patchKey: `patches/sbv_1/${"b".repeat(64)}.diff`,
    patchSha256: "b".repeat(64),
  };
  const failed = row({ status: "failed" });
  const retried = row({
    id: "sbm_2",
    patchSha256: retryInput.patchSha256,
    retryOf: "sbm_1",
  });
  const store = (responses: readonly (readonly unknown[] | Error)[]) => {
    const fake = createSequencedFakeDb(responses);
    return { fake, store: createSubmissionStore(fake.db) };
  };
  const made = store([[failed], [], [retried]]);
  const result = await made.store.retry("owner", "sbm_1", retryInput);
  assert.deepEqual(result.ok && [result.created, result.submission.retryOf], [
    true,
    "sbm_1",
  ]);
  assert.equal(made.fake.calls[2]?.kind, "insert");
  assert.equal(made.fake.calls[2]?.values?.["retryOf"], "sbm_1");
  assert.equal(made.fake.calls[2]?.values?.["sandboxVersionId"], "sbv_1");

  // The same files again find the retry; other files find it used.
  const again = await store([[failed], [retried]]).store.retry(
    "owner",
    "sbm_1",
    retryInput,
  );
  assert.deepEqual(again.ok && again.created, false);
  assert.deepEqual(
    await store([[row({ status: "errored" })], [retried]]).store.retry(
      "owner",
      "sbm_1",
      { ...retryInput, patchSha256: "c".repeat(64) },
    ),
    { ok: false, reason: "retry_used" },
  );

  // An errored submission with its own files is graded again in place:
  // nothing is made, and its retry (or a retry's error) is not spent.
  for (const retryOf of [null, "sbm_0"]) {
    const errored = row({
      status: "errored",
      errorCode: "grading_failed",
      retryOf,
    });
    const regrade = store([[errored]]);
    const answered = await regrade.store.retry("owner", "sbm_1", {
      ...retryInput,
      patchSha256: input.patchSha256,
    });
    assert.deepEqual(
      answered.ok && [
        answered.created,
        answered.regrade,
        answered.submission.id,
        answered.submission.errorCode,
        "patchKey" in answered.submission,
      ],
      [false, true, "sbm_1", "grading_failed", false],
    );
    assert.equal(regrade.fake.calls.length, 1);
  }

  const refused = async (
    responses: readonly (readonly unknown[] | Error)[],
    patchSha256 = retryInput.patchSha256,
  ) => {
    const outcome = await store(responses).store.retry("owner", "sbm_1", {
      ...retryInput,
      patchSha256,
    });
    return outcome.ok ? "ok" : outcome.reason;
  };
  assert.equal(await refused([[]]), "not-found");
  assert.equal(await refused([[row({ retryOf: "sbm_0" })]]), "is_retry");
  assert.equal(await refused([[row({ status: "passed" })]]), "passed");
  assert.equal(await refused([[row({ status: "running" })]]), "not_finished");
  assert.equal(await refused([[row({ status: "queued" })]]), "not_finished");
  assert.equal(await refused([[failed], []], input.patchSha256), "same_patch");
  // Files another submission holds, or a retry made at the same moment.
  assert.equal(await refused([[failed], [], duplicate(), []]), "same_patch");
  assert.equal(await refused([[failed], [], duplicate(), [retried]]), "ok");
  await assert.rejects(
    store([[failed], [], new Error("down")]).store.retry(
      "owner",
      "sbm_1",
      retryInput,
    ),
    /down/,
  );
  await assert.rejects(
    store([[failed], [], []]).store.retry("owner", "sbm_1", retryInput),
    /returned no row/,
  );
});
