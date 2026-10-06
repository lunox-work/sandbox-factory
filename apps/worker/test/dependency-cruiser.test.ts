import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { cruise } from "dependency-cruiser";
import type { ICruiseOptions, ICruiseResult } from "dependency-cruiser";
import { DEPENDENCY_CRUISER_TOOL_VERSION } from "sandbox-factory";
import {
  DEPENDENCY_SUMMARY_LIMITS,
  dependencyCruiserSummarySchema,
} from "@sandbox-factory/shared";
import { AnalysisError } from "../src/errors.js";
import {
  CRUISE_OPTIONS,
  createDependencyCruiserAdapter,
  summarize,
} from "../src/tools/dependency-cruiser.js";
import type { ToolRunInput } from "../src/tools/adapter.js";
import { toolContext } from "./helpers.js";

const fixture = fileURLToPath(
  new URL("../../fixtures/repository/", import.meta.url),
);
const params = { deadlineMinutes: 30, builder: "dependency_cruiser" } as const;
async function scratch() {
  return mkdtemp(join(tmpdir(), "cruise-"));
}
function inputFor(
  outDir: string,
  overrides: Partial<ToolRunInput> = {},
): ToolRunInput & { messages: string[] } {
  const messages: string[] = [];
  return {
    ...toolContext(),
    sourceDir: fixture,
    outDir,
    params,
    signal: new AbortController().signal,
    log: (line) => messages.push(line),
    messages,
    ...overrides,
  };
}

/** A cruise result in the schema's shape, from a compact description. */
function resultOf(
  modules: {
    source: string;
    dependencies?: {
      module: string;
      circular?: boolean;
      cycle?: string[];
      couldNotResolve?: boolean;
      types?: string[];
    }[];
    dependents?: string[];
    orphan?: boolean;
    /** A module the cruise listed but could not resolve to a file. */
    couldNotResolve?: boolean;
    coreModule?: boolean;
  }[],
): ICruiseResult {
  return {
    modules: modules.map((module) => ({
      source: module.source,
      valid: true,
      ...(module.couldNotResolve === undefined
        ? {}
        : { couldNotResolve: module.couldNotResolve }),
      ...(module.coreModule === undefined
        ? {}
        : { coreModule: module.coreModule }),
      dependents: module.dependents ?? [],
      orphan: module.orphan ?? false,
      dependencies: (module.dependencies ?? []).map((dependency) => ({
        module: dependency.module,
        resolved: dependency.module,
        circular: dependency.circular ?? false,
        ...(dependency.cycle === undefined
          ? {}
          : {
              cycle: dependency.cycle.map((name) => ({
                name,
                dependencyTypes: ["local"],
              })),
            }),
        coreModule: false,
        couldNotResolve: dependency.couldNotResolve ?? false,
        dependencyTypes: (dependency.types ?? ["local", "import"]) as never,
        dynamic: false,
        exoticallyRequired: false,
        followable: true,
        protocol: "file:",
        mimeType: "text/typescript",
        moduleSystem: "es6",
        valid: true,
        instability: 0,
      })),
    })),
    summary: {
      error: 0,
      ignore: 0,
      info: 0,
      warn: 0,
      advisedExitCode: 0,
      optionsUsed: {},
      totalCruised: modules.length,
      violations: [],
      environment: {
        version: "18.5.0",
        nodeVersionSupported: ">=20",
        nodeVersionFound: "24",
        osVersionFound: "test",
        transpilersFound: [],
        extensionsFound: [],
      },
    },
  };
}

