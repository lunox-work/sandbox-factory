/**
 * What an `abstractions` run writes: every module's callable surface, the
 * exported functions, classes, interfaces and types with their signatures.
 * It is what a stub looks like at any cut, before anyone picks entry points.
 *
 * Coverage is recorded per module, never implied. `typed` is the
 * TypeScript compiler's own declaration text; `syntactic` is a signature as
 * written, read with a tree-sitter grammar, with no type resolved;
 * `names-only` is what graphify's map knows: names, kinds and lines.
 *
 * An export shares its id with the graph: the graph's module-qualified
 * symbol id when the graph has a node for it, otherwise the id
 * `surfaceSymbolId` gives, which no graph node can take. Everything here is
 * a pure function of the graph and the extracted surfaces.
 */

import type { SliceGraph } from "../slice/graph.js";
import { fileOf } from "../slice/graph.js";

export const ABSTRACTION_INDEX_SCHEMA_VERSION = 1;

export const SURFACE_COVERAGES = ["typed", "syntactic", "names-only"] as const;
export type SurfaceCoverage = (typeof SURFACE_COVERAGES)[number];

export const SURFACE_KINDS = [
  "function",
  "class",
  "interface",
  "type",
  "enum",
  "const",
  "method",
  "namespace",
] as const;
export type SurfaceKind = (typeof SURFACE_KINDS)[number];

export interface SurfaceExport {
  /** The graph's symbol id, or `surfaceSymbolId(path, name)`. */
  readonly id: string;
  /** As the module exports it; a method is `Class.method`. */
  readonly name: string;
  readonly kind: SurfaceKind;
  /** Declaration text with bodies elided; null when names-only. */
  readonly signature: string | null;
  /** 1-based line of the declaration in the module. */
  readonly line: number;
  /** Types it names, by symbol id or package specifier, sorted. */
  readonly references: readonly string[];
}

export interface ModuleSurface {
  readonly path: string;
  readonly language: string;
  readonly coverage: SurfaceCoverage;
  /** Repository files importing it, from the graph. */
  readonly importers: number;
  /** Sorted by line, then name. */
  readonly exports: readonly SurfaceExport[];
}

export const ABSTRACTION_OMISSION_CODES = [
  "program_too_large",
  "compiler_config",
  "declaration_failed",
  "parse_failed",
  "read_failed",
  "exports_capped",
  "signature_truncated",
  "extractor_failed",
] as const;
export type AbstractionOmissionCode =
  (typeof ABSTRACTION_OMISSION_CODES)[number];

/** Something the builder left out, and why; finding nothing is not one. */
export interface AbstractionOmission {
  readonly code: AbstractionOmissionCode;
  readonly file: string | null;
  readonly detail: string;
}

/** `abstractions.json`. */
export interface AbstractionIndex {
  readonly schemaVersion: typeof ABSTRACTION_INDEX_SCHEMA_VERSION;
  readonly toolVersion: string;
  /** The extractors that produced the typed and syntactic tiers, when they ran. */
  readonly extractors: {
    readonly typescript: string | null;
    readonly syntactic: string | null;
  };
  readonly sourceSnapshotId: string;
  readonly sourceCommitSha: string;
  readonly graphRunId: string;
  readonly graphSha256: string;
  /** Sorted by path. */
  readonly modules: readonly ModuleSurface[];
  /** Package specifiers the typed declarations name, sorted. */
  readonly externals: readonly string[];
  /** Sorted by file, code and detail. */
  readonly omissions: readonly AbstractionOmission[];
}

/** Bounds on what one module or signature may carry into the index. */
export const ABSTRACTION_LIMITS = {
  exportsPerModule: 500,
  signatureChars: 8_000,
} as const;

/** What the summary and the readable view may list before they are cut. */
export const ABSTRACTIONS_SUMMARY_LIMITS = {
  modules: 25,
  omissions: 25,
  markdownModules: 300,
  markdownChars: 256 * 1024,
} as const;

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The id an export takes when the graph has no node for it. `#` never
 * appears in the driver's ids, which are `symbol:<path>:<name>`.
 */
export function surfaceSymbolId(path: string, name: string): string {
  return `symbol:${path}#${name}`;
}

/** The languages the builder names, by file extension; null for anything else. */
const LANGUAGES: Readonly<Record<string, string>> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  go: "go",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  cs: "csharp",
  rs: "rust",
  rb: "ruby",
  php: "php",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hh: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  scala: "scala",
  swift: "swift",
  lua: "lua",
  jl: "julia",
  ex: "elixir",
  exs: "elixir",
  m: "objc",
  mm: "objc",
  zig: "zig",
  ps1: "powershell",
  v: "verilog",
  sv: "verilog",
};
export function surfaceLanguageOf(path: string): string | null {
  const name = path.split("/").at(-1) ?? path;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return LANGUAGES[name.slice(dot + 1).toLowerCase()] ?? null;
}

