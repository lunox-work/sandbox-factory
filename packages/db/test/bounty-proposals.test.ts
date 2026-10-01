import assert from "node:assert/strict";
import { test } from "node:test";

import { createBountyProposalStore } from "../src/bounty-proposals.js";
import type {
  BountyProposalRow,
  BountyRunRow,
  BountyWritebackRow,
} from "../src/schema.js";
import { createFakeDb, createSequencedFakeDb } from "./fake-db.js";

function row(overrides: Partial<BountyProposalRow> = {}): BountyProposalRow {
  return {
    id: "bpr_1",
    organizationId: "org_1",
    runId: "brn_1",
    jiraIssueId: "jri_1",
    specHash: "a".repeat(64),
    specHashVersion: 1,
    rateCard: {
      currency: "USD",
      xsMinor: 100,
      sMinor: 100,
      mMinor: 200,
      lMinor: 300,
      xlMinor: 400,
      revision: 1,
    },
    modelComplexity: "M",
    modelConfidence: "high",
    modelRationale: "A few related files.",
    unsizedReason: null,
    inputTruncated: false,
    actualModel: "configured-model",
    promptVersion: "jira-size-v1",
    complexity: "M",
    sizedBy: "model",
    resizedBy: null,
    resizedAt: null,
    amountMinor: 200,
    currency: "USD",
    status: "proposed",
    revision: 1,
    specRevision: null,
    decidedBy: null,
    decidedAt: null,
    decisionDeliveryPolicy: null,
    createdAt: new Date("2026-09-22T00:00:00Z"),
    updatedAt: new Date("2026-09-22T00:00:00Z"),
    ...overrides,
  };
}

const input = {
  runId: "brn_1",
  jiraIssueId: "jri_1",
  specHash: "a".repeat(64),
  specHashVersion: 1,
  rateCard: row().rateCard,
  sizing: {
    complexity: "M",
    confidence: "high",
    rationale: "A few related files.",
  },
  inputTruncated: false,
  actualModel: "configured-model",
  promptVersion: "jira-size-v1",
  amountMinor: 200,
  currency: "USD",
} as const;

/** A spec as a run hands it over: no proposal id, no revision. */
const spec = {
  specHash: "a".repeat(64),
  specHashVersion: 1,
  draft: {
    feature: "CSV export",
    background: [],
    scenarios: [
      {
        id: "s1",
        kind: "happy",
        title: "The filtered table is exported",
        steps: [{ keyword: "Then", text: "a CSV file is downloaded" }],
        origin: "draft",
      },
    ],
    openQuestions: [],
    assumptions: [],
  },
  origin: "draft",
  actualModel: "drafting-model",
  promptVersion: "draft-v1",
} as const;

test("creates only after both owner-scoped parents are found", async () => {
  const fake = createSequencedFakeDb([
    [{ runId: "brn_1", issueKey: "APP-1" }],
    [row()],
  ]);
  const proposal = await createBountyProposalStore(fake.db).create(
    "org_1",
    input,
  );
  assert.equal(proposal?.issueKey, "APP-1");
  assert.match(String(fake.calls[1]?.values?.["id"]), /^bpr_/);

  const missing = createFakeDb([]);
  assert.equal(
    await createBountyProposalStore(missing.db).create("org_2", input),
    null,
  );
});

test("creates under a live lease and classifies fencing outcomes", async () => {
  const running = {
    id: "brn_1",
    boardId: "jrb_1",
  } as BountyRunRow;
  const created = createSequencedFakeDb([
    [running],
    [{ key: "APP-1" }],
    [row()],
  ]);
  const result = await createBountyProposalStore(created.db).createForLease(
    "org_1",
    "lease",
    input,
  );
  assert.equal(result.status, "created");
  assert.equal(created.calls[2]?.ignoredConflict, true);

  const lost = createSequencedFakeDb([[]]);
  assert.deepEqual(
    await createBountyProposalStore(lost.db).createForLease(
      "org_1",
      "old-lease",
      input,
    ),
    { status: "lost-lease" },
  );

  const duplicate = createSequencedFakeDb([[running], [{ key: "APP-1" }], []]);
  assert.deepEqual(
    await createBountyProposalStore(duplicate.db).createForLease(
      "org_1",
      "lease",
      input,
    ),
    { status: "duplicate" },
  );
});

