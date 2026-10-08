/**
 * The dependency-cruiser adapter: the snapshot's module dependency graph,
 * cruised in-process and summarised for the console.
 *
 * The cruise reads the extracted source only. None of the repository's
 * own configuration (tsconfig, Babel, webpack, a rule set) is loaded, so
 * nothing in the snapshot is executed or interpreted as settings; the
 * cruiser parses files and resolves imports on disk. The snapshot carries
 * no `node_modules`, so a package import resolves to nothing; a bare
 * specifier that could not be resolved is counted as external, and only a
 * relative, absolute or subpath import that could not be is unresolved.
 */

import { Worker } from "node:worker_threads";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cruise, format } from "dependency-cruiser";
import type { ICruiseOptions, ICruiseResult } from "dependency-cruiser";
import {
  DEPENDENCY_CRUISER_TOOL_VERSION,
  isDependencyCruiserParams,
} from "sandbox-factory";
import {
  DEPENDENCY_SUMMARY_LIMITS,
  DIAGRAM_LAYOUT_FONTS,
  DIAGRAM_SKIN,
} from "@sandbox-factory/shared";
import type { DependencyCruiserSummaryDto } from "@sandbox-factory/shared";
import { AnalysisError } from "../errors.js";
import type { ArtifactFile, ToolAdapter } from "./adapter.js";

/**
 * Fixed for every run: the summary is a function of the snapshot alone.
 * `baseDir` is added per run. Bump the tool version when these change.
 */
export const CRUISE_OPTIONS = {
  outputType: "json",
  /*
    swc, named rather than found: dependency-cruiser parses TypeScript with
    the compiler only within the versions it supports, and finds none in a
    production install (the repository's own is newer, and a dev
    dependency). Without a parser it reads no `.ts` file at all and the
    graph is the JavaScript alone. `@swc/core` is the worker's own
    dependency, so dev and production read the same.
  */
  parser: "swc",
  tsPreCompilationDeps: true,
  // The snapshot only: an import that resolves above it names a file on
  // the worker, whose path and imports are not the repository's to record.
  includeOnly: "^(?!\\.\\./)",
  doNotFollow: { path: ["node_modules"] },
  exclude: {
    path: [
      "(^|/)node_modules/",
      "(^|/)dist/",
      "(^|/)build/",
      "(^|/)vendor/",
      "(^|/)third_party/",
      "(^|/)\\.git/",
    ],
  },
  moduleSystems: ["es6", "cjs", "tsd", "amd"],
  combinedDependencies: false,
} satisfies ICruiseOptions;

const skin = DIAGRAM_SKIN.light;
/** A skin color at an opacity, as Graphviz reads `#rrggbbaa`. */
const faded = (color: string, opacity: number) =>
  `${color}${Math.round(opacity * 255)
    .toString(16)
    .padStart(2, "0")}`;

/**
 * How `dependency-cruiser.dot` draws: in the diagram skin's light roles,
 * replacing the cruiser's own theme, which fills each file type with its
 * own pastel. Here color says what a module is to the graph, never what
 * language it is written in, and the accent is kept for what is wrong: a
 * rule's error and a cycle. Folders are hairline containers.
 *
 * Edges stay curved: the skin draws right-angled connectors, but Graphviz's
 * orthogonal router fails outright on a repository-sized graph.
 *
 * Bump the tool version when this changes: it is what the file draws.
 */