const IMPORT_RELATIONS = new Set(["imports", "imports_from"]);

/** Repository files importing each file, counted once per importer. */
export function importerCounts(graph: SliceGraph): Map<string, number> {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const importers = new Map<string, Set<string>>();
  for (const link of graph.links) {
    if (!IMPORT_RELATIONS.has(link.relation)) continue;
    const source = byId.get(link.source);
    const target = byId.get(link.target);
    if (source === undefined || target === undefined) continue;
    const from = fileOf(source);
    const to = fileOf(target);
    if (from === null || to === null || from === to) continue;
    const set = importers.get(to) ?? new Set<string>();
    set.add(from);
    importers.set(to, set);
  }
  return new Map([...importers].map(([file, set]) => [file, set.size]));
}

/** One symbol node of the graph, as the builder matches exports to it. */
export interface GraphSymbol {
  readonly id: string;
  /** The label without a leading `.` or a trailing `()`. */
  readonly name: string;
  readonly line: number | null;
  /** The driver labels a method `.name()`. */
  readonly method: boolean;
  /** Whether the driver wrote it as a call (`name()`). */
  readonly callable: boolean;
  /** For a method, the symbol the graph says owns it. */
  readonly owner: string | null;
}

/** The graph's symbol nodes by file, sorted by line then id. */
export function graphSymbols(graph: SliceGraph): Map<string, GraphSymbol[]> {
  const owners = new Map<string, string>();
  for (const link of graph.links)
    if (link.relation === "method") owners.set(link.target, link.source);
  const byFile = new Map<string, GraphSymbol[]>();
  for (const node of graph.nodes) {
    if (node.kind !== "symbol") continue;
    const label = node.label.trim();
    const symbol: GraphSymbol = {
      id: node.id,
      name: label.replace(/^\./, "").replace(/\(\)$/, ""),
      line: node.line,
      method: label.startsWith("."),
      callable: label.endsWith("()"),
      owner: owners.get(node.id) ?? null,
    };
    const list = byFile.get(node.sourceFile) ?? [];
    list.push(symbol);
    byFile.set(node.sourceFile, list);
  }
  for (const list of byFile.values())
    list.sort((a, b) => (a.line ?? 0) - (b.line ?? 0) || compare(a.id, b.id));
  return byFile;
}

/**
 * The id of the export `name` (a method as `Class.method`) declared at
 * `line`: the graph's node with that name at that line, else the only node
 * of that name in the file, else `surfaceSymbolId`.
 */
export function surfaceIdFor(
  symbols: readonly GraphSymbol[] | undefined,
  path: string,
  name: string,
  line: number,
): string {
  const bare = name.split(".").at(-1) ?? name;
  const method = name.includes(".");
  const candidates = (symbols ?? []).filter(
    (symbol) => symbol.name === bare && symbol.method === method,
  );
  const exact = candidates.find((symbol) => symbol.line === line);
  if (exact !== undefined) return exact.id;
  const [only, other] = candidates;
  return only !== undefined && other === undefined
    ? only.id
    : surfaceSymbolId(path, name);
}

/**
 * Names-only surfaces from the graph: every symbol node of a file, with a
 * method qualified by the symbol that owns it.
 */
export function namesOnlyExports(
  symbols: readonly GraphSymbol[],
): SurfaceExport[] {
  const byId = new Map(symbols.map((symbol) => [symbol.id, symbol]));
  const owning = new Set(
    symbols.flatMap((symbol) => (symbol.owner === null ? [] : [symbol.owner])),
  );
  return sortExports(
    symbols.map((symbol): SurfaceExport => {
      const owner = symbol.owner === null ? undefined : byId.get(symbol.owner);
      return {
        id: symbol.id,
        name:
          symbol.method && owner !== undefined
            ? `${owner.name}.${symbol.name}`
            : symbol.name,
        kind: symbol.method
          ? "method"
          : symbol.callable
            ? "function"
            : owning.has(symbol.id)
              ? "class"
              : "type",
        signature: null,
        line: symbol.line ?? 1,
        references: [],
      };
    }),
  ).slice(0, ABSTRACTION_LIMITS.exportsPerModule);
}

export function sortExports<T extends Pick<SurfaceExport, "line" | "name">>(
  exports: readonly T[],
): T[] {
  return [...exports].sort(
    (a, b) => a.line - b.line || compare(a.name, b.name),
  );
}

/** A signature cut to the limit, and whether it was. */
export function boundedSignature(text: string): {
  signature: string;
  truncated: boolean;
} {
  const trimmed = text.trim();
  return trimmed.length <= ABSTRACTION_LIMITS.signatureChars
    ? { signature: trimmed, truncated: false }
    : {
        signature: `${trimmed.slice(0, ABSTRACTION_LIMITS.signatureChars)}…`,
        truncated: true,
      };
}

