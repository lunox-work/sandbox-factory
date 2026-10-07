import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { StoredAnalysisRun, StoredArtifact } from "@sandbox-factory/db";
import {
  ABSTRACTIONS_TOOL_VERSION,
  ABSTRACTION_LIMITS,
  parseSliceGraph,
} from "sandbox-factory";
import type { AbstractionIndex } from "sandbox-factory";
import { abstractionsSummarySchema } from "@sandbox-factory/shared";
import { AnalysisError } from "../src/errors.js";
import {
  assembleIndex,
  createAbstractionsAdapter,
  surfaceModules,
} from "../src/tools/abstractions.js";
import type { SyntacticOutput } from "../src/tools/abstractions.js";
import {
  extractTypedSurfaces,
  extractTypedSurfacesInThread,
} from "../src/tools/abstractions/typescript.js";
import type { ToolInputs } from "../src/tools/adapter.js";
import { toolContext } from "./helpers.js";

const fixture = fileURLToPath(
  new URL("../../fixtures/abstractions/", import.meta.url),
);
const stamp = "2026-10-06T00:00:00.000Z";
const sha = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
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
  startedAt: stamp,
  finishedAt: stamp,
  deadlineAt: stamp,
  createdAt: stamp,
};
const params = {
  deadlineMinutes: 30,
  builder: "abstractions" as const,
  graphRunId: graphRun.id,
};

/** The fixture's graph, as the driver would write it: files, symbols, imports. */
function graphJson() {
  const files = [
    "lib/big.ts",
    "lib/util.ts",
    "src/ambient.d.ts",
    "src/app.py",
    "src/index.ts",
    "src/legacy.js",
    "src/model.test.ts",
    "src/model.ts",
    "src/store.go",
    "src/types.go",
    "src/README.md",
    "src/script.lua",
  ];
  const node = (id: string, label: string, file: string, line?: number) => ({
    id,
    label,
    source_file: file,
    community: 0,
    ...(line === undefined ? {} : { source_location: `L${line}` }),
  });
  return {
    nodes: [
      ...files.map((file) => node(`file:${file}`, file, file, 1)),
      node("symbol:src/model.ts:model_greet", "greet()", "src/model.ts", 19),
      node("symbol:src/model.ts:model_repo", "Repo", "src/model.ts", 25),
      node(
        "symbol:src/model.ts:model_repo_find",
        ".find()",
        "src/model.ts",
        26,
      ),
      node("symbol:src/store.go:go_user", "User", "src/store.go", 3),
      node("symbol:src/store.go:store_find", "Find()", "src/store.go", 7),
      node("symbol:src/script.lua:script_main", "main()", "src/script.lua", 1),
      node("symbol:src/script.lua:script_box", "Box", "src/script.lua", 4),
      node(
        "symbol:src/script.lua:script_box_open",
        ".open()",
        "src/script.lua",
        5,
      ),
      node("symbol:src/script.lua:script_lone", ".lone()", "src/script.lua", 9),
      {
        id: "dependency:src/model.ts:time-lib",
        label: "time-lib",
        source_file: "src/model.ts",
        community: 0,
        dependencyStatus: "external",
      },
    ],
    links: [
      {
        source: "file:src/index.ts",
        target: "file:src/model.ts",
        relation: "imports",
        specifier: "./model.js",
      },
      {
        source: "file:lib/util.ts",
        target: "file:src/model.ts",
        relation: "imports",
        specifier: "../src/model.js",
      },
      {
        source: "file:src/app.py",
        target: "symbol:src/model.ts:model_greet",
        relation: "imports_from",
      },
      {
        source: "file:src/model.ts",
        target: "file:src/model.ts",
        relation: "imports",
      },
      {
        source: "file:src/model.ts",
        target: "dependency:src/model.ts:time-lib",
        relation: "imports",
      },
      {
        source: "file:src/legacy.js",
        target: "file:src/model.ts",
        relation: "calls",
      },
      {
        source: "symbol:src/model.ts:model_repo",
        target: "symbol:src/model.ts:model_repo_find",
        relation: "method",
      },
      {
        source: "symbol:src/script.lua:script_box",
        target: "symbol:src/script.lua:script_box_open",
        relation: "method",
      },
    ],
  };
}
const graphBytes = Buffer.from(JSON.stringify(graphJson()));
const graphArtifact: StoredArtifact = {
  id: "art_graph",
  runId: graphRun.id,
  kind: "graph_json",
  path: "graph.json",
  objectKey: "runs/arn_graph/graph.json",
  contentType: "application/json",
  sizeBytes: graphBytes.byteLength,
  sha256: sha(graphBytes),
  meta: null,
  createdAt: stamp,
};
function inputs(overrides: Partial<ToolInputs> = {}): ToolInputs {
  return {
    ...toolContext().inputs,
    getRun: async (id) => (id === graphRun.id ? graphRun : null),
    listArtifacts: async (id) => (id === graphRun.id ? [graphArtifact] : []),
    readArtifact: async (key) =>
      key === graphArtifact.objectKey ? graphBytes : undefined,
    ...overrides,
  };
}

