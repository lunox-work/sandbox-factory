/**
 * A succeeded `abstractions` or `data_model` run, read back for the agents
 * that use it. The document is verified against its artifact hash and its
 * schema; a run that is gone, unfinished, on another snapshot or altered is
 * `context_unavailable`. The agents name these runs only when they exist,
 * so a failure here means something changed under the run.
 */

import {
  abstractionIndexSchema,
  dataModelSchema,
} from "@sandbox-factory/shared";
import type {
  AbstractionIndex,
  ArtifactKind,
  DataModel,
} from "sandbox-factory";
import type { z } from "zod";
import { AnalysisError } from "../errors.js";
import type { ToolInputs } from "./adapter.js";
import { sha256 } from "./slice/hash.js";

async function loadDocument<T>(
  inputs: ToolInputs,
  runId: string,
  snapshotId: string,
  tool: "abstractions" | "data_model",
  kind: ArtifactKind,
  schema: z.ZodType<T>,
): Promise<T> {
  const run = await inputs.getRun(runId);
  if (
    run === null ||
    run.tool !== tool ||
    run.status !== "succeeded" ||
    run.snapshotId !== snapshotId
  )
    throw new AnalysisError("context_unavailable");
  const artifact = (await inputs.listArtifacts(run.id)).find(
    (candidate) => candidate.kind === kind,
  );
  if (artifact === undefined) throw new AnalysisError("context_unavailable");
  const bytes = await inputs.readArtifact(artifact.objectKey);
  if (bytes === undefined || sha256(bytes) !== artifact.sha256)
    throw new AnalysisError("context_unavailable");
  const parsed = schema.safeParse(
    (() => {
      try {
        return JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
      } catch {
        return null;
      }
    })(),
  );
  if (!parsed.success) throw new AnalysisError("context_unavailable");
  return parsed.data;
}

export function loadAbstractions(
  inputs: ToolInputs,
  runId: string,
  snapshotId: string,
): Promise<AbstractionIndex> {
  return loadDocument(
    inputs,
    runId,
    snapshotId,
    "abstractions",
    "abstraction_index",
    abstractionIndexSchema as unknown as z.ZodType<AbstractionIndex>,
  );
}

export function loadDataModel(
  inputs: ToolInputs,
  runId: string,
  snapshotId: string,
): Promise<DataModel> {
  return loadDocument(
    inputs,
    runId,
    snapshotId,
    "data_model",
    "data_model",
    dataModelSchema as unknown as z.ZodType<DataModel>,
  );
}
