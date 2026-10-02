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
  "tool_failed",
  "tool_timeout",
  "upload_failed",
  "worker_lost",
  "cancelled",
] as const;
export type AnalysisErrorCode = (typeof ANALYSIS_ERROR_CODES)[number];
export const ARTIFACT_KINDS = [
  "graph_json",
  "graph_html",
  "report_md",
  "wiki_page",
  "manifest",
  "other",
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];
export const GRAPHIFY_TOOL_VERSION = "graphifyy@0.4.18+driver-1";
export interface AnalysisParams {
  readonly deadlineMinutes: number;
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