/** What the tree-sitter extractor would write for the fixture's Python and Go. */
const syntacticFor = (paths: readonly string[]): SyntacticOutput => ({
  version: "tree-sitter@test",
  modules: [
    {
      path: "src/app.py",
      language: "python",
      exports: [
        {
          name: "run",
          kind: "function",
          signature: "def run() -> None",
          line: 1,
          references: ["None"],
        },
      ],
    },
    {
      path: "src/store.go",
      language: "go",
      exports: [
        {
          name: "Find",
          kind: "function",
          signature: "func Find(id int) *User",
          line: 7,
          references: ["User", "int", "Shared"],
        },
        {
          name: "User",
          kind: "class",
          signature: "type User struct {\n\tID int\n}",
          line: 3,
          references: [],
        },
      ],
    },
    {
      path: "src/types.go",
      language: "go",
      exports: [
        {
          name: "Shared",
          kind: "type",
          signature: "type Shared int",
          line: 1,
          references: [],
        },
      ],
    },
    ...paths
      .filter((path) => path.endsWith(".ts"))
      .map((path) => ({
        path,
        language: "typescript",
        exports: [
          {
            name: "fallback",
            kind: "const" as const,
            signature: "export const fallback",
            line: 1,
            references: [],
          },
        ],
      })),
  ],
  omissions: [
    {
      code: "parse_failed",
      file: "src/app.py",
      detail:
        "The grammar recovered from a syntax error; signatures near it may be missing.",
    },
  ],
});

/** A fake extractor run: reads the listing, writes the output file. */
function fakeExecute(calls: string[][]) {
  return async (_executable: string, args: readonly string[]) => {
    calls.push([...args]);
    const listing = JSON.parse(await readFile(args[2] ?? "", "utf8")) as {
      path: string;
    }[];
    await writeFile(
      args[3] ?? "",
      JSON.stringify(syntacticFor(listing.map((entry) => entry.path))),
    );
    return "";
  };
}

