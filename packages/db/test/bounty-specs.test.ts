import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createBountySpecStore,
  insertSpecRevision,
  nextSpecRevision,
} from "../src/bounty-specs.js";
import type { BountySpecRow } from "../src/schema.js";
import { createFakeDb } from "./fake-db.js";

const draft = {
  feature: "CSV export",
  background: ["a signed-in analyst"],
  scenarios: [
    {
      id: "s1",
      kind: "happy",
      title: "The filtered table is exported",
      steps: [
        { keyword: "When", text: "they press Export" },
        { keyword: "Then", text: "a CSV file is downloaded" },
      ],
      origin: "draft",
    },
    {
      id: "s2",
      kind: "boundary",
      title: "An empty table exports only its header",
      steps: [{ keyword: "Then", text: "the file has one line" }],
      origin: "draft",
    },
  ],
  openQuestions: ["Is there a row limit?"],
  assumptions: [],
} as const;

function row(overrides: Partial<BountySpecRow> = {}): BountySpecRow {
  return {
    id: "bsp_1",
    organizationId: "org_1",
    proposalId: "bpr_1",
    revision: 1,
    specHash: "a".repeat(64),
    specHashVersion: 1,
    draft,
    origin: "draft",
    instruction: null,
    createdBy: null,
    runId: "brn_1",
    actualModel: "drafting-model",
    promptVersion: "draft-v1",
    createdAt: new Date("2026-09-30T00:00:00Z"),
    ...overrides,
  };
}

test("gets one revision, scoped to the owner, the proposal and the revision", async () => {
  const fake = createFakeDb([row()]);
  const spec = await createBountySpecStore(fake.db).get("org_1", "bpr_1", 1);

  assert.deepEqual(spec, {
    id: "bsp_1",
    organizationId: "org_1",
    proposalId: "bpr_1",
    revision: 1,
    specHash: "a".repeat(64),
    specHashVersion: 1,
    draft,
    origin: "draft",
    instruction: null,
    createdBy: null,
    runId: "brn_1",
    actualModel: "drafting-model",
    promptVersion: "draft-v1",
    createdAt: "2026-09-30T00:00:00.000Z",
  });
  assert.equal(fake.calls[0]?.kind, "select");
  assert.equal(fake.calls[0]?.filtered, true);
});

test("a revision nobody owns, or that does not exist, is null", async () => {
  const fake = createFakeDb([]);
  assert.equal(
    await createBountySpecStore(fake.db).get("org_2", "bpr_1", 1),
    null,
  );
});

test("lists a spec's revisions newest first, as counts rather than scenarios", async () => {
  const fake = createFakeDb([
    row({
      id: "bsp_2",
      revision: 2,
      origin: "expand",
      instruction: "More boundaries",
      createdBy: "user_1",
      createdAt: new Date("2026-09-30T01:00:00Z"),
    }),
    row({ draft: { ...draft, scenarios: [], openQuestions: [] } }),
  ]);
  const revisions = await createBountySpecStore(fake.db).listRevisions(
    "org_1",
    "bpr_1",
  );

  assert.deepEqual(revisions, [
    {
      revision: 2,
      origin: "expand",
      instruction: "More boundaries",
      scenarioCount: 2,
      openQuestionCount: 1,
      createdBy: "user_1",
      createdAt: "2026-09-30T01:00:00.000Z",
    },
    {
      revision: 1,
      origin: "draft",
      instruction: null,
      scenarioCount: 0,
      openQuestionCount: 0,
      createdBy: null,
      createdAt: "2026-09-30T00:00:00.000Z",
    },
  ]);
  assert.equal(fake.calls[0]?.filtered, true);
  assert.equal(fake.calls[0]?.ordered, true);
});

test("a proposal with no spec lists no revisions", async () => {
  const fake = createFakeDb([]);
  assert.deepEqual(
    await createBountySpecStore(fake.db).listRevisions("org_1", "bpr_1"),
    [],
  );
});

test("the next revision is one past the latest, or the first", async () => {
  const some = createFakeDb([{ revision: 4 }]);
  assert.equal(await nextSpecRevision(some.db, "org_1", "bpr_1"), 5);
  assert.equal(some.calls[0]?.filtered, true);
  assert.equal(some.calls[0]?.ordered, true);
  assert.equal(some.calls[0]?.limited, 1);

  const none = createFakeDb([]);
  assert.equal(await nextSpecRevision(none.db, "org_1", "bpr_1"), 1);
});

test("a revision is written for its owner, proposal and run", async () => {
  const fake = createFakeDb([]);
  await insertSpecRevision(
    fake.db,
    "org_1",
    { proposalId: "bpr_1", runId: "brn_1", revision: 2 },
    {
      specHash: "b".repeat(64),
      specHashVersion: 1,
      draft,
      origin: "draft",
      actualModel: "drafting-model",
      promptVersion: "draft-v1",
    },
  );

  const values = fake.calls[0]?.values;
  assert.equal(fake.calls[0]?.kind, "insert");
  assert.match(String(values?.["id"]), /^bsp_/);
  assert.deepEqual(
    { ...values, id: "bsp" },
    {
      id: "bsp",
      organizationId: "org_1",
      proposalId: "bpr_1",
      revision: 2,
      specHash: "b".repeat(64),
      specHashVersion: 1,
      draft,
      origin: "draft",
      instruction: null,
      createdBy: null,
      runId: "brn_1",
      actualModel: "drafting-model",
      promptVersion: "draft-v1",
    },
  );
});

test("a reviewer's revision records who asked and what, and a trim names no model", async () => {
  const fake = createFakeDb([]);
  await insertSpecRevision(
    fake.db,
    "org_1",
    { proposalId: "bpr_1", runId: "brn_2", revision: 3, createdBy: "user_1" },
    {
      specHash: "b".repeat(64),
      specHashVersion: 1,
      draft,
      origin: "trim",
      instruction: "Removed An empty table exports only its header",
      actualModel: null,
      promptVersion: null,
    },
  );
  const values = fake.calls[0]?.values;
  assert.equal(values?.["origin"], "trim");
  assert.equal(values?.["createdBy"], "user_1");
  assert.equal(
    values?.["instruction"],
    "Removed An empty table exports only its header",
  );
  assert.equal(values?.["actualModel"], null);
  assert.equal(values?.["promptVersion"], null);
});

test("the sized revision is the newest drafted one, read for its owner and proposal", async () => {
  const fake = createFakeDb([row({ revision: 2 })]);
  const sized = await createBountySpecStore(fake.db).sizedRevision(
    "org_1",
    "bpr_1",
    5,
  );
  assert.equal(sized?.revision, 2);
  assert.equal(sized?.origin, "draft");
  assert.equal(fake.calls[0]?.filtered, true);
  assert.equal(fake.calls[0]?.ordered, true);
  assert.equal(fake.calls[0]?.limited, 1);

  const none = createFakeDb([]);
  assert.equal(
    await createBountySpecStore(none.db).sizedRevision("org_1", "bpr_1", 5),
    null,
  );
});
