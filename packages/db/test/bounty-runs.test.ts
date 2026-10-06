import assert from "node:assert/strict";
import { test } from "node:test";

import { createBountyRunStore, runDeadline } from "../src/bounty-runs.js";
import type { BountyRunRow } from "../src/schema.js";
import { createFakeDb, createSequencedFakeDb } from "./fake-db.js";

function row(overrides: Partial<BountyRunRow> = {}): BountyRunRow {
  return {
    id: "brn_1",
    organizationId: "org_1",
    boardId: "jrb_1",
    bountyId: null,
    startedBy: "usr_1",
    kind: "backlog",
    sourceProposalId: null,
    sourceRevision: null,
    respec: null,
    requestId: "28bb313f-252a-4a1d-b656-558a215b604b",
    status: "queued",
    selection: {
      unassignedOnly: false,
      issueTypes: [],
      minAgeDays: 0,
      minSpecChars: 0,
      categories: {},
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

test("a one-bounty run does not wait behind the board's active run", async () => {
  // No activity read: the sequence has no row for it, so the insert is the
  // third call. The bounty is stored as the plan from the start.
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

test("a bounty's run needs no board, only the bounty, and waits for its own sizing", async () => {
  const planned = [
    {
      externalIssueId: "bty_1",
      issueKey: "B-1",
      summary: "Add login",
      bountyId: "bty_1",
    },
  ];
  const bountyInput = {
    ...input,
    boardId: null,
    bountyId: "bty_1",
    kind: "bounty",
    planned,
  } as const;
  // Request lookup, the bounty's ownership, nothing in flight, the insert.
  const fake = createSequencedFakeDb([
    [],
    [{ id: "bty_1" }],
    [],
    [row({ kind: "bounty", boardId: null, bountyId: "bty_1", planned })],
  ]);
  const result = await createBountyRunStore(fake.db).create(
    "org_1",
    bountyInput,
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.run.boardId, null);
    assert.equal(result.run.bountyId, "bty_1");
  }
  assert.equal(fake.calls[3]?.values?.["boardId"], null);
  assert.equal(fake.calls[3]?.values?.["bountyId"], "bty_1");
  assert.equal(fake.calls[3]?.values?.["kind"], "bounty");

  const active = createSequencedFakeDb([
    [],
    [{ id: "bty_1" }],
    [row({ id: "brn_9", kind: "bounty", bountyId: "bty_1" })],
  ]);
  assert.deepEqual(
    await createBountyRunStore(active.db).create("org_1", bountyInput),
    { ok: false, reason: "active", runId: "brn_9" },
  );

  const foreign = createSequencedFakeDb([[], []]);
  assert.deepEqual(
    await createBountyRunStore(foreign.db).create("org_2", bountyInput),
    { ok: false, reason: "not-found" },
  );
});

test("a run is refused without what its kind reads", async () => {
  for (const missing of [
    { ...input, boardId: null },
    { ...input, kind: "issue", boardId: undefined },
    { ...input, kind: "bounty", bountyId: null },
  ] as const) {
    const fake = createSequencedFakeDb([[]]);
    assert.deepEqual(
      await createBountyRunStore(fake.db).create("org_1", missing),
      { ok: false, reason: "not-found" },
    );
    // Refused before anything is read but the request id.
    assert.equal(fake.calls.length, 1);
  }
});

test("a re-price of a bounty with no board waits only for its proposal", async () => {
  const fake = createSequencedFakeDb([
    [],
    [{ id: "bty_1" }],
    [],
    [row({ kind: "reprice", boardId: null, bountyId: "bty_1" })],
  ]);
  const result = await createBountyRunStore(fake.db).create("org_1", {
    ...input,
    boardId: null,
    bountyId: "bty_1",
    kind: "reprice",
    sourceProposalId: "bpr_1",
    sourceRevision: 1,
  });
  assert.equal(result.ok, true);
  // No board to read and no board's run to wait for.
  assert.equal(fake.calls.length, 4);
});

test("a replayed one-bounty request must name the same bounty", async () => {
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

test("a spec change waits for nothing on the board, only for a change to its proposal", async () => {
  const respec = { mode: "trim", removeScenarioIds: ["s2"] } as const;
  const change = {
    ...input,
    kind: "respec",
    sourceProposalId: "bpr_1",
    sourceRevision: 3,
    respec,
  } as const;
  // No board activity read: the proposal's is the only one asked about.
  const free = createSequencedFakeDb([
    [],
    [{ id: "jrb_1" }],
    [],
    [
      row({
        kind: "respec",
        sourceProposalId: "bpr_1",
        sourceRevision: 3,
        respec,
      }),
    ],
  ]);
  const created = await createBountyRunStore(free.db).create("org_1", change);
  assert.equal(created.ok, true);
  if (created.ok) assert.deepEqual(created.run.respec, respec);
  assert.equal(free.calls[3]?.kind, "insert");
  assert.deepEqual(free.calls[3]?.values?.["respec"], respec);
  assert.equal(free.calls[3]?.values?.["kind"], "respec");

  const busy = createSequencedFakeDb([
    [],
    [{ id: "jrb_1" }],
    [row({ id: "brn_9", kind: "reprice", sourceProposalId: "bpr_1" })],
  ]);
  assert.deepEqual(
    await createBountyRunStore(busy.db).create("org_1", change),
    {
      ok: false,
      reason: "active",
      runId: "brn_9",
    },
  );
});

test("a re-price waits for the board's run, then for a change to its proposal", async () => {
  const reprice = {
    ...input,
    kind: "reprice",
    sourceProposalId: "bpr_1",
    sourceRevision: 3,
  } as const;
  const fake = createSequencedFakeDb([
    [],
    [{ id: "jrb_1" }],
    [],
    [row({ id: "brn_8", kind: "respec", sourceProposalId: "bpr_1" })],
  ]);
  assert.deepEqual(
    await createBountyRunStore(fake.db).create("org_1", reprice),
    {
      ok: false,
      reason: "active",
      runId: "brn_8",
    },
  );
});

test("a replayed spec change must ask the same thing", async () => {
  const respec = { mode: "expand", kinds: ["boundary"] } as const;
  const existing = row({
    kind: "respec",
    sourceProposalId: "bpr_1",
    sourceRevision: 3,
    respec,
  });
  const change = {
    ...input,
    kind: "respec",
    sourceProposalId: "bpr_1",
    sourceRevision: 3,
  } as const;
  const same = createSequencedFakeDb([[existing]]);
  assert.equal(
    (await createBountyRunStore(same.db).create("org_1", { ...change, respec }))
      .ok,
    true,
  );
  const other = createSequencedFakeDb([[existing]]);
  assert.deepEqual(
    await createBountyRunStore(other.db).create("org_1", {
      ...change,
      respec: { mode: "expand", kinds: ["recovery"] },
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

test("finds the sizing in flight on one bounty", async () => {
  const fake = createFakeDb([
    row({ kind: "bounty", boardId: null, bountyId: "bty_1" }),
  ]);
  const store = createBountyRunStore(fake.db);
  assert.equal((await store.activeForBounty("org_1", "bty_1"))?.id, "brn_1");
  assert.equal(fake.calls[0]?.limited, 1);
});

test("finds the change in flight on one proposal", async () => {
  const fake = createFakeDb([
    row({ kind: "reprice", sourceProposalId: "bpr_1", sourceRevision: 2 }),
  ]);
  const store = createBountyRunStore(fake.db);
  const active = await store.activeForProposal("org_1", "bpr_1");
  assert.equal(active?.id, "brn_1");
  assert.equal(active?.kind, "reprice");
  assert.equal(fake.calls[0]?.limited, 1);
});

test("run reads and lease writes report misses", async () => {
  const fake = createFakeDb([]);
  const store = createBountyRunStore(fake.db);
  assert.equal(await store.get("org_1", "brn_x"), null);
  assert.deepEqual(await store.listForBoard("org_1", "jrb_1"), []);
  assert.equal(await store.activeForProposal("org_1", "bpr_x"), null);
  assert.equal(await store.activeForBounty("org_1", "bty_x"), null);
  const now = new Date("2026-09-22T00:00:00Z");
  assert.equal(await store.claim("org_1", "brn_x", "lease", now), null);
  assert.equal(await store.heartbeat("org_1", "brn_x", "lease", now), false);
  assert.equal(await store.recordPlan("org_1", "brn_x", "lease", []), null);
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
  const planned = [
    {
      externalIssueId: "10001",
      issueKey: "APP-1",
      summary: "Add login",
      categories: [
        {
          id: "left-behind",
          label: "Left behind",
          reason: "Open 412 days, never in a sprint, unassigned",
        },
      ],
    },
    { externalIssueId: "10002", issueKey: "APP-2", summary: "Fix logout" },
  ];
  const before = Date.now();
  assert.equal(
    (await store.recordPlan("org_1", "brn_1", "lease", planned))?.id,
    "brn_1",
  );
  // The plan is written with its reasons, and the deadline moves with its
  // size: ten minutes, plus twenty seconds a bounty.
  const planWrite = fake.calls.find(
    ({ values }) => values?.["planned"] !== undefined,
  );
  assert.deepEqual(planWrite?.values?.["planned"], planned);
  const deadline = planWrite?.values?.["deadlineAt"] as Date;
  assert.ok(deadline.getTime() >= before + 10 * 60_000 + 2 * 20_000);
  assert.ok(deadline.getTime() <= Date.now() + 10 * 60_000 + 2 * 20_000);
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

test("a run's deadline grows with the number of bounties it planned", () => {
  const now = new Date("2026-09-30T00:00:00Z");
  // Nothing planned yet: the time a run has to choose its bounties.
  assert.equal(runDeadline(now, 0).toISOString(), "2026-09-30T00:10:00.000Z");
  assert.equal(runDeadline(now, 3).toISOString(), "2026-09-30T00:11:00.000Z");
  // A board's worth of matches is hours, not a failure at ten minutes.
  assert.equal(runDeadline(now, 900).toISOString(), "2026-09-30T05:10:00.000Z");
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
