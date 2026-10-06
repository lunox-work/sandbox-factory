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

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cruise, format } from "dependency-cruiser";
import type { ICruiseOptions, ICruiseResult } from "dependency-cruiser";
import {
  DEPENDENCY_CRUISER_TOOL_VERSION,
  isDependencyCruiserParams,
} from "sandbox-factory";
import { DEPENDENCY_SUMMARY_LIMITS } from "@sandbox-factory/shared";
import type { DependencyCruiserSummaryDto } from "@sandbox-factory/shared";
import { AnalysisError } from "../errors.js";
import type { ArtifactFile, ToolAdapter } from "./adapter.js";

/**
 * Fixed for every run: the summary is a function of the snapshot alone.
 * `baseDir` is added per run. Bump the tool version when these change.
 */
export const CRUISE_OPTIONS = {
  outputType: "json",
  tsPreCompilationDeps: true,
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
        const cruised = await (options.cruise ?? cruise)(["."], {
          ...CRUISE_OPTIONS,
          baseDir: input.sourceDir,
        });
        json =
          typeof cruised.output === "string"
            ? cruised.output
            : JSON.stringify(cruised.output);
        result = JSON.parse(json) as ICruiseResult;
        const formatted = await (options.format ?? format)(result, {
          outputType: "dot",
        });
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