export const DOT_THEME = {
  replace: true,
  graph: {
    rankdir: "LR",
    splines: "true",
    overlap: "false",
    nodesep: "0.16",
    ranksep: "0.32",
    bgcolor: skin.paper,
    style: "rounded",
    color: skin.rule,
    penwidth: "1",
    fontname: DIAGRAM_LAYOUT_FONTS.mono,
    fontsize: "9",
    fontcolor: skin.soft,
    compound: "true",
  },
  node: {
    shape: "box",
    style: "rounded,filled",
    height: "0.3",
    margin: "0.12,0.06",
    penwidth: "1",
    color: skin.ink,
    fillcolor: skin.node,
    fontcolor: skin.ink,
    fontname: DIAGRAM_LAYOUT_FONTS.sans,
    // Geist at a name's weight runs a tenth wider than Helvetica: the
    // workbench draws it a tenth smaller, at the skin's 12px.
    fontsize: "13",
  },
  edge: {
    arrowhead: "normal",
    arrowsize: "0.6",
    penwidth: "1",
    color: skin.muted,
    fontname: DIAGRAM_LAYOUT_FONTS.mono,
    fontsize: "8",
    fontcolor: skin.muted,
  },
  // The first entry a module matches wins each attribute.
  modules: [
    {
      criteria: { "rules[0].severity": "error" },
      attributes: {
        color: skin.accent,
        fillcolor: faded(skin.accent, 0.08),
        fontcolor: skin.ink,
      },
    },
    {
      criteria: { matchesHighlight: true },
      attributes: { color: skin.accent, fillcolor: faded(skin.accent, 0.08) },
    },
    {
      criteria: { "rules[0].severity": "warn" },
      attributes: {
        color: faded(skin.accent, 0.5),
        fillcolor: faded(skin.accent, 0.05),
        style: "rounded,filled,dashed",
      },
    },
    { criteria: { consolidated: true }, attributes: { shape: "box3d" } },
    { criteria: { matchesDoNotFollow: true }, attributes: { shape: "folder" } },
    // Outside the repository: a package or the runtime's own module.
    {
      criteria: { coreModule: true },
      attributes: {
        color: faded(skin.ink, 0.3),
        fillcolor: faded(skin.ink, 0.03),
        fontcolor: skin.muted,
      },
    },
    {
      criteria: { source: "node_modules" },
      attributes: {
        color: faded(skin.ink, 0.3),
        fillcolor: faded(skin.ink, 0.03),
        fontcolor: skin.muted,
      },
    },
    // Nothing imports it and it imports nothing.
    {
      criteria: { orphan: true },
      attributes: {
        color: faded(skin.ink, 0.2),
        fillcolor: faded(skin.ink, 0.02),
        style: "rounded,filled,dashed",
      },
    },
    {
      criteria: { "rules[0].severity": "info" },
      attributes: { color: skin.soft },
    },
  ],
  dependencies: [
    {
      criteria: { "rules[0].severity": "error" },
      attributes: { color: skin.accent, fontcolor: skin.accent },
    },
    {
      criteria: { circular: true },
      attributes: { color: skin.accent, style: "dashed" },
    },
    {
      criteria: { "rules[0].severity": "warn" },
      attributes: { color: faded(skin.accent, 0.5), style: "dashed" },
    },
    {
      criteria: { "rules[0].severity": "info" },
      attributes: { color: skin.soft },
    },
    // Optional or passive: loaded later, or gone once compiled.
    { criteria: { dynamic: true }, attributes: { style: "dashed" } },
    {
      criteria: {
        dependencyTypes: [
          "pre-compilation-only",
          "triple-slash-type-reference",
          "type-import",
          "type-only",
        ],
      },
      attributes: { arrowhead: "onormal", style: "dashed", color: skin.soft },
    },
    {
      criteria: { dependencyTypes: ["export"] },
      attributes: { arrowhead: "inv" },
    },
    {
      criteria: { dependencyTypes: "core" },
      attributes: { style: "dashed", color: skin.soft },
    },
    { criteria: { dependencyTypes: "npm" }, attributes: { color: skin.soft } },
  ],
};

/**
 * The cruise, on a thread of its own. It reads and parses every file
 * synchronously, so on the worker's own thread a large repository held
 * the heartbeat and the deadline timer until it finished, and an abort
 * could not stop it. Aborting terminates the thread.
 */
