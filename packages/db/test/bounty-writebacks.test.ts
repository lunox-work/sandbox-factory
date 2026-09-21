import assert from "node:assert/strict";
import { test } from "node:test";

import { createBountyWritebackStore } from "../src/bounty-writebacks.js";
import type { BountyProposalRow, BountyWritebackRow } from "../src/schema.js";
import { createFakeDb, createSequencedFakeDb } from "./fake-db.js";

function operation(
  overrides: Partial<BountyWritebackRow> = {},
): BountyWritebackRow {
  return {
    id: "bwo_1",
    organizationId: "org_1",
    proposalId: "bpr_1",
    proposalRevision: 2,
    kind: "approved",
    status: "pending",
    step: "comment",
    payload: {
      complexity: "M",
      amountMinor: 200,
      currency: "USD",
      proposalUrl: "https://app.test/proposal",
    },
    jiraCommentId: null,
    errorCode: null,
    leaseToken: null,
    leaseExpiresAt: null,
    commentAttemptedAt: null,
    requestedBy: "usr_1",
    createdAt: new Date("2026-09-22T00:00:00Z"),
    updatedAt: new Date("2026-09-22T00:00:00Z"),
    ...overrides,
  };
}

test("approval and its write intent commit through one transaction", async () => {
  const approved = { id: "bpr_1" } as BountyProposalRow;
  const fake = createSequencedFakeDb([[approved], [operation()]]);
  const result = await createBountyWritebackStore(fake.db).approveWithIntent(
    "org_1",
    "bpr_1",
    1,
    "usr_1",
    operation().payload,
  );
  assert.equal(result.status, "created");
  assert.equal(fake.calls[0]?.values?.["decisionDeliveryPolicy"], "requested");
  assert.equal(fake.calls[1]?.values?.["kind"], "approved");
});

test("a missed approval distinguishes missing and changed proposals", async () => {
  const missing = createSequencedFakeDb([[], []]);
  assert.equal(
    (
      await createBountyWritebackStore(missing.db).approveWithIntent(
        "org_1",
        "x",
        1,
        "u",
        operation().payload,
      )
    ).status,
    "not-found",
  );
  const changed = createSequencedFakeDb([
    [],
    [{ revision: 2, status: "approved" }],
  ]);
  assert.equal(
    (
      await createBountyWritebackStore(changed.db).approveWithIntent(
        "org_1",
        "bpr_1",
        1,
        "u",
        operation().payload,
      )
    ).status,
    "changed",
  );
  const invalid = createSequencedFakeDb([
    [],
    [{ revision: 1, status: "rejected" }],
  ]);
  assert.equal(
    (
      await createBountyWritebackStore(invalid.db).approveWithIntent(
        "org_1",
        "bpr_1",
        1,
        "u",
        operation().payload,
      )
    ).status,
    "invalid-state",
  );
});

test("withdrawal and its follow-up intent commit through one transaction", async () => {
  const rejected = { id: "bpr_1" } as BountyProposalRow;
  const followUp = operation({ kind: "rejected", proposalRevision: 3 });
  const fake = createSequencedFakeDb([[rejected], [followUp]]);
  const result = await createBountyWritebackStore(fake.db).rejectWithIntent(
    "org_1",
    "bpr_1",
    2,
    "usr_1",
    operation().payload,
  );
  assert.equal(result.status, "created");
  assert.equal(fake.calls[0]?.values?.["status"], "rejected");
  assert.equal(fake.calls[1]?.values?.["kind"], "rejected");
});

test("a missed withdrawal distinguishes missing and invalid state", async () => {
  const missing = createSequencedFakeDb([[], []]);
  assert.equal(
    (
      await createBountyWritebackStore(missing.db).rejectWithIntent(
        "org_1",
        "bpr_1",
        2,
        "usr_1",
        operation().payload,
      )
    ).status,
    "not-found",
  );
  const invalid = createSequencedFakeDb([
    [],
    [{ revision: 2, status: "rejected" }],
  ]);
  assert.equal(
    (
      await createBountyWritebackStore(invalid.db).rejectWithIntent(
        "org_1",
        "bpr_1",
        2,
        "usr_1",
        operation().payload,
      )
    ).status,
    "invalid-state",
  );
  const changed = createSequencedFakeDb([
    [],
    [{ revision: 3, status: "approved" }],
  ]);
  assert.equal(
    (
      await createBountyWritebackStore(changed.db).rejectWithIntent(
        "org_1",
        "bpr_1",
        2,
        "usr_1",
        operation().payload,
      )
    ).status,
    "changed",
  );
});

test("a lost writeback lease cannot be heartbeated", async () => {
  const store = createBountyWritebackStore(createFakeDb([]).db);
  assert.equal(
    await store.heartbeat("org_1", "bwo_1", "old", new Date()),
    false,
  );
});

test("lease-fenced writeback transitions report misses", async () => {
  const store = createBountyWritebackStore(createFakeDb([]).db);
  const now = new Date();
  assert.equal(await store.get("org_1", "missing"), null);
  assert.deepEqual(await store.listForProposal("org_1", "bpr_1"), []);
  assert.equal(await store.claim("org_1", "bwo_1", "lease", now), null);
  assert.equal(
    await store.recordComment("org_1", "bwo_1", "lease", "10", true),
    null,
  );
  assert.equal(await store.completeLabel("org_1", "bwo_1", "lease"), null);
  assert.equal(
    await store.fail("org_1", "bwo_1", "lease", "failed", "permission"),
    null,
  );
  assert.equal(await store.cancel("org_1", "bwo_1"), null);
  assert.equal(await store.adoptComment("org_1", "bwo_1", "10"), null);
});

test("writeback lifecycle methods are owner scoped and preserve comment state", async () => {
  const fake = createFakeDb([
    operation({ status: "running", leaseToken: "lease" }),
  ]);
  const store = createBountyWritebackStore(fake.db);
  assert.equal((await store.get("org_1", "bwo_1"))?.id, "bwo_1");
  assert.equal((await store.listForProposal("org_1", "bpr_1")).length, 1);
  assert.equal(
    (await store.claim("org_1", "bwo_1", "lease", new Date()))?.status,
    "running",
  );
  assert.equal(
    await store.heartbeat("org_1", "bwo_1", "lease", new Date()),
    true,
  );
  assert.equal(
    await store.markCommentAttempted("org_1", "bwo_1", "lease", new Date()),
    true,
  );
  assert.equal(
    (await store.recordComment("org_1", "bwo_1", "lease", "10", true))
      ?.jiraCommentId,
    null,
  );
  assert.equal(
    (await store.completeLabel("org_1", "bwo_1", "lease"))?.status,
    "running",
  );
  assert.equal(
    (await store.fail("org_1", "bwo_1", "lease", "uncertain", "jira_uncertain"))
      ?.id,
    "bwo_1",
  );
  assert.equal((await store.cancel("org_1", "bwo_1"))?.id, "bwo_1");
  assert.equal((await store.adoptComment("org_1", "bwo_1", "10"))?.id, "bwo_1");
  assert.ok(
    fake.calls.every((call) => call.kind === "select" || call.filtered),
  );
});

test("expired writebacks are discovered and classified without replay", async () => {
  const fake = createFakeDb([
    { organizationId: "org_1" },
    { organizationId: "org_1" },
  ]);
  const store = createBountyWritebackStore(fake.db);
  const now = new Date("2026-09-22T00:02:00Z");
  assert.deepEqual(await store.organizationsWithExpiredWritebacks(now), [
    "org_1",
  ]);
  assert.equal(await store.classifyExpired("org_1", now), 2);
});
