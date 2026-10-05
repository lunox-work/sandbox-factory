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
    [row()],
  ]);
  const stored = await createBountyProfileStore(fake.db).request(
    "org_1",
    request,
  );
  assert.equal(stored?.id, "bpf_1");
  assert.equal(stored?.status, "queued");
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

test("latest reads the newest revision's profile, owner-scoped", async () => {
  const ready = row({
    specRevision: 3,
    status: "ready",
    scopeRunId: "arn_1",
    sliceRunId: "arn_2",
  });
  const fake = createFakeDb([ready]);
  const stored = await createBountyProfileStore(fake.db).latest(
    "org_1",
    "bpr_1",
  );
  assert.equal(stored?.specRevision, 3);
  assert.equal(stored?.sliceRunId, "arn_2");
  assert.equal(fake.calls[0]?.filtered, true);
  assert.equal(fake.calls[0]?.ordered, true);
  assert.equal(fake.calls[0]?.limited, 1);
  assert.equal(
    await createBountyProfileStore(createFakeDb([]).db).latest("org_1", "x"),
    null,
  );
});

test("pending lists rows in flight oldest first, within a bounded page", async () => {
  const fake = createFakeDb([row(), row({ id: "bpf_2", status: "scoping" })]);
  const store = createBountyProfileStore(fake.db);
  const rows = await store.pending("org_1");
  assert.deepEqual(
    rows.map((profile) => profile.id),
    ["bpf_1", "bpf_2"],
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
