/**
 * The data model adapter: the entities, fields, enums and relations a
 * repository stores, and the modules that touch them, from the graphify run
 * on the same snapshot and the source.
 *
 * No guessing from folder names: a recognizer runs only on its evidence.
 * Prisma runs on `.prisma` schema files; Drizzle on the files the graph
 * shows importing a Drizzle core module; SQL migrations on the `.sql` files
 * in the tree facts' migration directories or beside a Drizzle Kit journal.
 * Finding nothing is a success with an empty model. Nothing in the
 * repository is executed, and the model is a pure function of the graph
 * and the source bytes.
 */

import { constants } from "node:fs";
import { mkdir, open, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import {
  DATA_MODEL_SCHEMA_VERSION,
  DATA_MODEL_TOOL_VERSION,
  canonicalJson,
  dataModelSummary,
  importerCounts,
  isDataModelParams,
  isTestFile,
  mergeSources,
  packageNameOf,
  renderErdMermaid,
  surfaceLanguageOf,
  treeFacts,
} from "sandbox-factory";
import type {
  DataModel,
  DataModelOmission,
  RecognizedSource,
} from "sandbox-factory";
import { indexRepository } from "../agent/repo-tools.js";
import { AnalysisError } from "../errors.js";
import { snapshotOf } from "./adapter.js";
import type { ArtifactFile, ToolAdapter } from "./adapter.js";
import { findAccessors } from "./data-model/accessors.js";
import { recognizeDrizzle } from "./data-model/drizzle.js";
import { recognizePrisma } from "./data-model/prisma.js";
import { orderMigrations, replaySqlMigrations } from "./data-model/sql.js";
import { loadGraph } from "./slice.js";
import { sha256 } from "./slice/hash.js";

/** Bytes one schema, migration or code file may have to be read. */
export const DATA_MODEL_FILE_BYTES_MAX = 2 * 1024 * 1024;
/** Directories whose files are build output or vendored, never a schema. */
const IGNORED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "build",
  "vendor",
  "third_party",
  ".git",
]);
const DRIZZLE_CORE = /^drizzle-orm\/(pg|mysql|sqlite)-core$/;

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const ignored = (path: string) =>
  path.split("/").some((segment) => IGNORED_DIRECTORIES.has(segment));

/** A repository file's text: a regular file inside the root, within the size cap. */
export function sourceReader(root: string) {
  const cache = new Map<string, Promise<string | null>>();
  const read = async (path: string): Promise<string | null> => {
    const absolute = resolve(root, path);
    const rel = relative(root, absolute);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
    const handle = await open(
      absolute,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ).catch(() => null);
    if (handle === null) return null;
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.size > DATA_MODEL_FILE_BYTES_MAX)
        return null;
      return (await handle.readFile()).toString("utf8");
    } finally {
      await handle.close();
    }
  };
  return (path: string) => {
    let pending = cache.get(path);
    if (pending === undefined) {
      pending = read(path);
      cache.set(path, pending);
    }
    return pending;
  };
}

