/**
 * The abstractions adapter: every module's callable surface on a snapshot,
 * from the graphify run on the same snapshot and the source.
 *
 * The graph names the modules (every code file it parsed, tests aside),
 * how many files import each, and the symbol ids an export shares with it.
 * TypeScript and JavaScript are read with the compiler (`typed`), Python,
 * Go and Java with the pinned tree-sitter grammars (`syntactic`), and
 * anything else from the graph's own symbol nodes (`names-only`). A module
 * a tier could not read falls to the next, and an omission says why.
 * Nothing in the repository is executed, and the index is a pure function
 * of the graph and the source bytes.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ABSTRACTIONS_TOOL_VERSION,
  ABSTRACTION_INDEX_SCHEMA_VERSION,
  ABSTRACTION_LIMITS,
  ABSTRACTION_OMISSION_CODES,
  SURFACE_KINDS,
  abstractionsSummary,
  boundedSignature,
  canonicalJson,
  graphSymbols,
  importerCounts,
  isAbstractionsParams,
  isTestFile,
  namesOnlyExports,
  renderAbstractionsMarkdown,
  sortExports,
  surfaceIdFor,
  surfaceLanguageOf,
} from "sandbox-factory";
import type {
  AbstractionIndex,
  AbstractionOmission,
  ModuleSurface,
  SliceGraph,
  SurfaceCoverage,
  SurfaceKind,
} from "sandbox-factory";
import { z } from "zod";
import { command } from "../command.js";
import { AnalysisError } from "../errors.js";
import { snapshotOf } from "./adapter.js";
import type { ArtifactFile, ToolAdapter } from "./adapter.js";
import { extractTypedSurfacesInThread } from "./abstractions/typescript.js";
import type {
  RawReference,
  TypedInput,
  TypedSurfaces,
} from "./abstractions/typescript.js";
import { loadGraph } from "./slice.js";
import { sha256 } from "./slice/hash.js";
import { isScriptPath } from "./slice/typescript.js";

/** Languages the syntactic tier reads; scripts reach it only past the program cap. */
export const SYNTACTIC_LANGUAGES: readonly string[] = ["python", "go", "java"];
/** Languages whose package is a directory, so a type is named across its files. */
const DIRECTORY_PACKAGES = new Set(["go", "java"]);

/** What `python/abstractions.py` writes. */
export const syntacticOutputSchema = z.object({
  version: z.string(),
  modules: z.array(
    z.object({
      path: z.string(),
      language: z.string(),
      exports: z.array(
        z.object({
          name: z.string().min(1),
          kind: z.enum(SURFACE_KINDS),
          signature: z.string(),
          line: z.number().int().positive(),
          references: z.array(z.string()),
        }),
      ),
    }),
  ),
  omissions: z.array(
    z.object({
      code: z.enum(ABSTRACTION_OMISSION_CODES),
      file: z.string().nullable(),
      detail: z.string(),
    }),
  ),
});
export type SyntacticOutput = z.infer<typeof syntacticOutputSchema>;

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The modules the builder describes: the graph's code files, tests aside. */
export function surfaceModules(graph: SliceGraph): string[] {
  return [
    ...new Set(
      graph.nodes
        .filter((node) => node.kind === "file")
        .map((node) => node.sourceFile),
    ),
  ]
    .filter((path) => surfaceLanguageOf(path) !== null && !isTestFile(path))
    .sort(compare);
}

interface Draft {
  readonly path: string;
  readonly language: string;
  readonly coverage: SurfaceCoverage;
  readonly exports: readonly {
    readonly name: string;
    readonly kind: SurfaceKind;
    readonly signature: string | null;
    readonly line: number;
    /** Typed: references to resolve; syntactic: names in the signature. */
    readonly references: readonly (RawReference | string)[];
  }[];
}

/**
 * The index from what each tier found. The graph decides the modules, the
 * importer counts and the ids; a reference resolves to an id when the
 * index has the export it names, or stays a package specifier.
 */
