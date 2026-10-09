import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createBountyProfileStore,
  PENDING_PROFILE_STATUSES,
} from "../src/bounty-profiles.js";
import type { BountyProfileRow } from "../src/schema.js";
import { createFakeDb, createSequencedFakeDb } from "./fake-db.js";

function row(overrides: Partial<BountyProfileRow> = {}): BountyProfileRow {
  return {
    id: "bpf_1",
    organizationId: "org_1",
    proposalId: "bpr_1",
    specRevision: 1,
    specHash: "a".repeat(64),
    snapshotId: "rsn_1",
    status: "queued",
    errorCode: null,
    runErrorCode: null,
    scopeRunId: null,
    sliceRunId: null,
    profile: null,
    createdAt: new Date("2026-10-03T00:00:00Z"),
    updatedAt: new Date("2026-10-03T00:01:00Z"),
    ...overrides,
  };
}

/** A row as the store reads it: with its snapshot's repository's name. */
function named(
  overrides: Partial<BountyProfileRow> = {},
  repository: string | null = "acme/api",
) {
  return { row: row(overrides), repository };
}

const request = {
  proposalId: "bpr_1",
  specRevision: 1,
  specHash: "a".repeat(64),
  snapshotId: "rsn_1",
};

test("a request checks the proposal is the owner's, then inserts once and reads the row back", async () => {
  const fake = createSequencedFakeDb([
    [{ id: "bpr_1" }],
    [{ id: "rsn_1" }],
    [],
    [named()],
  ]);
  const stored = await createBountyProfileStore(fake.db).request(
    "org_1",
    request,
  );
  assert.equal(stored?.id, "bpf_1");
  assert.equal(stored?.status, "queued");
  assert.equal(stored?.repository, "acme/api");
  assert.equal(stored?.createdAt, "2026-10-03T00:00:00.000Z");
  const [owner, snapshot, insert, read] = fake.calls;
  assert.equal(owner?.filtered, true);
  // The snapshot is the owner's too, and held until the insert commits.
  assert.equal(snapshot?.filtered, true);
  assert.equal(snapshot?.lock, "key share");
  assert.equal(insert?.kind, "insert");
  assert.equal(insert?.values?.["organizationId"], "org_1");
  assert.equal(insert?.values?.["snapshotId"], "rsn_1");
  assert.match(String(insert?.values?.["id"]), /^bpf_/);
  // Asking twice for one revision is a no-op, not an error.
  assert.equal(insert?.ignoredConflict, true);
  assert.equal(read?.filtered, true);
});

test("a request for another organization's proposal writes nothing", async () => {
  const fake = createSequencedFakeDb([[]]);
  assert.equal(
    await createBountyProfileStore(fake.db).request("org_2", request),
    null,
  );
  assert.equal(fake.calls.length, 1);
  // So is another organization's snapshot, or one pruned since.
  const foreign = createSequencedFakeDb([[{ id: "bpr_1" }], []]);
  assert.equal(
    await createBountyProfileStore(foreign.db).request("org_1", request),
    null,
  );
  assert.equal(
    foreign.calls.some(({ kind }) => kind === "insert"),
    false,
  );
  // A row that vanished between the insert and the read is a miss too.
  const racing = createSequencedFakeDb([
    [{ id: "bpr_1" }],
    [{ id: "rsn_1" }],
    [],
    [],
  ]);
  assert.equal(
    await createBountyProfileStore(racing.db).request("org_1", request),
    null,
  );
});

test("a request for each snapshot of one revision reads back its own row", async () => {
  const fake = createSequencedFakeDb([
    [{ id: "bpr_1" }],
    [{ id: "rsn_1" }],
    [],
    [named()],
    [{ id: "bpr_1" }],
    [{ id: "rsn_2" }],
    [],
    [named({ id: "bpf_2", snapshotId: "rsn_2" }, "acme/web")],
  ]);
  const store = createBountyProfileStore(fake.db);
  const first = await store.request("org_1", request);
  const second = await store.request("org_1", {
    ...request,
    snapshotId: "rsn_2",
  });
  assert.deepEqual(
    [first, second].map((profile) => [
      profile?.id,
      profile?.snapshotId,
      profile?.repository,
    ]),
    [
      ["bpf_1", "rsn_1", "acme/api"],
      ["bpf_2", "rsn_2", "acme/web"],
    ],
  );
  // One revision, two rows: each insert names its own snapshot.
  const inserts = fake.calls.filter(({ kind }) => kind === "insert");
  assert.deepEqual(
    inserts.map(({ values }) => [
      values?.["specRevision"],
      values?.["snapshotId"],
    ]),
    [
      [1, "rsn_1"],
      [1, "rsn_2"],
    ],
  );
});

