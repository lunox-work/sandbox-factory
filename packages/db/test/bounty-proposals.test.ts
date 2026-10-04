import assert from "node:assert/strict";
import { test } from "node:test";

import { stepUp, type SpecDraft } from "sandbox-factory";

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
    bountyId: "bty_1",
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
    step: null,
    stepVersion: null,
    repoSnapshotId: null,
    decidedBy: null,
    decidedAt: null,
    decisionDeliveryPolicy: null,
    createdAt: new Date("2026-09-22T00:00:00Z"),
    updatedAt: new Date("2026-09-22T00:00:00Z"),
    ...overrides,
  };
}

/** The bounty's name as a proposal read joins it. */
const NAME = {
  bountyNumber: 1,
  bountyTitle: "Add login",
  jiraKey: "APP-1",
} as const;
/** The bounty a run writes for, with the board it was imported through. */
const BOUNTY = { ...NAME, boardId: "jrb_1" } as const;

const input = {
  runId: "brn_1",
  bountyId: "bty_1",
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
  const boardRun = { id: "brn_1", boardId: "jrb_1", bountyId: null };
  const fake = createSequencedFakeDb([[boardRun], [BOUNTY], [row()]]);
  const proposal = await createBountyProposalStore(fake.db).create(
    "org_1",
    input,
  );
  assert.equal(proposal?.issueKey, "APP-1");
  assert.equal(proposal?.title, "Add login");
  assert.equal(proposal?.bountyId, "bty_1");
  assert.match(String(fake.calls[2]?.values?.["id"]), /^bpr_/);
  assert.equal(fake.calls[2]?.values?.["bountyId"], "bty_1");

  const missing = createFakeDb([]);
  assert.equal(
    await createBountyProposalStore(missing.db).create("org_2", input),
    null,
  );
  // A run with no such bounty of the organization's writes nothing.
  const noBounty = createSequencedFakeDb([[boardRun], []]);
  assert.equal(
    await createBountyProposalStore(noBounty.db).create("org_1", input),
    null,
  );
  assert.equal(
    noBounty.calls.filter(({ kind }) => kind === "insert").length,
    0,
  );
});

test("a run writes only for its own bounty", async () => {
  const store = (responses: unknown[][]) =>
    createBountyProposalStore(createSequencedFakeDb(responses).db);
  // A board's run: only a bounty imported through that board.
  const otherBoard = { ...BOUNTY, boardId: "jrb_2" };
  assert.equal(
    await store([
      [{ id: "brn_1", boardId: "jrb_1", bountyId: null }],
      [otherBoard],
    ]).create("org_1", input),
    null,
  );
  // A bounty written here has no board, so no board's run writes for it.
  const handWritten = { ...BOUNTY, jiraKey: null, boardId: null };
  assert.equal(
    await store([
      [{ id: "brn_1", boardId: "jrb_1", bountyId: null }],
      [handWritten],
    ]).create("org_1", input),
    null,
  );
  // A bounty's run: that bounty, and no other.
  const oneBountyRun = { id: "brn_1", boardId: null, bountyId: "bty_2" };
  assert.equal(
    await store([[oneBountyRun], [handWritten]]).create("org_1", input),
    null,
  );
  const own = await store([
    [{ ...oneBountyRun, bountyId: "bty_1" }],
    [handWritten],
    [row()],
  ]).create("org_1", input);
  // Named by its own number while it has no Jira key.
  assert.equal(own?.issueKey, "B-1");
});

test("creates under a live lease and classifies fencing outcomes", async () => {
  const running = {
    id: "brn_1",
    boardId: "jrb_1",
    bountyId: null,
  } as BountyRunRow;
  const created = createSequencedFakeDb([[running], [BOUNTY], [row()]]);
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

  const duplicate = createSequencedFakeDb([[running], [BOUNTY], []]);
  assert.deepEqual(
    await createBountyProposalStore(duplicate.db).createForLease(
      "org_1",
      "lease",
      input,
    ),
    { status: "duplicate" },
  );
});

