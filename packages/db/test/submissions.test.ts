import assert from "node:assert/strict";
import { test } from "node:test";

import type { SubmissionRow } from "../src/schema.js";
import { createSubmissionStore } from "../src/submissions.js";
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
  runId: null,
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

test("a submission starts once, and finishes with the verdict its counts give", async () => {
  const started = createFakeDb([row({ status: "running", runId: "arn_1" })]);
  assert.equal(
    await createSubmissionStore(started.db).start("owner", "sbm_1", "arn_1"),
    true,
  );
  assert.equal(started.calls[0]?.values?.["status"], "running");
  assert.equal(started.calls[0]?.values?.["runId"], "arn_1");
  assert.equal(started.calls[0]?.filtered, true);
  assert.equal(
    await createSubmissionStore(createFakeDb([]).db).start(
      "owner",
      "sbm_1",
      "arn_1",
    ),
    false,
  );

  const all = { passed: 3, total: 3 };
  const passed = createFakeDb([row({ status: "passed" })]);
  await createSubmissionStore(passed.db).finish(
    "owner",
    "sbm_1",
    { public: all, hidden: all },
    now,
  );
  assert.equal(passed.calls[0]?.values?.["status"], "passed");
  assert.deepEqual(passed.calls[0]?.values?.["result"], {
    public: all,
    hidden: all,
  });

  const failed = createFakeDb([row({ status: "failed" })]);
  await createSubmissionStore(failed.db).finish("owner", "sbm_1", {
    public: all,
    hidden: { passed: 1, total: 3 },
  });
  assert.equal(failed.calls[0]?.values?.["status"], "failed");

  // A run that could not run at all records no counts.
  const errored = createFakeDb([row({ status: "errored" })]);
  const result = await createSubmissionStore(errored.db).finish(
    "owner",
    "sbm_1",
    "errored",
  );
  assert.equal(result?.status, "errored");
  assert.equal(errored.calls[0]?.values?.["status"], "errored");
  assert.equal(errored.calls[0]?.values?.["result"], undefined);

  assert.equal(
    await createSubmissionStore(createFakeDb([]).db).finish(
      "owner",
      "sbm_1",
      "errored",
    ),
    null,
  );
});
