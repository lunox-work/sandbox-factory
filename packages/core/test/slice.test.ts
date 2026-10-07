import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SliceGraphError,
  boundarySummary,
  detectExternals,
  entryPointPath,
  fileOf,
  isSliceParams,
  isTraversed,
  nodeKind,
  parseSliceGraph,
  reach,
  renderBoundaryMarkdown,
  renderPublicSurfaceMarkdown,
  serviceOf,
  sliceReadiness,
  toolVersionOf,
  OPERATION_POLICY,
  SUMMARY_LIMITS,
} from "../src/index.js";
import type {
  BoundaryContract,
  BoundaryModule,
  SliceManifest,
} from "../src/index.js";

/** The worker fixture's graph, as the driver wrote it on 2026-10-02. */
const fixture = {
  schemaVersion: 1,
  directed: true,
  nodes: [
    {
      id: "dependency:src/main.ts:dynamic:L9",
      label: "dynamic:L9",
      source_file: "src/main.ts",
      community: 0,
      dependencyStatus: "unresolved",
    },
    {
      id: "dependency:src/main.ts:missing-package",
      label: "missing-package",
      source_file: "src/main.ts",
      community: 0,
      dependencyStatus: "unresolved",
    },
    {
      id: "dependency:src/main.ts:pg",
      label: "pg",
      source_file: "src/main.ts",
      community: 0,
      dependencyStatus: "external",
    },
    {
      id: "file:packages/a/index.ts",
      label: "index.ts",
      source_file: "packages/a/index.ts",
      community: 1,
    },
    {
      id: "file:src/folder/index.ts",
      label: "index.ts",
      source_file: "src/folder/index.ts",
      community: 0,
    },
    {
      id: "file:src/main.ts",
      label: "main.ts",
      source_file: "src/main.ts",
      community: 0,
    },
    {
      id: "file:src/util.ts",
      label: "util.ts",
      source_file: "src/util.ts",
      community: 3,
    },
    {
      id: "file:src/deep.ts",
      label: "deep.ts",
      source_file: "src/deep.ts",
      community: 3,
    },
    {
      id: "symbol:src/main.ts:main_main",
      label: "main()",
      source_file: "src/main.ts",
      community: 0,
    },
    {
      id: "symbol:src/util.ts:util_helper",
      label: "helper()",
      source_file: "src/util.ts",
      community: 3,
    },
    {
      id: "symbol:packages/a/index.ts:index_shared",
      label: "shared()",
      source_file: "packages/a/index.ts",
      community: 1,
    },
  ],
  links: [
    {
      source: "file:src/main.ts",
      target: "symbol:src/main.ts:main_main",
      relation: "contains",
      confidence: "EXTRACTED",
    },
    {
      source: "file:src/main.ts",
      target: "dependency:src/main.ts:missing-package",
      relation: "imports",
      confidence: "EXTRACTED",
      specifier: "missing-package",
      source_location: "L4",
    },
    {
      source: "file:src/main.ts",
      target: "dependency:src/main.ts:dynamic:L9",
      relation: "imports",
      confidence: "EXTRACTED",
      specifier: null,
      source_location: "L9",
    },
    {
      source: "file:src/main.ts",
      target: "dependency:src/main.ts:pg",
      relation: "imports",
      confidence: "EXTRACTED",
      specifier: "pg",
      source_location: "L10",
    },
    {
      source: "file:src/main.ts",
      target: "file:src/util.ts",
      relation: "imports",
      confidence: "EXTRACTED",
      specifier: "./util.js",
      source_location: "L1",
    },
    {
      source: "file:src/main.ts",
      target: "file:src/util.ts",
      relation: "imports",
      confidence: "EXTRACTED",
      specifier: "@/util",
      source_location: "L3",
    },
    {
      source: "file:src/main.ts",
      target: "file:src/folder/index.ts",
      relation: "imports",
      confidence: "EXTRACTED",
      specifier: "./folder",
      source_location: "L2",
    },
    {
      source: "file:src/util.ts",
      target: "file:src/deep.ts",
      relation: "imports",
      confidence: "EXTRACTED",
      specifier: "./deep.js",
      source_location: "L1",
    },
    {
      source: "symbol:src/util.ts:util_helper",
      target: "symbol:src/main.ts:main_main",
      relation: "calls",
      confidence: "INFERRED",
    },
    {
      source: "file:packages/a/index.ts",
      target: "file:src/util.ts",
      relation: "imports",
      confidence: "EXTRACTED",
      specifier: "../../src/util.js",
      source_location: "L1",
    },
    {
      source: "file:src/deep.ts",
      target: "file:src/util.ts",
      relation: "imports",
      confidence: "EXTRACTED",
      specifier: "./util.js",
      source_location: "L1",
    },
  ],
  communities: {
    "0": ["file:src/main.ts"],
    "1": ["file:packages/a/index.ts"],
    "3": ["file:src/util.ts"],
  },
};
const budget = { maxFiles: 40, maxDepth: 3 };

