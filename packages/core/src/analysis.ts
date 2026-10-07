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
  "builder_unavailable",
  "context_unavailable",
] as const;
export type AnalysisErrorCode = (typeof ANALYSIS_ERROR_CODES)[number];
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
  "dependency_graph",
  "dependency_dot",
  "wiki_structure",
  "abstraction_index",
  "data_model",
  "erd_mermaid",
  "other",
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/**
 * The context builders: the tools that read a snapshot on their own and
 * describe it for people and agents. `graphify` maps a snapshot's
 * structure; `dependency_cruiser` cruises its module dependencies;
 * `deepwiki` asks a DeepWiki-Open service for a wiki of the repository.
 * `abstractions` lists every module's callable surface, and `data_model`
 * the entities a repository stores and the modules that touch them; both
 * read graphify's map of the same snapshot, and the scope and fixtures
 * agents read them. An owner or admin can start one from a repository's page.
 */
export const CONTEXT_BUILDERS = [
  "graphify",
  "dependency_cruiser",
  "deepwiki",
  "abstractions",
  "data_model",
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
/** Bumped when the cruise options, summary or artifact shapes change meaning. */
export const DEPENDENCY_CRUISER_TOOL_VERSION =
  "dependency-cruiser@18.5.0+driver-3";
/** Bumped when the DeepWiki-Open request or the artifacts written from its wiki change meaning. */
export const DEEPWIKI_TOOL_VERSION = "deepwiki-open@driver-1";
/** Bumped when an extractor, a visibility rule or the index's shape changes meaning. */
export const ABSTRACTIONS_TOOL_VERSION = "abstractions@2";
/** Bumped when a recognizer, the replay rules or the model's shape change meaning. */
export const DATA_MODEL_TOOL_VERSION = "data_model@1";
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
/** Bumped when the slice walk, extractor or artifact shapes change meaning. */
export const SLICE_TOOL_VERSION = "slice@1";
/** Bumped when the generated project, harness or baseline rules change meaning. */
export const SANDBOX_BUILD_RUN_VERSION = "sandbox_build@2";
/** Bumped when the scope agent's tools, prompt or proposal shape change meaning. */
export const SCOPE_TOOL_VERSION = "scope@3";
/** Bumped when the fixtures agent's tools, prompt or set shape change meaning. */
export const FIXTURES_TOOL_VERSION = "fixtures@2";
/** Bumped when the starter agent's tools, prompt, set or project change meaning. */
export const STARTER_TOOL_VERSION = "sandbox_starter@3";
/** Tools that read a repository snapshot; every other one runs without source. */
export function readsSource(tool: AnalysisTool): boolean {
  return tool !== "sandbox_starter";
}
/**
 * Tools that read the snapshot's files, so the worker downloads its archive.
 * DeepWiki reads a snapshot's commit but clones the repository itself, so
 * fetching the archive for it only fails large repositories for nothing.
 */
export function downloadsSource(tool: AnalysisTool): boolean {
  return readsSource(tool) && tool !== "deepwiki";
}
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
    case "dependency_cruiser":
      return DEPENDENCY_CRUISER_TOOL_VERSION;
    case "deepwiki":
      return DEEPWIKI_TOOL_VERSION;
    case "abstractions":
      return ABSTRACTIONS_TOOL_VERSION;
    case "data_model":
      return DATA_MODEL_TOOL_VERSION;
  }
}

export interface GraphifyParams {
  readonly deadlineMinutes: number;
}
/**
 * A context builder other than graphify names itself: its parameters are
 * otherwise graphify's, and the tool is read from the parameters.
 */
export interface DependencyCruiserParams extends GraphifyParams {
  readonly builder: "dependency_cruiser";
}
export interface DeepwikiParams extends GraphifyParams {
  readonly builder: "deepwiki";
}
/**
 * The builders that read graphify's map name the succeeded graphify run on
 * the same snapshot, as a slice does, and wait for it in the queue.
 */
export interface AbstractionsParams extends GraphifyParams {
  readonly builder: "abstractions";
  readonly graphRunId: string;
}
export interface DataModelParams extends GraphifyParams {
  readonly builder: "data_model";
  readonly graphRunId: string;
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
}
export type AnalysisParams =
  | GraphifyParams
  | DependencyCruiserParams
  | DeepwikiParams
  | AbstractionsParams
  | DataModelParams
  | SliceParams
  | SandboxBuildParams
  | ScopeParams
  | FixturesParams
  | StarterParams;
export function isDependencyCruiserParams(
  params: AnalysisParams,
): params is DependencyCruiserParams {
  return "builder" in params && params.builder === "dependency_cruiser";
}
export function isDeepwikiParams(
  params: AnalysisParams,
): params is DeepwikiParams {
  return "builder" in params && params.builder === "deepwiki";
}
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