test("a proposal created with a spec stores it as revision 1 in the same transaction", async () => {
  const running = { id: "brn_1", boardId: "jrb_1" } as BountyRunRow;
  const fake = createSequencedFakeDb([
    [running],
    [{ key: "APP-1" }],
    [row({ specRevision: 1 })],
    [],
  ]);
  const result = await createBountyProposalStore(fake.db).createForLease(
    "org_1",
    "lease",
    { ...input, spec },
  );

  assert.equal(result.status, "created");
  if (result.status === "created") {
    assert.equal(result.proposal.specRevision, 1);
  }
  // The proposal says which revision it goes with, and the revision is
  // written after it, for it, by the run that drafted it.
  assert.equal(fake.calls[2]?.values?.["specRevision"], 1);
  const stored = fake.calls[3];
  assert.equal(stored?.kind, "insert");
  assert.match(String(stored?.values?.["id"]), /^bsp_/);
  assert.equal(stored?.values?.["organizationId"], "org_1");
  assert.equal(stored?.values?.["proposalId"], "bpr_1");
  assert.equal(stored?.values?.["revision"], 1);
  assert.equal(stored?.values?.["runId"], "brn_1");
  assert.equal(stored?.values?.["origin"], "draft");
  assert.equal(stored?.values?.["actualModel"], "drafting-model");
  assert.equal(stored?.values?.["promptVersion"], "draft-v1");
  assert.deepEqual(stored?.values?.["draft"], spec.draft);
});

test("a proposal created without a spec points at none", async () => {
  const running = { id: "brn_1", boardId: "jrb_1" } as BountyRunRow;
  const fake = createSequencedFakeDb([[running], [{ key: "APP-1" }], [row()]]);
  const result = await createBountyProposalStore(fake.db).createForLease(
    "org_1",
    "lease",
    input,
  );

  assert.equal(result.status, "created");
  assert.equal(fake.calls[2]?.values?.["specRevision"], null);
  assert.equal(fake.calls.filter(({ kind }) => kind === "insert").length, 1);
});

test("a ticket that already has a live proposal gets no spec", async () => {
  // The proposal insert lost to the live one, so there is nothing for a
  // spec to belong to.
  const running = { id: "brn_1", boardId: "jrb_1" } as BountyRunRow;
  const fake = createSequencedFakeDb([[running], [{ key: "APP-1" }], []]);
  assert.deepEqual(
    await createBountyProposalStore(fake.db).createForLease("org_1", "lease", {
      ...input,
      spec,
    }),
    { status: "duplicate" },
  );
  assert.equal(fake.calls.filter(({ kind }) => kind === "insert").length, 1);
});

test("gets and lists proposals with issue display keys", async () => {
  const joined = {
    row: row(),
    issueKey: "APP-1",
    externalId: "10001",
    planned: [
      { externalIssueId: "10002", issueKey: "APP-2", summary: "Another" },
      {
        externalIssueId: "10001",
        issueKey: "APP-1",
        summary: "Add login",
        categories: [
          {
            id: "holding-others-up",
            label: "Holding others up",
            reason: "Blocks 3 open tickets, unassigned",
          },
        ],
      },
    ],
  };
  const fake = createFakeDb([joined]);
  const store = createBountyProposalStore(fake.db);
  assert.equal((await store.get("org_1", "bpr_1"))?.issueKey, "APP-1");
  const listed = await store.listForBoard("org_1", "jrb_1", {
    status: "proposed",
    cursor: {
      createdAt: "2026-09-23T00:00:00Z",
      id: "bpr_after",
    },
    limit: 500,
  });
  assert.equal(listed[0]?.id, "bpr_1");
  // The title its own ticket was planned under, not a neighbour's.
  assert.equal(listed[0]?.sizedTitle, "Add login");
  // And why its own run picked it, from the same plan entry.
  assert.deepEqual(listed[0]?.categories, [
    {
      id: "holding-others-up",
      label: "Holding others up",
      reason: "Blocks 3 open tickets, unassigned",
    },
  ]);
  assert.equal(fake.calls[1]?.limited, 50);
});

