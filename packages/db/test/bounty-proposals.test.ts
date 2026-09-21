import assert from "node:assert/strict";
import { test } from "node:test";

import { createBountyProposalStore } from "../src/bounty-proposals.js";
import type { BountyProposalRow } from "../src/schema.js";
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

test("gets and lists proposals with issue display keys", async () => {
  const joined = { row: row(), issueKey: "APP-1" };
  const fake = createFakeDb([joined]);
  const store = createBountyProposalStore(fake.db);
  assert.equal((await store.get("org_1", "bpr_1"))?.issueKey, "APP-1");
  assert.equal(
    (
      await store.listForBoard("org_1", "jrb_1", {
        status: "proposed",
        cursor: "2026-09-23T00:00:00Z",
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
