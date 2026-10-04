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
  "other",
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/**
 * The analysis tools a run can name. `graphify` maps a snapshot's structure;
 * `slice` reads that map and the source to describe one task's boundary;
 * `sandbox_build` turns a slice and a version's private transform into a
 * runnable project and checks its baseline. `scope` and `fixtures` are
 * agent runs: a model reads the source to propose a slice for a bounty, and
 * to write believable behaviour for a succeeded slice's mocked seams.
 */
export const ANALYSIS_TOOLS = [
  "graphify",
  "slice",
  "sandbox_build",
  "scope",
  "fixtures",
] as const;
export type AnalysisTool = (typeof ANALYSIS_TOOLS)[number];
export const GRAPHIFY_TOOL_VERSION = "graphifyy@0.4.18+driver-1";
/** Bumped when the slice walk, extractor or artifact shapes change meaning. */
export const SLICE_TOOL_VERSION = "slice@1";
/** Bumped when the generated project, harness or baseline rules change meaning. */
export const SANDBOX_BUILD_RUN_VERSION = "sandbox_build@1";
/** Bumped when the scope agent's tools, prompt or proposal shape change meaning. */
export const SCOPE_TOOL_VERSION = "scope@2";
/** Bumped when the fixtures agent's tools, prompt or set shape change meaning. */
export const FIXTURES_TOOL_VERSION = "fixtures@1";
export function toolVersionOf(tool: AnalysisTool): string {
  switch (tool) {
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
  }
}

export interface GraphifyParams {
  readonly deadlineMinutes: number;
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
/** The scope agent reads the graphify run on the same snapshot. */
export interface ScopeParams extends AgentTaskParams {
  readonly agent: "scope";
  readonly graphRunId: string;
}
/** The fixtures agent writes for a succeeded slice run on the same snapshot. */
export interface FixturesParams extends AgentTaskParams {
  readonly agent: "fixtures";
  readonly sliceRunId: string;
}
export type AnalysisParams =
  | GraphifyParams
  | SliceParams
  | SandboxBuildParams
  | ScopeParams
  | FixturesParams;
export function isScopeParams(params: AnalysisParams): params is ScopeParams {
  return "agent" in params && params.agent === "scope";
}
export function isFixturesParams(
  params: AnalysisParams,
): params is FixturesParams {
  return "agent" in params && params.agent === "fixtures";
}
/** A scope run names a graph run too; only a run with no agent is a slice. */
export function isSliceParams(params: AnalysisParams): params is SliceParams {
  return "graphRunId" in params && !("agent" in params);
}
export function isSandboxBuildParams(
  params: AnalysisParams,
): params is SandboxBuildParams {
  return "sandboxVersionId" in params;
}
export function toolOfParams(params: AnalysisParams): AnalysisTool {
  if (isScopeParams(params)) return "scope";
  if (isFixturesParams(params)) return "fixtures";
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