export function cruiseInThread(
  cruiseOptions: ICruiseOptions,
  signal: AbortSignal,
): Promise<string> {
  if (signal.aborted) return Promise.reject(signal.reason as Error);
  return new Promise((resolvePromise, reject) => {
    const thread = new Worker(new URL("./cruise-thread.js", import.meta.url), {
      workerData: cruiseOptions,
    });
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      void thread.terminate();
      finish();
    };
    const abort = () => settle(() => reject(signal.reason));
    signal.addEventListener("abort", abort, { once: true });
    thread.once("message", (output: string) =>
      settle(() => resolvePromise(output)),
    );
    thread.once("error", (error) => settle(() => reject(error)));
    thread.once("exit", (code) =>
      settle(() => reject(new Error(`The cruise thread exited with ${code}.`))),
    );
  });
}

/** Dependency types that name a package or a runtime built-in, not a repository file. */
const EXTERNAL_TYPES = new Set<string>([
  "npm",
  "npm-dev",
  "npm-peer",
  "npm-optional",
  "npm-bundled",
  "npm-no-pkg",
  "npm-unknown",
  "core",
]);

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A package name rather than a path: not relative, absolute or a `#` subpath import. */
function isBareSpecifier(module: string): boolean {
  return !/^[./#]/.test(module);
}

/** A cycle's canonical spelling: rotated to start at its smallest member. */
function canonicalCycle(names: readonly string[]): string[] {
  let start = 0;
  for (let index = 1; index < names.length; index += 1)
    if (compare(names[index] ?? "", names[start] ?? "") < 0) start = index;
  return [...names.slice(start), ...names.slice(0, start)];
}

/** The console's view of a cruise: counts and bounded, sorted lists. */
/** A module of the repository itself, not a package, a built-in or a name that resolved to nothing. */
function isRepositoryModule(module: ICruiseResult["modules"][number]): boolean {
  return (
    module.coreModule !== true &&
    module.couldNotResolve !== true &&
    !(module.dependencyTypes ?? []).some((type) => EXTERNAL_TYPES.has(type))
  );
}

/**
 * The console's view of a cruise: counts and bounded, sorted lists. The
 * cruise lists what it could not resolve as modules too; the counts and
 * the ranking cover the repository's own modules, and their dependencies
 * are where packages and unresolved names are counted.
 */
export function summarize(result: ICruiseResult): DependencyCruiserSummaryDto {
  const modules = result.modules
    .filter(isRepositoryModule)
    .sort((a, b) => compare(a.source, b.source));
  const limits = DEPENDENCY_SUMMARY_LIMITS;
  let dependencies = 0;
  let circular = 0;
  let unresolved = 0;
  let external = 0;
  const cycles = new Map<string, string[]>();
  const unresolvedList: { from: string; module: string }[] = [];
  for (const module of modules) {
    for (const dependency of module.dependencies) {
      dependencies += 1;
      if (dependency.circular) {
        circular += 1;
        const names = (dependency.cycle ?? []).map((step) => step.name);
        if (names.length > 0) {
          const cycle = canonicalCycle(names);
          cycles.set(cycle.join("\n"), cycle);
        }
      }
      if (
        dependency.dependencyTypes.some((type) => EXTERNAL_TYPES.has(type)) ||
        (dependency.couldNotResolve && isBareSpecifier(dependency.module))
      )
        external += 1;
      else if (dependency.couldNotResolve) {
        unresolved += 1;
        unresolvedList.push({ from: module.source, module: dependency.module });
      }
    }
  }
  const orphans = modules
    .filter((module) => module.orphan === true)
    .map((module) => module.source);
  const busiest = modules
    .map((module) => ({
      source: module.source,
      dependents: module.dependents.length,
      dependencies: module.dependencies.length,
    }))
    .sort(
      (a, b) =>
        b.dependents + b.dependencies - (a.dependents + a.dependencies) ||
        compare(a.source, b.source),
    );
  const sortedCycles = [...cycles.entries()]
    .sort(([a], [b]) => compare(a, b))
    .map(([, cycle]) => cycle);
  unresolvedList.sort(
    (a, b) => compare(a.from, b.from) || compare(a.module, b.module),
  );
  return {
    schemaVersion: 1,
    toolVersion: DEPENDENCY_CRUISER_TOOL_VERSION,
    counts: {
      modules: modules.length,
      dependencies,
      circular,
      orphans: orphans.length,
      unresolved,
      external,
    },
    modules: busiest.slice(0, limits.modules),
    cycles: sortedCycles.slice(0, limits.cycles),
    orphans: orphans.slice(0, limits.orphans),
    unresolved: unresolvedList.slice(0, limits.unresolved),
    truncated:
      busiest.length > limits.modules ||
      sortedCycles.length > limits.cycles ||
      orphans.length > limits.orphans ||
      unresolvedList.length > limits.unresolved,
  };
}

export function createDependencyCruiserAdapter(
  options: { cruise?: typeof cruise; format?: typeof format } = {},
): ToolAdapter {
  return {
    name: "dependency_cruiser",
    version: DEPENDENCY_CRUISER_TOOL_VERSION,
    async run(input) {
      if (!isDependencyCruiserParams(input.params))
        throw new AnalysisError("tool_failed");
      input.signal.throwIfAborted();
      input.log("Dependency cruise started.");
      let json: string;
      let result: ICruiseResult;
      let dot: string;
      try {
        const cruiseOptions = { ...CRUISE_OPTIONS, baseDir: input.sourceDir };
        if (options.cruise === undefined) {
          json = await cruiseInThread(cruiseOptions, input.signal);
        } else {
          const cruised = await options.cruise(["."], cruiseOptions);
          json =
            typeof cruised.output === "string"
              ? cruised.output
              : JSON.stringify(cruised.output);
        }
        result = JSON.parse(json) as ICruiseResult;
        // The options echoed back carry this run's scratch directory, which
        // changes every run and names the worker's disk, not the snapshot.
        const used = result.summary.optionsUsed as { baseDir?: unknown };
        if ("baseDir" in used) {
          delete used.baseDir;
          json = JSON.stringify(result);
        }
        // Not in the format options' type, but read from them: the result's
        // own options are re-summarised with these over them.
        const dotOptions = {
          outputType: "dot",
          reporterOptions: { dot: { theme: DOT_THEME } },
        } as const;
        const formatted = await (options.format ?? format)(result, dotOptions);
        dot =
          typeof formatted.output === "string"
            ? formatted.output
            : JSON.stringify(formatted.output);
      } catch (error) {
        if (input.signal.aborted) throw error;
        throw new AnalysisError("tool_failed");
      }
      input.signal.throwIfAborted();
      if (!Array.isArray(result.modules))
        throw new AnalysisError("tool_failed");
      const summary = summarize(result) as unknown as Record<string, unknown>;
      await mkdir(input.outDir, { recursive: true });
      const outputs: {
        path: string;
        text: string;
        kind: ArtifactFile["kind"];
        contentType: string;
        meta: Record<string, unknown> | null;
      }[] = [
        {
          path: "dependency-cruiser.json",
          text: json,
          kind: "dependency_graph",
          contentType: "application/json",
          meta: summary,
        },
        {
          path: "dependency-cruiser.dot",
          text: dot,
          kind: "dependency_dot",
          contentType: "text/plain; charset=utf-8",
          meta: null,
        },
        {
          path: "manifest.json",
          text: JSON.stringify(summary, null, 2),
          kind: "manifest",
          contentType: "application/json",
          meta: summary,
        },
      ];
      const files: ArtifactFile[] = [];
      for (const output of outputs) {
        const absolutePath = join(input.outDir, output.path);
        await writeFile(absolutePath, output.text, "utf8");
        files.push({
          path: output.path,
          absolutePath,
          kind: output.kind,
          contentType: output.contentType,
          meta: output.meta,
        });
      }
      input.log("Dependency cruise completed.");
      return files;
    },
  };
}
