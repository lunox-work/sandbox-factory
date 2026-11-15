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
  repoId: "ghr_1",
  mergeWhen: "open" as const,
};
/** What an opened row holds of its pull request before anything is read back. */
const followed = {
  pullRequestState: "open",
  ciState: "pending",
  ciSummary: null,
  ciHeadSha: "beef",
  ciCheckedAt: null,
  mergedCommitSha: null,
  mergedAt: null,
  mergeError: null,
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
  ...followed,
  ciHeadSha: null,
};
const row = {
  ...pending,
  status: "opened",
  claimedAt: null,
  ...opened,
  ciHeadSha: "beef",
};
const stored = {
  id: "smg_1",
  ...claim,
  ...opened,
  createdAt: at.toISOString(),
  ...followed,
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
    "mergeWhen",
    "openedBy",
    "repoId",
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
    ciHeadSha: "beef",
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

test("an open pull request is followed: merge when CI passes, by repository, and the sweep's due rows", async () => {
  const asked = store([[{ ...row, mergeWhen: "ci_passes" }]]);
  assert.deepEqual(
    await asked.store.setMergeWhen("org_1", "sbm_1", "ci_passes"),
    { ...stored, mergeWhen: "ci_passes" },
  );
  assert.deepEqual(asked.calls[0]?.values, { mergeWhen: "ci_passes" });
  assert.equal(asked.calls[0]?.filtered, true);
  // Merged or closed already: nothing to ask.
  assert.equal(
    await store([[]]).store.setMergeWhen("org_1", "sbm_1", "ci_passes"),
    null,
  );

  const byRepo = store([[row, pending]]);
  assert.deepEqual(await byRepo.store.openForRepo("org_1", "ghr_1"), [stored]);
  assert.equal(byRepo.calls[0]?.filtered, true);

  const due = store([[{ ...row, organizationId: "org_2" }, pending]]);
  assert.deepEqual(
    await due.store.dueForCi(at, new Date(at.getTime() - 86_400_000), 50),
    [{ organizationId: "org_2", merge: stored }],
  );
  assert.equal(due.calls[0]?.limited, 50);
  assert.equal(due.calls[0]?.filtered, true);
});

test("a CI read and a merge are recorded only on a pull request still open", async () => {
  const summary = {
    total: 2,
    passed: 1,
    failed: 1,
    pending: 0,
    failing: ["e2e"],
    detailsUrl: "https://ci.test/e2e",
  };
  const read = {
    ciState: "failing" as const,
    ciSummary: summary,
    ciHeadSha: "cafe",
    ciCheckedAt: at,
  };
  const recorded = store([
    [
      {
        ...row,
        ciState: "failing",
        ciSummary: summary,
        ciHeadSha: "cafe",
        ciCheckedAt: at,
      },
    ],
  ]);
  assert.deepEqual(await recorded.store.recordCi("org_1", "sbm_1", read), {
    ...stored,
    ciState: "failing",
    ciSummary: summary,
    ciHeadSha: "cafe",
    ciCheckedAt: at.toISOString(),
  });
  // An absent refusal is kept; a given one (or null) is written.
  assert.deepEqual(recorded.calls[0]?.values, read);
  const refused = store([[{ ...row, mergeError: "Review required." }]]);
  assert.equal(
    (
      await refused.store.recordCi("org_1", "sbm_1", {
        ...read,
        mergeError: "Review required.",
      })
    )?.mergeError,
    "Review required.",
  );
  assert.equal(refused.calls[0]?.values?.["mergeError"], "Review required.");
  assert.equal(await store([[]]).store.recordCi("org_1", "sbm_1", read), null);

  const ended = {
    pullRequestState: "merged" as const,
    mergedCommitSha: "landed",
    mergedAt: at,
    checkedAt: at,
  };
  const merged = store([
    [
      {
        ...row,
        pullRequestState: "merged",
        mergedCommitSha: "landed",
        mergedAt: at,
        ciCheckedAt: at,
      },
    ],
  ]);
  assert.deepEqual(
    await merged.store.recordPullRequest("org_1", "sbm_1", ended),
    {
      ...stored,
      pullRequestState: "merged",
      mergedCommitSha: "landed",
      mergedAt: at.toISOString(),
      ciCheckedAt: at.toISOString(),
    },
  );
  assert.deepEqual(merged.calls[0]?.values, {
    pullRequestState: "merged",
    mergedCommitSha: "landed",
    mergedAt: at,
    ciCheckedAt: at,
  });
  // Seen merged already by another process: it reports, this one does not.
  assert.equal(
    await store([[]]).store.recordPullRequest("org_1", "sbm_1", ended),
    null,
  );
});
