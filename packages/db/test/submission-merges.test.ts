import assert from "node:assert/strict";
import { test } from "node:test";

import { createSubmissionMergeStore } from "../src/submission-merges.js";
import { createSequencedFakeDb } from "./fake-db.js";

const at = new Date("2026-11-12T00:00:00.000Z");
const input = {
  submissionId: "sbm_1",
  repositoryFullName: "acme/shop",
  branch: "lunox/sbm_1",
  commitSha: "beef",
  pullRequestNumber: 7,
  pullRequestUrl: "https://github.com/acme/shop/pull/7",
  openedBy: "user_1",
};
const row = { id: "smg_1", organizationId: "org_1", ...input, createdAt: at };
const stored = { id: "smg_1", ...input, createdAt: at.toISOString() };

test("a merge-back is recorded once per submission, and read back by the owner", async () => {
  const made = createSequencedFakeDb([[row]]);
  assert.deepEqual(
    await createSubmissionMergeStore(made.db).record("org_1", input),
    stored,
  );
  assert.equal(made.calls[0]?.kind, "insert");
  assert.match(String(made.calls[0]?.values?.["id"]), /^smg_/);
  assert.equal(made.calls[0]?.values?.["organizationId"], "org_1");

  // A second record keeps the first.
  assert.deepEqual(
    await createSubmissionMergeStore(
      createSequencedFakeDb([[], [row]]).db,
    ).record("org_1", { ...input, pullRequestNumber: 8 }),
    stored,
  );
  await assert.rejects(
    createSubmissionMergeStore(createSequencedFakeDb([[], []]).db).record(
      "org_1",
      input,
    ),
    /no row/,
  );

  assert.deepEqual(
    await createSubmissionMergeStore(createSequencedFakeDb([[row]]).db).get(
      "org_1",
      "sbm_1",
    ),
    stored,
  );
  assert.equal(
    await createSubmissionMergeStore(createSequencedFakeDb([[]]).db).get(
      "org_1",
      "sbm_x",
    ),
    null,
  );
  const listed = createSequencedFakeDb([[row]]);
  assert.deepEqual(
    await createSubmissionMergeStore(listed.db).list("org_1", ["sbm_1"]),
    [stored],
  );
  // No submissions, no query.
  const none = createSequencedFakeDb([]);
  assert.deepEqual(
    await createSubmissionMergeStore(none.db).list("org_1", []),
    [],
  );
  assert.equal(none.calls.length, 0);
});
