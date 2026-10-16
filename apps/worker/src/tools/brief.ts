/**
 * The brief adapter: one bounded document per snapshot (`renderBrief` in
 * core), from the file list, the stack its manifests name, and the newest
 * succeeded `abstractions`, `data_model` and `documents` runs on the same
 * snapshot. The queue holds a brief back until none of those is queued or
 * running, so it reads what the build made; a builder that failed is left
 * out, and the brief says less.
 *
 * No model, and nothing in the repository is executed: two builds of one
 * commit give one brief.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BRIEF_TOOL_VERSION,
  detectStack,
  isBriefParams,
  renderBrief,
  stackManifests,
  treeFacts,
} from "sandbox-factory";
import type {
  AbstractionIndex,
  DataModel,
  DocumentSet,
  StackManifest,
} from "sandbox-factory";
import { indexRepository } from "../agent/repo-tools.js";
import { AnalysisError } from "../errors.js";
import { snapshotOf } from "./adapter.js";
import type { ArtifactFile, ToolAdapter, ToolInputs } from "./adapter.js";
import {
  loadAbstractions,
  loadDataModel,
  loadDocumentSet,
} from "./context-runs.js";
import { sourceReader } from "./data-model.js";

export const BRIEF_PATH = "brief.md";

/**
 * A builder's document, when the snapshot has a succeeded run of it. One
 * that cannot be read is left out, as one that failed is.
 */
async function newest<T>(
  inputs: ToolInputs,
  snapshotId: string,
  tool: "abstractions" | "data_model" | "documents",
  load: (inputs: ToolInputs, runId: string, snapshotId: string) => Promise<T>,
  log: (line: string) => void,
): Promise<T | null> {
  const run = await inputs.latestSucceeded?.(snapshotId, tool);
  if (run == null) return null;
  try {
    return await load(inputs, run.id, snapshotId);
  } catch (error) {
    if (!(error instanceof AnalysisError)) throw error;
    log(`The ${tool} run could not be read; the brief goes without it.`);
    return null;
  }
}

export function createBriefAdapter(): ToolAdapter {
  return {
    name: "brief",
    version: BRIEF_TOOL_VERSION,
    async run(input) {
      if (!isBriefParams(input.params)) throw new AnalysisError("tool_failed");
      const snapshot = snapshotOf(input);
      const index = await indexRepository(input.sourceDir, input.signal);
      const files = index.paths.map((path) => ({
        path,
        size: index.sizes.get(path) ?? 0,
      }));
      const read = sourceReader(input.sourceDir);
      const manifests: StackManifest[] = [];
      for (const path of stackManifests(files)) {
        const text = await read(path);
        if (text !== null) manifests.push({ path, text });
      }
      const [abstractions, dataModel, documents] = await Promise.all([
        newest<AbstractionIndex>(
          input.inputs,
          snapshot.snapshotId,
          "abstractions",
          loadAbstractions,
          input.log,
        ),
        newest<DataModel>(
          input.inputs,
          snapshot.snapshotId,
          "data_model",
          loadDataModel,
          input.log,
        ),
        newest<DocumentSet>(
          input.inputs,
          snapshot.snapshotId,
          "documents",
          loadDocumentSet,
          input.log,
        ),
      ]);
      const text = renderBrief({
        facts: treeFacts(files),
        stack: detectStack({ languages: {}, files, manifests }),
        abstractions,
        dataModel,
        documents,
      });
      await mkdir(input.outDir, { recursive: true });
      const absolutePath = join(input.outDir, BRIEF_PATH);
      await writeFile(absolutePath, text, "utf8");
      input.log(`Brief written: ${text.length} characters.`);
      return [
        {
          path: BRIEF_PATH,
          absolutePath,
          kind: "brief_md",
          contentType: "text/markdown; charset=utf-8",
          meta: {
            chars: text.length,
            lines: text.split("\n").length,
            read: {
              abstractions: abstractions !== null,
              dataModel: dataModel !== null,
              documents: documents !== null,
            },
          },
        } satisfies ArtifactFile,
      ];
    },
  };
}
