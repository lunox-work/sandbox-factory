/**
 * The slice adapter: from a graphify run's graph and the source at the same
 * commit, the files a task needs and the shape of their boundary.
 *
 * Reads `graph.json` of the graphify run named in its parameters, walks it
 * with `reach`, reads the included files, extracts signatures for the cut
 * modules and the public surface (TypeScript and JavaScript; other
 * languages get names only), compiles the fixture, and writes the manifest,
 * the contract, the stubs and the readable views. Everything it writes is
 * a pure function of the graph, the source bytes and the parameters.
 */

import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  BOUNDARY_CONTRACT_SCHEMA_VERSION,
  OPERATION_POLICY,
  SLICE_MANIFEST_SCHEMA_VERSION,
  SLICE_TOOL_VERSION,
  boundarySummary,
  canonicalJson,
  detectExternals,
  isSliceParams,
  parseSliceGraph,
  reach,
  renderBoundaryMarkdown,
  renderPublicSurfaceMarkdown,
  sliceReadiness,
} from "sandbox-factory";
import type {
  BoundaryContract,
  BoundaryModule,
  CompilationResult,
  IncludedFile,
  SliceBlocker,
  SliceGraph,
  SliceManifest,
  SliceParams,
  StubCoverage,
  SyntheticFile,
} from "sandbox-factory";
import type { StoredAnalysisRun, StoredArtifact } from "@sandbox-factory/db";
import { AnalysisError } from "../errors.js";
import type {
  ArtifactFile,
  ToolAdapter,
  ToolInputs,
  ToolRunInput,
} from "./adapter.js";
import { SHIM_PATH, compileFixture, packageShim } from "./slice/fixture.js";
import { gitBlobId, gitFileMode, sha256 } from "./slice/hash.js";
import {
  declarationPathFor,
  extractTypeScriptBoundary,
  isNodeBuiltin,
  isDataPath,
  isScriptPath,
  packageNameOf,
} from "./slice/typescript.js";

/** Bytes of included source one slice may copy. */
export const INCLUDED_BYTES_MAX = 64 * 1024 * 1024;