async function runAdapter(
  adapter: ReturnType<typeof createAbstractionsAdapter>,
  overrides: { params?: unknown; inputs?: ToolInputs } = {},
) {
  const out = await mkdtemp(join(tmpdir(), "abstractions-"));
  const lines: string[] = [];
  try {
    const files = await adapter.run({
      ...toolContext(),
      sourceDir: fixture,
      outDir: out,
      params: (overrides.params ?? params) as never,
      inputs: overrides.inputs ?? inputs(),
      signal: new AbortController().signal,
      log: (line) => lines.push(line),
    });
    const texts = new Map<string, string>();
    for (const file of files)
      texts.set(file.path, await readFile(file.absolutePath, "utf8"));
    return { files, texts, lines };
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}
const isCode = (code: string) => (error: unknown) =>
  error instanceof AnalysisError && error.code === code;

test("the typed tier reads every export with the compiler, its line, kind and the types it names", () => {
  const typed = extractTypedSurfaces({
    root: fixture,
    files: [
      "lib/big.ts",
      "lib/util.ts",
      "src/ambient.d.ts",
      "src/index.ts",
      "src/legacy.js",
      "src/model.ts",
    ],
  });
  assert.match(typed.extractorVersion, /^typescript@/);
  assert.deepEqual(typed.fallback, []);
  // A project's broken option is an omission; the project is still read.
  assert.deepEqual(typed.omissions, [
    {
      code: "compiler_config",
      file: "lib/tsconfig.json",
      detail: "Unknown compiler option 'unknownOption'.",
    },
  ]);
  const model = typed.modules.find((module) => module.path === "src/model.ts");
  const byName = new Map(model?.exports.map((entry) => [entry.name, entry]));
  assert.deepEqual(
    model?.exports.map((entry) => [entry.line, entry.kind, entry.name]),
    [
      [4, "interface", "User"],
      [10, "type", "Id"],
      [12, "enum", "Role"],
      [17, "const", "LIMIT"],
      [19, "function", "greet"],
      [23, "function", "shout"],
      [25, "class", "Repo"],
      [31, "namespace", "Shapes"],
      [35, "function", "load"],
      [40, "const", "default"],
    ],
  );
  assert.equal(
    byName.get("greet")?.signature,
    "export declare function greet(user: User): string;",
  );
  // A package's type is named by its specifier; a built-in is not.
  assert.deepEqual(byName.get("User")?.references, [{ package: "time-lib" }]);
  assert.deepEqual(byName.get("load")?.references, []);
  assert.deepEqual(byName.get("Repo")?.references, [
    { module: "src/model.ts", name: "Id" },
    { module: "src/model.ts", name: "User" },
  ]);
  // `export default answer` reads with the declaration it names.
  assert.match(byName.get("default")?.signature ?? "", /^declare const answer/);
  const barrel = typed.modules.find((module) => module.path === "src/index.ts");
  assert.equal(
    barrel?.exports.find((entry) => entry.name === "Role")?.signature,
    'export { Role } from "./model";',
  );
  assert.deepEqual(
    barrel?.exports.find((entry) => entry.name === "hello")?.references,
    [{ module: "src/model.ts", name: "greet" }],
  );
  assert.deepEqual(
    typed.modules.find((module) => module.path === "lib/util.ts")?.exports[0]
      ?.references,
    [{ module: "src/model.ts", name: "User" }],
  );
  assert.equal(
    typed.modules.find((module) => module.path === "src/legacy.js")?.language,
    "javascript",
  );
  assert.match(
    typed.modules.find((module) => module.path === "src/ambient.d.ts")
      ?.exports[0]?.signature ?? "",
    /export interface Ambient/,
  );
});

test("the typed tier follows every import form, and bounds what one module may carry", async () => {
  const root = await mkdtemp(join(tmpdir(), "typed-"));
  try {
    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true, module: "commonjs" } }),
    );
    await writeFile(
      join(root, "model.ts"),
      "export interface User { id: number }\nexport default class Store {}\n",
    );
    await writeFile(
      join(root, "uses.ts"),
      [
        'import Store from "./model";',
        'import * as model from "./model";',
        'import fs = require("fs");',
        'import type { Missing } from "./nowhere";',
        "export function store(): Store { return new Store(); }",
        "export function user(): model.User { return { id: 1 }; }",
        "export type Reader = typeof fs.readFileSync;",
        'export type Lazy = import("./model").User;',
        'export type Whole = typeof import("./model");',
        "export type Gone = Missing;",
        "export const handler = function () { return 1; };",
        "export const Klass = class {};",
        "export class Child extends Store {}",
      ].join("\n"),
    );
    const long = `export interface Long { ${Array.from({ length: 900 }, (_, index) => `f${index}: number;`).join(" ")} }`;
    const many = Array.from(
      { length: ABSTRACTION_LIMITS.exportsPerModule + 1 },
      (_, index) => `export const c${index} = ${index};`,
    ).join("\n");
    await writeFile(join(root, "big.ts"), `${long}\n${many}\n`);
    const typed = extractTypedSurfaces({
      root,
      files: ["big.ts", "missing.ts", "model.ts", "uses.ts"],
    });
    const uses = typed.modules.find((module) => module.path === "uses.ts");
    const entry = (name: string) =>
      uses?.exports.find((candidate) => candidate.name === name);
    assert.deepEqual(entry("store")?.references, [
      { module: "model.ts", name: "default" },
    ]);
    // A namespace names a module, not an export: nothing to point at.
    assert.deepEqual(entry("user")?.references, []);
    assert.deepEqual(entry("Reader")?.references, []);
    assert.deepEqual(entry("Lazy")?.references, [
      { module: "model.ts", name: "User" },
    ]);
    assert.deepEqual(entry("Whole")?.references, []);
    assert.deepEqual(entry("Gone")?.references, []);
    assert.equal(entry("handler")?.kind, "function");
    assert.equal(entry("Klass")?.kind, "class");
    assert.deepEqual(entry("Child")?.references, [
      { module: "model.ts", name: "default" },
    ]);
    const big = typed.modules.find((module) => module.path === "big.ts");
    assert.equal(big?.exports.length, ABSTRACTION_LIMITS.exportsPerModule);
    assert.match(big?.exports[0]?.signature ?? "", /…$/);
    assert.deepEqual(
      typed.omissions.map((omission) => [omission.code, omission.file]),
      [
        ["signature_truncated", "big.ts"],
        ["exports_capped", "big.ts"],
        ["declaration_failed", "missing.ts"],
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a project past the program cap goes to the syntactic tier with an omission", () => {
  const typed = extractTypedSurfaces({
    root: fixture,
    files: ["src/index.ts", "src/model.ts"],
    maxProgramFiles: 1,
  });
  assert.deepEqual(typed.modules, []);
  assert.deepEqual(typed.fallback, ["src/index.ts", "src/model.ts"]);
  assert.equal(typed.omissions[0]?.code, "program_too_large");
});

