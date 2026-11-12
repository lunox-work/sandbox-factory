import assert from "node:assert/strict";
import { test } from "node:test";

import { createDecisionConfirmationStore } from "../src/decision-confirmations.js";
import { createFakeDb, createSequencedFakeDb } from "./fake-db.js";

const at = new Date("2026-11-12T00:00:00.000Z");
const row = {
  id: "dcf_1",
  organizationId: "org_1",
  proposalId: "bpr_1",
  specRevision: 2,
  decisionsSha256: "a".repeat(64),
  confirmedBy: "user_1",
  confirmedAt: at,
};
const stored = {
  id: "dcf_1",
  proposalId: "bpr_1",
  specRevision: 2,
  decisionsSha256: "a".repeat(64),
  confirmedBy: "user_1",
  confirmedAt: at.toISOString(),
};
const input = {
  organizationId: "org_1",
  proposalId: "bpr_1",
  specRevision: 2,
  decisionsSha256: "a".repeat(64),
  confirmedBy: "user_1",
};

test("a confirmation is read only for the decisions it names, within the workspace", async () => {
  const fake = createFakeDb([row]);
  const store = createDecisionConfirmationStore(fake.db);
  assert.deepEqual(
    await store.get("org_1", "bpr_1", 2, "a".repeat(64)),
    stored,
  );
  assert.equal(fake.calls[0]?.filtered, true);
  assert.equal(fake.calls[0]?.limited, 1);
  assert.equal(await store.get("org_1", "bpr_1", 2, "b".repeat(64)), null);
  assert.equal(
    await createDecisionConfirmationStore(createFakeDb([]).db).get(
      "org_1",
      "bpr_1",
      2,
      "a".repeat(64),
    ),
    null,
  );
});

test("confirming records once per revision; a second confirmation keeps the first", async () => {
  const fresh = createFakeDb([row]);
  assert.deepEqual(
    await createDecisionConfirmationStore(fresh.db).confirm(input),
    stored,
  );
  assert.equal(fresh.calls[0]?.kind, "insert");
  assert.deepEqual(fresh.calls[0]?.conflictTarget, [
    "proposal_id",
    "spec_revision",
  ]);
  // The insert met the unique key: the one already there answers.
  const again = createSequencedFakeDb([[], [row]]);
  assert.deepEqual(
    await createDecisionConfirmationStore(again.db).confirm(input),
    stored,
  );
  // And names other decisions: none.
  const other = createSequencedFakeDb([
    [],
    [{ ...row, decisionsSha256: "b".repeat(64) }],
  ]);
  assert.equal(
    await createDecisionConfirmationStore(other.db).confirm(input),
    null,
  );
  const gone = createSequencedFakeDb([[], []]);
  assert.equal(
    await createDecisionConfirmationStore(gone.db).confirm(input),
    null,
  );
});
