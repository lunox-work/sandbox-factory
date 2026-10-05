import assert from "node:assert/strict";
import { test } from "node:test";

import type { BountyContent } from "sandbox-factory";

import { createJiraIssueStore } from "../src/jira-issues.js";
import type { JiraIssueRow, BountyRow } from "../src/schema.js";
import { createFakeDb, createSequencedFakeDb } from "./fake-db.js";

function row(overrides: Partial<JiraIssueRow> = {}): JiraIssueRow {
  return {
    id: "jri_1",
    organizationId: "org_1",
    boardId: "jrb_1",
    externalId: "10001",
    key: "APP-1",
    bountyId: "bty_1",
    statusCategory: "new",
    remoteCreatedAt: new Date("2026-01-01T00:00:00Z"),
    remoteUpdatedAt: new Date("2026-09-22T00:00:00Z"),
    lastSeenAt: new Date("2026-09-22T00:00:00Z"),
    removedAt: null,
    ...overrides,
  };
}

function bountyRow(overrides: Partial<BountyRow> = {}): BountyRow {
  return {
    id: "bty_1",
    organizationId: "org_1",
    title: "Invitations are not sent",
    description: "Steps",
    components: [],
    inputTruncated: false,
    origin: "jira",
    repoId: null,
    stack: [],
    createdBy: null,
    revision: 1,
    createdAt: new Date("2026-09-22T00:00:00Z"),
    updatedAt: new Date("2026-09-22T00:00:00Z"),
    ...overrides,
  };
}

const facts = {
  externalId: "10001",
  key: "APP-1",
  statusCategory: "new",
  remoteCreatedAt: "2026-01-01T00:00:00Z",
  remoteUpdatedAt: "2026-09-22T00:00:00Z",
};

const content: BountyContent = {
  title: "Invitations are not sent",
  description: "Steps",
  components: [],
  inputTruncated: false,
};

test("gets an issue pointer through an owner filter", async () => {
  const fake = createFakeDb([row()]);
  const issue = await createJiraIssueStore(fake.db).get("org_1", "jri_1");
  assert.equal(issue?.key, "APP-1");
  assert.equal(issue?.bountyId, "bty_1");
  assert.equal(fake.calls[0]?.filtered, true);
});

test("does not import into a board the organization cannot see", async () => {
  const fake = createFakeDb([]);
  const issue = await createJiraIssueStore(fake.db).upsert(
    "org_2",
    "jrb_1",
    facts,
    content,
  );
  assert.equal(issue, null);
  assert.equal(fake.calls.filter(({ kind }) => kind === "insert").length, 0);
});

test("a first read imports the issue as a new ticket", async () => {
  const fake = createSequencedFakeDb([
    [{ id: "jrb_1" }],
    // Not seen before.
    [],
    [bountyRow({ id: "bty_new" })],
    [row({ bountyId: "bty_new" })],
  ]);
  const issue = await createJiraIssueStore(fake.db).upsert(
    "org_1",
    "jrb_1",
    facts,
    { ...content, components: ["Mailer"] },
  );
  assert.equal(issue?.bountyId, "bty_new");
  const created = fake.calls[2];
  assert.equal(created?.kind, "insert");
  assert.match(String(created?.values?.["id"]), /^bty_/);
  assert.equal(created?.values?.["origin"], "jira");
  assert.equal(created?.values?.["title"], "Invitations are not sent");
  assert.deepEqual(created?.values?.["components"], ["Mailer"]);
  // The pointer names the ticket as it was stored.
  const pointer = fake.calls[3];
  assert.equal(pointer?.values?.["bountyId"], "bty_new");
  assert.equal(pointer?.values?.["removedAt"], null);
  assert.equal(pointer?.ignoredConflict, true);
});

test("an issue with no summary is imported under its key", async () => {
  const fake = createSequencedFakeDb([
    [{ id: "jrb_1" }],
    [],
    [bountyRow()],
    [row()],
  ]);
  await createJiraIssueStore(fake.db).upsert("org_1", "jrb_1", facts, {
    ...content,
    title: "  ",
  });
  assert.equal(fake.calls[2]?.values?.["title"], "APP-1");
});

test("a later read refreshes the pointer and the ticket's text", async () => {
  const fake = createSequencedFakeDb([
    [{ id: "jrb_1" }],
    [row({ key: "APP-2" })],
    [bountyRow({ description: "Old steps", revision: 3 })],
    [{ id: "bty_1" }],
  ]);
  const issue = await createJiraIssueStore(fake.db).upsert(
    "org_1",
    "jrb_1",
    { ...facts, key: "APP-2" },
    content,
  );
  assert.equal(issue?.key, "APP-2");
  // The pointer, found and refreshed in one write.
  assert.equal(fake.calls[1]?.kind, "update");
  assert.equal(fake.calls[1]?.values?.["removedAt"], null);
  // The ticket, read under a lock and rewritten at its next revision.
  assert.equal(fake.calls[2]?.lock, "update");
  assert.equal(fake.calls[3]?.values?.["description"], "Steps");
  assert.equal(fake.calls[3]?.values?.["revision"], 4);
  assert.equal(fake.calls.filter(({ kind }) => kind === "insert").length, 0);
});

test("a later read that finds nothing new writes no ticket", async () => {
  const fake = createSequencedFakeDb([
    [{ id: "jrb_1" }],
    [row()],
    [bountyRow()],
  ]);
  await createJiraIssueStore(fake.db).upsert("org_1", "jrb_1", facts, content);
  assert.equal(fake.calls.length, 3);
});

test("an import that loses a race keeps the winner's ticket", async () => {
  const fake = createSequencedFakeDb([
    [{ id: "jrb_1" }],
    [],
    [bountyRow({ id: "bty_lost" })],
    // The pointer insert met the other run's row.
    [],
    // So the ticket just made is deleted, and the winner's refreshed.
    [],
    [row({ bountyId: "bty_won" })],
    [bountyRow({ id: "bty_won" })],
  ]);
  const issue = await createJiraIssueStore(fake.db).upsert(
    "org_1",
    "jrb_1",
    facts,
    content,
  );
  assert.equal(issue?.bountyId, "bty_won");
  assert.equal(fake.calls[4]?.kind, "delete");
  assert.equal(fake.calls[4]?.filtered, true);
});

test("an import whose race leaves no pointer imports nothing", async () => {
  const fake = createSequencedFakeDb([
    [{ id: "jrb_1" }],
    [],
    [bountyRow({ id: "bty_lost" })],
    [],
    [],
    [],
  ]);
  assert.equal(
    await createJiraIssueStore(fake.db).upsert(
      "org_1",
      "jrb_1",
      facts,
      content,
    ),
    null,
  );
});

test("marks a pointer removed through an owner filter", async () => {
  const fake = createFakeDb([row()]);
  assert.equal(
    await createJiraIssueStore(fake.db).markRemoved("org_1", "jri_1"),
    true,
  );
  assert.equal(fake.calls[0]?.filtered, true);
});

test("marks an issue removed by Jira's id, when it was imported", async () => {
  const seen = createFakeDb([row()]);
  assert.equal(
    await createJiraIssueStore(seen.db).markRemovedByExternal(
      "org_1",
      "jrb_1",
      "10001",
    ),
    true,
  );
  assert.ok(seen.calls[0]?.values?.["removedAt"] instanceof Date);
  const unseen = createFakeDb([]);
  assert.equal(
    await createJiraIssueStore(unseen.db).markRemovedByExternal(
      "org_1",
      "jrb_1",
      "10009",
    ),
    false,
  );
});
