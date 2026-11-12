/**
 * The slice adapter: from a request on a graphify run and the source at
 * the same commit, the files a task needs and the shape of their boundary.
 *
 * carveout analyses the slice (`slice/carveout-analysis.ts`): it walks the
 * compiler's resolution of the source from the entry points, reads the
 * included files, extracts signatures for the cut modules and the public
 * surface (TypeScript and JavaScript; other languages get names only) and
 * compiles the fixture. This adapter checks the graph run the request
 * names, and writes the manifest, the contract, the stubs and the readable
 * views. Everything it writes is a pure function of the source bytes, the
 * graph run and the parameters.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  SLICE_TOOL_VERSION,
  boundarySummary,
  canonicalJson,
  isSliceParams,
  parseSliceGraph,
  renderBoundaryMarkdown,
  renderPublicSurfaceMarkdown,
} from "sandbox-factory";
import type { SliceExternals, SliceGraph, SliceParams } from "sandbox-factory";
import type { StoredAnalysisRun, StoredArtifact } from "@sandbox-factory/db";
import { AnalysisError } from "../errors.js";
import { snapshotOf } from "./adapter.js";
import type {
  ArtifactFile,
  ToolAdapter,
  ToolInputs,
  ToolRunInput,
} from "./adapter.js";
import {
  analyseWithCarveout,
  type SliceAnalysis,
} from "./slice/carveout-analysis.js";
import { type PackageTypesFetcher, sha256 } from "carveout/extract";

export type { SliceAnalysis } from "./slice/carveout-analysis.js";

export function sliceArtifactKind(path: string): ArtifactFile["kind"] {
  if (path === "slice-manifest.json") return "slice_manifest";
  if (path === "boundary-contract.json") return "boundary_contract";
  if (path === "boundary.md") return "boundary_md";
  if (path === "public-surface.md") return "public_surface_md";
  if (path === "abstract.md") return "abstract_md";
  return path.startsWith("stubs/") ? "stub" : "other";
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A succeeded graphify run's graph on the run's own snapshot, hash-verified. */
export interface LoadedGraph {
  readonly run: StoredAnalysisRun;
  readonly graph: SliceGraph;
  readonly bytes: Buffer;
  readonly artifacts: readonly StoredArtifact[];
  /** An artifact of that run, verified against its recorded hash. */
  readVerified(artifact: StoredArtifact | undefined): Promise<Buffer | null>;
}

export async function loadGraph(
  inputs: ToolInputs,
  graphRunId: string,
  snapshotId: string,
): Promise<LoadedGraph> {
  const graphRun = await inputs.getRun(graphRunId);
  if (
    graphRun === null ||
    graphRun.tool !== "graphify" ||
    graphRun.status !== "succeeded" ||
    graphRun.snapshotId !== snapshotId
  )
    throw new AnalysisError("graph_unavailable");
  const artifacts = await inputs.listArtifacts(graphRun.id);
  const readVerified = async (artifact: StoredArtifact | undefined) => {
    if (artifact === undefined) return null;
    const bytes = await inputs.readArtifact(artifact.objectKey);
    if (bytes === undefined || sha256(bytes) !== artifact.sha256)
      throw new AnalysisError("graph_unavailable");
    return Buffer.from(bytes);
  };
  const graphBytes = await readVerified(
    artifacts.find((artifact) => artifact.kind === "graph_json"),
  );
  if (graphBytes === null) throw new AnalysisError("graph_unavailable");
  let graph;
  try {
    graph = parseSliceGraph(JSON.parse(graphBytes.toString("utf8")));
  } catch {
    throw new AnalysisError("graph_unavailable");
  }
  return { run: graphRun, graph, bytes: graphBytes, artifacts, readVerified };
}

/**
 * Slices one request with carveout (`analyseWithCarveout`) on the graph
 * run it names. A pure function of the source bytes, the graph run and the
 * parameters; the slice tool writes its result, and the scope agent checks
 * its proposals with it.
 */
