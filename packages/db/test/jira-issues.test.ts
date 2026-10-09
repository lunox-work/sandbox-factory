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
    stack: [],
    categories: [],
    createdBy: null,
    revision: 1,
    version: 1,
    approvedVersion: null,
    approvedBy: null,
    approvedAt: null,
    createdAt: new Date("2026-09-22T00:00:00Z"),
    updatedAt: new Date("2026-09-22T00:00:00Z"),
    ...overrides,
  };
}

const facts = {
  externalId: "10001",
  key: "APP-1",
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
    // Its overview's first version.
    [],
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
  // Jira's text is its overview's version 1, which nobody here wrote.
  assert.equal(fake.calls[3]?.values?.["version"], 1);
  assert.equal(fake.calls[3]?.values?.["bountyId"], "bty_new");
  // The pointer names the ticket as it was stored.
  const pointer = fake.calls[4];
  assert.equal(pointer?.values?.["bountyId"], "bty_new");
  assert.equal(pointer?.values?.["removedAt"], null);
  assert.equal(pointer?.ignoredConflict, true);
});

test("an issue with no summary is imported under its key", async () => {
  const fake = createSequencedFakeDb([
    [{ id: "jrb_1" }],
    [],
    [bountyRow()],
    [],
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
    [bountyRow({ revision: 4, version: 2 })],
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
  // New words: the overview's next version, and nothing else made.
  assert.equal(fake.calls[3]?.values?.["version"], 2);
  const inserts = fake.calls.filter(({ kind }) => kind === "insert");
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0]?.values?.["version"], 2);
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
    [],
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
  assert.equal(fake.calls[5]?.kind, "delete");
  assert.equal(fake.calls[5]?.filtered, true);
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

test("links a bounty written here to an issue, taking Jira's text", async () => {
  const fake = createSequencedFakeDb([
    [{ id: "jrb_1" }],
    [bountyRow({ origin: "manual", description: "Written here", revision: 2 })],
    // Not anyone's yet.
    [],
    // Whatever issue it followed before goes.
    [],
    [row({ bountyId: "bty_1" })],
    [{ id: "bty_1" }],
  ]);
  const linked = await createJiraIssueStore(fake.db).link(
    "org_1",
    "jrb_1",
    "bty_1",
    facts,
    content,
  );
  assert.equal(linked.ok, true);
  assert.equal(linked.ok && linked.pointer.bountyId, "bty_1");
  // The bounty, read under a lock, so the text is written over that read.
  assert.equal(fake.calls[1]?.lock, "update");
  assert.equal(fake.calls[3]?.kind, "delete");
  assert.equal(fake.calls[3]?.filtered, true);
  assert.equal(fake.calls[4]?.kind, "insert");
  assert.equal(fake.calls[4]?.values?.["bountyId"], "bty_1");
  assert.equal(fake.calls[4]?.values?.["externalId"], "10001");
  assert.equal(fake.calls[5]?.kind, "update");
  assert.equal(fake.calls[5]?.values?.["description"], "Steps");
  assert.equal(fake.calls[5]?.values?.["revision"], 3);
});

test("an issue already the bounty's is read again, not linked twice", async () => {
  const fake = createSequencedFakeDb([
    [{ id: "jrb_1" }],
    [bountyRow()],
    [{ bountyId: "bty_1" }],
    [row({ key: "APP-2" })],
  ]);
  const linked = await createJiraIssueStore(fake.db).link(
    "org_1",
    "jrb_1",
    "bty_1",
    { ...facts, key: "APP-2" },
    content,
  );
  assert.equal(linked.ok && linked.pointer.key, "APP-2");
  assert.equal(fake.calls[3]?.kind, "update");
  assert.equal(fake.calls.filter(({ kind }) => kind === "insert").length, 0);
  assert.equal(fake.calls.filter(({ kind }) => kind === "delete").length, 0);
});

test("an issue that is another bounty's is not linked", async () => {
  const fake = createSequencedFakeDb([
    [{ id: "jrb_1" }],
    [bountyRow()],
    [{ bountyId: "bty_other" }],
  ]);
  assert.deepEqual(
    await createJiraIssueStore(fake.db).link(
      "org_1",
      "jrb_1",
      "bty_1",
      facts,
      content,
    ),
    { ok: false, reason: "issue-linked", bountyId: "bty_other" },
  );
  assert.equal(fake.calls.length, 3);
});

test("a link that loses a race to an import names the bounty that won", async () => {
  const fake = createSequencedFakeDb([
    [{ id: "jrb_1" }],
    [bountyRow()],
    [],
    [],
    // The pointer insert met the import's row.
    [],
    [{ bountyId: "bty_won" }],
  ]);
  assert.deepEqual(
    await createJiraIssueStore(fake.db).link(
      "org_1",
      "jrb_1",
      "bty_1",
      facts,
      content,
    ),
    { ok: false, reason: "issue-linked", bountyId: "bty_won" },
  );
});

test("does not link through a board or a bounty the organization cannot see", async () => {
  const board = createSequencedFakeDb([[]]);
  assert.deepEqual(
    await createJiraIssueStore(board.db).link(
      "org_2",
      "jrb_1",
      "bty_1",
      facts,
      content,
    ),
    { ok: false, reason: "not-found" },
  );
  const bounty = createSequencedFakeDb([[{ id: "jrb_1" }], []]);
  assert.deepEqual(
    await createJiraIssueStore(bounty.db).link(
      "org_1",
      "jrb_1",
      "bty_9",
      facts,
      content,
    ),
    { ok: false, reason: "not-found" },
  );
  assert.equal(bounty.calls[1]?.filtered, true);
});

test("unlinks a bounty's issue through an owner filter", async () => {
  const linked = createFakeDb([{ id: "jri_1" }]);
  assert.equal(
    await createJiraIssueStore(linked.db).unlink("org_1", "bty_1"),
    true,
  );
  assert.equal(linked.calls[0]?.kind, "delete");
  assert.equal(linked.calls[0]?.filtered, true);
  const none = createFakeDb([]);
  assert.equal(
    await createJiraIssueStore(none.db).unlink("org_1", "bty_1"),
    false,
  );
});

test("names the bounty each of a board's issues is", async () => {
  const fake = createFakeDb([{ externalId: "10001", bountyId: "bty_1" }]);
  const found = await createJiraIssueStore(fake.db).bountiesFor(
    "org_1",
    "jrb_1",
    ["10001", "10002"],
  );
  assert.equal(found.get("10001"), "bty_1");
  assert.equal(found.has("10002"), false);
  assert.equal(fake.calls[0]?.filtered, true);
  // Nothing to ask about asks nothing.
  const empty = createFakeDb([]);
  assert.equal(
    (await createJiraIssueStore(empty.db).bountiesFor("org_1", "jrb_1", []))
      .size,
    0,
  );
  assert.equal(empty.calls.length, 0);
});
