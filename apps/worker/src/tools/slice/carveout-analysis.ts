/**
 * The slice analysis from carveout (`carveout/api` `analyse`, pinned exactly
 * in package.json), in the slice tool's terms: the manifest, the boundary
 * contract and the stubs carveout's `cut` writes a folder from, with what
 * only the platform knows put in (the snapshot, the graphify run, the
 * platform's own parameters and tool version) and what only carveout keeps
 * taken out.
 *
 * carveout walks the TypeScript compiler's resolution of the source, not
 * graphify's graph: the graph run is named and hashed in the manifest
 * because the slice was requested on it, but it chooses no file, and the
 * walk has no communities. A literal path read at runtime blocks nothing
 * (`pathReads: "omit"`): the slice tool has no way to carry one, and
 * graphify never reported them. Where carveout's analysis differs from the
 * platform's before it, carveout's NOTICE.md lists it.
 */

import { createRequire } from "node:module";
import { CutError, analyse } from "carveout/api";
import type { Analysis, PackageTypesFetcher } from "carveout/api";
import {
  SLICE_TOOL_VERSION,
  canonicalJson,
  type BoundaryContract,
  type CutEdge,
  type SliceExternals,
  type SliceManifest,
  type SliceParams,
} from "sandbox-factory";
import { AnalysisError } from "../../errors.js";
import { sha256 } from "carveout/extract";

/** The carveout release installed, as package.json pins it. */
export const CARVEOUT_VERSION = (
  createRequire(import.meta.url)("carveout/package.json") as {
    version: string;
  }
).version;

/** The manifest's `walkEngine` for every slice carveout walks. */
export const CARVEOUT_WALK_ENGINE = `carveout@${CARVEOUT_VERSION}`;

/** Everything a slice of one request is, before anything is written. */
export interface SliceAnalysis {
  readonly manifest: SliceManifest;
  readonly contract: BoundaryContract;
  readonly contractJson: string;
  readonly stubs: readonly { path: string; module: string; text: string }[];
  readonly ready: boolean;
}

/** What the platform knows of a slice that carveout does not. */
export interface SliceOrigin {
  readonly params: SliceParams;
  readonly snapshotId: string;
  readonly commitSha: string;
  readonly graphRunId: string;
  /** The graphify run's `graph.json`, hashed as the run stored it. */
  readonly graphSha256: string;
}

type CarveoutEdge = Analysis["manifest"]["internalImports"][number];

/** An edge as the platform's contract has it: carveout's `typeOnly` has no field there. */
const edgeOf = (edge: CarveoutEdge): CutEdge => ({
  from: edge.from,
  to: edge.to,
  relation: edge.relation,
  specifier: edge.specifier,
  location: edge.location,
  targetSymbol: null,
});

/**
 * carveout's analysis as the slice tool's: the snapshot, graph run and
 * platform parameters added, `toolVersion` the platform's (the shim it
 * generated with it), `walkEngine` carveout's, `communities` empty,
 * `sourceDirty` dropped, every edge's `typeOnly` dropped for a null
 * `targetSymbol`, and the contract hashed again with the fields added.
 */
export function fromCarveout(
  analysis: Analysis,
  origin: SliceOrigin,
): SliceAnalysis {
  const { manifest: carved, contract: carvedContract } = analysis;
  const contract: BoundaryContract = {
    schemaVersion: carvedContract.schemaVersion,
    toolVersion: SLICE_TOOL_VERSION,
    extractorVersion: carvedContract.extractorVersion,
    sourceSnapshotId: origin.snapshotId,
    sourceCommitSha: origin.commitSha,
    graphRunId: origin.graphRunId,
    language: carvedContract.language,
    outbound: carvedContract.outbound,
    inbound: carvedContract.inbound,
    stubCoverage: carvedContract.stubCoverage,
    compilation: carvedContract.compilation,
    blockers: carvedContract.blockers as BoundaryContract["blockers"],
  };
  const contractJson = canonicalJson(contract);
  const manifest: SliceManifest = {
    schemaVersion: carved.schemaVersion,
    toolVersion: SLICE_TOOL_VERSION,
    extractorVersion: carved.extractorVersion,
    sourceSnapshotId: origin.snapshotId,
    sourceCommitSha: origin.commitSha,
    graphRunId: origin.graphRunId,
    graphSha256: origin.graphSha256,
    walkEngine: CARVEOUT_WALK_ENGINE,
    params: origin.params,
    entryPoints: carved.entryPoints,
    budget: origin.params.budget,
    included: carved.included,
    synthetic: carved.synthetic.map((file) =>
      file.generator === "slice"
        ? { ...file, generatorVersion: SLICE_TOOL_VERSION }
        : file,
    ),
    requiredBuildInputs: carved.requiredBuildInputs,
    cuts: {
      outbound: carved.cuts.outbound.map(edgeOf),
      inbound: carved.cuts.inbound.map(edgeOf),
    },
    internalImports: carved.internalImports.map(edgeOf),
    externals: carved.externals,
    communities: [],
    blockers: contract.blockers,
    policy: carved.policy,
    boundaryContractSha256: sha256(contractJson),
    meta: carved.meta,
  };
  return {
    manifest,
    contract,
    contractJson,
    stubs: analysis.stubs,
    ready: analysis.ready,
  };
}

/**
 * A cut carveout cannot make at all, as the platform's `AnalysisError`:
 * `too_large` past the bytes a slice may copy; `tool_failed` when the entry
 * points reach nothing (`no_files`) or a file cannot be read
 * (`unreadable`). Any other error is not carveout's verdict, and passes.
 */
export function analysisErrorOf(error: unknown): unknown {
  if (!(error instanceof CutError)) return error;
  return new AnalysisError(
    error.code === "too_large" ? "too_large" : "tool_failed",
  );
}

/** Repository paths, as carveout names entry points: never graphify's `file:` node ids. */
const entryOf = (entry: string) =>
  entry.startsWith("file:") ? entry.slice(5) : entry;

/**
 * Slices one request with carveout: its walk, stubs, fixture compile and
 * manifest, mapped by `fromCarveout`. A cut carveout cannot make at all is
 * the platform's `AnalysisError`: `too_large` past the bytes a slice may
 * copy, `tool_failed` when the entry points reach nothing or a file cannot
 * be read.
 */
export async function analyseWithCarveout(input: {
  readonly sourceDir: string;
  readonly origin: SliceOrigin;
  readonly signal: AbortSignal;
  readonly log: (line: string) => void;
  readonly externalsOf?: (included: readonly string[]) => SliceExternals | null;
  readonly packageTypes?: PackageTypesFetcher;
}): Promise<SliceAnalysis> {
  const { params } = input.origin;
  let analysis: Analysis;
  try {
    analysis = await analyse({
      root: input.sourceDir,
      entries: params.entryPoints.map(entryOf),
      depth: params.budget.maxDepth,
      maxFiles: params.budget.maxFiles,
      withTests: false,
      commitSha: input.origin.commitSha,
      pathReads: "omit",
      signal: input.signal,
      log: input.log,
      ...(input.packageTypes === undefined
        ? {}
        : { packageTypes: input.packageTypes }),
      ...(input.externalsOf === undefined
        ? {}
        : { externalsOf: input.externalsOf }),
    });
  } catch (error) {
    if (error instanceof CutError) input.log(error.message);
    throw analysisErrorOf(error);
  }
  return fromCarveout(analysis, input.origin);
}
