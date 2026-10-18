/** The deterministic source-analysis contract, shared by every surface. */
export const ANALYSIS_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
] as const;
export type AnalysisStatus = (typeof ANALYSIS_STATUSES)[number];
export const ANALYSIS_ERROR_CODES = [
  "too_large",
  "too_many_files",
  "source_unavailable",
  "graph_unavailable",
  "tool_failed",
  "tool_timeout",
  "upload_failed",
  "worker_lost",
  "cancelled",
  "slice_unavailable",
  "evaluation_failed",
  "agent_unavailable",
  "agent_incomplete",
  "context_unavailable",
] as const;
export type AnalysisErrorCode = (typeof ANALYSIS_ERROR_CODES)[number];
/**
 * What a run has done so far, written as it works, so a page following the
 * run shows its steps rather than a spinner. Each step is a line the worker
 * writes about one tool call, never the model's prose. Only the newest
 * `ANALYSIS_PROGRESS_STEPS_MAX` are kept; `count` is how many there have
 * been. A context builder writes how far it has got instead, for a bar.
 */
export interface AnalysisProgress {
  readonly count: number;
  readonly steps: readonly AnalysisProgressStep[];
  /** Units done of a total the builder counts: files read, stages ended. */
  readonly fraction?: AnalysisProgressFraction;
}
export interface AnalysisProgressFraction {
  readonly done: number;
  readonly total: number;
}
export interface AnalysisProgressStep {
  /** When it was done, as an ISO timestamp. */
  readonly at: string;
  readonly text: string;
}
export const ANALYSIS_PROGRESS_STEPS_MAX = 20;
/**
 * What a build has written before it is checked: the generated project,
 * uploaded the moment it exists, so a page can show the files while the
 * baseline still runs. Replaced as a later candidate is written, cleared
 * when the run ends; the run's committed artifacts are then what it wrote.
 */
export interface AnalysisPreview {
  /** When it was written, as an ISO timestamp. */
  readonly at: string;
  readonly files: readonly AnalysisPreviewFile[];
}
export interface AnalysisPreviewFile {
  readonly path: string;
  readonly objectKey: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}
/** The longest a step's line may be; a longer one is cut with an ellipsis. */
export const ANALYSIS_PROGRESS_TEXT_MAX = 160;
/**
 * Where a run's time went, written once when it ends, so the waits a person
 * sees can be measured against the work behind them. Milliseconds
 * throughout. A stage the run never reached is absent, as are the lists a
 * tool of its kind does not make.
 */
export interface AnalysisTiming {
  readonly stages: Partial<Record<AnalysisTimingStage, number>>;
  /** An agent run's turns, oldest first, at most `ANALYSIS_TIMING_TURNS_MAX`. */
  readonly turns?: readonly AnalysisTurnTiming[];
  /** A run's baselines in the order they ran, at most `ANALYSIS_TIMING_BASELINES_MAX`. */
  readonly baselines?: readonly (readonly AnalysisBaselineStepTiming[])[];
}
/**
 * `fetch` is the archive's download, `extract` its unpacking, `tool` the
 * tool's own work, `upload` its artifacts' and `commit` the database write
 * that makes them visible.
 */
