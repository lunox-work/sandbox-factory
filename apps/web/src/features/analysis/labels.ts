/**
 * The words the repository page uses for runs: what a tool is called, what
 * a status reads as, and what each error code means. One place, so the
 * builder cards, the result block and the run history say the same thing.
 */

import { ApiError } from "@sandbox-factory/client";
import type { AnalysisRunDto } from "@sandbox-factory/shared";
import type {
  AnalysisErrorCode,
  AnalysisStatus,
  ContextBuilder,
} from "sandbox-factory";

/** What a failed request reads as: the API's words, or ours when it had none. */
export function errorMessage(error: unknown): string {
  return error instanceof ApiError
    ? error.message
    : "Analysis could not be loaded. Try again.";
}

/**
 * Every error code, in the words the person needs. Typed over the code
 * union, so a code the contract adds has to be given a label here.
 */
export const errorLabels: Record<AnalysisErrorCode, string> = {
  too_large: "This repository exceeds the source size limit.",
  too_many_files: "This repository has too many files.",
  source_unavailable:
    "The source commit could not be read. Check the GitHub connection.",
  graph_unavailable:
    "The structure analysis this run needs did not succeed. Build Graphify again, then retry.",
  tool_failed: "The analysis tool could not complete this run.",
  tool_timeout: "Analysis exceeded its time limit.",
  upload_failed: "Artifacts could not be saved.",
  worker_lost: "The worker stopped responding.",
  cancelled: "Analysis was interrupted.",
  slice_unavailable: "The slice this run builds on is gone or changed.",
  evaluation_failed: "The evaluation job could not run.",
  agent_unavailable: "No agent model is configured on the worker.",
  agent_incomplete:
    "The agent stopped without an answer it could check. Try again.",
  builder_unavailable: "This builder is not configured on the worker.",
  context_unavailable:
    "A context build this run reads is gone or changed. Build it again, then retry.",
};

/** A run's status, as a word. */
export const statusLabels: Record<AnalysisStatus, string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
};

/** What a context builder is called on its card. */
export const builderNames: Record<ContextBuilder, string> = {
  graphify: "Graphify",
  dependency_cruiser: "Dependency Cruiser",
  deepwiki: "DeepWiki Open",
  abstractions: "Abstractions",
  data_model: "Data model",
};

/** What a run in the history is, in the page's words. */
export function runLabel(run: AnalysisRunDto): string {
  switch (run.tool) {
    case "slice":
      return `Slice (${run.params.entryPoints.length} entry ${run.params.entryPoints.length === 1 ? "point" : "points"})`;
    case "scope":
      return "Scope suggestion";
    case "fixtures":
      return "Fake data";
    case "sandbox_build":
      return "Sandbox build";
    case "sandbox_starter":
      return "Generated starter";
    case "graphify":
      return "Graphify";
    case "dependency_cruiser":
      return "Dependency Cruiser";
    case "deepwiki":
      return "DeepWiki wiki";
    case "abstractions":
      return "Abstractions";
    case "data_model":
      return "Data model";
  }
}

/** The first seven characters, as Git shows a commit. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** How long a run took, once it has finished; nothing until then. */
export function runDuration(run: AnalysisRunDto): string | null {
  if (run.startedAt === null || run.finishedAt === null) return null;
  const seconds = Math.max(
    0,
    Math.round((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000),
  );
  return `${seconds}s`;
}