test("proposal writes keep only surviving owner-scoped snapshots", async () => {
  for (const available of [true, false]) {
    const snapshot = available ? [{ id: "rsn_1" }] : [];
    const snapshotId = available ? "rsn_1" : null;
    const created = createSequencedFakeDb([
      snapshot,
      [{ id: "brn_1", boardId: "jrb_1", bountyId: null } as BountyRunRow],
      [BOUNTY],
      [row({ repoSnapshotId: snapshotId })],
    ]);
    const result = await createBountyProposalStore(created.db).createForLease(
      "org_1",
      "lease",
      { ...input, repoSnapshotId: "rsn_1" },
    );
    assert.equal(result.status, "created");
    assert.equal(created.calls[0]?.filtered, true);
    assert.equal(created.calls[0]?.lock, "key share");
    assert.equal(created.calls[3]?.values?.["repoSnapshotId"], snapshotId);

    const direct = createSequencedFakeDb([
      [{ id: "brn_1", boardId: "jrb_1", bountyId: null }],
      [BOUNTY],
      snapshot,
      [row({ repoSnapshotId: snapshotId })],
    ]);
    await createBountyProposalStore(direct.db).create("org_1", {
      ...input,
      repoSnapshotId: "rsn_1",
    });
    assert.equal(direct.calls[2]?.lock, "key share");
    assert.equal(direct.calls[3]?.values?.["repoSnapshotId"], snapshotId);

    const repriced = row({
      revision: 2,
      runId: "brn_2",
      repoSnapshotId: snapshotId,
    });
    const reprice = createSequencedFakeDb([
      snapshot,
      [{ id: "brn_2", boardId: "jrb_1", bountyId: null } as BountyRunRow],
      [row()],
      [repriced],
      [{ row: repriced, ...NAME }],
    ]);
    const revised = await createBountyProposalStore(reprice.db).repriceForLease(
      "org_1",
      "lease",
      "bpr_1",
      1,
      { ...input, runId: "brn_2", repoSnapshotId: "rsn_1" },
    );
    assert.equal(revised.status, "repriced");
    assert.equal(reprice.calls[0]?.lock, "key share");
    assert.equal(reprice.calls[3]?.values?.["repoSnapshotId"], snapshotId);
  }
});

