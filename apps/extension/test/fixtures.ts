import { SANDBOX_COMMANDS, SANDBOX_TOOLCHAIN } from "sandbox-factory";

/** A valid `sandbox-task.json`, shared by the task and command tests. */
export const descriptor = {
  schemaVersion: 1,
  sandboxId: "sbx_1",
  versionId: "sbv_1",
  version: 2,
  title: "Fix the widget",
  specSummary: "Make it work.",
  complexity: "M",
  tags: ["typescript"],
  commands: SANDBOX_COMMANDS,
  toolchain: SANDBOX_TOOLCHAIN,
  editablePaths: ["src/app.ts"],
  publicTests: ["tests/public/interface.test.ts", "tests/public/spec.test.ts"],
  testSummary: [{ label: "public", count: 2 }],
};
