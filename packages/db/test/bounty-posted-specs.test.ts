import assert from "node:assert/strict";
import { test } from "node:test";

import { createBountyPostedSpecStore } from "../src/bounty-posted-specs.js";
import { createFakeDb } from "./fake-db.js";

const draft = {
  feature: "Invitations",
  background: [],
  scenarios: [],
  openQuestions: ["Which mailer?"],
  assumptions: [],
};

test("a bounty's posted spec is read in its workspace; none is null", async () => {
  const at = new Date("2026-11-15T00:00:00.000Z");
  const fake = createFakeDb([
    {
      bountyId: "bty_1",
      organizationId: "org_1",
      document: "Feature: Invitations",
      draft,
      source: "duediligence@0.5.1",
      specHash: "a".repeat(64),
      specHashVersion: 2,
      confirmedBy: "user_1",
      confirmedCredential: "oauth",
      createdBy: "user_1",
      createdAt: at,
    },
  ]);
  assert.deepEqual(
    await createBountyPostedSpecStore(fake.db).get("org_1", "bty_1"),
    {
      bountyId: "bty_1",
      organizationId: "org_1",
      document: "Feature: Invitations",
      draft,
      source: "duediligence@0.5.1",
      specHash: "a".repeat(64),
      specHashVersion: 2,
      confirmedBy: "user_1",
      confirmedCredential: "oauth",
      createdBy: "user_1",
      createdAt: at.toISOString(),
    },
  );
  assert.equal(fake.calls[0]?.filtered, true);
  assert.equal(fake.calls[0]?.limited, 1);
  assert.equal(
    await createBountyPostedSpecStore(createFakeDb([]).db).get(
      "org_1",
      "bty_2",
    ),
    null,
  );
});
