/**
 * The sandbox wire contract: owner-side DTOs for sandboxes, versions and
 * their private provenance, and the request bodies that create and change
 * them. Public DTOs for published versions arrive with publication (5D);
 * nothing here is served without membership.
 */

import {
  ALIAS_KINDS,
  ALIAS_RULES_MAX,
  DEPENDENCY_RESOLUTIONS,
  FIXTURE_LIMITS,
  PRICED_BOUNTY_COMPLEXITIES,
  SANDBOX_COMMANDS,
  SANDBOX_STATUSES,
  TASK_DESCRIPTOR_SCHEMA_VERSION,
} from "sandbox-factory";
import { z } from "zod";
import { entryPointSchema, sandboxFixtureSchema } from "./analysis.js";
import { specDraftSchema } from "./spec.js";

export const SANDBOX_TICKETS_MAX = 20;
export const ACCEPTANCE_TESTS_MAX = 50;
export const ACCEPTANCE_TEST_CHARS_MAX = 64 * 1024;
export const SANDBOX_TAGS_MAX = 10;

const oneLine = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value === value.trim() && !/[\r\n]/.test(value), {
      message: "Must be one trimmed line.",
    });

export const aliasRuleSchema = z.strictObject({
  before: z.string().min(1).max(200),
  after: z.string().min(1).max(200),
  kind: z.enum(ALIAS_KINDS),
  paths: z.array(entryPointSchema).max(50).default([]),
});
export const aliasRulesSchema = z.array(aliasRuleSchema).max(ALIAS_RULES_MAX);
export const dependencyChoicesSchema = z.record(
  z.string().min(1).max(214),
  z.enum(["runtime-mock", "approved-package"]),
);
export const acceptanceTestSchema = z.strictObject({
  path: entryPointSchema.refine(
    (path) => path.startsWith("tests/private/") && path.endsWith(".test.ts"),
    "Hidden tests live under tests/private/ and end in .test.ts.",
  ),
  text: z.string().max(ACCEPTANCE_TEST_CHARS_MAX),
  expectedBaseline: z.enum(["pass", "fail"]).default("pass"),
});
export const acceptanceTestsSchema = z
  .array(acceptanceTestSchema)
  .max(ACCEPTANCE_TESTS_MAX)
  .refine(
    (tests) => new Set(tests.map((test) => test.path)).size === tests.length,
    "Hidden test paths must be unique.",
  );

/** Fixtures written by hand, or replaced on a draft. */
export const fixturesInputSchema = z.strictObject({
  fixtures: z.array(sandboxFixtureSchema).max(FIXTURE_LIMITS.fixtures),
  scenario: z.string().min(1).max(FIXTURE_LIMITS.scenarioChars).nullable(),
});
/** What a version keeps: the fixtures run they came from, if any. */
export const versionFixturesSchema = fixturesInputSchema.extend({
  fixtureRunId: z.string().nullable(),
});

export const createSandboxSchema = z.strictObject({
  sourceRepoId: z.string().min(1),
  /** The tickets the sandbox is cut for. */
  ticketIds: z.array(z.string().min(1)).max(SANDBOX_TICKETS_MAX).default([]),
});

/** A draft version from a succeeded slice run on the sandbox's source. */
export const createSandboxVersionSchema = z.strictObject({
  sliceRunId: z.string().min(1),
  title: oneLine(120),
  specSummary: z.string().min(1).max(4_000),
  complexity: z.enum(PRICED_BOUNTY_COMPLEXITIES),
  tags: z.array(oneLine(32)).max(SANDBOX_TAGS_MAX).default([]),
  /** The approved proposal whose spec and price the version snapshots. */
  proposalId: z.string().min(1).optional(),
  /** Defaults to the proposal's current spec revision. */
  specRevision: z.number().int().positive().optional(),
  aliasRules: aliasRulesSchema.default([]),
  dependencyChoices: dependencyChoicesSchema.default({}),
  acceptanceTests: acceptanceTestsSchema.default([]),
  /** A succeeded fixtures run for the same slice run, copied into the transform. */
  fixtureRunId: z.string().min(1).optional(),
});