test("latest reads every profile of the newest revision, owner-scoped, in name order", async () => {
  const fake = createSequencedFakeDb([
    [{ specRevision: 3 }],
    [
      named(
        {
          specRevision: 3,
          status: "ready",
          scopeRunId: "arn_1",
          sliceRunId: "arn_2",
        },
        "acme/api",
      ),
      named({ id: "bpf_2", specRevision: 3, snapshotId: "rsn_2" }, "acme/web"),
    ],
  ]);
  const stored = await createBountyProfileStore(fake.db).latest(
    "org_1",
    "bpr_1",
  );
  assert.deepEqual(
    stored.map((profile) => [
      profile.id,
      profile.specRevision,
      profile.repository,
    ]),
    [
      ["bpf_1", 3, "acme/api"],
      ["bpf_2", 3, "acme/web"],
    ],
  );
  assert.equal(stored[0]?.sliceRunId, "arn_2");
  // The newest revision first, then its rows.
  const [newest, rows] = fake.calls;
  assert.equal(newest?.filtered, true);
  assert.equal(newest?.ordered, true);
  assert.equal(newest?.limited, 1);
  assert.equal(rows?.filtered, true);
  assert.equal(rows?.ordered, true);
  assert.equal(rows?.limited, undefined);
  // None profiled yet reads as none, without asking for rows.
  const none = createSequencedFakeDb([[]]);
  assert.deepEqual(
    await createBountyProfileStore(none.db).latest("org_1", "x"),
    [],
  );
  assert.equal(none.calls.length, 1);
});

test("forRevision reads one revision's profiles, and a gone snapshot names no repository", async () => {
  const fake = createFakeDb([
    named({ specRevision: 2 }, "acme/api"),
    named({ id: "bpf_2", specRevision: 2, snapshotId: null }, null),
  ]);
  const stored = await createBountyProfileStore(fake.db).forRevision(
    "org_1",
    "bpr_1",
    2,
  );
  assert.deepEqual(
    stored.map((profile) => [
      profile.id,
      profile.snapshotId,
      profile.repository,
    ]),
    [
      ["bpf_1", "rsn_1", "acme/api"],
      ["bpf_2", null, null],
    ],
  );
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0]?.filtered, true);
  assert.equal(fake.calls[0]?.ordered, true);
  assert.deepEqual(
    await createBountyProfileStore(createFakeDb([]).db).forRevision(
      "org_1",
      "bpr_1",
      9,
    ),
    [],
  );
});

test("pending lists rows in flight oldest first, within a bounded page", async () => {
  const fake = createFakeDb([
    named(),
    named({ id: "bpf_2", status: "scoping", snapshotId: null }, null),
  ]);
  const store = createBountyProfileStore(fake.db);
  const rows = await store.pending("org_1");
  assert.deepEqual(
    rows.map((profile) => [profile.id, profile.repository]),
    [
      ["bpf_1", "acme/api"],
      ["bpf_2", null],
    ],
  );
  assert.equal(fake.calls[0]?.ordered, true);
  assert.equal(fake.calls[0]?.limited, 50);
  await store.pending("org_1", 10_000);
  assert.equal(fake.calls[1]?.limited, 200);
  await store.pending("org_1", 0);
  assert.equal(fake.calls[2]?.limited, 1);
  assert.deepEqual(PENDING_PROFILE_STATUSES, ["queued", "scoping", "slicing"]);
});

test("the sweep discovers each organization with work once", async () => {
  const fake = createFakeDb([
    { organizationId: "org_1" },
    { organizationId: "org_2" },
    { organizationId: "org_1" },
  ]);
  assert.deepEqual(
    await createBountyProfileStore(fake.db).organizationsWithPending(),
    ["org_1", "org_2"],
  );
});

test("advance moves a row only from the status it was read in, and sets what the step carries", async () => {
  const fake = createFakeDb([{ id: "bpf_1" }]);
  const store = createBountyProfileStore(fake.db);
  assert.equal(
    await store.advance("org_1", "bpf_1", "queued", {
      status: "scoping",
      scopeRunId: "arn_1",
    }),
    true,
  );
  await store.advance("org_1", "bpf_1", "scoping", {
    status: "slicing",
    sliceRunId: "arn_2",
  });
  const profile = { version: "profile-v1" } as never;
  await store.advance("org_1", "bpf_1", "slicing", {
    status: "ready",
    profile,
  });
  await store.advance("org_1", "bpf_1", "slicing", {
    status: "failed",
    errorCode: "slice_failed",
    runErrorCode: "tool_timeout",
  });
  await store.advance("org_1", "bpf_1", "queued", {
    status: "failed",
    errorCode: "source_unavailable",
  });
  const sets = fake.calls.map((call) => {
    const { updatedAt, ...rest } = call.values ?? {};
    assert.ok(updatedAt instanceof Date);
    assert.equal(call.filtered, true);
    return rest;
  });
  assert.deepEqual(sets, [
    { status: "scoping", scopeRunId: "arn_1" },
    { status: "slicing", sliceRunId: "arn_2" },
    { status: "ready", profile },
    {
      status: "failed",
      errorCode: "slice_failed",
      runErrorCode: "tool_timeout",
    },
    { status: "failed", errorCode: "source_unavailable", runErrorCode: null },
  ]);

  // A row another sweep moved first is not moved again.
  const moved = createFakeDb([]);
  assert.equal(
    await createBountyProfileStore(moved.db).advance(
      "org_1",
      "bpf_1",
      "queued",
      {
        status: "scoping",
        scopeRunId: "arn_1",
      },
    ),
    false,
  );
});
