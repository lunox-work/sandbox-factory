import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import ts from "typescript-compiler";
import type { StoredAnalysisRun, StoredArtifact } from "@sandbox-factory/db";
import type { SliceManifest, BoundaryContract } from "sandbox-factory";
import { AnalysisError } from "../src/errors.js";
import { createSliceAdapter, sliceArtifactKind } from "../src/tools/slice.js";
import {
  compileFixture,
  packageShim,
  packageUses,
  UNTYPED_PACKAGE_CODES,
  UNTYPED_PACKAGE_OPTIONS,
} from "../src/tools/slice/fixture.js";
import { gitBlobId, gitFileMode, sha256 } from "../src/tools/slice/hash.js";
import {
  declarationPathFor,
  extractTypeScriptBoundary,
  filterDeclaration,
  importsOf,
  isDataPath,
  isNodeBuiltin,
  loadConfig,
  packageNameOf,
  sanitizeDeclaration,
  stubPathFor,
} from "../src/tools/slice/typescript.js";
import type { ToolInputs, ToolRunInput } from "../src/tools/adapter.js";

const fixture = fileURLToPath(
  new URL("../../fixtures/slice/", import.meta.url),
);
const stamp = "2026-10-02T00:00:00.000Z";
const graphRun: StoredAnalysisRun = {
  id: "arn_graph",
  snapshotId: "rsn_1",
  repoId: "ghr_1",
  tool: "graphify",
  toolVersion: "test",
  params: { deadlineMinutes: 30 },
  status: "succeeded",
  attempt: 0,
  maxAttempts: 2,
  errorCode: null,
  errorDetail: null,
  progress: null,
  previewFiles: null,
  startedAt: stamp,
  finishedAt: stamp,
  deadlineAt: stamp,
  createdAt: stamp,
};

/** A graph in the driver's shape: file nodes, resolved and unresolved imports. */
function graphOf(
  edges: readonly (readonly [string, string, string?])[],
  communities: Record<string, string[]>,
) {
  const nodes = new Map<string, Record<string, unknown>>();
  const links: Record<string, unknown>[] = [];
  const community = (file: string) =>
    Number(
      Object.entries(communities).find(([, files]) =>
        files.includes(file),
      )?.[0] ?? 0,
    );
  for (const [from, to, specifier] of edges) {
    nodes.set(`file:${from}`, {
      id: `file:${from}`,
      label: from,
      source_file: from,
      community: community(from),
    });
    if (to.startsWith("dependency:")) {
      const status = to.includes(":external:") ? "external" : "unresolved";
      const id = to.replace(":external:", ":");
      nodes.set(id, {
        id,
        label: id.split(":").at(-1),
        source_file: from,
        community: community(from),
        dependencyStatus: status,
      });
      links.push({
        source: `file:${from}`,
        target: id,
        relation: "imports",
        confidence: "EXTRACTED",
        specifier: specifier ?? null,
        resolved: false,
        source_location: "L1",
      });
    } else {
      nodes.set(`file:${to}`, {
        id: `file:${to}`,
        label: to,
        source_file: to,
        community: community(to),
      });
      links.push({
        source: `file:${from}`,
        target: `file:${to}`,
        relation: "imports",
        confidence: "EXTRACTED",
        specifier: specifier ?? null,
        resolved: true,
        source_location: "L1",
      });
    }
  }
  return {
    schemaVersion: 1,
    directed: true,
    multigraph: true,
    nodes: [...nodes.values()],
    links,
    communities: Object.fromEntries(
      Object.entries(communities).map(([id, files]) => [
        id,
        files.map((f) => `file:${f}`),
      ]),
    ),
  };
}
const typescriptGraph = graphOf(
  [
    ["src/app.ts", "lib/service.ts", "../lib/service.js"],
    ["src/app.ts", "lib/alias.ts", "@lib/alias"],
    ["src/app.ts", "lib/reexport.ts", "../lib/reexport.js"],
    ["src/app.ts", "lib/helpers.ts", "../lib/helpers.js"],
    ["src/app.ts", "dependency:src/app.ts:external:pg", "pg"],
    ["src/local.ts", "src/app.ts", "./app.js"],
    ["lib/service.ts", "lib/types.ts", "./types.js"],
    ["lib/service.ts", "lib/origin.ts", "./origin.js"],
    ["lib/reexport.ts", "lib/origin.ts", "./origin.js"],
    ["lib/reexport.ts", "lib/star.ts", "./star.js"],
    ["consumers/cli.ts", "src/app.ts", "../src/app.js"],
    ["src/broken.ts", "dependency:src/broken.ts:missing.js", "./missing.js"],
    ["src/broken.ts", "dependency:src/broken.ts:dynamic:L3"],
  ],
  {
    "0": ["src/app.ts", "src/local.ts", "consumers/cli.ts"],
    "1": ["lib/service.ts", "lib/types.ts", "lib/origin.ts"],
    "2": ["src/broken.ts"],
  },
);
const pythonGraph = graphOf(
  [
    ["scripts/tool.py", "scripts/helper.py", "scripts.helper"],
    ["scripts/tool.py", "dependency:scripts/tool.py:external:boto3", "boto3"],
  ],
  { "0": ["scripts/tool.py", "scripts/helper.py"] },
);