/** Modules most imported first, then by path. */
export function byImporters(
  modules: readonly ModuleSurface[],
): ModuleSurface[] {
  return [...modules].sort(
    (a, b) => b.importers - a.importers || compare(a.path, b.path),
  );
}

/** What the `manifest.json` artifact's `meta` carries for the console. */
export interface AbstractionsSummary {
  readonly schemaVersion: 1;
  readonly toolVersion: string;
  readonly counts: {
    readonly modules: number;
    readonly exports: number;
    readonly omissions: number;
  };
  /** Modules by coverage. */
  readonly coverage: Readonly<Record<SurfaceCoverage, number>>;
  /** Most modules first, then by name. */
  readonly languages: readonly {
    readonly language: string;
    readonly modules: number;
    readonly exports: number;
  }[];
  /** The most imported modules, with their export counts. */
  readonly modules: readonly {
    readonly path: string;
    readonly language: string;
    readonly coverage: SurfaceCoverage;
    readonly importers: number;
    readonly exports: number;
  }[];
  readonly omissions: readonly AbstractionOmission[];
  readonly truncated: boolean;
}

export function abstractionsSummary(
  index: AbstractionIndex,
): AbstractionsSummary {
  const limits = ABSTRACTIONS_SUMMARY_LIMITS;
  const coverage: Record<SurfaceCoverage, number> = {
    typed: 0,
    syntactic: 0,
    "names-only": 0,
  };
  const languages = new Map<string, { modules: number; exports: number }>();
  let exports = 0;
  for (const module of index.modules) {
    coverage[module.coverage] += 1;
    exports += module.exports.length;
    const language = languages.get(module.language) ?? {
      modules: 0,
      exports: 0,
    };
    language.modules += 1;
    language.exports += module.exports.length;
    languages.set(module.language, language);
  }
  const ranked = byImporters(index.modules);
  return {
    schemaVersion: 1,
    toolVersion: index.toolVersion,
    counts: {
      modules: index.modules.length,
      exports,
      omissions: index.omissions.length,
    },
    coverage,
    languages: [...languages.entries()]
      .map(([language, counts]) => ({ language, ...counts }))
      .sort((a, b) => b.modules - a.modules || compare(a.language, b.language)),
    modules: ranked.slice(0, limits.modules).map((module) => ({
      path: module.path,
      language: module.language,
      coverage: module.coverage,
      importers: module.importers,
      exports: module.exports.length,
    })),
    omissions: index.omissions.slice(0, limits.omissions),
    truncated:
      ranked.length > limits.modules ||
      index.omissions.length > limits.omissions,
  };
}

const FENCE: Readonly<Record<string, string>> = {
  typescript: "ts",
  javascript: "ts",
  python: "python",
  go: "go",
  java: "java",
  kotlin: "kotlin",
  csharp: "csharp",
  rust: "rust",
  ruby: "ruby",
  php: "php",
  c: "c",
  cpp: "cpp",
};

/**
 * `abstractions.md`: the readable view, most-imported modules first, cut at
 * a number of modules and characters, never carrying what the index does
 * not.
 */
export function renderAbstractionsMarkdown(index: AbstractionIndex): string {
  const limits = ABSTRACTIONS_SUMMARY_LIMITS;
  const ranked = byImporters(index.modules).filter(
    (module) => module.exports.length > 0,
  );
  const lines = [
    "# Abstractions",
    "",
    `Every module's exported surface at commit ${index.sourceCommitSha}, most imported first. Coverage: \`typed\` declarations come from the TypeScript compiler; \`syntactic\` signatures are as written, with no type resolved; \`names-only\` lists what the structure analysis knows.`,
    "",
  ];
  let size = lines.join("\n").length;
  let shown = 0;
  for (const module of ranked) {
    if (shown >= limits.markdownModules) break;
    const fence = FENCE[module.language] ?? "";
    const block = [
      `## ${module.path}`,
      "",
      `${module.language} · ${module.coverage} · imported by ${module.importers} ${module.importers === 1 ? "file" : "files"}`,
      "",
      ...(module.coverage === "names-only"
        ? module.exports.map(
            (entry) => `- \`${entry.name}\` (${entry.kind}, L${entry.line})`,
          )
        : [
            `\`\`\`${fence}`,
            ...module.exports.map((entry) => entry.signature ?? entry.name),
            "```",
          ]),
      "",
    ].join("\n");
    if (size + block.length > limits.markdownChars) break;
    lines.push(block);
    size += block.length + 1;
    shown += 1;
  }
  if (shown < ranked.length)
    lines.push(
      `${ranked.length - shown} more ${ranked.length - shown === 1 ? "module is" : "modules are"} in abstractions.json.`,
      "",
    );
  return lines.join("\n");
}
