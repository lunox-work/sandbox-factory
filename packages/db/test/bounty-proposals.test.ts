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

test("gets and lists proposals with issue display keys", async () => {
  const joined = { row: row(), issueKey: "APP-1" };
  const fake = createFakeDb([joined]);
  const store = createBountyProposalStore(fake.db);
  assert.equal((await store.get("org_1", "bpr_1"))?.issueKey, "APP-1");
  assert.equal(
    (
      await store.listForBoard("org_1", "jrb_1", {
        status: "proposed",
        cursor: {
          createdAt: "2026-09-23T00:00:00Z",
          id: "bpr_after",
        },
        limit: 500,
      })
    )[0]?.id,
    "bpr_1",
  );
  assert.equal(fake.calls[1]?.limited, 50);
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
