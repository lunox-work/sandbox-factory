import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createWorkspaceSettingsStore,
  DEFAULT_WORKSPACE_SETTINGS,
} from "../src/workspace-settings.js";
import { createFakeDb, createSequencedFakeDb } from "./fake-db.js";

test("a workspace that has changed nothing has the defaults", async () => {
  const fake = createFakeDb([]);
  assert.deepEqual(
    await createWorkspaceSettingsStore(fake.db).get("org_1"),
    DEFAULT_WORKSPACE_SETTINGS,
  );
  assert.equal(DEFAULT_WORKSPACE_SETTINGS.prepareSandboxes, true);
  assert.equal(fake.calls[0]?.filtered, true);
});

test("a change keeps the rest and upserts the workspace's one row", async () => {
  const fake = createSequencedFakeDb([[{ prepareSandboxes: true }], []]);
  const updated = await createWorkspaceSettingsStore(fake.db).update(
    "org_1",
    { prepareSandboxes: false },
    "usr_1",
  );
  assert.deepEqual(updated, { prepareSandboxes: false });
  const insert = fake.calls.find((call) => call.kind === "insert");
  assert.deepEqual(insert?.values, {
    organizationId: "org_1",
    prepareSandboxes: false,
    updatedBy: "usr_1",
  });
  const { updatedAt, ...set } = insert?.conflictSet ?? {};
  assert.ok(updatedAt instanceof Date);
  assert.deepEqual(set, { prepareSandboxes: false, updatedBy: "usr_1" });
  // Changing nothing writes what is there.
  const same = createSequencedFakeDb([[{ prepareSandboxes: false }], []]);
  assert.deepEqual(
    await createWorkspaceSettingsStore(same.db).update("org_1", {}, "usr_1"),
    { prepareSandboxes: false },
  );
});
