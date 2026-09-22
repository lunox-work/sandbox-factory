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
    replacesProposalId: null,
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

test("proposal history is owner scoped and newest first", async () => {
  const newest = row({ id: "bpr_2" });
  const fake = createFakeDb([
    { row: newest, issueKey: "APP-1" },
    { row: row(), issueKey: "APP-1" },
  ]);
  const history = await createBountyProposalStore(fake.db).historyForIssue(
    "org_1",
    "jri_1",
  );
  assert.deepEqual(
    history.map(({ id }) => id),
    ["bpr_2", "bpr_1"],
  );
  assert.equal(fake.calls[0]?.filtered, true);
  assert.equal(fake.calls[0]?.ordered, true);
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

test("rejects and resizes through expected-revision filters", async () => {
  const changed = row({ revision: 2, status: "rejected" });
  const rejectFake = createSequencedFakeDb([
    [changed],
    [{ row: changed, issueKey: "APP-1" }],
  ]);
  assert.equal(
    (
      await createBountyProposalStore(rejectFake.db).reject(
        "org_1",
        "bpr_1",
        1,
        "usr_1",
      )
    ).ok,
    true,
  );

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
    await createBountyProposalStore(missing.db).reject(
      "org_2",
      "bpr_1",
      1,
      "usr_1",
    ),
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

  const invalid = row({ revision: 1, status: "rejected" });
  const invalidState = createSequencedFakeDb([
    [],
    [{ row: invalid, issueKey: "APP-1" }],
  ]);
  const invalidResult = await createBountyProposalStore(invalidState.db).reject(
    "org_1",
    "bpr_1",
    1,
    "usr_1",
  );
  assert.equal(invalidResult.ok, false);
  if (!invalidResult.ok) assert.equal(invalidResult.reason, "invalid-state");
});

test("re-price replacement supersedes and inserts in one transaction", async () => {
  const replacement = row({ id: "bpr_2", replacesProposalId: "bpr_1" });
  const fake = createSequencedFakeDb([
    [row({ status: "superseded", revision: 2 })],
    [replacement],
    [{ row: replacement, issueKey: "APP-1" }],
  ]);
  const result = await createBountyProposalStore(fake.db).replace(
    "org_1",
    "bpr_1",
    1,
    { ...input, runId: "brn_2" },
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.proposal.replacesProposalId, "bpr_1");
});

test("re-price replacement is fenced by its run lease and source revision", async () => {
  const replacement = row({
    id: "bpr_2",
    runId: "brn_2",
    replacesProposalId: "bpr_1",
  });
  const fake = createSequencedFakeDb([
    [{ id: "brn_2", boardId: "jrb_1" } as BountyRunRow],
    [row()],
    [row({ status: "superseded", revision: 2 })],
    [replacement],
    [{ row: replacement, issueKey: "APP-1" }],
  ]);
  const result = await createBountyProposalStore(fake.db).replaceForLease(
    "org_1",
    "lease_1",
    "bpr_1",
    1,
    { ...input, runId: "brn_2" },
  );
  assert.equal(result.status, "created");
  assert.ok(fake.calls.slice(0, 2).every(({ filtered }) => filtered));

  const lost = createFakeDb([]);
  assert.equal(
    (
      await createBountyProposalStore(lost.db).replaceForLease(
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

test("re-price queues a follow-up for a posted approval in the same transaction", async () => {
  const source = row({
    status: "approved",
    decisionDeliveryPolicy: "requested",
  });
  const replacement = row({
    id: "bpr_2",
    runId: "brn_2",
    replacesProposalId: "bpr_1",
  });
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
    [row({ status: "superseded", revision: 2 })],
    [replacement],
    [{ row: replacement, issueKey: "APP-1" }],
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

  const result = await createBountyProposalStore(fake.db).replaceForLease(
    "org_1",
    "lease_1",
    "bpr_1",
    1,
    { ...input, runId: "brn_2" },
  );

  assert.equal(result.status, "created");
  if (result.status === "created") {
    assert.match(result.writebackOperationId ?? "", /^bwo_/);
  }
  const followUp = fake.calls.find(
    (call) => call.kind === "insert" && call.values?.["kind"] === "superseded",
  );
  assert.match(
    String(
      (followUp?.values?.["payload"] as { replacementUrl?: string })
        .replacementUrl,
    ),
    /proposal=bpr_2/,
  );
});

test("re-price completion refuses unresolved approval delivery", async () => {
  const fake = createSequencedFakeDb([
    [{ id: "brn_2", boardId: "jrb_1" } as BountyRunRow],
    [row({ status: "approved", decisionDeliveryPolicy: "requested" })],
    [{ status: "uncertain" } as BountyWritebackRow],
  ]);
  const result = await createBountyProposalStore(fake.db).replaceForLease(
    "org_1",
    "lease_1",
    "bpr_1",
    1,
    { ...input, runId: "brn_2" },
  );
  assert.equal(result.status, "writeback-busy");
});

test("re-price does not queue a follow-up when the site holds no write grant", async () => {
  const source = row({
    status: "approved",
    decisionDeliveryPolicy: "requested",
  });
  const replacement = row({
    id: "bpr_2",
    runId: "brn_2",
    replacesProposalId: "bpr_1",
  });
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
    [row({ status: "superseded", revision: 2 })],
    [replacement],
    [{ row: replacement, issueKey: "APP-1" }],
    // A site connected read-only: the token was issued without the write
    // scope, so nothing is posted and nothing is queued.
    [
      {
        scopes: "read:jira-work offline_access",
        resourceScopes: "read:jira-work",
      },
    ],
  ]);
  const result = await createBountyProposalStore(fake.db).replaceForLease(
    "org_1",
    "lease_1",
    "bpr_1",
    1,
    { ...input, runId: "brn_2" },
  );
  assert.equal(result.status, "created");
  if (result.status === "created") {
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
      await createBountyProposalStore(missing.db).replaceForLease(
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
      await createBountyProposalStore(changed.db).replaceForLease(
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
