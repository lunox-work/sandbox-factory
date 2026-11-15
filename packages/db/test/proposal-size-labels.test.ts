import assert from "node:assert/strict";
import { test } from "node:test";

import { createProposalSizeLabelStore } from "../src/proposal-size-labels.js";
import { createFakeDb } from "./fake-db.js";

const at = new Date("2026-11-15T00:00:00.000Z");

test("a proposal's size labels are read back, owner-scoped and in order", async () => {
  const fake = createFakeDb([
    {
      id: "psl_1",
      organizationId: "org_1",
      proposalId: "bpr_1",
      proposalRevision: 2,
      specRevision: 1,
      modelComplexity: "S",
      modelConfidence: "medium",
      rubricComplexity: null,
      rubric: null,
      fromComplexity: "S",
      fromSizedBy: "model",
      fromAmountMinor: 100,
      complexity: "M",
      amountMinor: 200,
      currency: "USD",
      resizedBy: null,
      resizedAt: at,
    },
  ]);
  const labels = await createProposalSizeLabelStore(fake.db).list(
    "org_1",
    "bpr_1",
  );
  // The assessment itself stays in the table, for the dataset; the read
  // names its band.
  assert.deepEqual(labels, [
    {
      id: "psl_1",
      proposalId: "bpr_1",
      proposalRevision: 2,
      specRevision: 1,
      modelComplexity: "S",
      modelConfidence: "medium",
      rubricComplexity: null,
      fromComplexity: "S",
      fromSizedBy: "model",
      fromAmountMinor: 100,
      complexity: "M",
      amountMinor: 200,
      currency: "USD",
      resizedBy: null,
      resizedAt: at.toISOString(),
    },
  ]);
  assert.equal(fake.calls[0]?.filtered, true);
  assert.equal(fake.calls[0]?.ordered, true);
});