export function sliceArtifactKind(path: string): ArtifactFile["kind"] {
  if (path === "slice-manifest.json") return "slice_manifest";
  if (path === "boundary-contract.json") return "boundary_contract";
  if (path === "boundary.md") return "boundary_md";
  if (path === "public-surface.md") return "public_surface_md";
  if (path === "abstract.md") return "abstract_md";
  return path.startsWith("stubs/") ? "stub" : "other";
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The version a package.json nearest the importing file pins, if any. */
async function pinnedVersion(
  root: string,
  from: string,
  name: string,
  cache: Map<string, Record<string, string> | null>,
): Promise<{ version: string | null; declaredIn: string | null }> {
  for (let dir = dirname(from); ; dir = dirname(dir)) {
    if (dir === "." || dir === "" || dir === "/") dir = "";
    const path = dir === "" ? "package.json" : `${dir}/package.json`;
    let declared = cache.get(path);
    if (declared === undefined) {
      declared = null;
      try {
        const parsed = JSON.parse(
          await readFile(join(root, path), "utf8"),
        ) as Record<string, unknown>;
        const merged: Record<string, string> = {};
        for (const key of [
          "dependencies",
          "devDependencies",
          "peerDependencies",
          "optionalDependencies",
        ]) {
          const section = parsed[key];
          if (section !== null && typeof section === "object")
            for (const [dependency, version] of Object.entries(section))
              if (typeof version === "string") merged[dependency] ??= version;
        }
        declared = merged;
      } catch {
        declared = null;
      }
      cache.set(path, declared);
    }
    const version = declared?.[name];
    if (version !== undefined) return { version, declaredIn: path };
    if (dir === "") return { version: null, declaredIn: null };
  }
}

async function readIncluded(
  sourceDir: string,
  files: readonly string[],
): Promise<Map<string, { bytes: Buffer; file: IncludedFile }>> {
  const result = new Map<string, { bytes: Buffer; file: IncludedFile }>();
  let total = 0;
  for (const path of files) {
    const absolute = resolve(sourceDir, path);
    const rel = relative(sourceDir, absolute);
    if (rel.startsWith("..") || isAbsolute(rel) || rel === "")
      throw new AnalysisError("tool_failed");
    const stats = await lstat(absolute).catch(() => null);
    if (stats === null || !stats.isFile())
      throw new AnalysisError("tool_failed");
    total += stats.size;
    if (total > INCLUDED_BYTES_MAX) throw new AnalysisError("too_large");
    const bytes = await readFile(absolute);
    result.set(path, {
      bytes,
      file: {
        path,
        blobId: gitBlobId(bytes),
        sha256: sha256(bytes),
        mode: gitFileMode(stats),
        sizeBytes: bytes.byteLength,
        operations: ["edit"],
      },
    });
  }
  return result;
}

function namesOnly(
  edges: readonly { to: string; from: string; targetSymbol: string | null }[],
  side: "to" | "from",
): BoundaryModule[] {
  const modules = new Map<
    string,
    { symbols: Set<string>; importedBy: Set<string> }
  >();
  for (const edge of edges) {
    const module = side === "to" ? edge.to : edge.from;
    const by = side === "to" ? edge.from : edge.to;
    const entry = modules.get(module) ?? {
      symbols: new Set(),
      importedBy: new Set(),
    };
    if (edge.targetSymbol !== null)
      entry.symbols.add(edge.targetSymbol.replace(/\(\)$/, ""));
    entry.importedBy.add(by);
    modules.set(module, entry);
  }
  return [...modules.entries()]
    .sort(([a], [b]) => compare(a, b))
    .map(([module, entry]) => ({
      module,
      symbols: [...entry.symbols].sort(compare).map((name) => ({
        name,
        kind: "unknown",
        declaration: null,
      })),
      importedBy: [...entry.importedBy].sort(compare),
      stubPath: null,
    }));
}

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

/** Everything a slice of one request is, before anything is written. */
export interface SliceAnalysis {
  readonly manifest: SliceManifest;
  readonly contract: BoundaryContract;
  readonly contractJson: string;
  readonly stubs: readonly { path: string; module: string; text: string }[];
  readonly ready: boolean;
}

/**
 * Slices one request: walks the graph, reads the included files, extracts
 * the boundary, compiles the fixture and assembles the manifest. A pure
 * function of the graph, the source bytes and the parameters; the slice
 * tool writes its result, and the scope agent checks its proposals with it.
 */
export async function analyseSlice(input: {
  readonly sourceDir: string;
  readonly graph: LoadedGraph;
  readonly params: SliceParams;
  readonly run: { readonly snapshotId: string; readonly commitSha: string };
  readonly signal: AbortSignal;
  readonly log: (line: string) => void;
}): Promise<SliceAnalysis> {
  const { params, graph } = input;
  const graphRun = graph.run;
  const graphBytes = graph.bytes;
  input.signal.throwIfAborted();
  const walk = reach(graph.graph, params.entryPoints, params.budget, {
    includeInferred: params.includeInferred,
  });
  input.log(
    `Slice reached ${walk.included.length} files with ${walk.cuts.outbound.length} outbound and ${walk.cuts.inbound.length} inbound cuts.`,
  );
  const blockers: SliceBlocker[] = walk.unknownEntryPoints.map((entry) => ({
    code: "unknown_entry_point",
    file: null,
    location: null,
    detail: `${entry} names no file in the graph.`,
  }));
  if (walk.included.length === 0) {
    // Nothing to slice: say which entry points missed before failing.
    for (const blocker of blockers) input.log(blocker.detail);
    throw new AnalysisError("tool_failed");
  }
  const included = await readIncluded(input.sourceDir, walk.included);
  input.signal.throwIfAborted();
  const texts = new Map<string, string>();
  for (const [path, { bytes }] of included)
    texts.set(path, bytes.toString("utf8"));
  const externals = detectExternals(
    [...texts.entries()].map(([path, text]) => ({ path, text })),
  );
  const packageFiles = new Map<string, Set<string>>();
  // The source is read without its node_modules, so the graph cannot
  // tell an installed package from a missing one: every bare specifier
  // is a package, pinned or not; a relative path that misses is broken.
  const isBare = (specifier: string | null): specifier is string =>
    specifier !== null &&
    !specifier.startsWith(".") &&
    !specifier.startsWith("/");
  for (const dependency of walk.dependencies) {
    if (dependency.status !== "dynamic" && isBare(dependency.specifier)) {
      if (isNodeBuiltin(dependency.specifier)) continue;
      const files = packageFiles.get(dependency.specifier) ?? new Set();
      files.add(dependency.file);
      packageFiles.set(dependency.specifier, files);
    } else
      blockers.push({
        code:
          dependency.status === "dynamic"
            ? "dynamic_dependency"
            : "unresolved_import",
        file: dependency.file,
        location: dependency.location,
        detail:
          dependency.status === "dynamic"
            ? "A dynamic import of a computed name cannot be resolved."
            : `${dependency.specifier ?? ""} does not resolve to a repository file.`,
      });
  }
  // A JSON or stylesheet import does not make a TypeScript slice
  // untyped; code in another language does.
  const scripted =
    walk.included.some(isScriptPath) &&
    walk.included.every((path) => isScriptPath(path) || isDataPath(path));
  let language: BoundaryContract["language"] = "none";
  let extractorVersion: string | null = null;
  let outbound: BoundaryModule[];
  let inbound: BoundaryModule[];
  let stubs: readonly { path: string; module: string; text: string }[] = [];
  let configs: string[] = [];
  let compilation: CompilationResult = {
    attempted: false,
    ok: false,
    diagnostics: [],
    shimmedPackages: [],
  };
  const synthetic: SyntheticFile[] = [];
  if (scripted) {
    language = "typescript";
    const boundary = extractTypeScriptBoundary({
      root: input.sourceDir,
      included: walk.included,
      outbound: walk.cuts.outbound,
      inbound: walk.cuts.inbound,
      texts,
    });
    input.signal.throwIfAborted();
    extractorVersion = boundary.extractorVersion;
    outbound = [...boundary.outbound];
    inbound = [...boundary.inbound];
    stubs = boundary.stubs;
    configs = [...boundary.configs];
    blockers.push(...boundary.blockers);
    for (const [specifier, files] of boundary.packages) {
      const list = packageFiles.get(specifier) ?? new Set();
      for (const file of files) list.add(file);
      packageFiles.set(specifier, list);
    }
    const shimmed = [...new Set([...packageFiles.keys()].map(packageNameOf))];
    const fixture = new Map<string, string>(texts);
    for (const stub of stubs)
      fixture.set(declarationPathFor(stub.module), stub.text);
    const shim = packageShim(shimmed);
    fixture.set(SHIM_PATH, shim);
    compilation = compileFixture({
      root: input.sourceDir,
      files: fixture,
      compilerOptions: boundary.compilerOptions,
      shimmedPackages: shimmed,
    });
    for (const diagnostic of compilation.diagnostics.slice(0, 20))
      blockers.push({
        code: "compile_error",
        file: diagnostic.file,
        location: diagnostic.line === null ? null : `L${diagnostic.line}`,
        detail: `${diagnostic.code}: ${diagnostic.message}`,
      });
    synthetic.push({
      path: SHIM_PATH,
      kind: "shim",
      generator: "slice",
      generatorVersion: SLICE_TOOL_VERSION,
      sha256: sha256(shim),
      sizeBytes: Buffer.byteLength(shim),
    });
    input.log(
      compilation.ok
        ? "Fixture compiled with stubs in place."
        : `Fixture compilation reported ${compilation.diagnostics.length} errors.`,
    );
  } else {
    outbound = namesOnly(walk.cuts.outbound, "to");
    inbound = namesOnly(walk.cuts.inbound, "from");
    blockers.push({
      code: "no_extractor",
      file: null,
      location: null,
      detail: "Signature extraction exists for TypeScript and JavaScript only.",
    });
  }
  const versions = new Map<string, Record<string, string> | null>();
  const packages: {
    name: string;
    version: string | null;
    declaredIn: string | null;
  }[] = [];
  for (const name of [
    ...new Set([...packageFiles.keys()].map(packageNameOf)),
  ].sort(compare)) {
    const from = [...packageFiles.entries()]
      .filter(([specifier]) => packageNameOf(specifier) === name)
      .flatMap(([, files]) => [...files])
      .sort(compare)[0];
    const pinned = await pinnedVersion(
      input.sourceDir,
      from ?? "",
      name,
      versions,
    );
    packages.push({ name, ...pinned });
    if (pinned.version === null)
      blockers.push({
        code: "missing_build_input",
        file: from ?? null,
        location: null,
        detail: `${name} is imported but no package.json pins its version.`,
      });
  }
  for (const path of versions.keys())
    if (versions.get(path) !== null) configs.push(path);
  configs = [...new Set(configs)].sort(compare);
  const complete = (modules: readonly BoundaryModule[]) =>
    modules.every((module) =>
      module.symbols.every((symbol) => symbol.declaration !== null),
    );
  const stubCoverage: StubCoverage =
    language === "none"
      ? "names-only"
      : complete(outbound) &&
          complete(inbound) &&
          compilation.ok &&
          !blockers.some((blocker) => blocker.code === "declaration_incomplete")
        ? "full"
        : "partial";
  // The graph and the extractor can report the same missing import.
  const blockerKey = (blocker: SliceBlocker) =>
    `${blocker.code}\n${blocker.file ?? ""}\n${blocker.location ?? ""}\n${blocker.detail}`;
  const sortedBlockers = [
    ...new Map(
      blockers.map((blocker) => [blockerKey(blocker), blocker]),
    ).values(),
  ].sort((a, b) => compare(blockerKey(a), blockerKey(b)));
  const contract: BoundaryContract = {
    schemaVersion: BOUNDARY_CONTRACT_SCHEMA_VERSION,
    toolVersion: SLICE_TOOL_VERSION,
    extractorVersion,
    sourceSnapshotId: input.run.snapshotId,
    sourceCommitSha: input.run.commitSha,
    graphRunId: graphRun.id,
    language,
    outbound,
    inbound,
    stubCoverage,
    compilation,
    blockers: sortedBlockers,
  };
  const contractJson = canonicalJson(contract);
  for (const stub of stubs)
    synthetic.push({
      path: stub.path,
      kind: "stub",
      generator: "typescript-declaration-emit",
      generatorVersion: extractorVersion ?? SLICE_TOOL_VERSION,
      sha256: sha256(stub.text),
      sizeBytes: Buffer.byteLength(stub.text),
    });
  synthetic.sort((a, b) => compare(a.path, b.path));
  const includedFiles = [...included.values()].map(({ file }) => file);
  const includedBytes = includedFiles.reduce(
    (total, file) => total + file.sizeBytes,
    0,
  );
  const readiness = sliceReadiness({
    stubCoverage,
    blockers: sortedBlockers,
  });
  const manifest: SliceManifest = {
    schemaVersion: SLICE_MANIFEST_SCHEMA_VERSION,
    toolVersion: SLICE_TOOL_VERSION,
    extractorVersion,
    sourceSnapshotId: input.run.snapshotId,
    sourceCommitSha: input.run.commitSha,
    graphRunId: graphRun.id,
    graphSha256: sha256(graphBytes),
    params,
    entryPoints: walk.entries,
    budget: params.budget,
    included: includedFiles,
    synthetic,
    requiredBuildInputs: { configs, packages },
    cuts: walk.cuts,
    internalImports: walk.internal,
    externals,
    communities: walk.communities,
    blockers: sortedBlockers,
    policy: OPERATION_POLICY,
    boundaryContractSha256: sha256(contractJson),
    meta: {
      includedFiles: includedFiles.length,
      includedBytes,
      outboundCuts: walk.cuts.outbound.length,
      inboundCuts: walk.cuts.inbound.length,
      stubCoverage,
      externals: externals.packages.length + externals.environment.length,
      blockers: sortedBlockers.length,
      ready: readiness.ready,
    },
  };
  return {
    manifest,
    contract,
    contractJson,
    stubs,
    ready: readiness.ready,
  };
}

export function createSliceAdapter(): ToolAdapter {
  return {
    name: "slice",
    version: SLICE_TOOL_VERSION,
    async run(input: ToolRunInput): Promise<ArtifactFile[]> {
      const params = input.params;
      if (!isSliceParams(params)) throw new AnalysisError("tool_failed");
      input.log("Slice started.");
      const graph = await loadGraph(
        input.inputs,
        params.graphRunId,
        input.run.snapshotId,
      );
      const { manifest, contract, contractJson, stubs, ready } =
        await analyseSlice({
          sourceDir: input.sourceDir,
          graph,
          params,
          run: input.run,
          signal: input.signal,
          log: input.log,
        });
      // The touched communities' wiki pages, so the reader has the narrative.
      const pages: string[] = [];
      for (const community of manifest.communities) {
        const page = await graph.readVerified(
          graph.artifacts.find(
            (artifact) =>
              artifact.kind === "wiki_page" &&
              artifact.path === `wiki/Community_${community}.md`,
          ),
        );
        if (page !== null) pages.push(page.toString("utf8").trim());
      }
      const abstract = `# Slice abstract\n\nCommunities ${manifest.communities.join(", ") || "(none)"} of graph run ${graph.run.id}, from the graphify wiki.\n\n${pages.length === 0 ? "No community pages were available." : pages.join("\n\n---\n\n")}\n`;
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
