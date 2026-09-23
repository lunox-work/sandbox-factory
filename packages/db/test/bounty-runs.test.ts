import assert from "node:assert/strict";
import { test } from "node:test";

import { createBountyRunStore } from "../src/bounty-runs.js";
import type { BountyRunRow } from "../src/schema.js";
import { createFakeDb, createSequencedFakeDb } from "./fake-db.js";

function row(overrides: Partial<BountyRunRow> = {}): BountyRunRow {
  return {
    id: "brn_1",
    organizationId: "org_1",
    boardId: "jrb_1",
    startedBy: "usr_1",
    kind: "backlog",
    sourceProposalId: null,
    sourceRevision: null,
    requestId: "28bb313f-252a-4a1d-b656-558a215b604b",
    status: "queued",
    selection: {
      maxTickets: 10,
      excludeAssigned: true,
      issueTypes: [],
      minAgeDays: 0,
      minSpecChars: 0,
    },
    rateCard: {
      currency: "USD",
      xsMinor: 100,
      sMinor: 100,
      mMinor: 200,
      lMinor: 300,
      xlMinor: 400,
      revision: 1,
    },
    requestedModel: "configured-model",
    promptVersion: "jira-size-v1",
    planned: [],
    outcomes: [],
    candidatesScanned: 0,
    skippedLive: 0,
    scanLimitReached: false,
    leaseToken: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    deadlineAt: null,
    fatalErrorCode: null,
    startedAt: null,
    finishedAt: null,
    createdAt: new Date("2026-09-22T00:00:00Z"),
    updatedAt: new Date("2026-09-22T00:00:00Z"),
    ...overrides,
  };
}

const input = {
  boardId: "jrb_1",
  startedBy: "usr_1",
  requestId: "28bb313f-252a-4a1d-b656-558a215b604b",
  selection: row().selection,
  rateCard: row().rateCard,
  requestedModel: "configured-model",
  promptVersion: "jira-size-v1",
} as const;

test("same request id returns the existing run", async () => {
  const fake = createFakeDb([row()]);
  const result = await createBountyRunStore(fake.db).create("org_1", input);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.created, false);
});

test("request id reuse with other parameters conflicts", async () => {
  const fake = createFakeDb([row()]);
  const result = await createBountyRunStore(fake.db).create("org_1", {
    ...input,
    boardId: "jrb_2",
  });
  assert.deepEqual(result, { ok: false, reason: "request-conflict" });
});

test("creates a queued run only after checking board ownership and activity", async () => {
  const fake = createSequencedFakeDb([[], [{ id: "jrb_1" }], [], [row()]]);
  const result = await createBountyRunStore(fake.db).create("org_1", input);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.created, true);
  assert.match(String(fake.calls[3]?.values?.["id"]), /^brn_/);
  assert.equal(fake.calls[3]?.values?.["organizationId"], "org_1");
});

test("refuses a foreign board and reports an existing active run", async () => {
  const missing = createSequencedFakeDb([[], []]);
  assert.deepEqual(
    await createBountyRunStore(missing.db).create("org_2", input),
    { ok: false, reason: "not-found" },
  );

  const active = createSequencedFakeDb([[], [{ id: "jrb_1" }], [row()]]);
  assert.deepEqual(
    await createBountyRunStore(active.db).create("org_1", input),
    {
      ok: false,
      reason: "active",
      runId: "brn_1",
    },
  );
});