test("the driver's graph parses into typed nodes, links and communities", () => {
  const graph = parseSliceGraph(fixture);
  assert.equal(graph.nodes.length, fixture.nodes.length);
  assert.equal(graph.links.length, fixture.links.length);
  assert.deepEqual([...graph.communities.keys()], [0, 1, 3]);
  assert.equal(nodeKind("file:a"), "file");
  assert.equal(nodeKind("symbol:a:b"), "symbol");
  assert.equal(nodeKind("dependency:a:b"), "dependency");
  assert.equal(nodeKind("doc:a"), "other");
  const dependency = graph.nodes.find((node) => node.kind === "dependency");
  assert.ok(dependency);
  assert.equal(fileOf(dependency), null);
  assert.equal(dependency.dependencyStatus, "unresolved");
  const parsed = parseSliceGraph({ nodes: [], links: [] });
  assert.equal(parsed.communities.size, 0);
  for (const broken of [
    null,
    { nodes: {}, links: [] },
    { nodes: [{ label: "x" }], links: [] },
    { nodes: [{ id: "file:a", source_file: "" }], links: [] },
    {
      nodes: [
        { id: "file:a", source_file: "a" },
        { id: "file:a", source_file: "a" },
      ],
      links: [],
    },
    {
      nodes: [{ id: "file:a", source_file: "a" }],
      links: [{ source: "file:a" }],
    },
    {
      nodes: [{ id: "file:a", source_file: "a" }],
      links: [{ source: "file:a", target: "file:b", relation: "imports" }],
    },
    { nodes: [], links: [], communities: [] },
    { nodes: [], links: [], communities: { x: ["a"] } },
    { nodes: [], links: [], communities: { "1": [1] } },
  ])
    assert.throws(() => parseSliceGraph(broken), SliceGraphError);
});

test("reach walks dependency relations breadth first inside the budget", () => {
  const graph = parseSliceGraph(fixture);
  const result = reach(graph, ["src/main.ts"], budget);
  assert.deepEqual(result.entries, ["src/main.ts"]);
  assert.deepEqual(result.included, [
    "src/deep.ts",
    "src/folder/index.ts",
    "src/main.ts",
    "src/util.ts",
  ]);
  assert.deepEqual(result.depthOf, {
    "src/main.ts": 0,
    "src/folder/index.ts": 1,
    "src/util.ts": 1,
    "src/deep.ts": 2,
  });
  assert.deepEqual(result.cuts.outbound, []);
  assert.deepEqual(
    result.cuts.inbound.map((edge) => [edge.from, edge.to, edge.targetSymbol]),
    [["packages/a/index.ts", "src/util.ts", null]],
  );
  // Imports that stay inside keep their specifiers, for the generator.
  assert.ok(result.internal.length > 0);
  assert.ok(
    result.internal.every(
      (edge) =>
        edge.specifier !== null &&
        result.included.includes(edge.from) &&
        result.included.includes(edge.to),
    ),
  );
  assert.ok(
    result.internal.some(
      (edge) => edge.from === "src/main.ts" && edge.to === "src/util.ts",
    ),
  );
  assert.deepEqual(
    reach(graph, ["src/util.ts"], budget, {
      includeInferred: true,
    }).cuts.inbound.map((edge) => edge.from),
    ["packages/a/index.ts"],
  );
  assert.equal(
    reach(
      graph,
      ["src/util.ts"],
      { maxFiles: 1, maxDepth: 3 },
      { includeInferred: true },
    ).cuts.outbound.find((edge) => edge.relation === "calls")?.targetSymbol,
    "main()",
  );
  assert.deepEqual(
    result.dependencies.map((d) => [d.specifier, d.status]),
    [
      [null, "dynamic"],
      ["missing-package", "unresolved"],
      ["pg", "external"],
    ],
  );
  assert.deepEqual(result.communities, [0, 3]);
  assert.deepEqual(result.unknownEntryPoints, []);
});

