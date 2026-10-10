import {
  ABSTRACTION_OMISSION_CODES,
  ANALYSIS_STATUSES,
  ANALYSIS_ERROR_CODES,
  ANALYSIS_PROGRESS_STEPS_MAX,
  ANALYSIS_PROGRESS_TEXT_MAX,
  ARTIFACT_KINDS,
  CONTEXT_BUILDERS,
  DATA_MODEL_OMISSION_CODES,
  DATA_SOURCE_KINDS,
  FIELD_TYPES,
  RELATION_CARDINALITIES,
  SURFACE_COVERAGES,
  SURFACE_KINDS,
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
/**
 * `POST .../repositories/:id/runs`: one context builder on one snapshot.
 * The parameters are graphify's for every builder; the API adds the
 * builder's name, and for a builder that reads graphify's map
 * (`readsGraph` in core) the graph run it enqueues or finds first. With no
 * parameters the deadline is the tool's own: `GRAPH_DEADLINE_MINUTES` for
 * the deterministic builders and `AGENT_DEADLINE_MINUTES` for deepwiki,
 * which waits on a model.
 */
export const enqueueAnalysisSchema = z.strictObject({
  tool: z.enum(CONTEXT_BUILDERS),
  snapshotId: z.string().min(1).optional(),
  params: analysisParamsSchema.optional(),
});
/**
 * `POST .../repositories/:id/builds`: every context builder on one
 * snapshot, as one request. Each is enqueued as `.../runs` would enqueue it
 * with no parameters, so a builder already built (or queued, or out of
 * retries) is answered with its run as is, and an outdated one is built
 * again. The set is admitted against the organization's active-run cap
 * once, by the first run it creates, so a full set is never refused
 * halfway.
 */
export const buildAllSchema = z.strictObject({
  snapshotId: z.string().min(1).optional(),
});
/** Stored parameters of the builders that name themselves; see core. */
export const dependencyCruiserParamsSchema = z.strictObject({
  deadlineMinutes: z.number().int().min(1).max(120).default(30),
  builder: z.literal("dependency_cruiser"),
});
export const deepwikiParamsSchema = z.strictObject({
  deadlineMinutes: z.number().int().min(1).max(120).default(30),
  builder: z.literal("deepwiki"),
});
/** The builders that read graphify's map name the graph run they read. */
export const abstractionsParamsSchema = z.strictObject({
  deadlineMinutes: z.number().int().min(1).max(120).default(30),
  builder: z.literal("abstractions"),
  graphRunId: z.string().min(1),
});
export const dataModelParamsSchema = z.strictObject({
  deadlineMinutes: z.number().int().min(1).max(120).default(30),
  builder: z.literal("data_model"),
  graphRunId: z.string().min(1),
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
  /** Named only when the snapshot has a succeeded run of the builder. */
  abstractionsRunId: z.string().min(1).optional(),
  dataModelRunId: z.string().min(1).optional(),
});
export const fixturesParamsSchema = z.strictObject({
  ...agentTaskFields,
  agent: z.literal("fixtures"),
  sliceRunId: z.string().min(1),
  dataModelRunId: z.string().min(1).optional(),
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

/** What an agent run has done so far: `AnalysisProgress` in core. */
export const analysisProgressSchema = z.object({
  count: z.number().int().nonnegative(),
  steps: z
    .array(
      z.object({
        at: z.iso.datetime(),
        text: z.string().min(1).max(ANALYSIS_PROGRESS_TEXT_MAX),
      }),
    )
    .max(ANALYSIS_PROGRESS_STEPS_MAX),
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
  /**
   * What an agent run has done so far. Steps that cannot be read are
   * dropped rather than failing the run's read: they are a preview.
   */
  progress: analysisProgressSchema.nullable().catch(null),
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
    tool: z.literal("dependency_cruiser"),
    params: dependencyCruiserParamsSchema,
  }),
  z.strictObject({
    ...runCommon,
    tool: z.literal("deepwiki"),
    params: deepwikiParamsSchema,
  }),
  z.strictObject({
    ...runCommon,
    tool: z.literal("abstractions"),
    params: abstractionsParamsSchema,
  }),
  z.strictObject({
    ...runCommon,
    tool: z.literal("data_model"),
    params: dataModelParamsSchema,
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
/**
 * The largest artifact `.../artifacts/:id/content` answers with as text.
 * A larger one still opens through its signed URL.
 */
export const ARTIFACT_TEXT_MAX_BYTES = 1_000_000;
/**
 * `GET .../artifacts/:id/content`: one artifact as text, for the console's
 * viewer. `text` is null when it is not UTF-8 text or is over
 * `ARTIFACT_TEXT_MAX_BYTES`, which `omitted` says.
 */
export const artifactContentSchema = z.object({
  path: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  text: z.string().nullable(),
  omitted: z.enum(["binary", "too_large"]).nullable(),
});
/**
 * `GET .../runs/:id/log/content`: a run's log as text, for owners and
 * admins. `text` is null when it is not UTF-8 text or is over
 * `ARTIFACT_TEXT_MAX_BYTES`, which `omitted` says.
 */
export const runLogContentSchema = z.object({
  sizeBytes: z.number().int().nonnegative(),
  text: z.string().nullable(),
  omitted: z.enum(["binary", "too_large"]).nullable(),
});

const count = z.number().int().nonnegative();
/**
 * What graphify's `manifest.json` carries, as its `graph_json` artifact's
 * `meta` also does. Loose: the driver writes more, and the console reads
 * these figures.
 */
export const graphifySummarySchema = z.looseObject({
  nodes: count,
  edges: count,
  unresolved: count,
  visualizationNodes: count,
  files: z.array(z.string()).optional(),
  confidence: z.record(z.string(), count).optional(),
  skippedSensitive: z.array(z.unknown()).optional(),
});
/** Modules one list of a summary may name before it is cut short. */
export const DEPENDENCY_SUMMARY_LIMITS = {
  modules: 25,
  cycles: 20,
  orphans: 50,
  unresolved: 50,
} as const;
/**
 * What the dependency-cruiser `manifest.json` artifact's `meta` carries for
 * the console: counts over the whole cruise, and bounded lists of the most
 * connected modules, the cycles, the orphans and the unresolved imports.
 * The full cruise is `dependency-cruiser.json`.
 */
export const dependencyCruiserSummarySchema = z.object({
  schemaVersion: z.literal(1),
  toolVersion: z.string(),
  counts: z.object({
    modules: count,
    dependencies: count,
    circular: count,
    orphans: count,
    unresolved: count,
    external: count,
  }),
  /** Busiest first: modules by dependents plus dependencies. */
  modules: z.array(
    z.object({ source: z.string(), dependents: count, dependencies: count }),
  ),
  cycles: z.array(z.array(z.string()).min(1)),
  orphans: z.array(z.string()),
  unresolved: z.array(z.object({ from: z.string(), module: z.string() })),
  truncated: z.boolean(),
});
/** How important DeepWiki-Open says a page is. */
export const WIKI_IMPORTANCE = ["high", "medium", "low"] as const;
/**
 * What the deepwiki `wiki-structure.json` artifact's `meta` carries: the
 * wiki's outline, each page naming the artifact its text is in. The
 * repository is read by the DeepWiki-Open service at its default branch
 * when the run happens, not from the snapshot, which the summary says.
 */
export const deepwikiSummarySchema = z.object({
  schemaVersion: z.literal(1),
  toolVersion: z.string(),
  title: z.string(),
  description: z.string(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  repositoryUrl: z.string(),
  /** The commit the run was asked for; the service read the branch head instead. */
  requestedCommitSha: z.string(),
  pages: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      importance: z.enum(WIKI_IMPORTANCE),
      filePaths: z.array(z.string()),
      relatedPages: z.array(z.string()),
      /** The artifact path its text was written to. */
      path: z.string(),
    }),
  ),
  sections: z.array(
    z.object({ id: z.string(), title: z.string(), pages: z.array(z.string()) }),
  ),
});

const abstractionOmissionSchema = z.object({
  code: z.enum(ABSTRACTION_OMISSION_CODES),
  file: z.string().nullable(),
  detail: z.string(),
});
/** One module's callable surface in `abstractions.json`. */
export const moduleSurfaceSchema = z.object({
  path: z.string(),
  language: z.string(),
  coverage: z.enum(SURFACE_COVERAGES),
  importers: count,
  exports: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      kind: z.enum(SURFACE_KINDS),
      signature: z.string().nullable(),
      line: z.number().int().positive(),
      references: z.array(z.string()),
    }),
  ),
});
/** `abstractions.json`, as the agents read it back. */
export const abstractionIndexSchema = z.object({
  schemaVersion: z.literal(1),
  toolVersion: z.string(),
  extractors: z.object({
    typescript: z.string().nullable(),
    syntactic: z.string().nullable(),
  }),
  sourceSnapshotId: z.string(),
  sourceCommitSha: z.string(),
  graphRunId: z.string(),
  graphSha256: z.string(),
  modules: z.array(moduleSurfaceSchema),
  externals: z.array(z.string()),
  omissions: z.array(abstractionOmissionSchema),
});
/**
 * What the abstractions `manifest.json` artifact's `meta` carries for the
 * console: counts by coverage and language, the most imported modules with
 * their export counts, and the first omissions.
 */