test("a listed proposal has no sized title when its run planned none", async () => {
  for (const planned of [
    [],
    [{ externalIssueId: "10002", issueKey: "APP-2", summary: "Another" }],
    // A plan that recorded the ticket with nothing to call it.
    [{ externalIssueId: "10001", issueKey: "APP-1", summary: "" }],
  ]) {
    const fake = createFakeDb([
      { row: row(), issueKey: "APP-1", externalId: "10001", planned },
    ]);
    const listed = await createBountyProposalStore(fake.db).listForBoard(
      "org_1",
      "jrb_1",
    );
    assert.equal(listed[0]?.sizedTitle, null);
    // A plan from before categories, or a ticket picked by hand: none.
    assert.deepEqual(listed[0]?.categories, []);
  }
});

test("category counts are per category and per proposal", async () => {
  const leftBehind = { id: "left-behind", label: "Left behind", reason: "r" };
  const paperCuts = { id: "paper-cuts", label: "Paper cuts", reason: "r" };
  const fake = createFakeDb([
    { categories: [leftBehind, paperCuts] },
    { categories: [leftBehind] },
    // A ticket someone picked by hand, and a plan from before categories.
    { categories: [] },
    { categories: null },
    // Stored JSON is not trusted to be well formed: a repeat counts once,
    // and an entry without a usable id counts nowhere.
    { categories: [paperCuts, paperCuts, { label: "No id" }, null, { id: 7 }] },
  ]);

  const result = await createBountyProposalStore(fake.db).categoryCounts(
    "org_1",
    "jrb_1",
  );

  // Five proposals; one is in two categories, so the counts sum past the
  // two that are in none.
  assert.deepEqual(result, {
    total: 5,
    uncategorized: 2,
    counts: { "left-behind": 2, "paper-cuts": 2 },
  });
  assert.equal(fake.calls[0]?.filtered, true);
});

test("a board with no proposals has no counts", async () => {
  const fake = createFakeDb([]);
  assert.deepEqual(
    await createBountyProposalStore(fake.db).categoryCounts("org_1", "jrb_1"),
    { total: 0, uncategorized: 0, counts: {} },
  );
});

test("a plan entry with no usable category id is in no category", async () => {
  // Counted the way the list's `uncategorized` filter reads it: what makes
  // a category is a string id, not the presence of a list.
  const fake = createFakeDb([
    { categories: [{ label: "No id" }, null, { id: 7 }] },
    { categories: "not a list" },
  ]);
  assert.deepEqual(
    await createBountyProposalStore(fake.db).categoryCounts("org_1", "jrb_1"),
    { total: 2, uncategorized: 2, counts: {} },
  );
});

test("listing the uncategorized filters, and still pages", async () => {
  const fake = createFakeDb([
    { row: row(), issueKey: "APP-1", externalId: "10001", planned: [] },
  ]);
  const listed = await createBountyProposalStore(fake.db).listForBoard(
    "org_1",
    "jrb_1",
    { uncategorized: true, limit: 10 },
  );

  assert.equal(listed[0]?.id, "bpr_1");
  assert.deepEqual(listed[0]?.categories, []);
  assert.equal(fake.calls[0]?.limited, 10);
  assert.equal(fake.calls[0]?.filtered, true);
});

test("listing by category still pages and still reads each row's reasons", async () => {
  const joined = {
    row: row(),
    issueKey: "APP-1",
    externalId: "10001",
    planned: [
      {
        externalIssueId: "10001",
        issueKey: "APP-1",
        summary: "Add login",
        categories: [{ id: "paper-cuts", label: "Paper cuts", reason: "r" }],
      },
    ],
  };
  const fake = createFakeDb([joined]);
  const listed = await createBountyProposalStore(fake.db).listForBoard(
    "org_1",
    "jrb_1",
    { category: "paper-cuts", limit: 10 },
  );

  assert.equal(listed[0]?.id, "bpr_1");
  assert.deepEqual(
    listed[0]?.categories.map(({ id }) => id),
    ["paper-cuts"],
  );
  assert.equal(fake.calls[0]?.limited, 10);
  assert.equal(fake.calls[0]?.filtered, true);
});