test("budgets cut the first file past them on every path, deterministically", () => {
  const graph = parseSliceGraph(fixture);
  const files = reach(graph, ["file:src/main.ts"], {
    maxFiles: 2,
    maxDepth: 3,
  });
  // Path order within a level: `src/folder/index.ts` sorts before `src/util.ts`.
  assert.deepEqual(files.included, ["src/folder/index.ts", "src/main.ts"]);
  assert.deepEqual(
    files.cuts.outbound.map(
      (edge) => `${edge.from} -> ${edge.to} (${edge.specifier})`,
    ),
    [
      "src/main.ts -> src/util.ts (./util.js)",
      "src/main.ts -> src/util.ts (@/util)",
    ],
  );
  const depth = reach(graph, ["src/main.ts"], { maxFiles: 40, maxDepth: 1 });
  assert.deepEqual(depth.included, [
    "src/folder/index.ts",
    "src/main.ts",
    "src/util.ts",
  ]);
  assert.deepEqual(
    depth.cuts.outbound.map((edge) => edge.to),
    ["src/deep.ts"],
  );
  assert.deepEqual(depth.cuts.inbound.map((edge) => edge.from).sort(), [
    "packages/a/index.ts",
    "src/deep.ts",
  ]);
  // The same inputs with the arrays shuffled give the same slice.
  const shuffled = parseSliceGraph({
    ...fixture,
    nodes: [...fixture.nodes].reverse(),
    links: [...fixture.links].reverse(),
  });
  assert.deepEqual(
    reach(shuffled, ["src/main.ts"], { maxFiles: 2, maxDepth: 3 }),
    files,
  );
  assert.deepEqual(
    reach(graph, ["src/main.ts"], { maxFiles: 0, maxDepth: 0 }).included,
    [],
  );
});

test("inferred edges are walked only on request, and cycles terminate", () => {
  const graph = parseSliceGraph(fixture);
  assert.deepEqual(reach(graph, ["src/util.ts"], budget).included, [
    "src/deep.ts",
    "src/util.ts",
  ]);
  assert.deepEqual(
    reach(graph, ["src/util.ts"], budget, { includeInferred: true }).included,
    ["src/deep.ts", "src/folder/index.ts", "src/main.ts", "src/util.ts"],
  );
  assert.equal(isTraversed("uses_component"), true);
  assert.equal(isTraversed("contains"), false);
  assert.equal(isTraversed("defines"), false);
});

test("entry points may be node ids, files or directories; unknown ones are reported", () => {
  const graph = parseSliceGraph(fixture);
  const result = reach(
    graph,
    [
      "symbol:src/util.ts:util_helper",
      "/packages/",
      "nowhere.ts",
      "",
      "dependency:src/main.ts:pg",
    ],
    budget,
  );
  assert.deepEqual(result.entries, ["packages/a/index.ts", "src/util.ts"]);
  assert.deepEqual(result.unknownEntryPoints, [
    "nowhere.ts",
    "",
    "dependency:src/main.ts:pg",
  ]);
});