export function assembleIndex(input: {
  readonly graph: SliceGraph;
  readonly typed: TypedSurfaces | null;
  readonly syntactic: SyntacticOutput | null;
  readonly snapshotId: string;
  readonly commitSha: string;
  readonly graphRunId: string;
  readonly graphSha256: string;
}): AbstractionIndex {
  const symbols = graphSymbols(input.graph);
  const importers = importerCounts(input.graph);
  const typed = new Map(
    (input.typed?.modules ?? []).map((module) => [module.path, module]),
  );
  const syntactic = new Map(
    (input.syntactic?.modules ?? []).map((module) => [module.path, module]),
  );
  const omissions: AbstractionOmission[] = [
    ...(input.typed?.omissions ?? []),
    ...(input.syntactic?.omissions ?? []),
  ];
  const drafts: Draft[] = surfaceModules(input.graph).map((path) => {
    const language = surfaceLanguageOf(path) ?? "unknown";
    const fromTyped = typed.get(path);
    if (fromTyped !== undefined)
      return {
        path,
        language: fromTyped.language,
        coverage: "typed",
        exports: fromTyped.exports,
      };
    const fromSyntax = syntactic.get(path);
    if (fromSyntax !== undefined) {
      const exports = sortExports(fromSyntax.exports);
      if (exports.length > ABSTRACTION_LIMITS.exportsPerModule)
        omissions.push({
          code: "exports_capped",
          file: path,
          detail: `${exports.length} exports; the first ${ABSTRACTION_LIMITS.exportsPerModule} are listed.`,
        });
      return {
        path,
        language,
        coverage: "syntactic",
        exports: exports
          .slice(0, ABSTRACTION_LIMITS.exportsPerModule)
          .map((entry) => {
            const bounded = boundedSignature(entry.signature);
            if (bounded.truncated)
              omissions.push({
                code: "signature_truncated",
                file: path,
                detail: `${entry.name} is longer than ${ABSTRACTION_LIMITS.signatureChars} characters.`,
              });
            return { ...entry, signature: bounded.signature };
          }),
      };
    }
    return {
      path,
      language,
      coverage: "names-only",
      exports: namesOnlyExports(symbols.get(path) ?? []),
    };
  });
  // Ids first, so a reference can name any export in the index.
  const idOf = new Map<string, string>();
  const ids = drafts.map((draft) => {
    const used = new Set<string>();
    return draft.exports.map((entry) => {
      let id = surfaceIdFor(
        symbols.get(draft.path),
        draft.path,
        entry.name,
        entry.line,
      );
      // Overloads and redeclarations share a name; each keeps its own id.
      if (used.has(id)) id = `${id}@L${entry.line}`;
      for (let index = 2; used.has(id); index += 1)
        id = `${id.replace(/~\d+$/, "")}~${index}`;
      used.add(id);
      const key = `${draft.path}\n${entry.name}`;
      if (!idOf.has(key)) idOf.set(key, id);
      return id;
    });
  });
  // A type named across a Go or Java package's files, when only one has it.
  const byDirectory = new Map<string, Map<string, string[]>>();
  for (const draft of drafts) {
    if (!DIRECTORY_PACKAGES.has(draft.language)) continue;
    const key = `${draft.language}\n${dirname(draft.path)}`;
    const names = byDirectory.get(key) ?? new Map<string, string[]>();
    for (const entry of draft.exports) {
      const id = idOf.get(`${draft.path}\n${entry.name}`);
      if (id !== undefined && !entry.name.includes("."))
        names.set(entry.name, [...(names.get(entry.name) ?? []), id]);
    }
    byDirectory.set(key, names);
  }
  const externals = new Set<string>();
  const resolveReference = (draft: Draft, reference: RawReference | string) => {
    if (typeof reference === "string") {
      const own = idOf.get(`${draft.path}\n${reference}`);
      if (own !== undefined) return own;
      const shared = byDirectory
        .get(`${draft.language}\n${dirname(draft.path)}`)
        ?.get(reference);
      return shared?.length === 1 ? (shared[0] ?? null) : null;
    }
    if ("package" in reference) {
      externals.add(reference.package);
      return reference.package;
    }
    return idOf.get(`${reference.module}\n${reference.name}`) ?? null;
  };
  const modules: ModuleSurface[] = drafts.map((draft, index) => ({
    path: draft.path,
    language: draft.language,
    coverage: draft.coverage,
    importers: importers.get(draft.path) ?? 0,
    exports: draft.exports.map((entry, position) => {
      const id = ids[index]?.[position] ?? "";
      return {
        id,
        name: entry.name,
        kind: entry.kind,
        signature: entry.signature,
        line: entry.line,
        references: [
          ...new Set(
            entry.references.flatMap((reference) => {
              const resolved = resolveReference(draft, reference);
              return resolved === null || resolved === id ? [] : [resolved];
            }),
          ),
        ].sort(compare),
      };
    }),
  }));
  return {
    schemaVersion: ABSTRACTION_INDEX_SCHEMA_VERSION,
    toolVersion: ABSTRACTIONS_TOOL_VERSION,
    extractors: {
      typescript: input.typed?.extractorVersion ?? null,
      syntactic: input.syntactic?.version ?? null,
    },
    sourceSnapshotId: input.snapshotId,
    sourceCommitSha: input.commitSha,
    graphRunId: input.graphRunId,
    graphSha256: input.graphSha256,
    modules,
    externals: [...externals].sort(compare),
    omissions: omissions.sort(
      (a, b) =>
        compare(a.file ?? "", b.file ?? "") ||
        compare(a.code, b.code) ||
        compare(a.detail, b.detail),
    ),
  };
}