test("the fixture repository is cruised in-process with fixed options", async () => {
  const out = await scratch();
  let seen: ICruiseOptions | undefined;
  try {
    const adapter = createDependencyCruiserAdapter({
      cruise: (files, options) => {
        seen = options;
        return cruise(files, options);
      },
    });
    assert.equal(adapter.name, "dependency_cruiser");
    assert.equal(adapter.version, DEPENDENCY_CRUISER_TOOL_VERSION);
    const input = inputFor(out);
    const files = await adapter.run(input);
    assert.deepEqual(
      files.map((file) => [file.path, file.kind, file.contentType]),
      [
        ["dependency-cruiser.json", "dependency_graph", "application/json"],
        [
          "dependency-cruiser.dot",
          "dependency_dot",
          "text/plain; charset=utf-8",
        ],
        ["manifest.json", "manifest", "application/json"],
      ],
    );
    // Nothing of the repository is read as configuration.
    assert.equal(seen?.baseDir, fixture);
    assert.equal(seen?.outputType, "json");
    assert.equal(seen?.tsConfig, undefined);
    assert.equal(seen?.babelConfig, undefined);
    assert.equal(seen?.webpackConfig, undefined);
    assert.equal(seen?.ruleSet, undefined);
    assert.deepEqual(seen?.moduleSystems, CRUISE_OPTIONS.moduleSystems);
    const meta = files[2]?.meta;
    const parsed = dependencyCruiserSummarySchema.safeParse(meta);
    assert.ok(parsed.success);
    assert.deepEqual(files[0]?.meta, meta);
    assert.equal(parsed.data.toolVersion, DEPENDENCY_CRUISER_TOOL_VERSION);
    // Six files; the two names the cruise could not resolve are not modules.
    assert.equal(parsed.data.counts.modules, 6);
    assert.equal(parsed.data.counts.dependencies, 4);
    // `missing-package` and the `@/util` alias are bare specifiers: external
    // to the cruise, which has no `node_modules` and reads no tsconfig.
    assert.equal(parsed.data.counts.unresolved, 0);
    assert.equal(parsed.data.counts.external, 2);
    assert.equal(parsed.data.counts.circular, 0);
    assert.equal(parsed.data.modules[0]?.source, "src/main.ts");
    assert.ok(parsed.data.orphans.includes("packages/a/index.ts"));
    assert.deepEqual(parsed.data.unresolved, []);
    assert.equal(parsed.data.truncated, false);
    const written = JSON.parse(
      await readFile(join(out, "dependency-cruiser.json"), "utf8"),
    ) as ICruiseResult;
    assert.equal(written.modules.length, 8);
    assert.deepEqual(
      JSON.parse(await readFile(join(out, "manifest.json"), "utf8")),
      meta,
    );
    assert.match(
      await readFile(join(out, "dependency-cruiser.dot"), "utf8"),
      /^strict digraph/,
    );
    assert.deepEqual(input.messages, [
      "Dependency cruise started.",
      "Dependency cruise completed.",
    ]);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test("the summary counts, ranks, dedupes cycles and bounds its lists", () => {
  const summary = summarize(
    resultOf([
      {
        source: "src/b.ts",
        dependents: ["src/a.ts"],
        dependencies: [
          { module: "./a.js", circular: true, cycle: ["src/a.ts", "src/b.ts"] },
          { module: "node:fs", types: ["core"] },
        ],
      },
      {
        source: "src/a.ts",
        dependents: ["src/b.ts"],
        dependencies: [
          { module: "./b.js", circular: true, cycle: ["src/b.ts", "src/a.ts"] },
          { module: "left-pad", couldNotResolve: true, types: ["unknown"] },
          { module: "./missing.js", couldNotResolve: true },
          { module: "./c.js" },
          { module: "zod", types: ["npm"] },
        ],
      },
      { source: "src/c.ts", dependents: ["src/a.ts"] },
      { source: "lone.ts", orphan: true },
      // The cruise lists what it could not resolve as modules too; neither
      // is a module of the repository, so neither is counted or ranked.
      { source: "left-pad", dependents: ["src/a.ts"], couldNotResolve: true },
      { source: "node:fs", dependents: ["src/b.ts"], coreModule: true },
    ]),
  );
  assert.ok(dependencyCruiserSummarySchema.safeParse(summary).success);
  assert.deepEqual(summary.counts, {
    modules: 4,
    dependencies: 7,
    circular: 2,
    orphans: 1,
    unresolved: 1,
    external: 3,
  });
  assert.deepEqual(
    summary.modules.map((module) => module.source),
    ["src/a.ts", "src/b.ts", "src/c.ts", "lone.ts"],
  );
  // One cycle, however many edges report it, spelt from its smallest member.
  assert.deepEqual(summary.cycles, [["src/a.ts", "src/b.ts"]]);
  assert.deepEqual(summary.orphans, ["lone.ts"]);
  assert.deepEqual(summary.unresolved, [
    { from: "src/a.ts", module: "./missing.js" },
  ]);
  assert.equal(summary.truncated, false);
  const crowded = summarize(
    resultOf(
      Array.from({ length: DEPENDENCY_SUMMARY_LIMITS.orphans + 1 }, (_, i) => ({
        source: `orphan-${String(i).padStart(3, "0")}.ts`,
        orphan: true,
      })),
    ),
  );
  assert.equal(crowded.orphans.length, DEPENDENCY_SUMMARY_LIMITS.orphans);
  assert.equal(crowded.modules.length, DEPENDENCY_SUMMARY_LIMITS.modules);
  assert.equal(crowded.truncated, true);
  // A circular edge with no recorded cycle counts but names nothing.
  const bare = summarize(
    resultOf([
      {
        source: "x.ts",
        dependencies: [{ module: "./y.js", circular: true }],
      },
    ]),
  );
  assert.equal(bare.counts.circular, 1);
  assert.deepEqual(bare.cycles, []);
});

test("injected cruises may return objects, and failures map to tool_failed", async () => {
  const out = await scratch();
  try {
    const result = resultOf([{ source: "a.ts" }]);
    const adapter = createDependencyCruiserAdapter({
      cruise: async () => ({ output: result, exitCode: 0 }),
      format: async () => ({ output: result, exitCode: 0 }),
    });
    const files = await adapter.run(inputFor(out));
    assert.equal(files.length, 3);
    assert.equal(
      JSON.parse(await readFile(join(out, "dependency-cruiser.dot"), "utf8"))
        .modules.length,
      1,
    );
    await assert.rejects(
      createDependencyCruiserAdapter({
        cruise: async () => {
          throw new Error("parser crashed");
        },
      }).run(inputFor(out)),
      (error) => error instanceof AnalysisError && error.code === "tool_failed",
    );
    await assert.rejects(
      createDependencyCruiserAdapter({
        cruise: async () => ({ output: "{}", exitCode: 0 }),
        format: async () => ({ output: "", exitCode: 0 }),
      }).run(inputFor(out)),
      (error) => error instanceof AnalysisError && error.code === "tool_failed",
    );
    await assert.rejects(
      adapter.run(inputFor(out, { params: { deadlineMinutes: 30 } })),
      (error) => error instanceof AnalysisError && error.code === "tool_failed",
    );
    const abort = new AbortController();
    abort.abort(new Error("lease lost"));
    await assert.rejects(
      adapter.run(inputFor(out, { signal: abort.signal })),
      /lease lost/,
    );
    // An abort during the cruise surfaces as the abort, not as a tool failure.
    const during = new AbortController();
    await assert.rejects(
      createDependencyCruiserAdapter({
        cruise: async () => {
          during.abort(new Error("deadline"));
          throw new Error("interrupted");
        },
      }).run(inputFor(out, { signal: during.signal })),
      /interrupted/,
    );
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