export const abstractionsSummarySchema = z.object({
  schemaVersion: z.literal(1),
  toolVersion: z.string(),
  counts: z.object({ modules: count, exports: count, omissions: count }),
  coverage: z.object({ typed: count, syntactic: count, "names-only": count }),
  languages: z.array(
    z.object({ language: z.string(), modules: count, exports: count }),
  ),
  modules: z.array(
    z.object({
      path: z.string(),
      language: z.string(),
      coverage: z.enum(SURFACE_COVERAGES),
      importers: count,
      exports: count,
    }),
  ),
  omissions: z.array(abstractionOmissionSchema),
  truncated: z.boolean(),
});
const dataModelOmissionSchema = z.object({
  code: z.enum(DATA_MODEL_OMISSION_CODES),
  file: z.string().nullable(),
  detail: z.string(),
});
const dataSourceSchema = z.object({
  kind: z.enum(DATA_SOURCE_KINDS),
  storage: z.string(),
  files: z.array(z.string()),
  evidence: z.array(z.string()),
  entities: count,
  shadowed: count,
});
const dataAccessorSchema = z.object({
  module: z.string(),
  entities: z.array(z.string()),
  importers: count,
});
/**
 * One end of a relation. `table` says which entity is meant where two
 * sources each keep one by the same name; absent on older documents, which
 * are matched by name.
 */