test("proposal reads can miss and list with defaults", async () => {
  const fake = createFakeDb([]);
  const store = createBountyProposalStore(fake.db);
  assert.equal(await store.get("org_1", "bpr_x"), null);
  assert.deepEqual(await store.listForBoard("org_1", "jrb_1"), []);
});

test("finds live proposal issue ids for selection", async () => {
  const fake = createFakeDb([{ externalId: "10001" }]);
  const ids = await createBountyProposalStore(fake.db).liveExternalIds(
    "org_1",
    "jrb_1",
    ["10001", "10002"],
  );
  assert.deepEqual([...ids], ["10001"]);
  assert.equal(
    (
      await createBountyProposalStore(fake.db).liveExternalIds(
        "org_1",
        "jrb_1",
        [],
      )
    ).size,
    0,
  );
});

test("finds each live ticket's proposal id, for search results", async () => {
  const fake = createFakeDb([{ externalId: "10001", proposalId: "bpr_1" }]);
  const ids = await createBountyProposalStore(fake.db).liveProposalIds(
    "org_1",
    "jrb_1",
    ["10001", "10002"],
  );
  assert.deepEqual([...ids], [["10001", "bpr_1"]]);
});

test("finds each proposal's Jira issue, for reading live titles", async () => {
  const fake = createFakeDb([
    { proposalId: "bpr_1", jiraIssueId: "jri_1", externalId: "10001" },
  ]);
  const store = createBountyProposalStore(fake.db);
  const issues = await store.issuesForProposals("org_1", "jrb_1", [
    "bpr_1",
    "bpr_2",
  ]);
  assert.deepEqual(
    [...issues],
    [["bpr_1", { jiraIssueId: "jri_1", externalId: "10001" }]],
  );
  assert.equal((await store.issuesForProposals("org_1", "jrb_1", [])).size, 0);
});

test("approves once and treats the exact replay as idempotent", async () => {
  const approved = row({ status: "approved", revision: 2 });
  const fake = createSequencedFakeDb([
    [approved],
    [{ row: approved, issueKey: "APP-1" }],
  ]);
  const result = await createBountyProposalStore(fake.db).approve(
    "org_1",
    "bpr_1",
    1,
    "usr_1",
    "off",
  );
  assert.equal(result.ok, true);

  const replay = createSequencedFakeDb([
    [],
    [{ row: approved, issueKey: "APP-1" }],
  ]);
  assert.equal(
    (
      await createBountyProposalStore(replay.db).approve(
        "org_1",
        "bpr_1",
        1,
        "usr_1",
        "off",
      )
    ).ok,
    true,
  );
});

test("withdraws and resizes through expected-revision filters", async () => {
  const withdrawn = row({ revision: 2, status: "proposed" });
  const withdrawFake = createSequencedFakeDb([
    [withdrawn],
    [{ row: withdrawn, issueKey: "APP-1" }],
  ]);
  assert.equal(
    (
      await createBountyProposalStore(withdrawFake.db).withdraw(
        "org_1",
        "bpr_1",
        1,
      )
    ).ok,
    true,
  );
  // Back to proposed with no decision left on the row.
  assert.equal(withdrawFake.calls[0]?.values?.["status"], "proposed");
  assert.equal(withdrawFake.calls[0]?.values?.["decidedBy"], null);
  assert.equal(withdrawFake.calls[0]?.values?.["decisionDeliveryPolicy"], null);

  const resized = row({ revision: 2, complexity: "L", amountMinor: 300 });
  const resizeFake = createSequencedFakeDb([
    [resized],
    [{ row: resized, issueKey: "APP-1" }],
  ]);
  assert.equal(
    (
      await createBountyProposalStore(resizeFake.db).resize(
        "org_1",
        "bpr_1",
        1,
        "usr_1",
        "L",
        300,
        "USD",
      )
    ).ok,
    true,
  );
});