export async function analyseSlice(input: {
  readonly sourceDir: string;
  readonly graph: LoadedGraph;
  readonly params: SliceParams;
  readonly run: { readonly snapshotId: string; readonly commitSha: string };
  readonly signal: AbortSignal;
  readonly log: (line: string) => void;
  /**
   * The externals of the included files when an index already has them
   * all, as `detectExternals` would give them; null to read them here.
   */
  readonly externalsOf?: (included: readonly string[]) => SliceExternals | null;
  /**
   * Fetches the types of the public packages the slice reads; without it,
   * or when it fails, every package is untyped.
   */
  readonly packageTypes?: PackageTypesFetcher;
}): Promise<SliceAnalysis> {
  input.signal.throwIfAborted();
  return analyseWithCarveout({
    sourceDir: input.sourceDir,
    origin: {
      params: input.params,
      snapshotId: input.run.snapshotId,
      commitSha: input.run.commitSha,
      graphRunId: input.graph.run.id,
      graphSha256: sha256(input.graph.bytes),
    },
    signal: input.signal,
    log: input.log,
    ...(input.externalsOf === undefined
      ? {}
      : { externalsOf: input.externalsOf }),
    ...(input.packageTypes === undefined
      ? {}
      : { packageTypes: input.packageTypes }),
  });
}

export function createSliceAdapter(
  options: {
    readonly packageTypes?: PackageTypesFetcher;
  } = {},
): ToolAdapter {
  return {
    name: "slice",
    version: SLICE_TOOL_VERSION,
    async run(input: ToolRunInput): Promise<ArtifactFile[]> {
      const params = input.params;
      if (!isSliceParams(params)) throw new AnalysisError("tool_failed");
      const snapshot = snapshotOf(input);
      input.log("Slice started.");
      const graph = await loadGraph(
        input.inputs,
        params.graphRunId,
        snapshot.snapshotId,
      );
      const { manifest, contract, contractJson, stubs, ready } =
        await analyseSlice({
          sourceDir: input.sourceDir,
          graph,
          params,
          run: snapshot,
          signal: input.signal,
          log: input.log,
          ...(options.packageTypes === undefined
            ? {}
            : { packageTypes: options.packageTypes }),
        });
      // carveout's walk has no graphify communities, so no wiki page.
      const abstract = `# Slice abstract\n\nCommunities (none) of graph run ${graph.run.id}, from the graphify wiki.\n\nNo community pages were available.\n`;
      await mkdir(input.outDir, { recursive: true });
      const outputs: {
        path: string;
        text: string;
        meta: Record<string, unknown> | null;
      }[] = [
        {
          path: "slice-manifest.json",
          text: canonicalJson(manifest),
          meta: { ...manifest.meta },
        },
        {
          path: "boundary-contract.json",
          text: contractJson,
          meta: boundarySummary(contract, manifest) as unknown as Record<
            string,
            unknown
          >,
        },
        {
          path: "boundary.md",
          text: renderBoundaryMarkdown(contract, manifest),
          meta: null,
        },
        {
          path: "public-surface.md",
          text: renderPublicSurfaceMarkdown(contract),
          meta: null,
        },
        { path: "abstract.md", text: abstract, meta: null },
        ...stubs.map((stub) => ({
          path: stub.path,
          text: stub.text,
          meta: null,
        })),
      ];
      const files: ArtifactFile[] = [];
      for (const output of outputs) {
        const absolutePath = join(input.outDir, output.path);
        await mkdir(dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, output.text, "utf8");
        files.push({
          path: output.path,
          absolutePath,
          kind: sliceArtifactKind(output.path),
          contentType: output.path.endsWith(".json")
            ? "application/json"
            : "text/plain; charset=utf-8",
          meta: output.meta,
        });
      }
      input.log(
        ready
          ? "Slice completed with full declaration coverage."
          : `Slice completed as diagnostic output (${contract.stubCoverage}, ${contract.blockers.length} blockers).`,
      );
      return files.sort((a, b) => compare(a.path, b.path));
    },
  };
}