/** Changes to a draft's private transform. Refused once the version is frozen. */
export const updateSandboxVersionSchema = z
  .strictObject({
    title: oneLine(120).optional(),
    specSummary: z.string().min(1).max(4_000).optional(),
    complexity: z.enum(PRICED_BOUNTY_COMPLEXITIES).optional(),
    tags: z.array(oneLine(32)).max(SANDBOX_TAGS_MAX).optional(),
    aliasRules: aliasRulesSchema.optional(),
    dependencyChoices: dependencyChoicesSchema.optional(),
    acceptanceTests: acceptanceTestsSchema.optional(),
    /** Copy a fixtures run's set, or null to drop the version's fixtures. */
    fixtureRunId: z.string().min(1).nullable().optional(),
    /** Fixtures written by hand, replacing the version's. */
    fixtures: fixturesInputSchema.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, "Nothing to change.")
  .refine(
    (body) => body.fixtureRunId === undefined || body.fixtures === undefined,
    "Copy fixtures from a run or write them, not both.",
  );

export const sandboxDtoSchema = z.strictObject({
  id: z.string(),
  slug: z.string(),
  status: z.enum(SANDBOX_STATUSES),
  publicRepoId: z.string().nullable(),
  currentVersionId: z.string().nullable(),
  sourceRepoId: z.string(),
  ticketIds: z.array(z.string()),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const sandboxListSchema = z.object({
  sandboxes: z.array(sandboxDtoSchema),
});
export const sandboxResponseSchema = z.object({ sandbox: sandboxDtoSchema });

export const sandboxVersionDtoSchema = z.strictObject({
  id: z.string(),
  sandboxId: z.string(),
  version: z.number().int().positive(),
  title: z.string(),
  specSummary: z.string(),
  complexity: z.string(),
  tags: z.array(z.string()),
  testSummary: z.array(
    z.object({ label: z.string(), count: z.number().int() }),
  ),
  publicBaseCommitSha: z.string().nullable(),
  readme: z.string().nullable(),
  languages: z.record(z.string(), z.number()).nullable(),
  frozenAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});

export const resolvedDependencySchema = z.object({
  name: z.string(),
  kind: z.enum(["package", "module"]),
  version: z.string().nullable(),
  resolution: z.enum(DEPENDENCY_RESOLUTIONS),
  detail: z.string(),
});
export const scopeRecordSchema = z.object({
  editablePaths: z.array(z.string()),
  generatedPaths: z.array(z.string()),
  permittedOperations: z.array(z.enum(["edit", "add", "delete", "rename"])),
  dependencies: z.array(resolvedDependencySchema),
  blockers: z.array(z.object({ code: z.string(), detail: z.string() })),
});
const approvedTaskSelectionSchema = z.object({
  title: z.string(),
  summary: z.string(),
  spec: z
    .object({
      proposalId: z.string(),
      specRevision: z.number().int(),
      specHash: z.string(),
      draft: specDraftSchema,
    })
    .nullable(),
  pricing: z
    .object({
      proposalId: z.string(),
      proposalRevision: z.number().int(),
      complexity: z.string(),
      amountMinor: z.number().nullable(),
      currency: z.string().nullable(),
      status: z.string(),
      decidedAt: z.string().nullable(),
    })
    .nullable(),
  selectedBy: z.string(),
  selectedAt: z.string(),
});
/**
 * A version's frozen task. Version 2 names the sandbox's tickets; a version
 * frozen before tickets names Jira issue pointers, and is read as it was
 * written because its hash covers it.
 */
export const approvedTaskSnapshotSchema = z.discriminatedUnion(
  "schemaVersion",
  [
    approvedTaskSelectionSchema.extend({
      schemaVersion: z.literal(2),
      ticketIds: z.array(z.string()),
    }),
    approvedTaskSelectionSchema.extend({
      schemaVersion: z.literal(1),
      jiraIssueIds: z.array(z.string()),
    }),
  ],
);

/** Private provenance, for owners and admins only. */
export const sandboxVersionSourceDtoSchema = z.strictObject({
  sandboxVersionId: z.string(),
  sourceSnapshotId: z.string(),
  sourceCommitSha: z.string(),
  sliceRunId: z.string(),
  manifestSha256: z.string(),
  contractSha256: z.string(),
  transformConfigSha256: z.string(),
  approvedTaskSha256: z.string(),
  aliasRules: z.array(aliasRuleSchema),
  dependencyChoices: dependencyChoicesSchema,
  acceptanceTests: z.array(acceptanceTestSchema),
  fixtures: versionFixturesSchema.nullable(),
  approvedTask: approvedTaskSnapshotSchema,
  scope: scopeRecordSchema,
  harnessSha256: z.string().nullable(),
  toolchainDigest: z.string().nullable(),
  buildRunId: z.string().nullable(),
  roundTripRunId: z.string().nullable(),
  disclosureRunId: z.string().nullable(),
  approvedBy: z.string().nullable(),
  approvedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const sandboxVersionListSchema = z.object({
  versions: z.array(sandboxVersionDtoSchema),
});
export const sandboxVersionResponseSchema = z.object({
  version: sandboxVersionDtoSchema,
  /** Present for owners and admins; members see the version alone. */
  source: sandboxVersionSourceDtoSchema.optional(),
});
export const replayResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    sourceSnapshotId: z.string(),
    sourceCommitSha: z.string(),
    sliceRunId: z.string(),
    manifestSha256: z.string(),
    transformConfigSha256: z.string(),
    approvedTaskSha256: z.string(),
    aliasRules: z.array(aliasRuleSchema),
  }),
  z.object({
    ok: z.literal(false),
    reason: z.literal("source_unavailable"),
    detail: z.string(),
  }),
]);

export type AliasRuleInput = z.input<typeof aliasRuleSchema>;
export type CreateSandboxInput = z.input<typeof createSandboxSchema>;
export type CreateSandboxVersionInput = z.input<
  typeof createSandboxVersionSchema
>;
export type UpdateSandboxVersionInput = z.input<
  typeof updateSandboxVersionSchema
>;
export type SandboxDto = z.infer<typeof sandboxDtoSchema>;
export type SandboxVersionDto = z.infer<typeof sandboxVersionDtoSchema>;
export type SandboxVersionSourceDto = z.infer<
  typeof sandboxVersionSourceDtoSchema
>;
export type SandboxVersionResponseDto = z.infer<
  typeof sandboxVersionResponseSchema
>;
export type ReplayResponseDto = z.infer<typeof replayResponseSchema>;
export type VersionFixturesDto = z.infer<typeof versionFixturesSchema>;

/**
 * `sandbox-task.json`, as the extension reads it from a clone. Strict, and
 * the commands are literals: a repository file never decides what the
 * extension executes, it can only say the fixed commands exist.
 */
export const taskDescriptorSchema = z.strictObject({
  schemaVersion: z.literal(TASK_DESCRIPTOR_SCHEMA_VERSION),
  sandboxId: z.string().min(1),
  versionId: z.string().min(1),
  version: z.number().int().positive(),
  title: z.string().min(1).max(200),
  specSummary: z.string().max(4_000),
  complexity: z.string().min(1).max(10),
  tags: z.array(z.string().max(32)).max(SANDBOX_TAGS_MAX),
  commands: z.strictObject({
    install: z.literal(SANDBOX_COMMANDS.install),
    dev: z.literal(SANDBOX_COMMANDS.dev),
    build: z.literal(SANDBOX_COMMANDS.build),
    test: z.literal(SANDBOX_COMMANDS.test),
  }),
  toolchain: z.strictObject({
    node: z.string(),
    nodeRange: z.string(),
    npm: z.string(),
    typescript: z.string(),
    testRunner: z.literal("node:test"),
    supportedPlatforms: z.array(z.enum(["darwin", "linux", "win32"])),
  }),
  editablePaths: z.array(z.string()),
  publicTests: z.array(z.string()),
  testSummary: z.array(
    z.object({ label: z.string(), count: z.number().int() }),
  ),
});
export type TaskDescriptorDto = z.infer<typeof taskDescriptorSchema>;