test("a missed mutation distinguishes not found from changed", async () => {
  const missing = createSequencedFakeDb([[], []]);
  assert.deepEqual(
    await createBountyProposalStore(missing.db).withdraw("org_2", "bpr_1", 1),
    { ok: false, reason: "not-found" },
  );

  const changed = row({ revision: 2 });
  const conflict = createSequencedFakeDb([
    [],
    [{ row: changed, issueKey: "APP-1" }],
  ]);
  const result = await createBountyProposalStore(conflict.db).resize(
    "org_1",
    "bpr_1",
    1,
    "usr_1",
    "S",
    100,
    "USD",
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "changed");

  // Withdrawing what is already proposed: the revision matches, the state
  // does not.
  const invalid = row({ revision: 1, status: "proposed" });
  const invalidState = createSequencedFakeDb([
    [],
    [{ row: invalid, issueKey: "APP-1" }],
  ]);
  const invalidResult = await createBountyProposalStore(
    invalidState.db,
  ).withdraw("org_1", "bpr_1", 1);
  assert.equal(invalidResult.ok, false);
  if (!invalidResult.ok) assert.equal(invalidResult.reason, "invalid-state");
});

test("remove deletes a proposed proposal by expected revision", async () => {
  const fake = createSequencedFakeDb([
    [{ row: row(), issueKey: "APP-1" }],
    [row()],
  ]);
  const result = await createBountyProposalStore(fake.db).remove(
    "org_1",
    "bpr_1",
    1,
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.proposal.id, "bpr_1");
  assert.equal(fake.calls[1]?.kind, "delete");
  assert.equal(fake.calls[1]?.filtered, true);

  const missing = createSequencedFakeDb([[]]);
  assert.deepEqual(
    await createBountyProposalStore(missing.db).remove("org_1", "bpr_1", 1),
    { ok: false, reason: "not-found" },
  );

  // Present but moved on: the delete matches nothing, and the miss says why.
  const moved = row({ revision: 2 });
  const changed = createSequencedFakeDb([
    [{ row: moved, issueKey: "APP-1" }],
    [],
    [{ row: moved, issueKey: "APP-1" }],
  ]);
  const conflict = await createBountyProposalStore(changed.db).remove(
    "org_1",
    "bpr_1",
    1,
  );
  assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.equal(conflict.reason, "changed");
});

test("re-price updates the source in place, fenced by its run lease and source revision", async () => {
  const repriced = row({ revision: 2, runId: "brn_2" });
  const fake = createSequencedFakeDb([
    [{ id: "brn_2", boardId: "jrb_1" } as BountyRunRow],
    [row()],
    [repriced],
    [{ row: repriced, issueKey: "APP-1" }],
  ]);
  const result = await createBountyProposalStore(fake.db).repriceForLease(
    "org_1",
    "lease_1",
    "bpr_1",
    1,
    { ...input, runId: "brn_2" },
  );
  assert.equal(result.status, "repriced");
  if (result.status === "repriced") {
    // The same proposal, not a replacement.
    assert.equal(result.proposal.id, "bpr_1");
    assert.equal(result.proposal.revision, 2);
  }
  assert.ok(fake.calls.slice(0, 3).every(({ filtered }) => filtered));
  // Sized again by the model, back to proposed, with no decision carried over.
  const update = fake.calls[2]?.values;
  assert.equal(update?.["status"], "proposed");
  assert.equal(update?.["sizedBy"], "model");
  assert.equal(update?.["resizedBy"], null);
  assert.equal(update?.["decidedBy"], null);
  assert.equal(update?.["runId"], "brn_2");
  assert.equal(update?.["revision"], 2);
  assert.ok(!fake.calls.some(({ kind }) => kind === "insert"));

  const lost = createFakeDb([]);
  assert.equal(
    (
      await createBountyProposalStore(lost.db).repriceForLease(
        "org_1",
        "old",
        "bpr_1",
        1,
        { ...input, runId: "brn_2" },
      )
    ).status,
    "lost-lease",
  );
});

