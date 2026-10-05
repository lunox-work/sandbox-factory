import {
  ANALYSIS_STATUSES,
  ANALYSIS_ERROR_CODES,
  ARTIFACT_KINDS,
  FIXTURE_CALLS,
  FIXTURE_LIMITS,
  SCOPE_LIMITS,
  SEAM_KINDS,
  SLICE_BLOCKER_CODES,
  SLICE_BUDGET_DEFAULTS,
  STARTER_ALIAS_KINDS,
  STARTER_LIMITS,
  STARTER_SET_SCHEMA_VERSION,
} from "sandbox-factory";
import { z } from "zod";

export const analysisParamsSchema = z.strictObject({
  deadlineMinutes: z.number().int().min(1).max(120).default(30),
});
export const enqueueAnalysisSchema = z.strictObject({
  tool: z.literal("graphify"),
  snapshotId: z.string().min(1).optional(),
  params: analysisParamsSchema.default({ deadlineMinutes: 30 }),
});

/** A repository-relative path: no root, no `..`, no backslashes or NULs. */
export const entryPointSchema = z
  .string()
  .min(1)
  .max(1_000)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !/[\\\0]/.test(path) &&
      !path
        .split("/")
        .some((part) => part === "" || part === ".." || part === "."),
    "Expected a repository-relative path.",
  );
export const SLICE_ENTRY_POINTS_MAX = 50;
/** The budget's bounds, shared by the schema and the console's inputs. */
export const SLICE_BUDGET_LIMITS = {
  maxFiles: { min: 1, max: 200 },
  maxDepth: { min: 0, max: 10 },
} as const;
export const sliceBudgetSchema = z.strictObject({
  maxFiles: z
    .number()
    .int()
    .min(SLICE_BUDGET_LIMITS.maxFiles.min)
    .max(SLICE_BUDGET_LIMITS.maxFiles.max)
    .default(SLICE_BUDGET_DEFAULTS.maxFiles),
  maxDepth: z
    .number()
    .int()
    .min(SLICE_BUDGET_LIMITS.maxDepth.min)
    .max(SLICE_BUDGET_LIMITS.maxDepth.max)
    .default(SLICE_BUDGET_DEFAULTS.maxDepth),
});
/** Stored slice parameters: canonical, so equal inputs share one run. */
export const sliceParamsSchema = z.strictObject({
  deadlineMinutes: z.number().int().min(1).max(120).default(30),
  graphRunId: z.string().min(1),
  entryPoints: z
    .array(entryPointSchema)
    .min(1)
    .max(SLICE_ENTRY_POINTS_MAX)
    .refine(
      (points) => new Set(points).size === points.length,
      "Entry points must be unique.",
    )
    .refine(
      (points) =>
        points.every(
          (point, index) => index === 0 || (points[index - 1] ?? "") < point,
        ),
      "Entry points must be sorted.",
    ),
  budget: sliceBudgetSchema,
  includeInferred: z.boolean().default(false),
});
/** `POST .../repositories/:id/slices`. The graph run is chosen by the API. */
export const enqueueSliceSchema = z.strictObject({
  snapshotId: z.string().min(1).optional(),
  entryPoints: z.array(entryPointSchema).min(1).max(SLICE_ENTRY_POINTS_MAX),
  budget: sliceBudgetSchema.default(SLICE_BUDGET_DEFAULTS),
  includeInferred: z.boolean().default(false),
  deadlineMinutes: z.number().int().min(1).max(120).default(30),
});

/** The bounty an agent run works for; stored, so the cache key names the spec revision. */
const agentTaskFields = {
  deadlineMinutes: z.number().int().min(1).max(120).default(30),
  proposalId: z.string().min(1),
  specRevision: z.number().int().positive(),
  specHash: z.string().min(1),
};
export const scopeParamsSchema = z.strictObject({
  ...agentTaskFields,
  agent: z.literal("scope"),
  graphRunId: z.string().min(1),
});
export const fixturesParamsSchema = z.strictObject({
  ...agentTaskFields,
  agent: z.literal("fixtures"),
  sliceRunId: z.string().min(1),
});
/**
 * `POST .../repositories/:id/scope` and `POST .../runs/:id/fixtures`. The
 * spec revision defaults to the proposal's current one; the graph run is
 * chosen by the API.
 */
