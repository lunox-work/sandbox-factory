import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createSubmissionMergeStore,
  MERGE_CLAIM_LEASE_MS,
} from "../src/submission-merges.js";
import { createSequencedFakeDb } from "./fake-db.js";

const at = new Date("2026-11-12T00:00:00.000Z");
const claim = {
  submissionId: "sbm_1",
  repositoryFullName: "acme/shop",
  branch: "lunox/sbm_1",
  openedBy: "user_1",
};
const opened = {
  commitSha: "beef",
  pullRequestNumber: 7,
  pullRequestUrl: "https://github.com/acme/shop/pull/7",
};
const pending = {
  id: "smg_1",
  organizationId: "org_1",
  ...claim,
  status: "pending",
  claimedAt: at,
  commitSha: null,
  pullRequestNumber: null,
  pullRequestUrl: null,
  createdAt: at,
};
const row = { ...pending, status: "opened", claimedAt: null, ...opened };
const stored = {
  id: "smg_1",
  ...claim,
  ...opened,
  createdAt: at.toISOString(),
};
const store = (responses: unknown[][]) => {
  const made = createSequencedFakeDb(responses);
  return {
    ...made,
    store: createSubmissionMergeStore(made.db, { now: () => at.getTime() }),
  };
};

test("a merge-back is claimed pending before GitHub is asked, one claim per submission", async () => {
  const first = store([[pending]]);
  assert.deepEqual(await first.store.claim("org_1", claim), {
    status: "claimed",
  });
  const insert = first.calls[0];
  assert.equal(insert?.kind, "insert");
  assert.match(String(insert?.values?.["id"]), /^smg_/);
  assert.equal(insert?.values?.["organizationId"], "org_1");
  assert.equal(insert?.values?.["status"], "pending");
  assert.deepEqual(insert?.values?.["claimedAt"], at);
  // The conflict branch takes over only a released or lapsed claim, and
  // only the owner's: guarded, and it never touches the pull request.
  assert.equal(insert?.conflictGuarded, true);
  assert.deepEqual(Object.keys(insert?.conflictSet ?? {}).sort(), [
    "branch",
    "claimedAt",
    "openedBy",
    "repositoryFullName",
  ]);
  assert.ok(MERGE_CLAIM_LEASE_MS >= 60_000);

  // A second click while the first is out: the live claim is busy.
  assert.deepEqual(await store([[], [pending]]).store.claim("org_1", claim), {
    status: "busy",
  });
  // One that raced the first to the end: the pull request already opened.
  assert.deepEqual(await store([[], [row]]).store.claim("org_1", claim), {
    status: "opened",
    merge: stored,
  });
  await assert.rejects(store([[], []]).store.claim("org_1", claim), /no row/);
});

test("a claim is finished with what GitHub opened, or released for a retry", async () => {
  const finished = store([[row]]);
  assert.deepEqual(
    await finished.store.finish("org_1", "sbm_1", opened),
    stored,
  );
  assert.equal(finished.calls[0]?.kind, "update");
  assert.equal(finished.calls[0]?.filtered, true);
  assert.deepEqual(finished.calls[0]?.values, {
    status: "opened",
    claimedAt: null,
    ...opened,
  });
  // Finished already (a lapsed claim taken over): the first record stands.
  assert.deepEqual(
    await store([[], [row]]).store.finish("org_1", "sbm_1", {
      ...opened,
      pullRequestNumber: 8,
    }),
    stored,
  );
  await assert.rejects(
    store([[], [pending]]).store.finish("org_1", "sbm_1", opened),
    /no row/,
  );

  const released = store([[]]);
  await released.store.release("org_1", "sbm_1");
  assert.deepEqual(released.calls[0]?.values, { claimedAt: null });
  assert.equal(released.calls[0]?.filtered, true);
});

test("only an opened merge-back is read back by the owner", async () => {
  assert.deepEqual(await store([[row]]).store.get("org_1", "sbm_1"), stored);
  assert.equal(await store([[pending]]).store.get("org_1", "sbm_1"), null);
  assert.equal(await store([[]]).store.get("org_1", "sbm_x"), null);
  const listed = store([[row, pending]]);
  assert.deepEqual(await listed.store.list("org_1", ["sbm_1", "sbm_2"]), [
    stored,
  ]);
  assert.equal(listed.calls[0]?.filtered, true);
  // No submissions, no query.
  const none = store([]);
  assert.deepEqual(await none.store.list("org_1", []), []);
  assert.equal(none.calls.length, 0);
  // The default clock is the process's.
  assert.ok(createSubmissionMergeStore(createSequencedFakeDb([]).db));
});