test("the thread runs the same extraction off the event loop, and stops when aborted", async () => {
  const input = { root: fixture, files: ["lib/big.ts", "src/model.ts"] };
  assert.deepEqual(
    await extractTypedSurfacesInThread(input, new AbortController().signal),
    extractTypedSurfaces(input),
  );
  const aborted = new AbortController();
  aborted.abort(new Error("stop"));
  await assert.rejects(
    extractTypedSurfacesInThread(input, aborted.signal),
    /stop/,
  );
  const later = new AbortController();
  const pending = extractTypedSurfacesInThread(input, later.signal);
  later.abort(new Error("later"));
  await assert.rejects(pending, /later/);
  await assert.rejects(
    extractTypedSurfacesInThread(
      { root: fixture, files: null as never },
      new AbortController().signal,
    ),
  );
});

test("the index shares the graph's ids, resolves references and falls back tier by tier", () => {
  const graph = parseSliceGraph(graphJson());
  assert.deepEqual(surfaceModules(graph), [
    "lib/big.ts",
    "lib/util.ts",
    "src/ambient.d.ts",
    "src/app.py",
    "src/index.ts",
    "src/legacy.js",
    "src/model.ts",
    "src/script.lua",
    "src/store.go",
    "src/types.go",
  ]);
  const typed = extractTypedSurfaces({
    root: fixture,
    files: ["lib/util.ts", "src/index.ts", "src/model.ts"],
  });
  const index = assembleIndex({
    graph,
    typed: {
      ...typed,
      // An overload shares its name and id; each keeps its own.
      modules: typed.modules.map((module) =>
        module.path === "lib/util.ts"
          ? {
              ...module,
              exports: [
                ...module.exports,
                {
                  ...module.exports[0],
                  line: 9,
                } as (typeof module.exports)[number],
                {
                  ...module.exports[0],
                  line: 9,
                } as (typeof module.exports)[number],
              ],
            }
          : module,
      ),
    },
    syntactic: syntacticFor([]),
    snapshotId: "rsn_1",
    commitSha: "c".repeat(40),
    graphRunId: graphRun.id,
    graphSha256: sha(graphBytes),
  });
  const module = (path: string) =>
    index.modules.find((candidate) => candidate.path === path);
  const entry = (path: string, name: string) =>
    module(path)?.exports.find((candidate) => candidate.name === name);
  assert.equal(module("src/model.ts")?.coverage, "typed");
  assert.equal(module("src/model.ts")?.importers, 3);
  assert.equal(
    entry("src/model.ts", "greet")?.id,
    "symbol:src/model.ts:model_greet",
  );
  assert.equal(entry("src/model.ts", "User")?.id, "symbol:src/model.ts#User");
  assert.deepEqual(entry("src/model.ts", "Repo")?.references, [
    "symbol:src/model.ts#Id",
    "symbol:src/model.ts#User",
  ]);
  assert.deepEqual(entry("src/model.ts", "User")?.references, ["time-lib"]);
  assert.deepEqual(index.externals, ["time-lib"]);
  assert.deepEqual(
    module("lib/util.ts")?.exports.map((candidate) => candidate.id),
    [
      "symbol:lib/util.ts#label",
      "symbol:lib/util.ts#label@L9",
      "symbol:lib/util.ts#label@L9~2",
    ],
  );
  // Go names a type across its package's files.
  assert.equal(module("src/store.go")?.coverage, "syntactic");
  assert.equal(
    entry("src/store.go", "Find")?.id,
    "symbol:src/store.go:store_find",
  );
  assert.deepEqual(entry("src/store.go", "Find")?.references, [
    "symbol:src/store.go:go_user",
    "symbol:src/types.go#Shared",
  ]);
  // Scripts the compiler did not read, and other languages, are names only.
  assert.equal(module("src/legacy.js")?.coverage, "names-only");
  assert.deepEqual(
    module("src/script.lua")?.exports.map((e) => [e.name, e.kind, e.signature]),
    [
      ["main", "function", null],
      ["Box", "class", null],
      ["Box.open", "method", null],
      ["lone", "method", null],
    ],
  );
  assert.deepEqual(
    index.omissions.map((omission) => omission.code),
    ["compiler_config", "parse_failed"],
  );
  assert.equal(index.extractors.syntactic, "tree-sitter@test");
});