test("externals list service packages and environment names, never values", () => {
  const externals = detectExternals([
    {
      path: "src/a.ts",
      text: [
        'import { S3Client } from "@aws-sdk/client-s3";',
        'import pg from "pg";',
        'import { z } from "zod";',
        'export { default } from "stripe";',
        'const fetch = require("node-fetch");',
        'const key = process.env.SECRET_KEY ?? process.env["OTHER_KEY"];',
        "const url = import.meta.env.VITE_URL;",
        'const token = Deno.env.get("TOKEN");',
        "const nothing = process.envelope.X;",
      ].join("\n"),
    },
    {
      // Python's forms are not read in a script: `got` here is a binding.
      path: "src/c.ts",
      text: ['import got from "./got.js";', "import redis"].join("\n"),
    },
    {
      path: "scripts/b.py",
      text: [
        "import boto3",
        "from requests import get",
        'os.environ["SECRET_KEY"]',
        'os.environ.get("REGION")',
        'os.getenv("ZONE")',
      ].join("\n"),
    },
  ]);
  assert.deepEqual(
    externals.packages.map((p) => [p.specifier, p.service, p.files]),
    [
      ["@aws-sdk/client-s3", "aws", ["src/a.ts"]],
      ["boto3", "aws", ["scripts/b.py"]],
      ["node-fetch", "http", ["src/a.ts"]],
      ["pg", "postgres", ["src/a.ts"]],
      ["requests", "http", ["scripts/b.py"]],
      ["stripe", "stripe", ["src/a.ts"]],
    ],
  );
  assert.deepEqual(
    externals.environment.map((e) => [e.name, e.files]),
    [
      ["OTHER_KEY", ["src/a.ts"]],
      ["REGION", ["scripts/b.py"]],
      ["SECRET_KEY", ["scripts/b.py", "src/a.ts"]],
      ["TOKEN", ["src/a.ts"]],
      ["VITE_URL", ["src/a.ts"]],
      ["ZONE", ["scripts/b.py"]],
    ],
  );
  assert.doesNotMatch(JSON.stringify(externals), /hunter2/);
  assert.equal(serviceOf("@octokit/rest"), "github");
  assert.equal(serviceOf("google.cloud.storage"), null);
  assert.equal(serviceOf("@google-cloud/storage"), "google");
  assert.equal(serviceOf("pg-promise"), "postgres");
  assert.equal(serviceOf("pgx"), null);
  assert.equal(serviceOf("zod"), null);
  // PyGithub is imported as `github`, which as a rule would also claim
  // every Go import from github.com; it is not in the table at all.
  assert.equal(serviceOf("PyGithub"), null);
  assert.equal(serviceOf("github.com/jackc/pgx/v5"), null);
});

test("an entry point maps to the file its node id or path names", () => {
  assert.equal(entryPointPath("file:src/a.ts"), "src/a.ts");
  assert.equal(entryPointPath("symbol:src/a.ts:run"), "src/a.ts");
  assert.equal(entryPointPath("symbol:src/a.rs:Store::get"), "src/a.rs");
  assert.equal(entryPointPath("symbol:src/a.ts"), "src/a.ts");
  assert.equal(entryPointPath("dependency:src/a.ts:pg"), null);
  assert.equal(entryPointPath("src/a.ts"), "src/a.ts");
});

test("reach takes files named like Object's own properties at face value", () => {
  // Under a plain object and `in`, these read as reached before they were.
  const names = ["constructor", "toString", "__proto__", "hasOwnProperty"];
  const graph = parseSliceGraph({
    nodes: [
      { id: "file:main.ts", source_file: "main.ts" },
      ...names.map((name) => ({ id: `file:${name}`, source_file: name })),
    ],
    links: names.map((name) => ({
      source: "file:main.ts",
      target: `file:${name}`,
      relation: "imports",
      specifier: `./${name}`,
    })),
  });
  const result = reach(graph, ["main.ts"], { maxFiles: 10, maxDepth: 2 });
  assert.deepEqual(result.included, [...names, "main.ts"].sort());
  assert.equal(Object.keys(result.depthOf).length, names.length + 1);
  assert.equal(Object.hasOwn(result.depthOf, "__proto__"), true);
  assert.equal(result.depthOf["constructor"], 1);
  assert.deepEqual(result.cuts.outbound, []);
  // The budget still counts every file, these included.
  const tight = reach(graph, ["main.ts"], { maxFiles: 2, maxDepth: 2 });
  assert.deepEqual(tight.included, ["__proto__", "main.ts"]);
});