function inputsFor(
  graph: unknown,
  overrides: Partial<{
    run: StoredAnalysisRun | null;
    corrupt: boolean;
    pages: boolean;
  }> = {},
) {
  const objects = new Map<string, Buffer>();
  const artifacts: StoredArtifact[] = [];
  const add = (kind: StoredArtifact["kind"], path: string, text: string) => {
    const bytes = Buffer.from(text);
    objects.set(`runs/${graphRun.id}/lease/${path}`, bytes);
    artifacts.push({
      id: `art_${artifacts.length}`,
      runId: graphRun.id,
      kind,
      path,
      objectKey: `runs/${graphRun.id}/lease/${path}`,
      contentType: "application/json",
      sizeBytes: bytes.byteLength,
      sha256:
        overrides.corrupt === true
          ? "0".repeat(64)
          : createHash("sha256").update(bytes).digest("hex"),
      meta: null,
      createdAt: stamp,
    });
  };
  add("graph_json", "graph.json", JSON.stringify(graph));
  if (overrides.pages !== false) {
    add(
      "wiki_page",
      "wiki/Community_0.md",
      "# Community 0\n\nThe app and its callers.\n",
    );
    add(
      "wiki_page",
      "wiki/Community_1.md",
      "# Community 1\n\nThe service layer.\n",
    );
  }
  const inputs: ToolInputs = {
    getRun: async (id) =>
      id === graphRun.id
        ? overrides.run === undefined
          ? graphRun
          : overrides.run
        : null,
    listArtifacts: async (id) => (id === graphRun.id ? artifacts : []),
    readArtifact: async (key) => objects.get(key),
    getVersion: async () => null,
    getTask: async () => null,
    recordBuildOutput: async () => false,
    recordStarterOutput: async () => false,
  };
  return inputs;
}
async function runSlice(
  outDir: string,
  entryPoints: string[],
  options: Partial<{
    budget: { maxFiles: number; maxDepth: number };
    graph: unknown;
    inputs: ToolInputs;
    sourceDir: string;
    includeInferred: boolean;
  }> = {},
) {
  const messages: string[] = [];
  const input: ToolRunInput = {
    sourceDir: options.sourceDir ?? fixture,
    outDir,
    params: {
      deadlineMinutes: 30,
      graphRunId: graphRun.id,
      entryPoints,
      budget: options.budget ?? { maxFiles: 40, maxDepth: 3 },
      includeInferred: options.includeInferred ?? false,
    },
    run: { snapshotId: "rsn_1", commitSha: "a".repeat(40) },
    inputs: options.inputs ?? inputsFor(options.graph ?? typescriptGraph),
    signal: new AbortController().signal,
    log: (line) => messages.push(line),
  };
  const files = await createSliceAdapter().run(input);
  const read = async (path: string) => readFile(join(outDir, path), "utf8");
  const manifest = JSON.parse(
    await read("slice-manifest.json"),
  ) as SliceManifest;
  const contract = JSON.parse(
    await read("boundary-contract.json"),
  ) as BoundaryContract;
  return { files, manifest, contract, read, messages };
}
async function scratch(name: string) {
  return mkdtemp(join(tmpdir(), `slice-${name}-`));
}