test("long syntactic modules and signatures are cut with an omission", () => {
  const graph = parseSliceGraph(graphJson());
  const many = Array.from(
    { length: ABSTRACTION_LIMITS.exportsPerModule + 1 },
    (_, index) => ({
      name: `f${index}`,
      kind: "function" as const,
      signature:
        index === 0
          ? "x".repeat(ABSTRACTION_LIMITS.signatureChars + 1)
          : `def f${index}()`,
      line: index + 1,
      references: [],
    }),
  );
  const index = assembleIndex({
    graph,
    typed: null,
    syntactic: {
      version: "v",
      modules: [{ path: "src/app.py", language: "python", exports: many }],
      omissions: [],
    },
    snapshotId: "rsn_1",
    commitSha: "c",
    graphRunId: "g",
    graphSha256: "s",
  });
  const app = index.modules.find((module) => module.path === "src/app.py");
  assert.equal(app?.exports.length, ABSTRACTION_LIMITS.exportsPerModule);
  assert.match(app?.exports[0]?.signature ?? "", /…$/);
  assert.deepEqual(index.omissions.map((omission) => omission.code).sort(), [
    "exports_capped",
    "signature_truncated",
  ]);
  assert.equal(index.extractors.typescript, null);
});

test("the adapter writes the index, the readable view and the summary, the same from any checkout", async () => {
  const calls: string[][] = [];
  const adapter = createAbstractionsAdapter({
    execute: fakeExecute(calls) as never,
    python: "python-test",
    scriptPath: "/script.py",
    typed: async (input) => extractTypedSurfaces(input),
  });
  const first = await runAdapter(adapter);
  const second = await runAdapter(adapter);
  assert.equal(
    first.texts.get("abstractions.json"),
    second.texts.get("abstractions.json"),
  );
  assert.deepEqual(
    first.files.map((file) => [file.path, file.kind]),
    [
      ["abstractions.json", "abstraction_index"],
      ["abstractions.md", "other"],
      ["manifest.json", "manifest"],
    ],
  );
  assert.equal(calls[0]?.[0], "/script.py");
  assert.equal(calls[0]?.[1], fixture);
  const index = JSON.parse(
    first.texts.get("abstractions.json") ?? "",
  ) as AbstractionIndex;
  assert.equal(index.toolVersion, ABSTRACTIONS_TOOL_VERSION);
  assert.equal(index.graphRunId, graphRun.id);
  assert.equal(index.graphSha256, sha(graphBytes));
  assert.equal(index.modules.length, 10);
  const summary = abstractionsSummarySchema.parse(first.files[2]?.meta);
  assert.deepEqual(summary.coverage, {
    typed: 6,
    syntactic: 3,
    "names-only": 1,
  });
  assert.equal(summary.modules[0]?.path, "src/model.ts");
  assert.deepEqual(first.files[0]?.meta, first.files[2]?.meta);
  assert.match(first.texts.get("abstractions.md") ?? "", /^# Abstractions/);
  assert.match(first.texts.get("abstractions.md") ?? "", /## src\/model\.ts/);
  assert.ok(first.lines.includes("Abstractions started."));
  assert.ok(
    first.lines.some((line) => /^Typed tier read 6 of 6 scripts/.test(line)),
  );
});

test("an extractor that stops leaves its modules names-only, and the run still succeeds", async () => {
  const { texts, lines } = await runAdapter(
    createAbstractionsAdapter({
      execute: (async () => {
        throw new Error("no python");
      }) as never,
      typed: async () => {
        throw new Error("compiler crashed");
      },
    }),
  );
  const index = JSON.parse(
    texts.get("abstractions.json") ?? "",
  ) as AbstractionIndex;
  assert.ok(index.modules.every((module) => module.coverage === "names-only"));
  assert.deepEqual(
    index.omissions.map((omission) => omission.code),
    ["extractor_failed", "extractor_failed"],
  );
  assert.ok(lines.some((line) => /syntactic extractor failed/.test(line)));
  // A compiler that stops hands its scripts to the syntactic tier.
  const crashed = await runAdapter(
    createAbstractionsAdapter({
      execute: fakeExecute([]) as never,
      typed: async () => {
        throw new Error("compiler crashed");
      },
    }),
  );
  const crashedIndex = JSON.parse(
    crashed.texts.get("abstractions.json") ?? "",
  ) as AbstractionIndex;
  assert.equal(
    crashedIndex.modules.find((module) => module.path === "src/model.ts")
      ?.coverage,
    "syntactic",
  );
  assert.ok(
    crashed.lines.includes(
      "The compiler stopped; the scripts are read syntactically.",
    ),
  );
  // A project past the cap reaches the syntactic tier.
  const calls: string[][] = [];
  const { texts: capped } = await runAdapter(
    createAbstractionsAdapter({
      execute: fakeExecute(calls) as never,
      typed: async (input) =>
        extractTypedSurfaces({ ...input, maxProgramFiles: 1 }),
    }),
  );
  const cappedIndex = JSON.parse(
    capped.get("abstractions.json") ?? "",
  ) as AbstractionIndex;
  assert.equal(
    cappedIndex.modules.find((module) => module.path === "src/model.ts")
      ?.coverage,
    "syntactic",
  );
});

test("the adapter refuses other parameters, a missing graph and an aborted run", async () => {
  const adapter = createAbstractionsAdapter({
    execute: fakeExecute([]) as never,
    typed: async (input) => extractTypedSurfaces(input),
  });
  await assert.rejects(
    runAdapter(adapter, { params: { deadlineMinutes: 30 } }),
    isCode("tool_failed"),
  );
  await assert.rejects(
    runAdapter(adapter, { inputs: inputs({ getRun: async () => null }) }),
    isCode("graph_unavailable"),
  );
  const aborted = new AbortController();
  aborted.abort(new Error("stopped"));
  const out = await mkdtemp(join(tmpdir(), "abstractions-"));
  try {
    for (const failing of [
      createAbstractionsAdapter({
        typed: async (_input, signal) => {
          signal.throwIfAborted();
          return extractTypedSurfaces(_input);
        },
      }),
      createAbstractionsAdapter({
        execute: async (_e, _a, options) => {
          options.signal.throwIfAborted();
          return "";
        },
        typed: async () => ({
          extractorVersion: "",
          modules: [],
          fallback: [],
          omissions: [],
        }),
      }),
    ])
      await assert.rejects(
        failing.run({
          ...toolContext(),
          sourceDir: fixture,
          outDir: out,
          params,
          inputs: inputs(),
          signal: aborted.signal,
          log: () => {},
        }),
        /stopped/,
      );
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test("a barrel's names each read as their own re-export, not the whole statement", async () => {
  const root = await mkdtemp(join(tmpdir(), "typed-"));
  try {
    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true } }),
    );
    await writeFile(
      join(root, "model.ts"),
      "export const a = 1;\nexport const b = 2;\nexport interface T { id: number }\nexport interface U { id: number }\n",
    );
    await writeFile(
      join(root, "index.ts"),
      'export { a, b as bee } from "./model";\nexport type { T, U } from "./model";\n',
    );
    const typed = extractTypedSurfaces({
      root,
      files: ["index.ts", "model.ts"],
    });
    const barrel = typed.modules.find((module) => module.path === "index.ts");
    assert.deepEqual(
      barrel?.exports.map((entry) => [entry.name, entry.signature]),
      [
        ["a", 'export { a } from "./model";'],
        ["bee", 'export { b as bee } from "./model";'],
        ["T", 'export type { T } from "./model";'],
        ["U", 'export type { U } from "./model";'],
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