test("a proposal created with a spec stores it as revision 1 in the same transaction", async () => {
  const running = {
    id: "brn_1",
    boardId: "jrb_1",
    bountyId: null,
  } as BountyRunRow;
  const fake = createSequencedFakeDb([
    [running],
    [BOUNTY],
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

/** A weighed draft and the same draft grown by a heavy scenario. */
const weighed: SpecDraft = {
  ...spec.draft,
  scenarios: [{ ...spec.draft.scenarios[0], weight: "light" }],
};
const grown: SpecDraft = {
  ...weighed,
  scenarios: [
    ...weighed.scenarios,
    {
      id: "s2",
      kind: "recovery",
      title: "A failed export can be retried",
      steps: [{ keyword: "Then", text: "the export runs again" }],
      origin: "expansion",
      weight: "heavy",
    },
  ],
};

test("a proposal created with a step is priced at the step's size and keeps it", async () => {
  const step = stepUp("M", weighed, grown);
  assert.ok(step !== null);
  const running = {
    id: "brn_1",
    boardId: "jrb_1",
    bountyId: null,
  } as BountyRunRow;
  const stored = row({
    complexity: "M+",
    amountMinor: 250,
    step,
    stepVersion: step.stepVersion,
  });
  const fake = createSequencedFakeDb([[running], [BOUNTY], [stored]]);
  const result = await createBountyProposalStore(fake.db).createForLease(
    "org_1",
    "lease",
    { ...input, amountMinor: 250, step },
  );

  const values = fake.calls[2]?.values;
  // The model's size is kept apart from the size the step made of it.
  assert.equal(values?.["modelComplexity"], "M");
  assert.equal(values?.["complexity"], "M+");
  assert.equal(values?.["amountMinor"], 250);
  assert.deepEqual(values?.["step"], step);
  assert.equal(values?.["stepVersion"], "step-v1");
  assert.equal(result.status, "created");
  if (result.status === "created") {
    assert.deepEqual(result.proposal.step, step);
  }
});

test("a proposal created without a spec points at none", async () => {
  const running = {
    id: "brn_1",
    boardId: "jrb_1",
    bountyId: null,
  } as BountyRunRow;
  const fake = createSequencedFakeDb([[running], [BOUNTY], [row()]]);
  const result = await createBountyProposalStore(fake.db).createForLease(
    "org_1",
    "lease",
    input,
  );

  assert.equal(result.status, "created");
  assert.equal(fake.calls[2]?.values?.["specRevision"], null);
  assert.equal(fake.calls.filter(({ kind }) => kind === "insert").length, 1);
  // No step either: the size is the model's own.
  assert.equal(fake.calls[2]?.values?.["complexity"], "M");
  assert.equal(fake.calls[2]?.values?.["step"], null);
  assert.equal(fake.calls[2]?.values?.["stepVersion"], null);
  if (result.status === "created") assert.equal(result.proposal.step, null);
});

test("a bounty that already has a live proposal gets no spec", async () => {
  // The proposal insert lost to the live one, so there is nothing for a
  // spec to belong to.
  const running = {
    id: "brn_1",
    boardId: "jrb_1",
    bountyId: null,
  } as BountyRunRow;
  const fake = createSequencedFakeDb([[running], [BOUNTY], []]);
  assert.deepEqual(
    await createBountyProposalStore(fake.db).createForLease("org_1", "lease", {
      ...input,
      spec,
    }),
    { status: "duplicate" },
  );
  assert.equal(fake.calls.filter(({ kind }) => kind === "insert").length, 1);
});

test("gets and lists proposals with bounty display keys", async () => {
  const joined = {
    row: row(),
    ...NAME,
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
  const listed = await store.list("org_1", {
    boardId: "jrb_1",
    status: "proposed",
    cursor: {
      createdAt: "2026-09-23T00:00:00Z",
      id: "bpr_after",
    },
    limit: 500,
  });
  assert.equal(listed[0]?.id, "bpr_1");
  // The bounty's own title, as the platform holds it.
  assert.equal(listed[0]?.title, "Add login");
  // And why its own run picked it, from its own plan entry.
  assert.deepEqual(listed[0]?.categories, [
    {
      id: "holding-others-up",
      label: "Holding others up",
      reason: "Blocks 3 open tickets, unassigned",
    },
  ]);
  assert.equal(fake.calls[1]?.limited, 50);
});

test("a listed proposal has no reasons when its run planned none for it", async () => {
  for (const planned of [
    [],
    [{ externalIssueId: "10002", issueKey: "APP-2", summary: "Another" }],
    [{ externalIssueId: "10001", issueKey: "APP-1", summary: "" }],
  ]) {
    const fake = createFakeDb([
      { row: row(), ...NAME, externalId: "10001", planned },
    ]);
    const listed = await createBountyProposalStore(fake.db).list("org_1");
    // The title is the bounty's, whatever the plan said.
    assert.equal(listed[0]?.title, "Add login");
    // A plan from before categories, or a bounty picked by hand: none.
    assert.deepEqual(listed[0]?.categories, []);
  }
});

test("a repository's proposals are those its bounties are about", async () => {
  const fake = createFakeDb([
    {
      row: row(),
      ...NAME,
      externalId: "10001",
      issueBoardId: "jrb_1",
      planned: [],
    },
  ]);
  const listed = await createBountyProposalStore(fake.db).list("org_1", {
    repoId: "ghr_1",
  });
  assert.equal(listed[0]?.boardId, "jrb_1");
  assert.equal(fake.calls[0]?.filtered, true);
});

test("a bounty written here is matched to its plan entry by its own id", async () => {
  const fake = createFakeDb([
    {
      row: row(),
      ...NAME,
      jiraKey: null,
      externalId: null,
      planned: [
        {
          externalIssueId: "bty_1",
          issueKey: "B-1",
          summary: "Add login",
          bountyId: "bty_1",
          categories: [{ id: "paper-cuts", label: "Paper cuts", reason: "r" }],
        },
      ],
    },
  ]);
  const listed = await createBountyProposalStore(fake.db).list("org_1");
  assert.equal(listed[0]?.issueKey, "B-1");
  assert.deepEqual(
    listed[0]?.categories.map(({ id }) => id),
    ["paper-cuts"],
  );
});

test("category counts are per category and per proposal", async () => {
  const leftBehind = { id: "left-behind", label: "Left behind", reason: "r" };
  const paperCuts = { id: "paper-cuts", label: "Paper cuts", reason: "r" };
  const fake = createFakeDb([
    { categories: [leftBehind, paperCuts] },
    { categories: [leftBehind] },
    // A bounty someone picked by hand, and a plan from before categories.
    { categories: [] },
    { categories: null },
    // Stored JSON is not trusted to be well formed: a repeat counts once,
    // and an entry without a usable id counts nowhere.
    { categories: [paperCuts, paperCuts, { label: "No id" }, null, { id: 7 }] },
  ]);

  const result = await createBountyProposalStore(fake.db).categoryCounts(
    "org_1",
    { boardId: "jrb_1" },
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
    await createBountyProposalStore(fake.db).categoryCounts("org_1"),
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
    await createBountyProposalStore(fake.db).categoryCounts("org_1", {
      boardId: "jrb_1",
    }),
    { total: 2, uncategorized: 2, counts: {} },
  );
});

test("listing the uncategorized filters, and still pages", async () => {
  const fake = createFakeDb([
    { row: row(), ...NAME, externalId: "10001", planned: [] },
  ]);
  const listed = await createBountyProposalStore(fake.db).list("org_1", {
    boardId: "jrb_1",
    uncategorized: true,
    limit: 10,
  });

  assert.equal(listed[0]?.id, "bpr_1");
  assert.deepEqual(listed[0]?.categories, []);
  assert.equal(fake.calls[0]?.limited, 10);
  assert.equal(fake.calls[0]?.filtered, true);
});

test("listing by category still pages and still reads each row's reasons", async () => {
  const joined = {
    row: row(),
    ...NAME,
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
  const listed = await createBountyProposalStore(fake.db).list("org_1", {
    boardId: "jrb_1",
    category: "paper-cuts",
    limit: 10,
  });

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
  assert.deepEqual(await store.list("org_1"), []);
});

test("finds a bounty's live proposal, or none", async () => {
  const live = createFakeDb([{ id: "bpr_1" }]);
  assert.equal(
    await createBountyProposalStore(live.db).liveForBounty("org_1", "bty_1"),
    "bpr_1",
  );
  assert.equal(live.calls[0]?.filtered, true);
  assert.equal(
    await createBountyProposalStore(createFakeDb([]).db).liveForBounty(
      "org_1",
      "bty_2",
    ),
    null,
  );
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

test("finds each live bounty's proposal id, for search results", async () => {
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
    [{ row: approved, ...NAME }],
  ]);
  const result = await createBountyProposalStore(fake.db).approve(
    "org_1",
    "bpr_1",
    1,
    "usr_1",
    "off",
  );
  assert.equal(result.ok, true);

  const replay = createSequencedFakeDb([[], [{ row: approved, ...NAME }]]);
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
    [{ row: withdrawn, ...NAME }],
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
    [{ row: resized, ...NAME }],
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
  // Without a step the proposal is left with none.
  assert.equal(resizeFake.calls[0]?.values?.["complexity"], "L");
  assert.equal(resizeFake.calls[0]?.values?.["step"], null);
  assert.equal(resizeFake.calls[0]?.values?.["stepVersion"], null);
  assert.equal(resizeFake.calls[0]?.values?.["sizedBy"], "reviewer");
});

test("a resize with a step writes the rebased step and the size it comes to", async () => {
  const step = stepUp("L", weighed, grown);
  assert.ok(step !== null);
  const resized = row({
    revision: 2,
    complexity: "L+",
    amountMinor: 350,
    step,
    stepVersion: step.stepVersion,
  });
  const fake = createSequencedFakeDb([[resized], [{ row: resized, ...NAME }]]);
  const result = await createBountyProposalStore(fake.db).resize(
    "org_1",
    "bpr_1",
    1,
    "usr_1",
    "L+",
    350,
    "USD",
    step,
  );
  assert.equal(result.ok, true);
  const values = fake.calls[0]?.values;
  assert.equal(values?.["complexity"], "L+");
  assert.equal(values?.["amountMinor"], 350);
  assert.deepEqual(values?.["step"], step);
  assert.equal(values?.["stepVersion"], "step-v1");
  if (result.ok) assert.equal(result.proposal.step?.base, "L");
});

test("a missed mutation distinguishes not found from changed", async () => {
  const missing = createSequencedFakeDb([[], []]);
  assert.deepEqual(
    await createBountyProposalStore(missing.db).withdraw("org_2", "bpr_1", 1),
    { ok: false, reason: "not-found" },
  );

  const changed = row({ revision: 2 });
  const conflict = createSequencedFakeDb([[], [{ row: changed, ...NAME }]]);
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
  const invalidState = createSequencedFakeDb([[], [{ row: invalid, ...NAME }]]);
  const invalidResult = await createBountyProposalStore(
    invalidState.db,
  ).withdraw("org_1", "bpr_1", 1);
  assert.equal(invalidResult.ok, false);
  if (!invalidResult.ok) assert.equal(invalidResult.reason, "invalid-state");
});

test("remove deletes a proposed proposal by expected revision", async () => {
  const fake = createSequencedFakeDb([[{ row: row(), ...NAME }], [row()]]);
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
    [{ row: moved, ...NAME }],
    [],
    [{ row: moved, ...NAME }],
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
    [{ id: "brn_2", boardId: "jrb_1", bountyId: null } as BountyRunRow],
    [row()],
    [repriced],
    [{ row: repriced, ...NAME }],
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
  // A re-price sized without a step clears the one the proposal had.
  assert.equal(update?.["step"], null);
  assert.equal(update?.["stepVersion"], null);
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
    [{ id: "brn_2", boardId: "jrb_1", bountyId: null } as BountyRunRow],
    [row({ specRevision: 2 })],
    // The proposal's latest spec revision, read while its row is locked.
    [{ revision: 2 }],
    [repriced],
    [],
    [{ row: repriced, ...NAME }],
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

test("re-price writes the fresh step with the fresh size", async () => {
  const step = stepUp("S", weighed, weighed);
  assert.ok(step !== null);
  const repriced = row({
    revision: 2,
    runId: "brn_2",
    step,
    stepVersion: "step-v1",
  });
  const fake = createSequencedFakeDb([
    [{ id: "brn_2", boardId: "jrb_1", bountyId: null } as BountyRunRow],
    [row()],
    [repriced],
    [{ row: repriced, ...NAME }],
  ]);
  await createBountyProposalStore(fake.db).repriceForLease(
    "org_1",
    "lease_1",
    "bpr_1",
    1,
    {
      ...input,
      runId: "brn_2",
      sizing: { ...input.sizing, complexity: "S" },
      amountMinor: 100,
      step,
    },
  );
  const update = fake.calls[2]?.values;
  assert.equal(update?.["complexity"], "S");
  assert.deepEqual(update?.["step"], step);
  assert.equal(update?.["stepVersion"], "step-v1");
});

test("re-price starts a spec at revision 1 for a proposal that had none", async () => {
  const repriced = row({ revision: 2, runId: "brn_2", specRevision: 1 });
  const fake = createSequencedFakeDb([
    [{ id: "brn_2", boardId: "jrb_1", bountyId: null } as BountyRunRow],
    [row()],
    [],
    [repriced],
    [],
    [{ row: repriced, ...NAME }],
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
  // The earlier revisions were drafted from a bounty this size no longer
  // goes with, so the proposal stops pointing at any of them.
  const repriced = row({ revision: 2, runId: "brn_2" });
  const fake = createSequencedFakeDb([
    [{ id: "brn_2", boardId: "jrb_1", bountyId: null } as BountyRunRow],
    [row({ specRevision: 2 })],
    [repriced],
    [{ row: repriced, ...NAME }],
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
    [{ row: repriced, ...NAME }],
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
    [{ id: "brn_2", boardId: "jrb_1", bountyId: null } as BountyRunRow],
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
    [{ id: "brn_2", boardId: "jrb_1", bountyId: null } as BountyRunRow],
    [source],
    [approval],
    [repriced],
    [{ row: repriced, ...NAME }],
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
    [{ id: "brn_2", boardId: "jrb_1", bountyId: null } as BountyRunRow],
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
    [{ id: "brn_2", boardId: "jrb_1", bountyId: null } as BountyRunRow],
    [],
    [{ row: row({ revision: 2 }), ...NAME }],
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

test("a spec change writes the next revision and the stepped size, and nothing else", async () => {
  const sizedStep = stepUp("M", weighed, weighed);
  const step = stepUp("M", weighed, grown);
  assert.ok(sizedStep !== null && step !== null);
  const source = row({
    revision: 4,
    specRevision: 2,
    step: sizedStep,
    stepVersion: "step-v1",
  });
  const respecced = row({
    revision: 5,
    specRevision: 3,
    complexity: "M+",
    amountMinor: 250,
    step,
    stepVersion: "step-v1",
  });
  const fake = createSequencedFakeDb([
    [{ id: "brn_3", boardId: "jrb_1", startedBy: "user_1" } as BountyRunRow],
    [source],
    // The proposal's latest spec revision, read while its row is locked.
    [{ revision: 2 }],
    [respecced],
    [],
    [{ row: respecced, ...NAME }],
  ]);
  const result = await createBountyProposalStore(fake.db).respecForLease(
    "org_1",
    "lease_1",
    "bpr_1",
    4,
    {
      runId: "brn_3",
      fromSpecRevision: 2,
      spec: {
        ...spec,
        draft: grown,
        origin: "expand",
        instruction: "More recovery scenarios",
        promptVersion: "revise-v1",
      },
      step,
      amountMinor: 250,
      currency: "USD",
    },
  );

  assert.equal(result.status, "respecced");
  if (result.status === "respecced") {
    assert.equal(result.proposal.complexity, "M+");
    assert.equal(result.proposal.specRevision, 3);
    // What the outcome reports the change from.
    assert.equal(result.previousComplexity, "M");
  }
  assert.ok(fake.calls.slice(0, 4).every(({ filtered }) => filtered));
  // The size and its price move, with the spec pointer and the revision.
  assert.deepEqual(fake.calls[3]?.values, {
    complexity: "M+",
    step,
    stepVersion: "step-v1",
    amountMinor: 250,
    currency: "USD",
    specRevision: 3,
    revision: 5,
    updatedAt: fake.calls[3]?.values?.["updatedAt"],
  });
  // The revision records the change's run and the person who asked.
  const stored = fake.calls[4]?.values;
  assert.equal(fake.calls[4]?.kind, "insert");
  assert.equal(stored?.["revision"], 3);
  assert.equal(stored?.["runId"], "brn_3");
  assert.equal(stored?.["createdBy"], "user_1");
  assert.equal(stored?.["origin"], "expand");
  assert.equal(stored?.["instruction"], "More recovery scenarios");
});

test("a spec change is fenced by its lease and refused once the proposal moved", async () => {
  const step = stepUp("M", weighed, grown);
  assert.ok(step !== null);
  const change = {
    runId: "brn_3",
    fromSpecRevision: 2,
    spec: { ...spec, draft: grown, origin: "expand" },
    step,
    amountMinor: 250,
    currency: "USD",
  } as const;
  const store = (fake: ReturnType<typeof createSequencedFakeDb>) =>
    createBountyProposalStore(fake.db).respecForLease(
      "org_1",
      "lease_1",
      "bpr_1",
      4,
      change,
    );

  const lost = createSequencedFakeDb([[]]);
  assert.equal((await store(lost)).status, "lost-lease");

  const running = {
    id: "brn_3",
    boardId: "jrb_1",
    bountyId: null,
  } as BountyRunRow;
  const missing = createSequencedFakeDb([[running], [], []]);
  assert.equal((await store(missing)).status, "not-found");

  // Approved, revised or re-specced since: the lock finds nothing to hold.
  const changed = createSequencedFakeDb([
    [running],
    [],
    [{ row: row({ revision: 5, status: "approved" }), ...NAME }],
  ]);
  assert.equal((await store(changed)).status, "changed");
  assert.ok(!changed.calls.some(({ kind }) => kind === "insert"));
});

test("legacy snapshot reads add XS without changing historical rates", async () => {
  const legacy = row();
  Reflect.deleteProperty(legacy.rateCard, "xsMinor");
  const fake = createFakeDb([{ row: legacy, ...NAME }]);
  const record = await createBountyProposalStore(fake.db).get("org_1", "bpr_1");
  assert.equal(record?.rateCard.xsMinor, 100);
  assert.equal(record?.rateCard.sMinor, 100);
  assert.equal(record?.rateCard.revision, 1);
});

test("profile intent uses the surviving locked snapshot and frozen bounty metadata", async () => {
  const running = {
    id: "brn_1",
    boardId: "jrb_1",
    bountyId: null,
  } as BountyRunRow;
  for (const snapshot of [[], [{ id: "rsn_1" }]]) {
    const fake = createSequencedFakeDb([
      snapshot,
      [running],
      [BOUNTY],
      [
        row({
          specRevision: 1,
          repoSnapshotId: snapshot.length ? "rsn_1" : null,
        }),
      ],
      [],
      [],
    ]);
    const result = await createBountyProposalStore(fake.db).createForLease(
      "org_1",
      "lease",
      {
        ...input,
        spec,
        repoSnapshotId: "rsn_1",
        profileIntent: { issueType: "Bug", priority: "High" },
      },
    );
    assert.equal(result.status, "created");
    const intents = fake.calls.filter((call) =>
      String(call.values?.["id"]).startsWith("bpf_"),
    );
    assert.equal(intents.length, snapshot.length);
    if (snapshot.length) {
      assert.equal(intents[0]?.values?.["organizationId"], "org_1");
      assert.equal(intents[0]?.values?.["proposalId"], "bpr_1");
      assert.equal(intents[0]?.values?.["specRevision"], 1);
      assert.equal(intents[0]?.values?.["specHash"], spec.specHash);
      assert.equal(intents[0]?.values?.["snapshotId"], "rsn_1");
      assert.deepEqual(intents[0]?.values?.["bounty"], {
        issueType: "Bug",
        priority: "High",
      });
      assert.equal(intents[0]?.ignoredConflict, true);
    }
  }
  const disabled = createSequencedFakeDb([
    [{ id: "rsn_1" }],
    [running],
    [BOUNTY],
    [row({ specRevision: 1 })],
    [],
  ]);
  await createBountyProposalStore(disabled.db).createForLease(
    "org_1",
    "lease",
    { ...input, spec, repoSnapshotId: "rsn_1" },
  );
  assert.equal(
    disabled.calls.filter((call) =>
      String(call.values?.["id"]).startsWith("bpf_"),
    ).length,
    0,
  );
});
