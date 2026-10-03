import {
  sliceManifestSchema,
  boundaryContractSchema,
} from "@sandbox-factory/shared";
/**
 * A succeeded slice run, read back for the tools that build on it.
 *
 * The manifest and the contract are verified against their artifact
 * hashes, the declaration stubs are paired with the modules they stand
 * for, and the included source is read at the run's commit and verified
 * against the manifest. A slice that is gone, unfinished, on another
 * snapshot or altered is `slice_unavailable`; source bytes that differ from
 * the manifest are `source_unavailable`.
 */

import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { BoundaryContract, SliceManifest } from "sandbox-factory";
import type { StoredAnalysisRun, StoredArtifact } from "@sandbox-factory/db";
import { AnalysisError } from "../errors.js";
import type { ToolInputs } from "./adapter.js";
import { sha256 } from "./slice/hash.js";

export interface LoadedSliceRun {
  readonly run: StoredAnalysisRun;
  readonly manifest: SliceManifest;
  readonly contract: BoundaryContract;
  readonly manifestSha256: string;
  readonly contractSha256: string;
  readonly stubs: readonly { module: string; text: string }[];
}

/**
 * The module each stub artifact stands in for, as the contract records it.
 * A stub's path alone cannot say: `x.tsx` and `x.ts` share `x.d.ts`, and
 * `x.mts` becomes `x.d.mts`. A stub the contract does not list falls back
 * to the `.ts` reading of its path.
 */
export function stubModules(
  contract: Pick<BoundaryContract, "outbound">,
): (stubPath: string) => string {
  const byStub = new Map<string, string>();
  for (const module of contract.outbound)
    if (module.stubPath !== null) byStub.set(module.stubPath, module.module);
  return (stubPath) =>
    byStub.get(stubPath) ??
    `${stubPath.replace(/^stubs\//, "").replace(/\.d\.[cm]?ts$/, "")}.ts`;
}

export async function loadSliceRun(
  inputs: ToolInputs,
  sliceRunId: string,
  snapshotId: string,
): Promise<LoadedSliceRun> {
  const run = await inputs.getRun(sliceRunId);
  if (
    run === null ||
    run.tool !== "slice" ||
    run.status !== "succeeded" ||
    run.snapshotId !== snapshotId
  )
    throw new AnalysisError("slice_unavailable");
  const artifacts = await inputs.listArtifacts(run.id);
  const readVerified = async (artifact: StoredArtifact | undefined) => {
    if (artifact === undefined) throw new AnalysisError("slice_unavailable");
    const bytes = await inputs.readArtifact(artifact.objectKey);
    if (bytes === undefined || sha256(bytes) !== artifact.sha256)
      throw new AnalysisError("slice_unavailable");
    return Buffer.from(bytes).toString("utf8");
  };
  const manifestArtifact = artifacts.find((a) => a.kind === "slice_manifest");
  const contractArtifact = artifacts.find(
    (a) => a.kind === "boundary_contract",
  );
  let manifest: SliceManifest;
  let contract: BoundaryContract;
  try {
    manifest = sliceManifestSchema.parse(
      JSON.parse(await readVerified(manifestArtifact)),
    );
    contract = boundaryContractSchema.parse(
      JSON.parse(await readVerified(contractArtifact)),
    );
  } catch (error) {
    if (error instanceof AnalysisError) throw error;
    throw new AnalysisError("slice_unavailable");
  }
  const moduleOf = stubModules(contract);
  const stubs: { module: string; text: string }[] = [];
  for (const artifact of artifacts.filter((a) => a.kind === "stub"))
    stubs.push({
      module: moduleOf(artifact.path),
      text: await readVerified(artifact),
    });
  return {
    run,
    manifest,
    contract,
    manifestSha256: manifestArtifact?.sha256 ?? "",
    contractSha256: contractArtifact?.sha256 ?? "",
    stubs,
  };
}

/** The included files at the pinned commit, verified against the manifest. */
export async function readIncludedSource(
  sourceDir: string,
  manifest: Pick<SliceManifest, "included">,
): Promise<{ path: string; text: string }[]> {
  const included: { path: string; text: string }[] = [];
  for (const file of manifest.included) {
    const absolute = resolve(sourceDir, file.path);
    const rel = relative(sourceDir, absolute);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel))
      throw new AnalysisError("source_unavailable");
    const bytes = await readFile(absolute).catch(() => null);
    if (bytes === null || sha256(bytes) !== file.sha256)
      throw new AnalysisError("source_unavailable");
    included.push({ path: file.path, text: bytes.toString("utf8") });
  }
  return included;
}
