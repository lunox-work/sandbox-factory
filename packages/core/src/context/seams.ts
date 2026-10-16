/**
 * What an `abstractions` run writes beside the surfaces: per module, the
 * services and environment variables the slice would list for it, read
 * once with the slice's own extraction (`detectExternals`). A slice's
 * externals are the union of its files' entries, so the scope agent looks
 * them up rather than slicing to find them.
 *
 * Only modules that reach something are listed. Every other file of the
 * graph reaches nothing, unless it is `partial` or past `coveredThrough`;
 * for those the index cannot say, and the slice must read them. Everything
 * here is a pure function of the graph's file list and the source text.
 */

import { ABSTRACTIONS_TOOL_VERSION } from "../analysis.js";
import { detectExternals } from "../slice/externals.js";
import type { SliceExternals } from "../slice/externals.js";
import type { SliceGraph } from "../slice/graph.js";
import { fileOf } from "../slice/graph.js";

export const SEAMS_INDEX_SCHEMA_VERSION = 1;

/** Bounds on what one file, and the whole index, may carry. */
export const SEAMS_LIMITS = {
  /** A larger file is not read; it is partial. */
  fileBytes: 1024 * 1024,
  /** Specifiers or names one module lists before it is partial. */
  packagesPerModule: 50,
  environmentPerModule: 100,
  /** Modules and partial files together, in path order. */
  entries: 20_000,
} as const;

export interface ModuleSeams {
  readonly path: string;
  /** Service imports by specifier, sorted. */
  readonly packages: readonly {
    readonly specifier: string;
    readonly service: string;
  }[];
  /** Environment variable names read, sorted. */
  readonly environment: readonly string[];
}

/** `seams.json`. */
export interface SeamsIndex {
  readonly schemaVersion: typeof SEAMS_INDEX_SCHEMA_VERSION;
  readonly toolVersion: string;
  readonly sourceSnapshotId: string;
  readonly sourceCommitSha: string;
  readonly graphRunId: string;
  readonly graphSha256: string;
  /** Files of the graph the index was computed over. */
  readonly files: number;
  /** Modules that reach a service or an environment variable, sorted by path. */
  readonly modules: readonly ModuleSeams[];
  /**
   * Files whose entry is not exact: unreadable, over `fileBytes`, or with
   * more names than a module lists. Sorted.
   */
  readonly partial: readonly string[];
  /** The last path covered when the entries ran out; null for all of them. */
  readonly coveredThrough: string | null;
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Every file the graph names, which is every file a slice can include. */
export function seamsFiles(graph: SliceGraph): string[] {
  const files = new Set<string>();
  for (const node of graph.nodes) {
    const file = fileOf(node);
    if (file !== null) files.add(file);
  }
  return [...files].sort(compare);
}

/** One file's entry, and whether it is exact. */
export interface FileSeams {
  readonly path: string;
  /** Null when the file reaches nothing, or was not read. */
  readonly entry: ModuleSeams | null;
  readonly exact: boolean;
}

/**
 * One file's entry from its text, null for a file that could not be read:
 * `detectExternals` of that file alone, so a union of entries is
 * `detectExternals` of the union.
 */
export function fileSeams(path: string, text: string | null): FileSeams {
  if (text === null) return { path, entry: null, exact: false };
  const found = detectExternals([{ path, text }]);
  return {
    path,
    entry:
      found.packages.length + found.environment.length === 0
        ? null
        : {
            path,
            packages: found.packages
              .slice(0, SEAMS_LIMITS.packagesPerModule)
              .map(({ specifier, service }) => ({ specifier, service })),
            environment: found.environment
              .slice(0, SEAMS_LIMITS.environmentPerModule)
              .map(({ name }) => name),
          },
    exact:
      found.packages.length <= SEAMS_LIMITS.packagesPerModule &&
      found.environment.length <= SEAMS_LIMITS.environmentPerModule,
  };
}

/** The index from every file's entry, kept in path order up to the bound. */
export function buildSeamsIndex(input: {
  readonly files: readonly FileSeams[];
  readonly snapshotId: string;
  readonly commitSha: string;
  readonly graphRunId: string;
  readonly graphSha256: string;
}): SeamsIndex {
  const files = [...input.files].sort((a, b) => compare(a.path, b.path));
  const modules: ModuleSeams[] = [];
  const partial: string[] = [];
  let coveredThrough: string | null = null;
  let previous = "";
  for (const file of files) {
    if (file.entry !== null || !file.exact) {
      if (modules.length + partial.length >= SEAMS_LIMITS.entries) {
        coveredThrough = previous;
        break;
      }
      if (file.entry !== null) modules.push(file.entry);
      if (!file.exact) partial.push(file.path);
    }
    previous = file.path;
  }
  return {
    schemaVersion: SEAMS_INDEX_SCHEMA_VERSION,
    toolVersion: ABSTRACTIONS_TOOL_VERSION,
    sourceSnapshotId: input.snapshotId,
    sourceCommitSha: input.commitSha,
    graphRunId: input.graphRunId,
    graphSha256: input.graphSha256,
    files: files.length,
    modules,
    partial,
    coveredThrough,
  };
}

/**
 * The externals the slice would list for these files, from the index, as
 * `detectExternals` gives them; `unknown` names the files the index cannot
 * answer for, and when it is not empty the externals leave them out. The
 * files are taken to be the graph's: a path it never named reaches nothing.
 */
export function lookupSeams(
  index: SeamsIndex,
  files: readonly string[],
): { readonly externals: SliceExternals; readonly unknown: readonly string[] } {
  const byPath = new Map(index.modules.map((module) => [module.path, module]));
  const partial = new Set(index.partial);
  const packages = new Map<string, { service: string; files: Set<string> }>();
  const environment = new Map<string, Set<string>>();
  const unknown = new Set<string>();
  for (const path of files) {
    if (
      partial.has(path) ||
      (index.coveredThrough !== null && compare(path, index.coveredThrough) > 0)
    ) {
      unknown.add(path);
      continue;
    }
    const module = byPath.get(path);
    if (module === undefined) continue;
    for (const { specifier, service } of module.packages) {
      const entry = packages.get(specifier) ?? { service, files: new Set() };
      entry.files.add(path);
      packages.set(specifier, entry);
    }
    for (const name of module.environment) {
      const entry = environment.get(name) ?? new Set();
      entry.add(path);
      environment.set(name, entry);
    }
  }
  return {
    externals: {
      packages: [...packages.entries()]
        .sort(([a], [b]) => compare(a, b))
        .map(([specifier, entry]) => ({
          specifier,
          service: entry.service,
          files: [...entry.files].sort(compare),
        })),
      environment: [...environment.entries()]
        .sort(([a], [b]) => compare(a, b))
        .map(([name, paths]) => ({ name, files: [...paths].sort(compare) })),
    },
    unknown: [...unknown].sort(compare),
  };
}