test("a TypeScript slice gets compilable stubs, a public surface and a pinned manifest", async () => {
  const out = await scratch("full");
  try {
    const { files, manifest, contract, read } = await runSlice(
      out,
      ["src/app.ts", "src/local.ts"],
      {
        budget: { maxFiles: 2, maxDepth: 3 },
      },
    );
    assert.deepEqual(
      manifest.included.map((file) => file.path),
      ["src/app.ts", "src/local.ts"],
    );
    const app = await readFile(join(fixture, "src/app.ts"));
    assert.equal(manifest.included[0]?.blobId, gitBlobId(app));
    assert.equal(manifest.included[0]?.sha256, sha256(app));
    assert.equal(manifest.included[0]?.mode, "100644");
    assert.deepEqual(manifest.included[0]?.operations, ["edit"]);
    assert.equal(manifest.sourceCommitSha, "a".repeat(40));
    assert.equal(manifest.graphRunId, graphRun.id);
    assert.equal(
      manifest.boundaryContractSha256,
      sha256(await read("boundary-contract.json")),
    );
    assert.equal(manifest.meta.stubCoverage, "full");
    assert.equal(manifest.meta.ready, true);
    assert.deepEqual(manifest.blockers, []);
    assert.deepEqual(manifest.requiredBuildInputs, {
      configs: ["package.json", "tsconfig.json"],
      packages: [
        { name: "pg", version: "^8.11.0", declaredIn: "package.json" },
      ],
    });
    assert.deepEqual(manifest.policy.synthetic, "rejected");
    assert.deepEqual(manifest.externals, {
      packages: [
        { specifier: "pg", service: "postgres", files: ["src/app.ts"] },
      ],
      environment: [{ name: "DATABASE_URL", files: ["src/app.ts"] }],
    });
    assert.deepEqual(manifest.communities, [0]);
    assert.deepEqual(
      contract.outbound.map((module) => module.module),
      [
        "lib/alias.ts",
        "lib/helpers.ts",
        "lib/origin.ts",
        "lib/reexport.ts",
        "lib/service.ts",
        "lib/types.ts",
      ],
    );
    const service = contract.outbound.find(
      (module) => module.module === "lib/service.ts",
    );
    assert.deepEqual(
      service?.symbols.map((symbol) => [symbol.name, symbol.kind]),
      [
        ["ServiceOptions", "interface"],
        ["createService", "function"],
      ],
    );
    assert.deepEqual(service?.importedBy, ["src/app.ts"]);
    assert.equal(service?.stubPath, "stubs/lib/service.d.ts");
    const serviceStub = await read("stubs/lib/service.d.ts");
    assert.match(serviceStub, /export declare class Service \{/);
    assert.match(serviceStub, /describe\(label: string\): Thing;/);
    // Private members stay only as one nameless brand.
    assert.match(serviceStub, /#private;/);
    assert.doesNotMatch(serviceStub, /secret|options;|private /);
    assert.doesNotMatch(serviceStub, /return |unused/);
    assert.match(serviceStub, /import type \{ Config \} from "\.\/types\.js";/);
    // The nested type a kept interface needs arrives; the unrelated one does not.
    const typesStub = await read("stubs/lib/types.d.ts");
    assert.match(typesStub, /interface Config/);
    assert.match(typesStub, /interface Nested/);
    assert.doesNotMatch(typesStub, /Unrelated/);
    // A re-export resolves to its origin; the untouched star stays out.
    assert.match(
      await read("stubs/lib/reexport.d.ts"),
      /export type \{ Thing \} from "\.\/origin\.js";/,
    );
    assert.doesNotMatch(await read("stubs/lib/reexport.d.ts"), /star/);
    assert.match(await read("stubs/lib/origin.d.ts"), /interface Thing/);
    assert.equal(
      files.some((file) => file.path === "stubs/lib/star.d.ts"),
      false,
    );
    // A namespace import read only as `helpers.label` asks for `label`
    // alone; a path alias resolves.
    assert.match(await read("stubs/lib/helpers.d.ts"), /label\(\): string;/);
    assert.doesNotMatch(await read("stubs/lib/helpers.d.ts"), /other/);
    assert.match(await read("stubs/lib/alias.d.ts"), /fromAlias/);
    assert.deepEqual(
      contract.inbound.map((module) => [module.module, module.importedBy]),
      [["src/app.ts", ["consumers/cli.ts"]]],
    );
    assert.equal(contract.inbound[0]?.symbols[0]?.name, "run");
    assert.match(
      contract.inbound[0]?.symbols[0]?.declaration ?? "",
      /run\(options: ServiceOptions\): Thing;/,
    );
    assert.equal(contract.compilation.ok, true);
    assert.deepEqual(contract.compilation.shimmedPackages, ["pg"]);
    assert.deepEqual(
      manifest.synthetic.map((file) => [file.path, file.kind]),
      [
        ["__slice__/packages.d.ts", "shim"],
        ["stubs/lib/alias.d.ts", "stub"],
        ["stubs/lib/helpers.d.ts", "stub"],
        ["stubs/lib/origin.d.ts", "stub"],
        ["stubs/lib/reexport.d.ts", "stub"],
        ["stubs/lib/service.d.ts", "stub"],
        ["stubs/lib/types.d.ts", "stub"],
      ],
    );
    const boundary = await read("boundary.md");
    assert.match(boundary, /## Stubbed modules[\s\S]*### `lib\/service.ts`/);
    assert.match(boundary, /## Public surface[\s\S]*\*\*run\*\*/);
    assert.match(boundary, /`pg` \(postgres\)/);
    assert.match(await read("public-surface.md"), /\*\*run\*\*/);
    assert.match(
      await read("abstract.md"),
      /Community 0[\s\S]*The app and its callers/,
    );
    assert.doesNotMatch(await read("abstract.md"), /service layer/);
    assert.deepEqual(files.map((file) => [file.path, file.kind]).slice(0, 5), [
      ["abstract.md", "abstract_md"],
      ["boundary-contract.json", "boundary_contract"],
      ["boundary.md", "boundary_md"],
      ["public-surface.md", "public_surface_md"],
      ["slice-manifest.json", "slice_manifest"],
    ]);
    const summary = files.find((file) => file.kind === "boundary_contract")
      ?.meta as {
      ready: boolean;
      outbound: { module: string; symbols: string[] }[];
    };
    assert.equal(summary.ready, true);
    assert.deepEqual(summary.outbound[4], {
      module: "lib/service.ts",
      symbols: ["ServiceOptions", "createService"],
      importedBy: ["src/app.ts"],
      truncated: false,
    });
    assert.deepEqual(
      files.find((file) => file.kind === "slice_manifest")?.meta,
      manifest.meta,
    );
    // The fixture the sandbox rebuilds type-checks from the pinned files and stubs.
    const rebuilt = new Map<string, string>();
    for (const file of manifest.included)
      rebuilt.set(file.path, await readFile(join(fixture, file.path), "utf8"));
    for (const file of manifest.synthetic)
      rebuilt.set(
        file.kind === "stub" ? file.path.replace(/^stubs\//, "") : file.path,
        await read(
          file.path === "__slice__/packages.d.ts"
            ? "stubs/../__slice__/packages.d.ts"
            : file.path,
        ).catch(() => packageShim(["pg"])),
      );
    const recompiled = compileFixture({
      root: fixture,
      files: rebuilt,
      compilerOptions: loadConfig(fixture, "src/app.ts").options,
      shimmedPackages: ["pg"],
    });
    assert.deepEqual(recompiled.diagnostics, []);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test("the same slice twice gives byte-identical artifacts", async () => {
  const [a, b] = await Promise.all([scratch("det-a"), scratch("det-b")]);
  try {
    const first = await runSlice(a, ["src/app.ts"], {
      budget: { maxFiles: 1, maxDepth: 3 },
    });
    const second = await runSlice(b, ["src/app.ts"], {
      budget: { maxFiles: 1, maxDepth: 3 },
    });
    for (const file of first.files)
      assert.equal(
        await first.read(file.path),
        await second.read(file.path),
        file.path,
      );
    assert.equal(first.manifest.included.length, 1);
    assert.equal(first.manifest.meta.inboundCuts, 2);
  } finally {
    await rm(a, { recursive: true, force: true });
    await rm(b, { recursive: true, force: true });
  }
});

test("unresolved and dynamic imports block readiness and the compile reports them", async () => {
  const out = await scratch("broken");
  try {
    const { manifest, contract, read, messages } = await runSlice(out, [
      "src/broken.ts",
      "nowhere.ts",
    ]);
    assert.deepEqual(
      contract.blockers.map((blocker) => blocker.code),
      [
        "compile_error",
        "dynamic_dependency",
        "missing_build_input",
        "unknown_entry_point",
        "unresolved_import",
      ],
    );
    assert.deepEqual(manifest.requiredBuildInputs.packages, [
      { name: "unpinned-package", version: null, declaredIn: null },
    ]);
    assert.equal(contract.stubCoverage, "partial");
    assert.equal(manifest.meta.ready, false);
    assert.equal(contract.compilation.ok, false);
    assert.match(
      contract.compilation.diagnostics[0]?.message ?? "",
      /missing\.js/,
    );
    assert.match(await read("boundary.md"), /## Blockers/);
    assert.match(
      messages.at(-1) ?? "",
      /diagnostic output \(partial, 5 blockers\)/,
    );
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test("an import of the repository's own workspace package is marked, and the registry each other comes from recorded", async () => {
  const [out, source] = await Promise.all([
    scratch("workspace"),
    scratch("workspace-src"),
  ]);
  try {
    const write = async (path: string, text: string) => {
      await mkdir(dirname(join(source, path)), { recursive: true });
      await writeFile(join(source, path), text);
    };
    await write("package.json", JSON.stringify({ private: true }));
    await write(
      "pnpm-workspace.yaml",
      "packages:\n  - apps/*\n  - packages/**\n",
    );
    await write(".npmrc", "@payflow:registry=https://npm.payflow.dev/\n");
    await write(
      "package-lock.json",
      JSON.stringify({
        packages: {
          "node_modules/zod": {
            resolved: "https://registry.npmjs.org/zod/-/zod-4.0.0.tgz",
          },
        },
      }),
    );
    await write(
      "packages/shared/package.json",
      JSON.stringify({ name: "@acme/shared", version: "0.0.0" }),
    );
    await write(
      "apps/web/package.json",
      JSON.stringify({
        name: "web",
        dependencies: {
          "@acme/shared": "*",
          "@payflow/ui": "^1.0.0",
          zod: "^4.0.0",
        },
      }),
    );
    await write(
      "apps/web/src/index.ts",
      'import { greet } from "@acme/shared";\nimport { button } from "@payflow/ui";\nimport { z } from "zod";\nexport const hello = greet(z.string().parse(button));\n',
    );
    const { manifest, contract } = await runSlice(
      out,
      ["apps/web/src/index.ts"],
      {
        sourceDir: source,
        graph: graphOf(
          [
            [
              "apps/web/src/index.ts",
              "dependency:apps/web/src/index.ts:external:@acme/shared",
              "@acme/shared",
            ],
            [
              "apps/web/src/index.ts",
              "dependency:apps/web/src/index.ts:external:@payflow/ui",
              "@payflow/ui",
            ],
            [
              "apps/web/src/index.ts",
              "dependency:apps/web/src/index.ts:external:zod",
              "zod",
            ],
          ],
          { "0": ["apps/web/src/index.ts"] },
        ),
      },
    );
    assert.deepEqual(manifest.requiredBuildInputs.packages, [
      {
        name: "@acme/shared",
        version: "*",
        declaredIn: "apps/web/package.json",
        workspace: true,
      },
      {
        name: "@payflow/ui",
        version: "^1.0.0",
        declaredIn: "apps/web/package.json",
        registry: { source: "private", evidence: ".npmrc" },
      },
      {
        name: "zod",
        version: "^4.0.0",
        declaredIn: "apps/web/package.json",
        registry: { source: "public", evidence: "package-lock.json" },
      },
    ]);
    assert.equal(
      contract.blockers.some((b) => b.code === "missing_build_input"),
      false,
    );
  } finally {
    await rm(out, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

test("a language without an extractor still gets the manifest and names", async () => {
  const out = await scratch("python");
  try {
    const { manifest, contract, read } = await runSlice(
      out,
      ["scripts/tool.py"],
      {
        graph: pythonGraph,
        budget: { maxFiles: 1, maxDepth: 1 },
      },
    );
    assert.equal(contract.language, "none");
    assert.equal(contract.stubCoverage, "names-only");
    assert.equal(contract.compilation.attempted, false);
    assert.deepEqual(contract.outbound, [
      {
        module: "scripts/helper.py",
        symbols: [],
        importedBy: ["scripts/tool.py"],
        stubPath: null,
      },
    ]);
    assert.deepEqual(
      contract.blockers.map((b) => b.code),
      ["missing_build_input", "no_extractor"],
    );
    assert.deepEqual(manifest.requiredBuildInputs.packages, [
      { name: "boto3", version: null, declaredIn: null },
    ]);
    assert.deepEqual(
      manifest.externals.packages.map((p) => p.specifier),
      ["boto3"],
    );
    assert.deepEqual(
      manifest.externals.environment.map((e) => e.name),
      ["BUCKET"],
    );
    assert.match(await read("boundary.md"), /names-only/);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test("a missing, unfinished, foreign or corrupt graph is graph_unavailable; bad parameters fail", async () => {
  const out = await scratch("graph");
  try {
    for (const inputs of [
      inputsFor(typescriptGraph, { run: null }),
      inputsFor(typescriptGraph, { run: { ...graphRun, status: "running" } }),
      inputsFor(typescriptGraph, {
        run: { ...graphRun, snapshotId: "rsn_other" },
      }),
      inputsFor(typescriptGraph, { run: { ...graphRun, tool: "slice" } }),
      inputsFor(typescriptGraph, { corrupt: true }),
      inputsFor("not a graph"),
      { ...inputsFor(typescriptGraph), listArtifacts: async () => [] },
    ])
      await assert.rejects(
        runSlice(out, ["src/app.ts"], { inputs }),
        (error: unknown) =>
          error instanceof AnalysisError && error.code === "graph_unavailable",
      );
    await assert.rejects(
      createSliceAdapter().run({
        sourceDir: fixture,
        outDir: out,
        params: { deadlineMinutes: 30 },
        run: { snapshotId: "rsn_1", commitSha: "a".repeat(40) },
        inputs: inputsFor(typescriptGraph),
        signal: new AbortController().signal,
        log: () => {},
      }),
      (error: unknown) =>
        error instanceof AnalysisError && error.code === "tool_failed",
    );
    await assert.rejects(
      runSlice(out, ["nowhere.ts"]),
      (error: unknown) =>
        error instanceof AnalysisError && error.code === "tool_failed",
    );
    // A graph naming a file the source lacks is a failure, never a silent drop.
    const empty = await scratch("empty-source");
    try {
      await assert.rejects(
        runSlice(out, ["src/app.ts"], { sourceDir: empty }),
        (error: unknown) =>
          error instanceof AnalysisError && error.code === "tool_failed",
      );
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
    const { read } = await runSlice(out, ["src/local.ts"], {
      budget: { maxFiles: 1, maxDepth: 0 },
      inputs: inputsFor(typescriptGraph, { pages: false }),
    });
    assert.match(await read("abstract.md"), /No community pages/);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test("declaration filtering keeps requested exports and what they reference", () => {
  const text = [
    'import { Dep, Spare } from "./dep.js";',
    'import type * as ns from "./ns.js";',
    'import def = require("./legacy");',
    "declare const inner: Dep;",
    "export declare const [first, second]: [number, string];",
    "export declare function used(value: typeof inner): Spare;",
    "export declare function unused(): void;",
    "export default class Main {}",
    "export declare function viaNamespace(): ns.Thing;",
    "declare enum Local { A }",
    "export { Local as Renamed };",
    'export type Alias = import("./other.js").Other;',
    'export * from "./star.js";',
    "",
  ].join("\n");
  const picked = filterDeclaration(
    text,
    new Set(["used", "Renamed", "Alias", "ghost"]),
  );
  assert.match(picked.text, /declare const inner: Dep;/);
  assert.match(picked.text, /export declare function used/);
  assert.doesNotMatch(picked.text, /unused|class Main|first/);
  assert.match(picked.text, /declare enum Local/);
  assert.match(picked.text, /export \{ Local as Renamed \};/);
  assert.match(picked.text, /export \* from "\.\/star\.js";/);
  assert.deepEqual(picked.missing, []);
  assert.deepEqual(picked.forwarded, [
    { specifier: "./star.js", names: new Set(["ghost"]) },
  ]);
  assert.deepEqual(
    picked.imports.map((item) => [
      item.specifier,
      item.names === "*" ? "*" : [...item.names],
    ]),
    [
      ["./dep.js", ["Dep", "Spare"]],
      ["./other.js", ["Other"]],
    ],
  );
  assert.deepEqual(
    picked.symbols.map((symbol) => [symbol.name, symbol.kind]),
    [
      ["used", "function"],
      ["Renamed", "enum"],
      ["Alias", "type"],
    ],
  );
  const nothing = filterDeclaration(
    "declare const a: number;\n",
    new Set(["b"]),
  );
  assert.deepEqual(nothing.missing, ["b"]);
  assert.equal(nothing.text, "export {};\n");
  const all = filterDeclaration(text, "*");
  assert.match(all.text, /unused/);
  assert.deepEqual(all.forwarded, [{ specifier: "./star.js", names: "*" }]);
  assert.ok(
    all.symbols.some(
      (symbol) => symbol.name === "default" && symbol.kind === "class",
    ),
  );
  assert.ok(
    all.imports.some(
      (item) => item.specifier === "./legacy" && item.names === "*",
    ),
  );
  // A namespace read only through `ns.Thing` asks for `Thing`; one that
  // escapes (`typeof m`) asks for the whole module.
  assert.deepEqual(
    all.imports
      .filter((item) => item.specifier === "./ns.js")
      .map((item) => (item.names === "*" ? "*" : [...item.names])),
    [["Thing"]],
  );
  assert.deepEqual(
    filterDeclaration(
      'import d, * as m from "./m.js";\nexport declare const whole: typeof m;\nexport declare const one: m.One;\n',
      new Set(["one"]),
    ).imports.map((item) => [
      item.specifier,
      item.names === "*" ? "*" : [...item.names].sort(),
    ]),
    [["./m.js", ["One", "default"]]],
  );
  assert.deepEqual(
    filterDeclaration(
      'import * as m from "./m.js";\nexport declare const whole: typeof m;\n',
      "*",
    ).imports.map((item) => item.names),
    ["*"],
  );
  const equals = filterDeclaration(
    "declare function f(): void;\nexport = f;\n",
    "*",
  );
  assert.deepEqual(
    equals.symbols.map((symbol) => symbol.name),
    ["export="],
  );
  const namespaced = filterDeclaration(
    'export * as grouped from "./group.js";\nexport { a as b } from "./ab.js";\n',
    new Set(["grouped", "b"]),
  );
  assert.deepEqual(
    namespaced.imports.map((item) => [
      item.specifier,
      item.names === "*" ? "*" : [...item.names],
    ]),
    [
      ["./group.js", "*"],
      ["./ab.js", ["a"]],
    ],
  );
  assert.equal(
    filterDeclaration(
      "import x = Outer.Inner;\nexport declare const y: typeof x;\n",
      new Set(["y"]),
    ).text.includes("import x = Outer.Inner;"),
    true,
  );
});

test("one export list naming several locals gives each name its own declaration", () => {
  const picked = filterDeclaration(
    [
      "declare function make(): void;",
      "interface Shape {}",
      "declare const limit = 3;",
      "export { make as Create, Shape as Form, limit };",
    ].join("\n"),
    new Set(["Create", "Form", "limit"]),
  );
  assert.deepEqual(
    picked.symbols.map((symbol) => [
      symbol.name,
      symbol.kind,
      symbol.declaration,
    ]),
    [
      ["Create", "function", "declare function make(): void;"],
      ["Form", "interface", "interface Shape {}"],
      ["limit", "variable", "declare const limit = 3;"],
    ],
  );
});

test("import facts cover every import syntax, and helpers name paths and packages", () => {
  const source = ts.createSourceFile(
    "x.ts",
    [
      'import "./effect.js";',
      'import def, { named as renamed } from "./a.js";',
      'import * as all from "./b.js";',
      'export { re } from "./c.js";',
      'export * from "./d.js";',
      'import legacy = require("./e");',
      'const lazy = () => import("./f.js");',
      'const cjs = require("./g.js");',
      'type T = import("./h.js").Deep.Thing;',
      'type U = import("./i.js");',
      "const dynamic = (n: string) => import(n);",
      "const one = all.one + { all: 1 }.all;",
      "type Two = all.Two;",
      'import * as esc from "./j.js";',
      "console.log(esc);",
    ].join("\n"),
    ts.ScriptTarget.Latest,
    true,
  );
  assert.deepEqual(
    importsOf(source).map((fact) => [
      fact.specifier,
      fact.names === "*" ? "*" : [...fact.names].sort(),
      fact.line,
    ]),
    [
      ["./effect.js", [], 1],
      ["./a.js", ["default", "named"], 2],
      ["./b.js", ["Two", "one"], 3],
      ["./c.js", ["re"], 4],
      ["./d.js", "*", 5],
      ["./e", "*", 6],
      ["./j.js", "*", 14],
      ["./f.js", "*", 7],
      ["./g.js", "*", 8],
      ["./h.js", ["Deep"], 9],
      ["./i.js", "*", 10],
    ],
  );
  assert.equal(
    stubPathFor("packages/x/src/y.tsx"),
    "stubs/packages/x/src/y.d.ts",
  );
  assert.equal(declarationPathFor("lib/already.d.ts"), "lib/already.d.ts");
  assert.equal(declarationPathFor("lib/already.d.mts"), "lib/already.d.mts");
  assert.equal(declarationPathFor("lib/z.mts"), "lib/z.d.mts");
  assert.equal(declarationPathFor("lib/w.cjs"), "lib/w.d.cts");
  assert.equal(declarationPathFor("data/config.json"), "data/config.json.d.ts");
  assert.equal(
    packageNameOf("@aws-sdk/client-s3/dist/x"),
    "@aws-sdk/client-s3",
  );
  assert.equal(packageNameOf("pg/lib"), "pg");
  assert.equal(isNodeBuiltin("node:fs"), true);
  assert.equal(isNodeBuiltin("fs/promises"), true);
  assert.equal(isNodeBuiltin("pg"), false);
  // Data a script imports rides along; other languages' code does not.
  assert.equal(isDataPath("src/data.json"), true);
  assert.equal(isDataPath("src/theme.css"), true);
  assert.equal(isDataPath("scripts/tool.py"), false);
  assert.equal(isDataPath("src/app.ts"), false);
  assert.deepEqual(
    [
      "slice-manifest.json",
      "boundary-contract.json",
      "boundary.md",
      "public-surface.md",
      "abstract.md",
      "stubs/a.d.ts",
      "x",
    ].map(sliceArtifactKind),
    [
      "slice_manifest",
      "boundary_contract",
      "boundary_md",
      "public_surface_md",
      "abstract_md",
      "stub",
      "other",
    ],
  );
  assert.equal(gitFileMode({ mode: 0o100755 }), "100755");
  assert.equal(
    gitBlobId(Buffer.from("hello\n")),
    "ce013625030ba8dba906f756967f9e9ca394464a",
  );
});

test("configuration that reaches outside the source or cannot be read is a build-input blocker", async () => {
  const root = await scratch("config");
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(
      join(root, "tsconfig.json"),
      '{ "extends": "../outside/tsconfig.json", "compilerOptions": { "strict": true } }',
    );
    await writeFile(join(root, "src/a.ts"), "export const a = 1;\n");
    const loaded = loadConfig(root, "src/a.ts");
    assert.equal(loaded.path, "tsconfig.json");
    assert.equal(loaded.options.strict, true);
    assert.equal(loaded.errors.length, 1);
    await writeFile(join(root, "tsconfig.json"), "{ not json");
    assert.ok(loadConfig(root, "src/a.ts").errors.length >= 1);
    assert.equal(loadConfig(root, "../elsewhere/a.ts").path, null);
    const none = await scratch("noconfig");
    try {
      await writeFile(join(none, "a.ts"), "export const a = 1;\n");
      const bare = loadConfig(none, "a.ts");
      assert.equal(bare.path, null);
      assert.equal(bare.options.allowJs, true);
      const compiled = compileFixture({
        root: none,
        files: new Map([
          [
            "a.ts",
            'import { b } from "./b.js";\nimport fs from "node:fs";\nimport { readFile } from "fs/promises";\nimport path from "path";\nimport pkg from "pkg/sub";\nexport const a: number = b + Number(fs) + Number(pkg) + Number(path) + Number(readFile);\n',
          ],
          ["b.d.ts", "export declare const b: number;\n"],
          ["__slice__/packages.d.ts", packageShim(["pkg"])],
        ]),
        compilerOptions: bare.options,
        shimmedPackages: ["pkg", "pkg"],
      });
      assert.deepEqual(compiled, {
        attempted: true,
        ok: true,
        diagnostics: [],
        shimmedPackages: ["pkg"],
      });
      const failing = compileFixture({
        root: none,
        files: new Map([["a.ts", "export const a: string = 1;\n"]]),
        compilerOptions: bare.options,
        shimmedPackages: [],
      });
      assert.equal(failing.ok, false);
      assert.deepEqual(failing.diagnostics[0], {
        file: "a.ts",
        line: 1,
        code: "TS2322",
        message: "Type 'number' is not assignable to type 'string'.",
      });
    } finally {
      await rm(none, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("React code checks against shimmed packages: their names are types too, and JSX takes any element", async () => {
  const root = await scratch("react");
  try {
    const files = new Map([
      [
        "src/button.tsx",
        [
          'import * as React from "react";',
          'import { cva, type VariantProps } from "class-variance-authority";',
          'import { Slot } from "radix-ui";',
          'import Default from "pkg";',
          'import { z } from "zod";',
          'import * as mod from "mod";',
          'const variants = cva("base");',
          "type Inner = Default.Inner<string>;",
          "export type Shape = z.infer<typeof variants>;",
          "export function Button({",
          "  asChild,",
          "  ...props",
          '}: React.ComponentProps<"button"> &',
          "  VariantProps<typeof variants> & { asChild?: boolean; inner?: Inner }) {",
          "  const [count] = React.useState<number>(0);",
          "  // Reserved words read off a package are not declared, but still read.",
          "  mod.default(mod.delete);",
          '  const Comp = asChild ? Slot.Root : "button";',
          "  return <Comp data-count={count} {...props} />;",
          "}",
        ].join("\n"),
      ],
      [
        "src/notice.tsx",
        [
          'import { items } from "pkg";',
          "// React's global namespace, as @types/react declares it.",
          "export function Notice({ children }: { children: React.ReactNode }) {",
          "  const mode: string = import.meta.env.MODE;",
          "  return <p title={mode}>{items.map((item) => item)}{children}</p>;",
          "}",
        ].join("\n"),
      ],
    ]);
    const packages = [
      "class-variance-authority",
      "mod",
      "pkg",
      "radix-ui",
      "react",
      "zod",
    ];
    const uses = packageUses(files, (specifier) =>
      packages.includes(specifier),
    );
    const names = (specifier: string) => [
      ...(uses.modules.get(specifier)?.members.keys() ?? []),
    ];
    assert.deepEqual(names("react"), ["ComponentProps", "useState"]);
    assert.deepEqual(names("class-variance-authority"), [
      "cva",
      "VariantProps",
    ]);
    assert.deepEqual(names("pkg"), ["default", "items"]);
    assert.deepEqual(
      [
        ...(uses.modules.get("pkg")?.members.get("default")?.members.keys() ??
          []),
      ],
      ["Inner"],
    );
    assert.deepEqual(
      [...(uses.globals.get("React")?.members.keys() ?? [])],
      ["ReactNode"],
    );

    const compile = (shim: string) =>
      compileFixture({
        root,
        files: new Map([...files, ["__slice__/packages.d.ts", shim]]),
        compilerOptions: {
          strict: true,
          jsx: ts.JsxEmit.ReactJSX,
          module: ts.ModuleKind.ESNext,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          ...UNTYPED_PACKAGE_OPTIONS,
        },
        shimmedPackages: packages,
        ignoredCodes: UNTYPED_PACKAGE_CODES,
      });
    assert.deepEqual(compile(packageShim(packages, uses)).diagnostics, []);
    // Untyped modules alone: every name used as a type, and JSX, fails.
    const untyped = compile(packageShim(packages));
    assert.equal(untyped.ok, false);
    assert.ok(
      untyped.diagnostics.some(({ code }) => code === "TS2709"),
      JSON.stringify(untyped.diagnostics),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stubs carry no literal values, comments or private members, and credential files block", async () => {
  const [out, source] = await Promise.all([
    scratch("private"),
    scratch("private-src"),
  ]);
  // Assembled at run time so the repository holds no key whole.
  const key = ["sk_", "live_", "123"].join("");
  try {
    const write = async (path: string, text: string) => {
      await mkdir(dirname(join(source, path)), { recursive: true });
      await writeFile(join(source, path), text);
    };
    await write(
      "src/app.ts",
      [
        'import { API_KEY, LIMIT, ENABLED, Mode, Client, Keys, CONFIG, HOSTS, TIER, BIG } from "./b.js";',
        'import * as util from "./u.js";',
        'import * as whole from "./w.js";',
        "export const run = () => [API_KEY, LIMIT, ENABLED, Mode.Live, new Client().send(), Keys.KEY, new Keys().inst, CONFIG.url, HOSTS, TIER, BIG, util.pick(), whole];",
        "",
      ].join("\n"),
    );
    await write(
      "src/b.ts",
      [
        "/** The gateway key for acme-internal: rotate it quarterly. */",
        `export const API_KEY = "${key}";`,
        "export const LIMIT = -5;",
        "export const ENABLED = true;",
        'export enum Mode { Live = "live", Off = "off" }',
        "export class Client {",
        "  /** Sends through relay.acme-internal */",
        "  send(): string { return this.token + this.#vault; }",
        '  private token = "t";',
        "  private rotateHiddenCredential(): void {}",
        "  #vault = 1;",
        "  /** @internal */",
        '  debugDump(): string { return ""; }',
        "}",
        "export class Keys {",
        `  static readonly KEY = "${key}";`,
        '  readonly inst = "internal.acme-internal";',
        '  readonly typed: "acme-typed" = "acme-typed";',
        "}",
        "export const CONFIG = {",
        '  url: "https://relay.acme-internal",',
        "  ports: [8443, -1],",
        "  on: true,",
        '  nested: { region: "acme-eu" },',
        "} as const;",
        'export const HOSTS = ["db.acme-internal", "cache.acme-internal"] as const;',
        'export const TIER: "acme-gold" = "acme-gold";',
        "export const BIG = 9007199254740993n;",
        "/** @internal */",
        "export function internalHelper(): void {}",
        "",
      ].join("\n"),
    );
    await write(
      "src/u.ts",
      "export function pick(): number { return 1; }\nexport function spare(): void {}\n",
    );
    await write(
      "src/w.ts",
      "export const one = 1;\nexport function two(): void {}\n",
    );
    await write("keys/service-account.json", '{ "type": "service_account" }\n');
    const { manifest, contract, read } = await runSlice(
      out,
      ["src/app.ts", "keys/service-account.json"],
      {
        sourceDir: source,
        budget: { maxFiles: 2, maxDepth: 1 },
        graph: graphOf(
          [
            ["src/app.ts", "src/b.ts", "./b.js"],
            ["src/app.ts", "src/u.ts", "./u.js"],
            ["src/app.ts", "src/w.ts", "./w.js"],
            ["src/app.ts", "keys/service-account.json"],
          ],
          { "0": ["src/app.ts"] },
        ),
      },
    );
    assert.deepEqual(
      manifest.included.map((file) => file.path),
      ["keys/service-account.json", "src/app.ts"],
    );
    assert.deepEqual(
      contract.blockers.filter((b) => b.code === "secret_file"),
      [
        {
          code: "secret_file",
          file: "keys/service-account.json",
          location: null,
          detail:
            "keys/service-account.json is a credentials file; a slice may not include it. Import fixture values instead.",
        },
      ],
    );
    const stub = await read("stubs/src/b.d.ts");
    assert.match(stub, /export declare const API_KEY: string;/);
    assert.match(stub, /export declare const LIMIT: number;/);
    assert.match(stub, /export declare const ENABLED: boolean;/);
    // Class properties, `as const` values and literal annotations are
    // widened through objects and tuples, as constants are.
    assert.match(stub, /static readonly KEY: string;/);
    assert.match(stub, /readonly inst: string;/);
    assert.match(stub, /readonly typed: string;/);
    assert.match(stub, /readonly url: string;/);
    assert.match(stub, /readonly ports: readonly \[\s*number,\s*number\s*\];/);
    assert.match(stub, /readonly on: boolean;/);
    assert.match(stub, /readonly region: string;/);
    assert.match(stub, /HOSTS: readonly \[\s*string,\s*string\s*\];/);
    assert.match(stub, /export declare const TIER: string;/);
    assert.match(stub, /export declare const BIG: bigint;/);
    // A string enum stays one, its members named for themselves.
    assert.match(stub, /Live = "Live"/);
    assert.match(stub, /Off = "Off"/);
    assert.match(stub, /#private;\n\s+send\(\): string;/);
    // An `@internal` member of a kept class stays, without its comment;
    // an `@internal` export nothing asks for is filtered out.
    assert.match(stub, /debugDump\(\): string;/);
    assert.doesNotMatch(
      stub,
      /sk_live|acme|relay|8443|9007199254740993|"live"|rotate|token|vault|Credential|internalHelper|\/\*|\/\//,
    );
    const declarations = contract.outbound
      .flatMap((module) => module.symbols)
      .map((symbol) => symbol.declaration ?? "");
    assert.ok(declarations.includes("export declare const API_KEY: string;"));
    assert.equal(JSON.stringify(contract).includes(key), false);
    // Read only as `util.pick`, the namespace asks for `pick`; passed on
    // as a value, `whole` asks for the whole module.
    assert.match(await read("stubs/src/u.d.ts"), /pick/);
    assert.doesNotMatch(await read("stubs/src/u.d.ts"), /spare/);
    assert.match(await read("stubs/src/w.d.ts"), /one[\s\S]*two/);
  } finally {
    await Promise.all([
      rm(out, { recursive: true, force: true }),
      rm(source, { recursive: true, force: true }),
    ]);
  }
});

test("only a value's type is widened: an API's literal types, null and numeric enums stay", () => {
  const text = sanitizeDeclaration(
    [
      'export type Event = { kind: "click" } | { kind: "key" };',
      'export interface Shape { readonly kind: "circle"; }',
      'export declare function pick(mode: "fast" | "slow"): void;',
      'export declare const run: (mode: "a") => "b";',
      'export declare const box: Map<"k", 1>;',
      "export declare const none: null;",
      "export declare const prefixed: `acme-${string}`;",
      'export declare const optional: [first?: "x", ...rest: "y"[]];',
      'export declare const pair: ["x"?, ..."y"[]];',
      'export declare const mixed: { a: "x" } & ({ b: 1 } | null);',
      "export declare enum Level { Low = 1, High = 2 }",
      'export declare enum Named { "two words" = "acme" }',
      "export declare const plain: string;",
      "",
    ].join("\n"),
  );
  assert.match(text, /kind: "click"/);
  assert.match(text, /readonly kind: "circle"/);
  assert.match(text, /mode: "fast" \| "slow"/);
  assert.match(text, /\(mode: "a"\) => "b"/);
  assert.match(text, /Map<"k", 1>/);
  assert.match(text, /none: null/);
  assert.match(text, /prefixed: string/);
  assert.match(text, /\[\s*first\?: string,\s*\.\.\.rest: string\[\]\s*\]/);
  assert.match(text, /\[\s*string\?,\s*\.\.\.string\[\]\s*\]/);
  assert.match(text, /\{\s*a: string;\s*\} & \(\{\s*b: number;\s*\} \| null\)/);
  assert.match(text, /Low = 1,\s*High = 2/);
  assert.match(text, /"two words" = "two words"/);
  assert.doesNotMatch(text, /acme/);
});

test("an @internal declaration the slice imports or a kept declaration names is stubbed across the cut", async () => {
  const [out, source] = await Promise.all([
    scratch("internal"),
    scratch("internal-src"),
  ]);
  try {
    const write = async (path: string, text: string) => {
      await mkdir(dirname(join(source, path)), { recursive: true });
      await writeFile(join(source, path), text);
    };
    await write(
      "src/app.ts",
      [
        'import { internalHelper, make } from "./b.js";',
        "export const run = () => [internalHelper(), make().depth];",
        "",
      ].join("\n"),
    );
    await write(
      "src/b.ts",
      [
        "/** @internal Only the app reaches this. */",
        "export function internalHelper(): number { return 1; }",
        "/** @internal */",
        "export interface Hidden { depth: number }",
        "export function make(): Hidden { return { depth: 1 }; }",
        "/** @internal */",
        "export function unused(): void {}",
        "",
      ].join("\n"),
    );
    const { contract, read } = await runSlice(out, ["src/app.ts"], {
      sourceDir: source,
      budget: { maxFiles: 1, maxDepth: 1 },
      graph: graphOf([["src/app.ts", "src/b.ts", "./b.js"]], {
        "0": ["src/app.ts"],
      }),
    });
    assert.deepEqual(
      contract.blockers.filter(
        (b) =>
          b.code === "declaration_incomplete" || b.code === "compile_error",
      ),
      [],
    );
    const stub = await read("stubs/src/b.d.ts");
    assert.match(stub, /export declare function internalHelper\(\): number;/);
    assert.match(stub, /export interface Hidden/);
    assert.match(stub, /export declare function make\(\): Hidden;/);
    // What nothing asks for or names is not stubbed, and no comment is.
    assert.doesNotMatch(stub, /unused|@internal|\/\*/);
  } finally {
    await Promise.all([
      rm(out, { recursive: true, force: true }),
      rm(source, { recursive: true, force: true }),
    ]);
  }
});

test("a program past the file ceiling stops with a blocker instead of compiling on", async () => {
  const root = await scratch("ceiling");
  try {
    const texts = new Map([
      ["a.ts", 'import { b } from "./b.js";\nexport const a = b;\n'],
      ["b.ts", 'import { c } from "./c.js";\nexport const b = c;\n'],
      ["c.ts", "export const c = 1;\n"],
    ]);
    for (const [path, text] of texts) await writeFile(join(root, path), text);
    const input = {
      root,
      included: ["a.ts"],
      outbound: [
        {
          from: "a.ts",
          to: "b.ts",
          relation: "imports",
          specifier: "./b.js",
          location: null,
          targetSymbol: null,
        },
      ],
      inbound: [],
      texts,
    };
    const capped = extractTypeScriptBoundary({ ...input, maxProgramFiles: 2 });
    assert.deepEqual(capped.stubs, []);
    assert.equal(capped.blockers.at(-1)?.code, "declaration_incomplete");
    assert.match(
      capped.blockers.at(-1)?.detail ?? "",
      /more than 2 repository files/,
    );
    // Under the ceiling the same input compiles and stubs its cut module.
    const whole = extractTypeScriptBoundary(input);
    assert.deepEqual(
      whole.stubs.map((stub) => stub.module),
      ["b.ts"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
