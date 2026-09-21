import assert from "node:assert/strict";
import { test } from "node:test";

import { createJiraIssueStore } from "../src/jira-issues.js";
import type { JiraIssueRow } from "../src/schema.js";
import { createFakeDb } from "./fake-db.js";

function row(overrides: Partial<JiraIssueRow> = {}): JiraIssueRow {
  return {
    id: "jri_1",
    organizationId: "org_1",
    boardId: "jrb_1",
    externalId: "10001",
    key: "APP-1",
    statusCategory: "new",
    remoteCreatedAt: new Date("2026-01-01T00:00:00Z"),
    remoteUpdatedAt: new Date("2026-09-22T00:00:00Z"),
    lastSeenAt: new Date("2026-09-22T00:00:00Z"),
    removedAt: null,
    ...overrides,
  };
}

test("gets an issue pointer through an owner filter", async () => {
  const fake = createFakeDb([row()]);
  const issue = await createJiraIssueStore(fake.db).get("org_1", "jri_1");
  assert.equal(issue?.key, "APP-1");
  assert.equal(fake.calls[0]?.filtered, true);
});

test("does not upsert into a board the organization cannot see", async () => {
  const fake = createFakeDb([]);
  const issue = await createJiraIssueStore(fake.db).upsert("org_2", "jrb_1", {
    externalId: "10001",
    key: "APP-1",
    statusCategory: "new",
    remoteCreatedAt: "2026-01-01T00:00:00Z",
    remoteUpdatedAt: "2026-09-22T00:00:00Z",
  });
  assert.equal(issue, null);
  assert.equal(fake.calls.filter(({ kind }) => kind === "insert").length, 0);
});

test("upserts a pointer and clears a previous removed marker", async () => {
  const fake = createFakeDb([row()]);
  const issue = await createJiraIssueStore(fake.db).upsert("org_1", "jrb_1", {
    externalId: "10001",
    key: "APP-2",
    statusCategory: "indeterminate",
    remoteCreatedAt: "2026-01-01T00:00:00Z",
    remoteUpdatedAt: "2026-09-22T00:00:00Z",
  });
  assert.equal(issue?.id, "jri_1");
  assert.equal(fake.calls[1]?.values?.["organizationId"], "org_1");
  assert.equal(fake.calls[1]?.conflictSet?.["removedAt"], null);
});

test("marks a pointer removed through an owner filter", async () => {
  const fake = createFakeDb([row()]);
  assert.equal(
    await createJiraIssueStore(fake.db).markRemoved("org_1", "jri_1"),
    true,
  );
  assert.equal(fake.calls[0]?.filtered, true);
});