const symbol = (
  name: string,
  declaration: string | null = `export declare function ${name}(): number;`,
) => ({
  name,
  kind: "function",
  declaration,
});
const module = (
  name: string,
  symbols: BoundaryModule["symbols"],
  importedBy: string[],
  stubPath: string | null = null,
): BoundaryModule => ({
  module: name,
  symbols,
  importedBy,
  stubPath,
});
const contract: BoundaryContract = {
  schemaVersion: 1,
  toolVersion: "slice@1",
  extractorVersion: "typescript@5.9.3",
  sourceSnapshotId: "rsn_1",
  sourceCommitSha: "a".repeat(40),
  graphRunId: "arn_g",
  language: "typescript",
  outbound: [
    module(
      "src/util.ts",
      [symbol("helper")],
      ["src/main.ts"],
      "stubs/src/util.d.ts",
    ),
  ],
  inbound: [module("src/main.ts", [symbol("main")], ["packages/a/index.ts"])],
  stubCoverage: "full",
  compilation: {
    attempted: true,
    ok: true,
    diagnostics: [],
    shimmedPackages: ["pg"],
  },
  blockers: [],
};
const manifest: Pick<
  SliceManifest,
  "included" | "entryPoints" | "budget" | "externals" | "meta"
> = {
  included: [
    {
      path: "src/main.ts",
      blobId: "b".repeat(40),
      sha256: "c".repeat(64),
      mode: "100644",
      sizeBytes: 10,
      operations: ["edit"],
    },
  ],
  entryPoints: ["src/main.ts"],
  budget,
  externals: {
    packages: [
      { specifier: "pg", service: "postgres", files: ["src/main.ts"] },
    ],
    environment: [{ name: "DATABASE_URL", files: ["src/main.ts"] }],
  },
  meta: {
    includedFiles: 1,
    includedBytes: 10,
    outboundCuts: 1,
    inboundCuts: 1,
    stubCoverage: "full",
    externals: 2,
    blockers: 0,
    ready: true,
  },
};

test("readiness needs full coverage and no blockers", () => {
  assert.deepEqual(sliceReadiness({ stubCoverage: "full", blockers: [] }), {
    ready: true,
    reasons: [],
  });
  const blocked = sliceReadiness({
    stubCoverage: "names-only",
    blockers: [
      {
        code: "unresolved_import",
        file: "src/main.ts",
        location: "L4",
        detail: "missing-package",
      },
      { code: "no_extractor", file: null, location: null, detail: "python" },
    ],
  });
  assert.equal(blocked.ready, false);
  assert.equal(blocked.reasons.length, 3);
  assert.match(blocked.reasons[1] ?? "", /in src\/main.ts/);
  assert.equal(OPERATION_POLICY.unknown, "refused");
  assert.equal(toolVersionOf("slice"), "slice@1");
  assert.equal(toolVersionOf("graphify").startsWith("graphifyy"), true);
  assert.equal(isSliceParams({ deadlineMinutes: 30 }), false);
  assert.equal(
    isSliceParams({
      deadlineMinutes: 30,
      graphRunId: "x",
      entryPoints: [],
      budget,
      includeInferred: false,
    }),
    true,
  );
});