/**
 * The deadline the console's own graph runs carry. It is part of their
 * cache key, so every caller that wants the shared graph asks with this.
 */
export const GRAPH_DEADLINE_MINUTES = 30;

/** An agent takes many model turns; its runs get longer than a tool's 30 minutes. */
export const AGENT_DEADLINE_MINUTES = 60;
export const enqueueScopeSchema = z.strictObject({
  proposalId: z.string().min(1),
  specRevision: z.number().int().positive().optional(),
  snapshotId: z.string().min(1).optional(),
  deadlineMinutes: z
    .number()
    .int()
    .min(1)
    .max(120)
    .default(AGENT_DEADLINE_MINUTES),
});
export const enqueueFixturesSchema = z.strictObject({
  proposalId: z.string().min(1),
  specRevision: z.number().int().positive().optional(),
  deadlineMinutes: z
    .number()
    .int()
    .min(1)
    .max(120)
    .default(AGENT_DEADLINE_MINUTES),
});

const runCommon = {
  id: z.string(),
  /** Null for a run with no repository: a starter's. */
  snapshotId: z.string().nullable(),
  repoId: z.string().nullable(),
  toolVersion: z.string(),
  status: z.enum(ANALYSIS_STATUSES),
  attempt: z.number().int().nonnegative(),
  maxAttempts: z.number().int().nonnegative(),
  errorCode: z.enum(ANALYSIS_ERROR_CODES).nullable(),
  errorDetail: z.string().nullable(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  deadlineAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
};
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
/** Stored build parameters: the version and every hash the output binds to. */
export const sandboxBuildParamsSchema = z.strictObject({
  deadlineMinutes: z.number().int().min(1).max(120).default(30),
  sliceRunId: z.string().min(1),
  sandboxVersionId: z.string().min(1),
  manifestSha256: sha256Schema,
  contractSha256: sha256Schema,
  transformConfigSha256: sha256Schema,
  approvedTaskSha256: sha256Schema,
});
/** Stored starter parameters: the version it writes, and the stack it follows. */
export const starterParamsSchema = z.strictObject({
  deadlineMinutes: z.number().int().min(1).max(120).default(60),
  agent: z.literal("starter"),
  sandboxVersionId: z.string().min(1),
  approvedTaskSha256: sha256Schema,
  stack: z.array(z.string().min(1)),
});
export const analysisRunDtoSchema = z.discriminatedUnion("tool", [
  z.strictObject({
    ...runCommon,
    tool: z.literal("graphify"),
    params: analysisParamsSchema,
  }),
  z.strictObject({
    ...runCommon,
    tool: z.literal("slice"),
    params: sliceParamsSchema,
  }),
  z.strictObject({
    ...runCommon,
    tool: z.literal("sandbox_build"),
    params: sandboxBuildParamsSchema,
  }),
  z.strictObject({
    ...runCommon,
    tool: z.literal("scope"),
    params: scopeParamsSchema,
  }),
  z.strictObject({
    ...runCommon,
    tool: z.literal("fixtures"),
    params: fixturesParamsSchema,
  }),
  z.strictObject({
    ...runCommon,
    tool: z.literal("sandbox_starter"),
    params: starterParamsSchema,
  }),
]);
export const analysisRunListSchema = z.object({
  runs: z.array(analysisRunDtoSchema),
});
export const analysisRunResponseSchema = z.object({
  run: analysisRunDtoSchema,
});
/** The slice run and the graph run it waits for, which may be older. */
export const enqueueSliceResponseSchema = z.object({
  run: analysisRunDtoSchema,
  graphRun: analysisRunDtoSchema,
});
export const artifactDtoSchema = z.strictObject({
  id: z.string(),
  runId: z.string(),
  kind: z.enum(ARTIFACT_KINDS),
  path: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  meta: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.iso.datetime(),
});
export const artifactListSchema = z.object({
  artifacts: z.array(artifactDtoSchema),
});
export const artifactUrlSchema = z.object({ url: z.url() });

const summaryModuleSchema = z.object({
  module: z.string(),
  symbols: z.array(z.string()),
  importedBy: z.array(z.string()),
  truncated: z.boolean(),
});
export const sliceBlockerSchema = z.object({
  code: z.enum(SLICE_BLOCKER_CODES),
  file: z.string().nullable(),
  location: z.string().nullable(),
  detail: z.string(),
});
/** What the `boundary_contract` artifact's `meta` carries for the console. */
export const sliceBoundarySummarySchema = z.object({
  schemaVersion: z.literal(1),
  language: z.enum(["typescript", "none"]),
  stubCoverage: z.enum(["full", "partial", "names-only"]),
  ready: z.boolean(),
  counts: z.object({
    includedFiles: z.number().int().nonnegative(),
    includedBytes: z.number().int().nonnegative(),
    outboundModules: z.number().int().nonnegative(),
    inboundModules: z.number().int().nonnegative(),
    stubs: z.number().int().nonnegative(),
    publicSymbols: z.number().int().nonnegative(),
    externals: z.number().int().nonnegative(),
    blockers: z.number().int().nonnegative(),
  }),
  included: z.array(z.string()),
  outbound: z.array(summaryModuleSchema),
  inbound: z.array(summaryModuleSchema),
  externals: z.object({
    packages: z.array(z.object({ specifier: z.string(), service: z.string() })),
    environment: z.array(z.string()),
  }),
  blockers: z.array(sliceBlockerSchema),
  truncated: z.boolean(),
});
/**
 * A proposal an agent run can work for: one with a spec, whose bounty is
 * about the repository, by naming it or through its Jira board.
 * `GET .../repositories/:id/proposals`.
 */
export const repositoryProposalSchema = z.object({
  id: z.string(),
  /** Its bounty's Jira key; null for a bounty written here. */
  issueKey: z.string().nullable(),
  title: z.string().nullable(),
  status: z.string(),
  specRevision: z.number().int().positive(),
  /** The Jira board it came through, or null for a bounty written here. */
  boardId: z.string().nullable(),
  boardName: z.string().nullable(),
  createdAt: z.string(),
});
export const repositoryProposalListSchema = z.object({
  proposals: z.array(repositoryProposalSchema),
});
/** Tokens an agent run spent. */
export const agentUsageSchema = z.object({
  model: z.string(),
  turns: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
});
const reason = z.string().min(1).max(SCOPE_LIMITS.reasonChars);
/** What the scope agent submits; the worker checks it before recording it. */
export const scopeSubmissionSchema = z.strictObject({
  entryPoints: z
    .array(z.strictObject({ path: entryPointSchema, reason }))
    .min(1)
    .max(SLICE_ENTRY_POINTS_MAX),
  budget: sliceBudgetSchema,
  includeInferred: z.boolean(),
  seams: z
    .array(
      z.strictObject({
        module: entryPointSchema,
        kind: z.enum(SEAM_KINDS),
        reason,
      }),
    )
    .max(SCOPE_LIMITS.seams),
  summary: z.string().min(1).max(SCOPE_LIMITS.summaryChars),
  risks: z
    .array(z.string().min(1).max(SCOPE_LIMITS.reasonChars))
    .max(SCOPE_LIMITS.risks),
  /** Absent on proposals from before `scope@2`. */
  pattern: z
    .strictObject({ path: entryPointSchema, reason })
    .nullable()
    .optional(),
});
/** `scope-proposal.json`, which its artifact row's `meta` also carries. */
export const scopeProposalSchema = scopeSubmissionSchema.extend({
  schemaVersion: z.literal(1),
  toolVersion: z.string(),
  sourceSnapshotId: z.string(),
  sourceCommitSha: z.string(),
  graphRunId: z.string(),
  proposalId: z.string(),
  specRevision: z.number().int().positive(),
  check: z.object({
    stubCoverage: z.enum(["full", "partial", "names-only"]),
    ready: z.boolean(),
    includedFiles: z.number().int().nonnegative(),
    outboundModules: z.number().int().nonnegative(),
    blockers: z.number().int().nonnegative(),
  }),
  usage: agentUsageSchema,
});
export const sandboxFixtureSchema = z.strictObject({
  module: entryPointSchema,
  symbol: z.string().min(1).max(200),
  member: z.string().min(1).max(200).nullable(),
  call: z.enum(FIXTURE_CALLS),
  implementation: z.string().min(1).max(FIXTURE_LIMITS.implementationChars),
  reason: z.string().max(FIXTURE_LIMITS.reasonChars),
});
/** What the fixtures agent submits; the worker compiles it before recording it. */
export const fixtureSubmissionSchema = z.strictObject({
  fixtures: z.array(sandboxFixtureSchema).max(FIXTURE_LIMITS.fixtures),
  scenario: z.string().min(1).max(FIXTURE_LIMITS.scenarioChars),
  summary: z.string().min(1).max(FIXTURE_LIMITS.summaryChars),
});
/** `fixture-set.json`, which its artifact row's `meta` also carries. */
export const fixtureSetSchema = fixtureSubmissionSchema.extend({
  schemaVersion: z.literal(1),
  toolVersion: z.string(),
  sliceRunId: z.string(),
  sourceSnapshotId: z.string(),
  sourceCommitSha: z.string(),
  proposalId: z.string(),
  specRevision: z.number().int().positive(),
  usage: agentUsageSchema,
});
const starterFileSchema = (refine: (path: string) => boolean, rule: string) =>
  z.strictObject({
    path: entryPointSchema.refine(refine, rule),
    text: z.string().max(STARTER_LIMITS.fileChars),
  });
/**
 * What the starter agent submits. The schema holds each part's shape; the
 * worker's checks (`starterProblems` in core, then a type check and the
 * baseline) hold the rest.
 */
export const starterSubmissionSchema = z.strictObject({
  files: z
    .array(
      starterFileSchema(
        (path) => path.startsWith("src/"),
        "Source files live under src/.",
      ),
    )
    .min(1)
    .max(STARTER_LIMITS.files),
  publicTests: z
    .array(
      starterFileSchema(
        (path) => path.startsWith("tests/public/"),
        "Public tests live under tests/public/.",
      ),
    )
    .max(STARTER_LIMITS.publicTests),
  hiddenTests: z
    .array(
      starterFileSchema(
        (path) => path.startsWith("tests/private/"),
        "Hidden tests live under tests/private/.",
      ).extend({ expectedBaseline: z.enum(["pass", "fail"]) }),
    )
    .min(1)
    .max(STARTER_LIMITS.hiddenTests),
  packages: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(214),
        version: z.string().min(1).max(64),
      }),
    )
    .max(STARTER_LIMITS.packages),
  scenario: z.string().min(1).max(STARTER_LIMITS.scenarioChars),
  summary: z.string().min(1).max(STARTER_LIMITS.summaryChars),
  /** The name table; each rule a name the starter uses and its public one. */
  aliases: z
    .array(
      z.strictObject({
        before: z.string().min(1).max(200),
        after: z.string().min(1).max(200),
        kind: z.enum(STARTER_ALIAS_KINDS),
        paths: z.array(entryPointSchema).max(50).default([]),
      }),
    )
    .min(1)
    .max(STARTER_LIMITS.aliases),
});
/** `starter-set.json`, the accepted answer and what it was written for. */
export const starterSetSchema = starterSubmissionSchema.extend({
  schemaVersion: z.literal(STARTER_SET_SCHEMA_VERSION),
  toolVersion: z.string(),
  sandboxVersionId: z.string(),
  approvedTaskSha256: z.string(),
  stack: z.array(z.string()),
  usage: agentUsageSchema,
});
export type AnalysisRunDto = z.infer<typeof analysisRunDtoSchema>;
export type StarterSetDto = z.infer<typeof starterSetSchema>;
export type ArtifactDto = z.infer<typeof artifactDtoSchema>;
export type EnqueueAnalysisInput = z.input<typeof enqueueAnalysisSchema>;
export type EnqueueSliceInput = z.input<typeof enqueueSliceSchema>;
export type EnqueueScopeInput = z.input<typeof enqueueScopeSchema>;
export type RepositoryProposalDto = z.infer<typeof repositoryProposalSchema>;
export type EnqueueFixturesInput = z.input<typeof enqueueFixturesSchema>;
export type ScopeProposalDto = z.infer<typeof scopeProposalSchema>;
export type FixtureSetDto = z.infer<typeof fixtureSetSchema>;
export type SandboxFixtureDto = z.infer<typeof sandboxFixtureSchema>;
export type EnqueueSliceResponseDto = z.infer<
  typeof enqueueSliceResponseSchema
>;
export type SliceBoundarySummaryDto = z.infer<
  typeof sliceBoundarySummarySchema
>;
