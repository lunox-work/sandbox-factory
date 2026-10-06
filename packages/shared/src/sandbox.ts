/**
 * The sandbox wire contract: owner-side DTOs for sandboxes, versions and
 * their private provenance, and the request bodies that create and change
 * them. Public DTOs for published versions arrive with publication (5D);
 * nothing here is served without membership.
 */

import {
  ALIAS_KINDS,
  ANALYSIS_STATUSES,
  ALIAS_RULES_MAX,
  APPROVED_TASK_SCHEMA_VERSION,
  DEPENDENCY_RESOLUTIONS,
  FIXTURE_LIMITS,
  PRICED_BOUNTY_COMPLEXITIES,
  SANDBOX_COMMANDS,
  SANDBOX_STATUSES,
  TASK_DESCRIPTOR_SCHEMA_VERSION,
} from "sandbox-factory";
import { z } from "zod";
import {
  analysisRunDtoSchema,
  entryPointSchema,
  sandboxFixtureSchema,
} from "./analysis.js";
import { specDraftSchema } from "./spec.js";

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

/**
 * A bounty's sandbox. One per bounty. The repository it is cut from is
 * optional: a sandbox without one has its versions generated from the
 * bounty instead, until one is linked.
 */
export const createSandboxSchema = z.strictObject({
  bountyId: z.string().min(1),
  sourceRepoId: z.string().min(1).nullable().default(null),
});

/**
 * The repository a sandbox made without one is cut from. Linked once: the
 * versions sliced from it are bound to it.
 */
export const linkSandboxSourceSchema = z.strictObject({
  sourceRepoId: z.string().min(1),
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
  /** When its publication lapses; null while it has none. */
  expiresAt: z.iso.datetime().nullable(),
  bountyId: z.string(),
  /** Null for a sandbox with no repository to slice from. */
  sourceRepoId: z.string().nullable(),
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
 * A version's frozen task. Version 3 names the bounty the sandbox belongs
 * to. Older versions are read as they were written, because their hash
 * covers them: version 2 names the tickets, as bounties were then called,
 * and version 1 names Jira issue pointers.
 */
export const approvedTaskSnapshotSchema = z.discriminatedUnion(
  "schemaVersion",
  [
    approvedTaskSelectionSchema.extend({
      schemaVersion: z.literal(APPROVED_TASK_SCHEMA_VERSION),
      bountyId: z.string(),
    }),
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

/**
 * Private provenance, for owners and admins only. A sliced version names
 * its snapshot, commit, slice run, manifest and contract; a generated one
 * names the run that wrote its starter instead.
 */
export const sandboxVersionSourceDtoSchema = z.strictObject({
  sandboxVersionId: z.string(),
  origin: z.enum(["slice", "starter"]),
  sourceSnapshotId: z.string().nullable(),
  sourceCommitSha: z.string().nullable(),
  sliceRunId: z.string().nullable(),
  manifestSha256: z.string().nullable(),
  contractSha256: z.string().nullable(),
  starterRunId: z.string().nullable(),
  starterSha256: z.string().nullable(),
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
/**
 * `POST .../sandboxes/:id/starter`: a new draft version, and the run that
 * writes its starter from the bounty and builds it.
 */
export const generateStarterResponseSchema = z.object({
  version: sandboxVersionDtoSchema,
  source: sandboxVersionSourceDtoSchema,
  run: analysisRunDtoSchema,
});
/**
 * `POST .../sandboxes/versions/:id/publish` body: when the publication
 * lapses. Every publication is made until a date, which must be ahead.
 */
export const publishVersionSchema = z.strictObject({
  expiresAt: z.iso.datetime(),
});
export type PublishVersionInput = z.infer<typeof publishVersionSchema>;
/**
 * `POST .../sandboxes/versions/:id/publish`: the sandbox, now published at
 * that version, and the version, frozen and approved.
 */
export const publishVersionResponseSchema = z.object({
  sandbox: sandboxDtoSchema,
  version: sandboxVersionDtoSchema,
  source: sandboxVersionSourceDtoSchema,
});
export type PublishVersionResponseDto = z.infer<
  typeof publishVersionResponseSchema
>;
export const sandboxVersionResponseSchema = z.object({
  version: sandboxVersionDtoSchema,
  /** Present for owners and admins; members see the version alone. */
  source: sandboxVersionSourceDtoSchema.optional(),
});
/**
 * The largest file `.../versions/:id/files/content` answers with as text.
 * A larger one is still listed; its bytes stay in storage.
 */
export const SANDBOX_FILE_TEXT_MAX_BYTES = 1_000_000;
/** One file a version's build wrote: under `project/`, `private/` or beside them. */
export const sandboxFileDtoSchema = z.strictObject({
  path: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
/**
 * `GET .../sandboxes/versions/:id/files`: what the version's build run wrote
 * to private storage. `run` is null before a build was queued, and `files`
 * is empty until the run commits.
 */
export const sandboxFileListSchema = z.object({
  run: z
    .object({ id: z.string(), status: z.enum(ANALYSIS_STATUSES) })
    .nullable(),
  files: z.array(sandboxFileDtoSchema),
});
/**
 * `GET .../sandboxes/versions/:id/files/content?path=`: one file as text.
 * `text` is null when it is not UTF-8 text or is over
 * `SANDBOX_FILE_TEXT_MAX_BYTES`, which `omitted` says.
 */
export const sandboxFileContentSchema = z.object({
  path: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  text: z.string().nullable(),
  omitted: z.enum(["binary", "too_large"]).nullable(),
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
export type LinkSandboxSourceInput = z.input<typeof linkSandboxSourceSchema>;
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
export type SandboxFileDto = z.infer<typeof sandboxFileDtoSchema>;
export type SandboxFileListDto = z.infer<typeof sandboxFileListSchema>;
export type SandboxFileContentDto = z.infer<typeof sandboxFileContentSchema>;
export type GenerateStarterResponseDto = z.infer<
  typeof generateStarterResponseSchema
>;
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