test("markdown views are rendered from the contract and say when a slice is diagnostic", () => {
  const ready = renderBoundaryMarkdown(contract, manifest);
  assert.match(
    ready,
    /## Stubbed modules[\s\S]*### `src\/util.ts`[\s\S]*```ts\nexport declare function helper/,
  );
  assert.match(ready, /## Public surface[\s\S]*\*\*main\*\*/);
  assert.match(ready, /`pg` \(postgres\)/);
  assert.match(ready, /`DATABASE_URL` read in/);
  assert.match(ready, /declared as untyped packages/);
  assert.match(ready, /may proceed/);
  assert.doesNotMatch(ready, /## Blockers/);
  const diagnostic = renderBoundaryMarkdown(
    {
      ...contract,
      language: "none",
      outbound: [module("lib/x.py", [symbol("thing", null)], ["app.py"])],
      inbound: [],
      stubCoverage: "names-only",
      compilation: {
        attempted: false,
        ok: false,
        diagnostics: [],
        shimmedPackages: [],
      },
      blockers: [
        {
          code: "no_extractor",
          file: null,
          location: null,
          detail: "No extractor for python.",
        },
      ],
    },
    { ...manifest, externals: { packages: [], environment: [] } },
  );
  assert.match(
    diagnostic,
    /## Blockers\n\n- Declaration coverage is names-only/,
  );
  assert.match(diagnostic, /Nothing outside the slice imports it/);
  assert.match(diagnostic, /No service SDKs/);
  assert.match(diagnostic, /No compilation was attempted/);
  assert.match(diagnostic, /- \*\*thing\*\* \(function\)\n/);
  const failed = renderBoundaryMarkdown(
    {
      ...contract,
      compilation: {
        attempted: true,
        ok: false,
        diagnostics: [
          {
            file: "src/main.ts",
            line: 3,
            code: "TS2307",
            message: "Cannot find module",
          },
          { file: null, line: null, code: "TS5000", message: "Bad config" },
        ],
        shimmedPackages: [],
      },
      blockers: [
        {
          code: "compile_error",
          file: "src/main.ts",
          location: "L3",
          detail: "TS2307",
        },
      ],
    },
    manifest,
  );
  assert.match(
    failed,
    /- `src\/main.ts`:3 TS2307: Cannot find module\n- TS5000: Bad config/,
  );
  const surface = renderPublicSurfaceMarkdown(contract);
  assert.match(surface, /^# Public surface/);
  assert.match(surface, /Imported by: `packages\/a\/index.ts`/);
  assert.doesNotMatch(surface, /helper/);
});

test("the boundary summary is bounded and reports truncation", () => {
  const summary = boundarySummary(contract, manifest);
  assert.equal(summary.ready, true);
  assert.deepEqual(summary.counts, {
    includedFiles: 1,
    includedBytes: 10,
    outboundModules: 1,
    inboundModules: 1,
    stubs: 1,
    publicSymbols: 1,
    externals: 2,
    blockers: 0,
  });
  assert.deepEqual(summary.outbound[0], {
    module: "src/util.ts",
    symbols: ["helper"],
    importedBy: ["src/main.ts"],
    truncated: false,
  });
  assert.deepEqual(summary.externals, {
    packages: [{ specifier: "pg", service: "postgres" }],
    environment: ["DATABASE_URL"],
  });
  assert.equal(summary.truncated, false);
  const many = Array.from({ length: SUMMARY_LIMITS.symbols + 1 }, (_, i) =>
    symbol(`s${i}`),
  );
  const big = boundarySummary(
    {
      ...contract,
      outbound: Array.from({ length: SUMMARY_LIMITS.modules + 1 }, (_, i) =>
        module(`m${i}.ts`, many, []),
      ),
    },
    manifest,
  );
  assert.equal(big.truncated, true);
  assert.equal(big.outbound.length, SUMMARY_LIMITS.modules);
  assert.equal(big.outbound[0]?.symbols.length, SUMMARY_LIMITS.symbols);
  assert.equal(big.outbound[0]?.truncated, true);
});

test("the boundary summary caps externals and keeps every service", () => {
  const packages = [
    ...Array.from({ length: SUMMARY_LIMITS.externalPackages + 5 }, (_, i) => ({
      specifier: `@aws-sdk/client-${String(i).padStart(3, "0")}`,
      service: "aws",
      files: ["src/main.ts"],
    })),
    // Sorts after every AWS client, so a plain cut would drop it.
    { specifier: "stripe", service: "stripe", files: ["src/main.ts"] },
  ];
  const environment = Array.from(
    { length: SUMMARY_LIMITS.environment + 1 },
    (_, i) => ({ name: `VAR_${i}`, files: ["src/main.ts"] }),
  );
  const crowded = boundarySummary(contract, {
    ...manifest,
    externals: { packages, environment },
  });
  assert.equal(
    crowded.externals.packages.length,
    SUMMARY_LIMITS.externalPackages,
  );
  assert.deepEqual(
    [...new Set(crowded.externals.packages.map(({ service }) => service))],
    ["aws", "stripe"],
  );
  assert.equal(crowded.externals.packages.at(-1)?.specifier, "stripe");
  assert.equal(
    crowded.externals.environment.length,
    SUMMARY_LIMITS.environment,
  );
  assert.equal(crowded.counts.externals, packages.length + environment.length);
  assert.equal(crowded.truncated, true);
  const envOnly = boundarySummary(contract, {
    ...manifest,
    externals: { packages: [], environment },
  });
  assert.equal(envOnly.truncated, true);
});
