import assert from "node:assert/strict";
import { test } from "node:test";
import {
  updateWorkspaceSettingsSchema,
  workspaceSettingsSchema,
} from "../src/settings.js";

test("a workspace's settings are answered whole", () => {
  assert.deepEqual(workspaceSettingsSchema.parse({ prepareSandboxes: true }), {
    prepareSandboxes: true,
  });
  for (const body of [{}, { prepareSandboxes: "yes" }, null])
    assert.equal(workspaceSettingsSchema.safeParse(body).success, false);
});

test("a change names only settings there are, each optional", () => {
  assert.deepEqual(updateWorkspaceSettingsSchema.parse({}), {});
  assert.deepEqual(
    updateWorkspaceSettingsSchema.parse({ prepareSandboxes: false }),
    { prepareSandboxes: false },
  );
  for (const body of [
    { prepareSandboxes: 1 },
    { prepareSandboxes: null },
    { prepareSandboxes: true, other: 1 },
    "prepareSandboxes",
  ])
    assert.equal(updateWorkspaceSettingsSchema.safeParse(body).success, false);
});