export const ANALYSIS_TIMING_STAGES = [
  "fetch",
  "extract",
  "tool",
  "upload",
  "commit",
] as const;
export type AnalysisTimingStage = (typeof ANALYSIS_TIMING_STAGES)[number];
export interface AnalysisTurnTiming {
  /** The model call. */
  readonly modelMs: number;
  /** The turn's tool calls, end to end. */
  readonly toolMs: number;
}
export interface AnalysisBaselineStepTiming {
  readonly name: string;
  readonly durationMs: number;
  readonly ok: boolean;
}
export const ANALYSIS_TIMING_TURNS_MAX = 100;
export const ANALYSIS_TIMING_BASELINES_MAX = 20;
export const ARTIFACT_KINDS = [
  "graph_json",
  "graph_html",
  "report_md",
  "wiki_page",
  "manifest",
  "slice_manifest",
  "boundary_contract",
  "boundary_md",
  "public_surface_md",
  "stub",
  "abstract_md",
  "build_manifest",
  "project_file",
  "private_test",
  "baseline_report",
  "scope_proposal",
  "fixture_set",
  "starter_set",
  "pseudonyms",
  "abstraction_index",
  "data_model",
  "erd_mermaid",
  "documents",
  "brief_md",
  "seams_index",
  "other",
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/**
 * The context builders: the tools that read a snapshot on their own and
 * describe it for people and agents. `graphify` maps a snapshot's
 * structure. `abstractions` lists every module's callable surface, and `data_model`
 * the entities a repository stores and the modules that touch them; both
 * read graphify's map of the same snapshot, and the scope and fixtures
 * agents read them. `documents` keeps the repository's Markdown documents,
 * so a bounty's context is read from storage rather than GitHub. `brief`
 * reads what the others wrote into one bounded document (`renderBrief`),
 * which the price reads for every connected repository; it waits for the
 * other builders on its snapshot to end. An owner or admin can start one
 * from a repository's page.
 */
export const CONTEXT_BUILDERS = [
  "graphify",
  "abstractions",
  "data_model",
  "documents",
  "brief",
] as const;
export type ContextBuilder = (typeof CONTEXT_BUILDERS)[number];
/**
 * The analysis tools a run can name. The context builders above come first;
 * `slice` reads graphify's map and the source to describe one task's
 * boundary; `sandbox_build` turns a slice and a version's private transform
 * into a runnable project and checks its baseline. `scope` and `fixtures`
 * are agent runs: a model reads the source to propose a slice for a bounty,
 * and to write believable behaviour for a succeeded slice's mocked seams.
 * `sandbox_starter` is the one run with no repository: a model writes a
 * starter project from the bounty's own text, which is then built and
 * checked like a slice's.
 */
export const ANALYSIS_TOOLS = [
  ...CONTEXT_BUILDERS,
  "slice",
  "sandbox_build",
  "scope",
  "fixtures",
  "sandbox_starter",
] as const;
export type AnalysisTool = (typeof ANALYSIS_TOOLS)[number];
export const GRAPHIFY_TOOL_VERSION = "graphifyy@0.4.18+driver-1";
/** Bumped when an extractor, a visibility rule or the index's shape changes meaning. */
export const ABSTRACTIONS_TOOL_VERSION = "abstractions@3";
/** Bumped when a recognizer, the replay rules or the model's shape change meaning. */
export const DATA_MODEL_TOOL_VERSION = "data_model@1";
/** Bumped when which documents are kept, or how, changes. */
export const DOCUMENTS_TOOL_VERSION = "documents@1";
/** Bumped when what the brief says, its order or its cap change meaning. */
export const BRIEF_TOOL_VERSION = "brief@1";
/**
 * Tools that read a graphify run of the same snapshot, named in
 * `params.graphRunId`. The queue hands one to a worker only once that run
 * has finished.
 */
export const GRAPH_READERS = [
  "slice",
  "scope",
  "abstractions",
  "data_model",
] as const;
export function readsGraph(tool: AnalysisTool): boolean {
  return GRAPH_READERS.some((name) => name === tool);
}
/**
 * Tools that read what every other context builder on their snapshot
 * wrote. The queue hands one to a worker only once none of those is queued
 * or running.
 */
export const BUILDER_READERS = ["brief"] as const;
export function readsBuilders(tool: AnalysisTool): boolean {
  return BUILDER_READERS.some((name) => name === tool);
}
/**
 * Whether a snapshot's runs make it built: its graphify map succeeded, which
 * slices, scopes and the map readers all read, and every other context
 * builder has finished, however it finished. A builder that fails on the
 * repository does not keep its commit from being picked. Runs of any tool
 * may be passed; only the context builders' are read. The run store keeps
 * the same rule in SQL, to mark a snapshot built as its last builder ends
 * (`repo_snapshot.built_at`); a change here changes it there.
 */
export function snapshotBuilt(
  runs: readonly { readonly tool: string; readonly status: AnalysisStatus }[],
): boolean {
  const required = runs.filter((run) =>
    CONTEXT_BUILDERS.some((builder) => builder === run.tool),
  );
  if (
    !required.some(
      (run) => run.tool === "graphify" && run.status === "succeeded",
    )
  )
    return false;
  return CONTEXT_BUILDERS.every((builder) =>
    required.some(
      (run) =>
        run.tool === builder &&
        (run.status === "succeeded" || run.status === "failed"),
    ),
  );
}
/** Bumped when the slice walk, extractor or artifact shapes change meaning. */
export const SLICE_TOOL_VERSION = "slice@3";
/** Bumped when the generated project, harness or baseline rules change meaning. */
export const SANDBOX_BUILD_RUN_VERSION = "sandbox_build@8";
/** Bumped when the scope agent's tools, prompt or proposal shape change meaning. */
export const SCOPE_TOOL_VERSION = "scope@5";
/** Bumped when the fixtures agent's tools, prompt or set shape change meaning. */
export const FIXTURES_TOOL_VERSION = "fixtures@3";
/** Bumped when the starter agent's tools, prompt, set or project change meaning. */
export const STARTER_TOOL_VERSION = "sandbox_starter@4";
/** Tools that read a repository snapshot; every other one runs without source. */
export function readsSource(tool: AnalysisTool): boolean {
  return tool !== "sandbox_starter";
}
/**
 * Which of a worker's slots a run takes. An agent run spends its time
 * waiting on a model, so a worker runs several at once; a build spends it
 * on the worker's CPU, so it runs one. The sandbox build and the starter
 * run baselines too, but most of their wall time is their agents'.
 */
export type RunSlot = "agent" | "build";
export const RUN_SLOTS = ["agent", "build"] as const;
/** How many runs of each slot one worker runs at once. */
export const WORKER_SLOTS: Readonly<Record<RunSlot, number>> = {
  agent: 3,
  build: 1,
};
export function slotOf(tool: AnalysisTool): RunSlot {
  switch (tool) {
    case "scope":
    case "fixtures":
    case "sandbox_build":
    case "sandbox_starter":
      return "agent";
    case "graphify":
    case "abstractions":
    case "data_model":
    case "documents":
    case "brief":
    case "slice":
      return "build";
  }
}
/** The tools that take one slot. */
export function toolsOfSlot(slot: RunSlot): AnalysisTool[] {
  return ANALYSIS_TOOLS.filter((tool) => slotOf(tool) === slot);
}
/**
 * The builders a claimed run shares its claim, and its one build slot,
 * with: those of the same snapshot that read the same checkout and wait on
 * nothing it has not already waited on. `documents` reads no graph, so it
 * runs beside graphify's map too. The worker claims them together; the
 * launcher counts them as one build.
 */
export const SHARED_CLAIM: Readonly<
  Partial<Record<AnalysisTool, readonly AnalysisTool[]>>
> = {
  graphify: ["documents"],
  abstractions: ["data_model", "documents"],
  data_model: ["abstractions", "documents"],
  documents: ["abstractions", "data_model"],
};
export function toolVersionOf(tool: AnalysisTool): string {
  switch (tool) {
    case "sandbox_starter":
      return STARTER_TOOL_VERSION;
    case "slice":
      return SLICE_TOOL_VERSION;
    case "sandbox_build":
      return SANDBOX_BUILD_RUN_VERSION;
    case "scope":
      return SCOPE_TOOL_VERSION;
    case "fixtures":
      return FIXTURES_TOOL_VERSION;
    case "graphify":
      return GRAPHIFY_TOOL_VERSION;
    case "abstractions":
      return ABSTRACTIONS_TOOL_VERSION;
    case "data_model":
      return DATA_MODEL_TOOL_VERSION;
    case "documents":
      return DOCUMENTS_TOOL_VERSION;
    case "brief":
      return BRIEF_TOOL_VERSION;
  }
}

export interface GraphifyParams {
  readonly deadlineMinutes: number;
}
/**
 * A context builder other than graphify names itself, and the tool is read
 * from the parameters. The builders that read graphify's map name the
 * succeeded graphify run on the same snapshot, as a slice does, and wait
 * for it in the queue.
 */
export interface AbstractionsParams extends GraphifyParams {
  readonly builder: "abstractions";
  readonly graphRunId: string;
}
export interface DataModelParams extends GraphifyParams {
  readonly builder: "data_model";
  readonly graphRunId: string;
}
/** The documents builder reads the source alone. */
export interface DocumentsParams extends GraphifyParams {
  readonly builder: "documents";
}
/**
 * The brief reads the other builders' newest succeeded runs on its
 * snapshot when it runs, which the queue holds it back for.
 */
export interface BriefParams extends GraphifyParams {
  readonly builder: "brief";
}
export interface SliceBudget {
  /** Files inside the slice; the first file past it on any path is a cut. */
  readonly maxFiles: number;
  /** Edges from the nearest entry point; a file further away is a cut. */
  readonly maxDepth: number;
}
export const SLICE_BUDGET_DEFAULTS: SliceBudget = { maxFiles: 40, maxDepth: 3 };
export interface SliceParams extends GraphifyParams {
  /** The succeeded graphify run on the same snapshot whose graph is walked. */
  readonly graphRunId: string;
  /** Repository-relative file paths or graph node ids, sorted and unique. */
  readonly entryPoints: readonly string[];
  readonly budget: SliceBudget;
  /** Whether graphify's INFERRED edges are walked; AST edges always are. */
  readonly includeInferred: boolean;
}
/**
 * A build names the version it builds and every hash its output must bind
 * to. The hashes are in the cache key on purpose: a changed alias rule,
 * spec or hidden test is a different run on the same snapshot.
 */
export interface SandboxBuildParams extends GraphifyParams {
  readonly sliceRunId: string;
  readonly sandboxVersionId: string;
  readonly manifestSha256: string;
  readonly contractSha256: string;
  readonly transformConfigSha256: string;
  readonly approvedTaskSha256: string;
  /**
   * The names the workspace goes by, which no public file may carry
   * (`workspaceVocabulary`). Absent on a build queued before the check.
   */
  readonly vocabulary?: readonly string[];
  /**
   * The snapshot's newest succeeded `data_model` run, which the fixtures
   * agent reads when the build writes fixtures for a draft with none.
   */
  readonly dataModelRunId?: string;
  /**
   * A succeeded preparation run on the same slice (`FixturesParams` with
   * `pseudonyms`): a draft with no fixtures takes its fixtures, and one
   * with no name table its table when the build's checks pass it, rather
   * than running the agents again.
   */
  readonly preparedRunId?: string;
}
/**
 * The bounty an agent run works for: a proposal and one immutable revision
 * of its spec. The spec hash is in the cache key, so a revised spec is a
 * different run.
 */
export interface AgentTaskParams extends GraphifyParams {
  readonly proposalId: string;
  readonly specRevision: number;
  readonly specHash: string;
}
/**
 * The scope agent reads the graphify run on the same snapshot, and the
 * succeeded `abstractions` and `data_model` runs on it when there are any.
 * Those are optional and named only when present, so a scope with neither
 * keeps the cache key it had, and one with them is a different run.
 */
export interface ScopeParams extends AgentTaskParams {
  readonly agent: "scope";
  readonly graphRunId: string;
  readonly abstractionsRunId?: string;
  readonly dataModelRunId?: string;
}
/**
 * The fixtures agent writes for a succeeded slice run on the same snapshot,
 * and reads the snapshot's succeeded `data_model` run when there is one.
 */
export interface FixturesParams extends AgentTaskParams {
  readonly agent: "fixtures";
  readonly sliceRunId: string;
  readonly dataModelRunId?: string;
  /**
   * A sandbox's preparation, run once a bounty's profile is ready and its
   * price approved: after the fixtures, the run writes the name table too,
   * checked against the workspace's names (`workspaceVocabulary`) over the
   * slice, the spec, the fixtures and the listing a cut would give the
   * version. Absent for a person's fixtures run, which keeps its cache key.
   */
  readonly pseudonyms?: {
    readonly vocabulary: readonly string[];
    readonly title: string;
    readonly summary: string;
  };
}
/**
 * The starter agent writes the draft version it names, for the bounty the
 * version's approved task snapshots. The task's hash is in the cache key,
 * and the stack the agent follows is fixed when the run is queued.
 */
export interface StarterParams extends GraphifyParams {
  readonly agent: "starter";
  readonly sandboxVersionId: string;
  readonly approvedTaskSha256: string;
  readonly stack: readonly string[];
  /**
   * The names the workspace goes by, which no public file of the starter
   * may carry (`workspaceVocabulary`). Absent on a run queued before the
   * check.
   */
  readonly vocabulary?: readonly string[];
}
export type AnalysisParams =
  | GraphifyParams
  | AbstractionsParams
  | DataModelParams
  | DocumentsParams
  | BriefParams
  | SliceParams
  | SandboxBuildParams
  | ScopeParams
  | FixturesParams
  | StarterParams;
export function isAbstractionsParams(
  params: AnalysisParams,
): params is AbstractionsParams {
  return "builder" in params && params.builder === "abstractions";
}
export function isDataModelParams(
  params: AnalysisParams,
): params is DataModelParams {
  return "builder" in params && params.builder === "data_model";
}
export function isDocumentsParams(
  params: AnalysisParams,
): params is DocumentsParams {
  return "builder" in params && params.builder === "documents";
}
export function isBriefParams(params: AnalysisParams): params is BriefParams {
  return "builder" in params && params.builder === "brief";
}
export function isScopeParams(params: AnalysisParams): params is ScopeParams {
  return "agent" in params && params.agent === "scope";
}
export function isFixturesParams(
  params: AnalysisParams,
): params is FixturesParams {
  return "agent" in params && params.agent === "fixtures";
}
export function isStarterParams(
  params: AnalysisParams,
): params is StarterParams {
  return "agent" in params && params.agent === "starter";
}
/** A scope run names a graph run too; only a run with no agent and no builder is a slice. */
export function isSliceParams(params: AnalysisParams): params is SliceParams {
  return (
    "graphRunId" in params && !("agent" in params) && !("builder" in params)
  );
}
/** A starter names a version too; only a run with no agent is a build. */
export function isSandboxBuildParams(
  params: AnalysisParams,
): params is SandboxBuildParams {
  return "sandboxVersionId" in params && !("agent" in params);
}
export function toolOfParams(params: AnalysisParams): AnalysisTool {
  if ("builder" in params) return params.builder;
  if (isScopeParams(params)) return "scope";
  if (isFixturesParams(params)) return "fixtures";
  if (isStarterParams(params)) return "sandbox_starter";
  return isSliceParams(params)
    ? "slice"
    : isSandboxBuildParams(params)
      ? "sandbox_build"
      : "graphify";
}

/** Tokens one agent run spent, as the provider reported them. */
export interface AgentUsage {
  readonly model: string;
  readonly turns: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

/** A retry count, rather than the number of times a lease was claimed. */
export function expiredAnalysis(
  attempt: number,
  maxAttempts: number,
): { status: "queued" | "failed"; attempt: number } {
  return attempt < maxAttempts
    ? { status: "queued", attempt: attempt + 1 }
    : { status: "failed", attempt };
}

/** Stable cache-key input; object key order must not create another job. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  const json = JSON.stringify(value);
  if (json === undefined)
    throw new Error("Cache parameters must be JSON values.");
  return json;
}