test("re-price with a spec writes the next revision and points the proposal at it", async () => {
  const repriced = row({ revision: 2, runId: "brn_2", specRevision: 3 });
  const fake = createSequencedFakeDb([
    [{ id: "brn_2", boardId: "jrb_1" } as BountyRunRow],
    [row({ specRevision: 2 })],
    // The proposal's latest spec revision, read while its row is locked.
    [{ revision: 2 }],
    [repriced],
    [],
    [{ row: repriced, issueKey: "APP-1" }],
  ]);
  const result = await createBountyProposalStore(fake.db).repriceForLease(
    "org_1",
    "lease_1",
    "bpr_1",
    1,
    { ...input, runId: "brn_2", spec },
  );

  assert.equal(result.status, "repriced");
  if (result.status === "repriced") {
    assert.equal(result.proposal.specRevision, 3);
  }
  assert.equal(fake.calls[2]?.kind, "select");
  assert.equal(fake.calls[2]?.filtered, true);
  assert.equal(fake.calls[2]?.limited, 1);
  assert.equal(fake.calls[3]?.values?.["specRevision"], 3);
  const stored = fake.calls[4];
  assert.equal(stored?.kind, "insert");
  assert.equal(stored?.values?.["proposalId"], "bpr_1");
  assert.equal(stored?.values?.["revision"], 3);
  assert.equal(stored?.values?.["runId"], "brn_2");
});

test("re-price starts a spec at revision 1 for a proposal that had none", async () => {
  const repriced = row({ revision: 2, runId: "brn_2", specRevision: 1 });
  const fake = createSequencedFakeDb([
    [{ id: "brn_2", boardId: "jrb_1" } as BountyRunRow],
    [row()],
    [],
    [repriced],
    [],
    [{ row: repriced, issueKey: "APP-1" }],
  ]);
  await createBountyProposalStore(fake.db).repriceForLease(
    "org_1",
    "lease_1",
    "bpr_1",
    1,
    { ...input, runId: "brn_2", spec },
  );

  assert.equal(fake.calls[3]?.values?.["specRevision"], 1);
  assert.equal(fake.calls[4]?.values?.["revision"], 1);
});

test("re-price without a spec clears the pointer and writes no revision", async () => {
  // The earlier revisions were drafted from a ticket this size no longer
  // goes with, so the proposal stops pointing at any of them.
  const repriced = row({ revision: 2, runId: "brn_2" });
  const fake = createSequencedFakeDb([
    [{ id: "brn_2", boardId: "jrb_1" } as BountyRunRow],
    [row({ specRevision: 2 })],
    [repriced],
    [{ row: repriced, issueKey: "APP-1" }],
  ]);
  const result = await createBountyProposalStore(fake.db).repriceForLease(
    "org_1",
    "lease_1",
    "bpr_1",
    1,
    { ...input, runId: "brn_2" },
  );

  assert.equal(result.status, "repriced");
  assert.equal(fake.calls[2]?.values?.["specRevision"], null);
  assert.ok(!fake.calls.some(({ kind }) => kind === "insert"));
});

test("re-price queues a withdrawal for a posted approval in the same transaction", async () => {
  const source = row({
    status: "approved",
    decisionDeliveryPolicy: "requested",
  });
  const repriced = row({ revision: 2, runId: "brn_2" });
  const approval = {
    id: "bwo_approved",
    kind: "approved",
    status: "done",
    jiraCommentId: "10001",
    payload: {
      complexity: "M",
      amountMinor: 200,
      currency: "USD",
      proposalUrl:
        "https://app.test/o/acme/jira/jrc_1/jrb_1?tab=proposals&proposal=bpr_1",
    },
  } as BountyWritebackRow;
  const fake = createSequencedFakeDb([
    [
      {
        id: "brn_2",
        boardId: "jrb_1",
        startedBy: "usr_1",
      } as BountyRunRow,
    ],
    [source],
    [approval],
    [repriced],
    [{ row: repriced, issueKey: "APP-1" }],
    // The board's site, joined: the follow-up is queued only when the grant
    // covers writes.
    [
      {
        scopes: "read:jira-work write:jira-work offline_access",
        resourceScopes: "read:jira-work write:jira-work",
      },
    ],
    [],
  ]);

  const result = await createBountyProposalStore(fake.db).repriceForLease(
    "org_1",
    "lease_1",
    "bpr_1",
    1,
    { ...input, runId: "brn_2" },
  );

  assert.equal(result.status, "repriced");
  if (result.status === "repriced") {
    assert.match(result.writebackOperationId ?? "", /^bwo_/);
  }
  const followUp = fake.calls.find(
    (call) => call.kind === "insert" && call.values?.["kind"] === "withdrawn",
  );
  assert.ok(followUp !== undefined);
  // The withdrawal carries the approval's own payload: same amount, same
  // link, since the proposal it points at is the one that lives on.
  assert.deepEqual(followUp?.values?.["payload"], approval.payload);
  assert.equal(followUp?.values?.["proposalRevision"], 2);
  assert.equal(followUp?.values?.["requestedBy"], "usr_1");
});

