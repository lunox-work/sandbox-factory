import assert from "node:assert/strict";
import { test } from "node:test";

import { getTableConfig } from "drizzle-orm/pg-core";
import type { GithubContext, JiraContext } from "sandbox-factory";

import { createBountyContextStore } from "../src/bounty-contexts.js";
import { bountyContext } from "../src/schema.js";
import { createFakeDb, createSequencedFakeDb } from "./fake-db.js";

const at = new Date("2026-10-07T00:00:00Z");

const jira: JiraContext = {
  key: "ACME-1",
  issueType: "Story",
  status: "To Do",
  statusCategory: "new",
  priority: "High",
  labels: [],
  components: [],
  fixVersions: [],
  parentKey: null,
  dueDate: null,
  storyPoints: 3,
  originalEstimateSeconds: null,
  remainingEstimateSeconds: null,
  votes: null,
  watchers: null,
  subtaskCount: 0,
  links: [],
  updated: "2026-10-06T00:00:00.000+0000",
};

const github: GithubContext = {
  fullName: "acme/app",
  branch: "main",
  commitSha: "abc",
  documents: [],
  omitted: 0,
};

function row(
  source: "jira" | "github",
  version: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    bountyId: "bty_1",
    source,
    version,
    ref: source === "jira" ? "ACME-1" : "acme/app",
    refId: source === "jira" ? "10001" : "repo_1",
    revision: "r1",
    content: source === "jira" ? jira : github,
    contentHash: `hash-${version}`,
    syncedBy: "user_1",
    createdAt: at,
    checkedAt: at,
    ...overrides,
  };
}

test("versions are kept per bounty and source, and go with their bounty", () => {
  const config = getTableConfig(bountyContext);
  assert.deepEqual(
    config.primaryKeys[0]?.columns.map(({ name }) => name),
    ["bounty_id", "source", "version"],
  );
  const toBounty = config.foreignKeys.find(
    (key) => key.reference().columns[0]?.name === "bounty_id",
  );
  assert.equal(toBounty?.onDelete, "cascade");
  assert.deepEqual(config.checks.map(({ name }) => name).sort(), [
    "bounty_context_source_check",
    "bounty_context_version_check",
  ]);
});

test("the latest version of each source is read through the bounty's owner", async () => {
  const fake = createSequencedFakeDb([
    [{ id: "bty_1" }],
    [
      { row: row("jira", 3) },
      { row: row("github", 1) },
      { row: row("jira", 2) },
    ],
  ]);
  const latest = await createBountyContextStore(fake.db).latest(
    "org_1",
    "bty_1",
  );
  assert.equal(latest?.jira?.version, 3);
  assert.equal(latest?.jira?.source, "jira");
  assert.deepEqual(latest?.jira?.content, jira);
  assert.equal(latest?.github?.version, 1);
  assert.equal(latest?.github?.checkedAt, at.toISOString());
  assert.ok(fake.calls.every(({ filtered }) => filtered === true));
});

test("a bounty with no context has none of either, and another owner's is not found", async () => {
  assert.deepEqual(
    await createBountyContextStore(
      createSequencedFakeDb([[{ id: "bty_1" }], []]).db,
    ).latest("org_1", "bty_1"),
    { jira: null, github: null },
  );
  assert.equal(
    await createBountyContextStore(createFakeDb([]).db).latest(
      "org_2",
      "bty_1",
    ),
    null,
  );
});

test("a sync that finds something new is the next version", async () => {
  const fake = createSequencedFakeDb([
    [{ id: "bty_1" }],
    [row("jira", 2)],
    [row("jira", 3, { contentHash: "new" })],
  ]);
  const result = await createBountyContextStore(fake.db).record(
    "org_1",
    "bty_1",
    {
      source: "jira",
      ref: "ACME-1",
      refId: "10001",
      revision: "r2",
      content: jira,
      contentHash: "new",
    },
    "user_1",
  );
  assert.ok(result.ok);
  assert.equal(result.changed, true);
  assert.equal(result.context.version, 3);
  // Locked first, so two syncs do not both take version 3.
  assert.equal(fake.calls[0]?.lock, "update");
  assert.equal(fake.calls[2]?.kind, "insert");
  assert.equal(fake.calls[2]?.values?.version, 3);
  assert.equal(fake.calls[2]?.values?.syncedBy, "user_1");
});

test("a source's first sync is its version 1", async () => {
  const fake = createSequencedFakeDb([
    [{ id: "bty_1" }],
    [],
    [row("github", 1)],
  ]);
  const result = await createBountyContextStore(fake.db).record(
    "org_1",
    "bty_1",
    {
      source: "github",
      ref: "acme/app",
      refId: "repo_1",
      revision: "abc",
      content: github,
      contentHash: "hash-1",
    },
    null,
  );
  assert.ok(result.ok);
  assert.equal(fake.calls[2]?.values?.version, 1);
});

test("a sync that finds what the latest version holds only moves its revision", async () => {
  const fake = createSequencedFakeDb([
    [{ id: "bty_1" }],
    [row("jira", 2)],
    [row("jira", 2, { revision: "r9" })],
  ]);
  const result = await createBountyContextStore(fake.db).record(
    "org_1",
    "bty_1",
    {
      source: "jira",
      ref: "ACME-1",
      refId: "10001",
      revision: "r9",
      content: jira,
      contentHash: "hash-2",
    },
    "user_2",
  );
  assert.ok(result.ok);
  assert.equal(result.changed, false);
  assert.equal(result.context.version, 2);
  assert.equal(result.context.revision, "r9");
  assert.equal(fake.calls[2]?.kind, "update");
});

test("the same content from another issue is a new version", async () => {
  const fake = createSequencedFakeDb([
    [{ id: "bty_1" }],
    [row("jira", 1)],
    [row("jira", 2, { refId: "10002" })],
  ]);
  const result = await createBountyContextStore(fake.db).record(
    "org_1",
    "bty_1",
    {
      source: "jira",
      ref: "ACME-2",
      refId: "10002",
      revision: "r1",
      content: jira,
      contentHash: "hash-1",
    },
    null,
  );
  assert.ok(result.ok);
  assert.equal(result.changed, true);
  assert.equal(fake.calls[2]?.kind, "insert");
});

test("a sync for another owner's bounty, or none, is not found", async () => {
  const result = await createBountyContextStore(
    createSequencedFakeDb([[]]).db,
  ).record(
    "org_2",
    "bty_1",
    {
      source: "github",
      ref: "acme/app",
      refId: "repo_1",
      revision: "abc",
      content: github,
      contentHash: "x",
    },
    null,
  );
  assert.deepEqual(result, { ok: false, reason: "not-found" });
});

test("an insert that returns nothing is an error, not a version", async () => {
  await assert.rejects(
    createBountyContextStore(
      createSequencedFakeDb([[{ id: "bty_1" }], [], []]).db,
    ).record(
      "org_1",
      "bty_1",
      {
        source: "github",
        ref: "acme/app",
        refId: "repo_1",
        revision: "abc",
        content: github,
        contentHash: "x",
      },
      null,
    ),
    /returned no row/,
  );
});