const relationEndSchema = z.object({
  entity: z.string(),
  fields: z.array(z.string()),
  table: z.string().optional(),
});
/** `data-model.json`, as the agents read it back. */
export const dataModelSchema = z.object({
  schemaVersion: z.literal(1),
  toolVersion: z.string(),
  sourceSnapshotId: z.string(),
  sourceCommitSha: z.string(),
  graphRunId: z.string(),
  graphSha256: z.string(),
  sources: z.array(dataSourceSchema),
  entities: z.array(
    z.object({
      name: z.string(),
      table: z.string(),
      kind: z.enum(["table", "view"]),
      source: z.enum(DATA_SOURCE_KINDS),
      file: z.string(),
      line: z.number().int().positive(),
      fields: z.array(
        z.object({
          name: z.string(),
          column: z.string(),
          type: z.enum(FIELD_TYPES),
          nativeType: z.string(),
          list: z.boolean(),
          nullable: z.boolean(),
          default: z.string().nullable(),
          unique: z.boolean(),
          primaryKey: z.boolean(),
          enum: z.string().nullable(),
        }),
      ),
      primaryKey: z.array(z.string()),
      uniques: z.array(z.array(z.string())),
    }),
  ),
  enums: z.array(
    z.object({
      name: z.string(),
      values: z.array(z.string()),
      source: z.enum(DATA_SOURCE_KINDS),
      file: z.string(),
      line: z.number().int().positive(),
    }),
  ),
  relations: z.array(
    z.object({
      name: z.string().nullable(),
      from: relationEndSchema,
      to: relationEndSchema,
      cardinality: z.enum(RELATION_CARDINALITIES),
      onDelete: z.string().nullable(),
      onUpdate: z.string().nullable(),
      source: z.enum(DATA_SOURCE_KINDS),
    }),
  ),
  accessors: z.array(dataAccessorSchema),
  omissions: z.array(dataModelOmissionSchema),
});
/**
 * What the data model `manifest.json` and `data-model.json` artifacts'
 * `meta` carry for the console: the storage and sources, counts, and
 * bounded lists of entities with their fields, enums, relations, accessors
 * and omissions.
 */
export const dataModelSummarySchema = z.object({
  schemaVersion: z.literal(1),
  toolVersion: z.string(),
  storage: z.array(z.string()),
  sources: z.array(dataSourceSchema),
  counts: z.object({
    entities: count,
    fields: count,
    enums: count,
    relations: count,
    accessors: count,
    omissions: count,
  }),
  entities: z.array(
    z.object({
      name: z.string(),
      table: z.string(),
      kind: z.enum(["table", "view"]),
      source: z.enum(DATA_SOURCE_KINDS),
      file: z.string(),
      line: z.number().int().positive(),
      fieldCount: count,
      fields: z.array(
        z.object({
          name: z.string(),
          type: z.enum(FIELD_TYPES),
          nativeType: z.string(),
          nullable: z.boolean(),
          list: z.boolean(),
          primaryKey: z.boolean(),
          unique: z.boolean(),
          foreignKey: z.boolean(),
          enum: z.string().nullable(),
        }),
      ),
    }),
  ),
  enums: z.array(z.object({ name: z.string(), values: z.array(z.string()) })),
  relations: z.array(
    z.object({
      from: z.string(),
      fromFields: z.array(z.string()),
      to: z.string(),
      toFields: z.array(z.string()),
      cardinality: z.enum(RELATION_CARDINALITIES),
      onDelete: z.string().nullable(),
    }),
  ),
  accessors: z.array(dataAccessorSchema),
  omissions: z.array(dataModelOmissionSchema),
  truncated: z.boolean(),
});

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
export type ArtifactContentDto = z.infer<typeof artifactContentSchema>;
export type RunLogContentDto = z.infer<typeof runLogContentSchema>;
export type EnqueueAnalysisInput = z.input<typeof enqueueAnalysisSchema>;
export type BuildAllInput = z.input<typeof buildAllSchema>;
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
export type GraphifySummaryDto = z.infer<typeof graphifySummarySchema>;
export type DependencyCruiserSummaryDto = z.infer<
  typeof dependencyCruiserSummarySchema
>;
export type DeepwikiSummaryDto = z.infer<typeof deepwikiSummarySchema>;
export type AbstractionsSummaryDto = z.infer<typeof abstractionsSummarySchema>;
export type DataModelSummaryDto = z.infer<typeof dataModelSummarySchema>;
export type AnalysisProgressDto = z.infer<typeof analysisProgressSchema>;