test("re-price completion refuses unresolved approval delivery", async () => {
  const fake = createSequencedFakeDb([
    [{ id: "brn_2", boardId: "jrb_1" } as BountyRunRow],
    [row({ status: "approved", decisionDeliveryPolicy: "requested" })],
    [{ status: "uncertain" } as BountyWritebackRow],
  ]);
  const result = await createBountyProposalStore(fake.db).repriceForLease(
    "org_1",
    "lease_1",
    "bpr_1",
    1,
    { ...input, runId: "brn_2" },
  );
  assert.equal(result.status, "writeback-busy");
});

test("re-price does not queue a withdrawal when the site holds no write grant", async () => {
  const source = row({
    status: "approved",
    decisionDeliveryPolicy: "requested",
  });
  const repriced = row({ revision: 2, runId: "brn_2" });
  const approval = {
    kind: "approved",
    status: "done",
    jiraCommentId: "10001",
    payload: {
      complexity: "M",
      amountMinor: 200,
      currency: "USD",
      proposalUrl: "not a URL",
    },
  } as BountyWritebackRow;
  const fake = createSequencedFakeDb([
    [{ id: "brn_2", boardId: "jrb_1" } as BountyRunRow],
    [source],
    [approval],
    [repriced],
    [{ row: repriced, issueKey: "APP-1" }],
    // A site connected read-only: the token was issued without the write
    // scope, so nothing is posted and nothing is queued.
    [
      {
        scopes: "read:jira-work offline_access",
        resourceScopes: "read:jira-work",
      },
    ],
  ]);
  const result = await createBountyProposalStore(fake.db).repriceForLease(
    "org_1",
    "lease_1",
    "bpr_1",
    1,
    { ...input, runId: "brn_2" },
  );
  assert.equal(result.status, "repriced");
  if (result.status === "repriced") {
    assert.equal(result.writebackOperationId, undefined);
  }
});

test("re-price completion distinguishes a vanished source from a changed one", async () => {
  const missing = createSequencedFakeDb([
    [{ id: "brn_2", boardId: "jrb_1" } as BountyRunRow],
    [],
    [],
  ]);
  assert.equal(
    (
      await createBountyProposalStore(missing.db).repriceForLease(
        "org_1",
        "lease_1",
        "bpr_1",
        1,
        { ...input, runId: "brn_2" },
      )
    ).status,
    "not-found",
  );

  const changed = createSequencedFakeDb([
    [{ id: "brn_2", boardId: "jrb_1" } as BountyRunRow],
    [],
    [{ row: row({ revision: 2 }), issueKey: "APP-1" }],
  ]);
  assert.equal(
    (
      await createBountyProposalStore(changed.db).repriceForLease(
        "org_1",
        "lease_1",
        "bpr_1",
        1,
        { ...input, runId: "brn_2" },
      )
    ).status,
    "changed",
  );
});

test("legacy snapshot reads add XS without changing historical rates", async () => {
  const legacy = row();
  Reflect.deleteProperty(legacy.rateCard, "xsMinor");
  const fake = createFakeDb([{ row: legacy, issueKey: "APP-1" }]);
  const record = await createBountyProposalStore(fake.db).get("org_1", "bpr_1");
  assert.equal(record?.rateCard.xsMinor, 100);
  assert.equal(record?.rateCard.sMinor, 100);
  assert.equal(record?.rateCard.revision, 1);
});