test("a one-ticket run does not wait behind the board's active run", async () => {
  // No activity read: the sequence has no row for it, so the insert is the
  // third call. The ticket is stored as the plan from the start.
  const planned = [
    { externalIssueId: "10007", issueKey: "APP-7", summary: "Add login" },
  ];
  const fake = createSequencedFakeDb([
    [],
    [{ id: "jrb_1" }],
    [row({ kind: "issue", planned })],
  ]);
  const result = await createBountyRunStore(fake.db).create("org_1", {
    ...input,
    kind: "issue",
    planned,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(fake.calls[2]?.values?.["planned"], planned);
  assert.equal(fake.calls[2]?.values?.["kind"], "issue");
});

test("a replayed one-ticket request must name the same ticket", async () => {
  const planned = [
    { externalIssueId: "10007", issueKey: "APP-7", summary: "Add login" },
  ];
  const existing = row({ kind: "issue", planned });
  const same = createSequencedFakeDb([[existing]]);
  assert.equal(
    (
      await createBountyRunStore(same.db).create("org_1", {
        ...input,
        kind: "issue",
        planned,
      })
    ).ok,
    true,
  );
  const other = createSequencedFakeDb([[existing]]);
  assert.deepEqual(
    await createBountyRunStore(other.db).create("org_1", {
      ...input,
      kind: "issue",
      planned: [
        { externalIssueId: "10008", issueKey: "APP-8", summary: "Other" },
      ],
    }),
    { ok: false, reason: "request-conflict" },
  );
});

test("a uniqueness race is reclassified as the active run", async () => {
  const violation = Object.assign(new Error("unique"), { code: "23505" });
  const fake = createSequencedFakeDb([
    [],
    [{ id: "jrb_1" }],
    [],
    violation,
    [],
    [row()],
  ]);
  assert.deepEqual(await createBountyRunStore(fake.db).create("org_1", input), {
    ok: false,
    reason: "active",
    runId: "brn_1",
  });
});

test("gets and lists owner-scoped runs with a bounded page", async () => {
  const fake = createFakeDb([row()]);
  const store = createBountyRunStore(fake.db);
  assert.equal((await store.get("org_1", "brn_1"))?.id, "brn_1");
  const listed = await store.listForBoard("org_1", "jrb_1", {
    cursor: "2026-09-23T00:00:00Z",
    limit: 500,
  });
  assert.equal(listed.length, 1);
  assert.equal(fake.calls[1]?.limited, 50);
});

test("run reads and lease writes report misses", async () => {
  const fake = createFakeDb([]);
  const store = createBountyRunStore(fake.db);
  assert.equal(await store.get("org_1", "brn_x"), null);
  assert.deepEqual(await store.listForBoard("org_1", "jrb_1"), []);
  const now = new Date("2026-09-22T00:00:00Z");
  assert.equal(await store.claim("org_1", "brn_x", "lease", now), null);
  assert.equal(await store.heartbeat("org_1", "brn_x", "lease", now), false);
  assert.equal(await store.recordPlan("org_1", "brn_x", "lease", []), false);
  assert.equal(
    await store.recordOutcome("org_1", "brn_x", "lease", {
      externalIssueId: "1",
      issueKey: "APP-1",
      status: "failed",
    }),
    false,
  );
  assert.equal(
    await store.finish("org_1", "brn_x", "lease", "failed", {
      fatalErrorCode: "test",
    }),
    null,
  );
});

test("claims, heartbeats, records and finishes only under the lease", async () => {
  const running = row({
    status: "running",
    leaseToken: "lease",
    leaseExpiresAt: new Date("2026-09-22T00:01:00Z"),
    startedAt: new Date("2026-09-22T00:00:00Z"),
  });
  const fake = createFakeDb([running]);
  const store = createBountyRunStore(fake.db);
  const now = new Date("2026-09-22T00:00:00Z");
  assert.equal(
    (await store.claim("org_1", "brn_1", "lease", now))?.status,
    "running",
  );
  assert.equal(await store.heartbeat("org_1", "brn_1", "lease", now), true);
  assert.equal(
    await store.recordPlan("org_1", "brn_1", "lease", [
      { externalIssueId: "10001", issueKey: "APP-1", summary: "Add login" },
    ]),
    true,
  );
  assert.equal(
    await store.recordOutcome("org_1", "brn_1", "lease", {
      externalIssueId: "10001",
      issueKey: "APP-1",
      status: "proposed",
    }),
    true,
  );
  assert.equal(
    (
      await store.finish("org_1", "brn_1", "lease", "succeeded", {
        candidatesScanned: 1,
        skippedLive: 2,
        scanLimitReached: false,
      })
    )?.status,
    "running",
  );
  assert.ok(fake.calls.slice(0, 5).every(({ filtered }) => filtered));
});

test("expired runs are failed within an organization", async () => {
  const fake = createFakeDb([row({ status: "failed" })]);
  const count = await createBountyRunStore(fake.db).failExpired(
    "org_1",
    new Date("2026-09-22T00:02:00Z"),
  );
  assert.equal(count, 1);
  assert.equal(fake.calls[0]?.values?.["fatalErrorCode"], "worker_lost");
});

test("watchdog discovery returns distinct organizations with expired work", async () => {
  const fake = createFakeDb([
    { organizationId: "org_1" },
    { organizationId: "org_1" },
    { organizationId: "org_2" },
  ]);
  assert.deepEqual(
    await createBountyRunStore(fake.db).organizationsWithExpiredRuns(
      new Date("2026-09-22T00:02:00Z"),
    ),
    ["org_1", "org_2"],
  );
  assert.equal(fake.calls[0]?.filtered, true);
});

test("legacy snapshot reads add XS without changing historical rates", async () => {
  const legacy = row();
  Reflect.deleteProperty(legacy.rateCard, "xsMinor");
  const fake = createFakeDb([legacy]);
  const record = await createBountyRunStore(fake.db).get("org_1", "brn_1");
  assert.equal(record?.rateCard.xsMinor, 100);
  assert.equal(record?.rateCard.sMinor, 100);
  assert.equal(record?.rateCard.revision, 1);
});