export function createDataModelAdapter(): ToolAdapter {
  return {
    name: "data_model",
    version: DATA_MODEL_TOOL_VERSION,
    async run(input) {
      const params = input.params;
      if (!isDataModelParams(params)) throw new AnalysisError("tool_failed");
      const snapshot = snapshotOf(input);
      input.log("Data model started.");
      const graph = await loadGraph(
        input.inputs,
        params.graphRunId,
        snapshot.snapshotId,
      );
      const index = await indexRepository(input.sourceDir, input.signal);
      const paths = index.paths.filter((path) => !ignored(path));
      const read = sourceReader(input.sourceDir);
      const omissions: DataModelOmission[] = [];
      /** Files read for a recognizer; one it cannot read is an omission. */
      const readAll = async (files: readonly string[]) => {
        const texts: { path: string; text: string }[] = [];
        for (const path of files) {
          input.signal.throwIfAborted();
          const text = await read(path);
          if (text === null)
            omissions.push({
              code: "read_failed",
              file: path,
              detail: `Not a regular file of at most ${DATA_MODEL_FILE_BYTES_MAX / 1024 / 1024} MiB.`,
            });
          else texts.push({ path, text });
        }
        return texts;
      };
      const dependencies = graph.graph.nodes.filter(
        (node) => node.kind === "dependency",
      );
      const packages = new Set(
        dependencies.map((node) => packageNameOf(node.label)),
      );
      const recognized: RecognizedSource[] = [];

      const prismaFiles = paths.filter((path) => path.endsWith(".prisma"));
      if (prismaFiles.length > 0) {
        recognized.push(
          recognizePrisma(await readAll(prismaFiles), [
            ...prismaFiles.map((path) => `file:${path}`),
            ...(packages.has("@prisma/client")
              ? ["dependency:@prisma/client"]
              : []),
          ]),
        );
        input.log(`Prisma: read ${prismaFiles.length} schema files.`);
      }

      const drizzleImports = dependencies.filter((node) =>
        DRIZZLE_CORE.test(node.label),
      );
      const drizzleFiles = [
        ...new Set(drizzleImports.map((node) => node.sourceFile)),
      ]
        .filter((path) => !ignored(path) && !isTestFile(path))
        .sort(compare);
      let drizzleDefinitions: ReadonlyMap<
        string,
        ReadonlyMap<string, string>
      > = new Map();
      if (drizzleFiles.length > 0) {
        const drizzle = recognizeDrizzle(await readAll(drizzleFiles), [
          ...new Set(drizzleImports.map((node) => `dependency:${node.label}`)),
        ]);
        drizzleDefinitions = drizzle.definitions;
        const { definitions: _definitions, ...source } = drizzle;
        recognized.push(source);
        input.log(`Drizzle: read ${drizzleFiles.length} files.`);
      }

      // Migration directories: the tree facts', and Drizzle Kit's output
      // wherever its journal is.
      const facts = treeFacts(
        paths.map((path) => ({ path, size: index.sizes.get(path) ?? 0 })),
      );
      const journals = paths.filter(
        (path) =>
          path.endsWith("/meta/_journal.json") || path === "meta/_journal.json",
      );
      const directories = new Map<string, { journal: string | null }>();
      for (const directory of facts.migrationDirectories)
        directories.set(directory, { journal: null });
      for (const journal of journals)
        directories.set(posix.dirname(posix.dirname(journal)), { journal });
      const migrationSets: {
        directory: string;
        files: string[];
        journal: string[] | null;
      }[] = [];
      for (const [directory, { journal }] of directories) {
        const prefix = directory === "." ? "" : `${directory}/`;
        const files = paths.filter(
          (path) => path.startsWith(prefix) && path.endsWith(".sql"),
        );
        if (files.length === 0) continue;
        let tags: string[] | null = null;
        if (journal !== null) {
          try {
            const parsed = JSON.parse((await read(journal)) ?? "") as {
              entries?: { idx?: unknown; tag?: unknown }[];
            };
            tags = (parsed.entries ?? [])
              .filter(
                (entry): entry is { idx: number; tag: string } =>
                  typeof entry.idx === "number" &&
                  typeof entry.tag === "string",
              )
              .sort((a, b) => a.idx - b.idx)
              .map((entry) => entry.tag);
          } catch {
            omissions.push({
              code: "parse_failed",
              file: journal,
              detail:
                "The migration journal is not JSON; files are read in name order.",
            });
          }
        }
        migrationSets.push({ directory, files, journal: tags });
      }
      if (migrationSets.length > 0) {
        const ordered = orderMigrations(migrationSets);
        recognized.push(
          await replaySqlMigrations(await readAll(ordered), [
            ...migrationSets.map((set) => `migrations:${set.directory}`),
            ...journals.map((journal) => `journal:${journal}`),
          ]),
        );
        input.log(`SQL migrations: replayed ${ordered.length} files.`);
      }

      input.signal.throwIfAborted();
      const merged = mergeSources(recognized);
      const modules = [
        ...new Set(
          graph.graph.nodes
            .filter((node) => node.kind === "file")
            .map((node) => node.sourceFile),
        ),
      ]
        .filter(
          (path) =>
            surfaceLanguageOf(path) !== null &&
            !isTestFile(path) &&
            !ignored(path),
        )
        .sort(compare);
      const accessors = await findAccessors({
        graph: graph.graph,
        read,
        modules,
        entities: merged.entities,
        drizzle: drizzleDefinitions,
        importers: importerCounts(graph.graph),
      });
      const model: DataModel = {
        schemaVersion: DATA_MODEL_SCHEMA_VERSION,
        toolVersion: DATA_MODEL_TOOL_VERSION,
        sourceSnapshotId: snapshot.snapshotId,
        sourceCommitSha: snapshot.commitSha,
        graphRunId: graph.run.id,
        graphSha256: sha256(graph.bytes),
        sources: merged.sources,
        entities: merged.entities,
        enums: merged.enums,
        relations: merged.relations,
        accessors,
        omissions: [...omissions, ...merged.omissions].sort(
          (a, b) =>
            compare(a.file ?? "", b.file ?? "") ||
            compare(a.code, b.code) ||
            compare(a.detail, b.detail),
        ),
      };
      const summary = dataModelSummary(model) as unknown as Record<
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
          path: "data-model.json",
          text: canonicalJson(model),
          kind: "data_model",
          contentType: "application/json",
          meta: summary,
        },
        {
          path: "erd.mmd",
          text: renderErdMermaid(model),
          kind: "erd_mermaid",
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
      const written: ArtifactFile[] = [];
      for (const output of outputs) {
        const absolutePath = join(input.outDir, output.path);
        await mkdir(dirname(absolutePath), { recursive: true });
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
        `Data model completed: ${model.entities.length} entities, ${model.relations.length} relations, ${model.accessors.length} accessors.`,
      );
      return written;
    },
  };
}