export function createAbstractionsAdapter(
  options: {
    execute?: typeof command;
    python?: string;
    scriptPath?: string;
    /** The typed tier; a worker thread unless a test runs it in place. */
    typed?: (input: TypedInput, signal: AbortSignal) => Promise<TypedSurfaces>;
  } = {},
): ToolAdapter {
  return {
    name: "abstractions",
    version: ABSTRACTIONS_TOOL_VERSION,
    async run(input) {
      const params = input.params;
      if (!isAbstractionsParams(params)) throw new AnalysisError("tool_failed");
      const snapshot = snapshotOf(input);
      input.log("Abstractions started.");
      const graph = await loadGraph(
        input.inputs,
        params.graphRunId,
        snapshot.snapshotId,
      );
      const files = surfaceModules(graph.graph);
      const scripts = files.filter(isScriptPath);
      let typed: TypedSurfaces | null = null;
      if (scripts.length > 0) {
        try {
          typed = await (options.typed ?? extractTypedSurfacesInThread)(
            { root: input.sourceDir, files: scripts },
            input.signal,
          );
        } catch (error) {
          if (input.signal.aborted) throw error;
          input.log(
            "The compiler stopped; the scripts are read syntactically.",
          );
          typed = {
            extractorVersion: "",
            modules: [],
            fallback: scripts,
            omissions: [
              {
                code: "extractor_failed",
                file: null,
                detail:
                  "The TypeScript compiler stopped; scripts are read syntactically.",
              },
            ],
          };
        }
        input.log(
          `Typed tier read ${typed.modules.length} of ${scripts.length} scripts.`,
        );
      }
      const listing = [
        ...files
          .filter((path) =>
            SYNTACTIC_LANGUAGES.includes(surfaceLanguageOf(path) ?? ""),
          )
          .map((path) => ({ path, language: surfaceLanguageOf(path) ?? "" })),
        ...(typed?.fallback ?? []).map((path) => ({
          path,
          language: surfaceLanguageOf(path) ?? "typescript",
        })),
      ].sort((a, b) => compare(a.path, b.path));
      let syntactic: SyntacticOutput | null = null;
      if (listing.length > 0) {
        const scratch = await mkdtemp(join(tmpdir(), "abstractions-"));
        try {
          const listingPath = join(scratch, "listing.json");
          const outPath = join(scratch, "syntactic.json");
          await writeFile(listingPath, JSON.stringify(listing), "utf8");
          const script =
            options.scriptPath ??
            fileURLToPath(
              new URL("../../python/abstractions.py", import.meta.url),
            );
          await (options.execute ?? command)(
            options.python ?? "python3",
            [script, input.sourceDir, listingPath, outPath],
            { signal: input.signal },
          );
          syntactic = syntacticOutputSchema.parse(
            JSON.parse(await readFile(outPath, "utf8")),
          );
        } catch (error) {
          if (input.signal.aborted) throw error;
          input.log(
            "The syntactic extractor failed; those modules are listed by name.",
          );
          syntactic = {
            version: "",
            modules: [],
            omissions: [
              {
                code: "extractor_failed",
                file: null,
                detail:
                  "The tree-sitter extractor stopped; its modules are listed by name.",
              },
            ],
          };
        } finally {
          await rm(scratch, { recursive: true, force: true });
        }
        input.log(
          `Syntactic tier read ${syntactic.modules.length} of ${listing.length} modules.`,
        );
      }
      input.signal.throwIfAborted();
      const index = assembleIndex({
        graph: graph.graph,
        typed,
        syntactic,
        snapshotId: snapshot.snapshotId,
        commitSha: snapshot.commitSha,
        graphRunId: graph.run.id,
        graphSha256: sha256(graph.bytes),
      });
      const summary = abstractionsSummary(index) as unknown as Record<
        string,
        unknown
      >;
      await mkdir(input.outDir, { recursive: true });
      const outputs: {
        path: string;
        text: string;
        kind: ArtifactFile["kind"];
        contentType: string;
        meta: Record<string, unknown> | null;
      }[] = [
        {
          path: "abstractions.json",
          text: canonicalJson(index),
          kind: "abstraction_index",
          contentType: "application/json",
          meta: summary,
        },
        {
          path: "abstractions.md",
          text: renderAbstractionsMarkdown(index),
          kind: "other",
          contentType: "text/markdown; charset=utf-8",
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
      const written: ArtifactFile[] = [];
      for (const output of outputs) {
        const absolutePath = join(input.outDir, output.path);
        await writeFile(absolutePath, output.text, "utf8");
        written.push({
          path: output.path,
          absolutePath,
          kind: output.kind,
          contentType: output.contentType,
          meta: output.meta,
        });
      }
      input.log(
        `Abstractions completed: ${index.modules.length} modules, ${index.omissions.length} omissions.`,
      );
      return written;
    },
  };
}
