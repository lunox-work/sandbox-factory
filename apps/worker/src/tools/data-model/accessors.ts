/**
 * Accessors: the modules that read or write each entity, the candidate
 * `database` seams. Found from evidence, per source:
 *
 * - Drizzle: the files the graph shows importing a table's defining file,
 *   and the names they take from it; a file that re-exports tables (a
 *   barrel) passes them on to its own importers.
 * - Prisma: the files that import `@prisma/client`, or import a file that
 *   does, and call a model's delegate (`prisma.user.findMany`) or import
 *   its type.
 * - Raw SQL, for a table from any source: code whose query strings name
 *   the table after `FROM`, `JOIN`, `INTO` or `UPDATE`.
 *
 * Each accessor counts the repository files that import it, so a module
 * that touches entities and is imported by business logic ranks high.
 */

import { packageNameOf, rankAccessors } from "sandbox-factory";
import type { DataAccessor, DataEntity, SliceGraph } from "sandbox-factory";
import { fileOf } from "sandbox-factory";
import ts from "typescript-compiler";

const ALL = "*";
const IMPORT_RELATIONS = new Set(["imports", "imports_from"]);
const PRISMA_METHODS = [
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
  "delete",
  "deleteMany",
  "count",
  "aggregate",
  "groupBy",
];
/** How many barrels deep re-exported tables are followed. */
const BARREL_DEPTH = 3;

/** What one file imports and re-exports, by specifier. */
function moduleFacts(path: string, text: string) {
  const source = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    false,
    /\.[cm]?jsx?$/.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TSX,
  );
  const imports = new Map<string, Set<string>>();
  const reexports = new Map<string, Map<string, string>>();
  const add = (specifier: string, name: string) => {
    const set = imports.get(specifier) ?? new Set<string>();
    set.add(name);
    imports.set(specifier, set);
  };
  for (const statement of source.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      const specifier = statement.moduleSpecifier.text;
      const clause = statement.importClause;
      if (clause === undefined) continue;
      if (clause.name !== undefined) add(specifier, "default");
      const named = clause.namedBindings;
      if (named !== undefined && ts.isNamespaceImport(named))
        add(specifier, ALL);
      else if (named !== undefined)
        for (const element of named.elements)
          add(specifier, (element.propertyName ?? element.name).text);
    } else if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      const specifier = statement.moduleSpecifier.text;
      const names = reexports.get(specifier) ?? new Map<string, string>();
      const clause = statement.exportClause;
      if (clause === undefined) names.set(ALL, ALL);
      else if (ts.isNamedExports(clause))
        for (const element of clause.elements)
          names.set(
            (element.propertyName ?? element.name).text,
            element.name.text,
          );
      reexports.set(specifier, names);
    }
  }
  return { imports, reexports };
}

/** String literals' contents, where query text lives. */
function stringsIn(text: string): string[] {
  const found: string[] = [];
  const pattern =
    /`([^`]*)`|"""([\s\S]*?)"""|"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'/g;
  for (const match of text.matchAll(pattern)) {
    const content = match[1] ?? match[2] ?? match[3] ?? match[4] ?? "";
    if (/\b(select|insert|update|delete)\b/i.test(content)) found.push(content);
  }
  return found;
}

export async function findAccessors(input: {
  readonly graph: SliceGraph;
  /** A repository file's text, or null when it cannot be read. */
  readonly read: (path: string) => Promise<string | null>;
  /** The code files to consider, tests aside. */
  readonly modules: readonly string[];
  readonly entities: readonly DataEntity[];
  /** Drizzle's table-defining files: exported name to entity. */
  readonly drizzle: ReadonlyMap<string, ReadonlyMap<string, string>>;
  readonly importers: ReadonlyMap<string, number>;
}): Promise<DataAccessor[]> {
  const modules = new Set(input.modules);
  const touched = new Map<string, Set<string>>();
  const touch = (module: string, entity: string) => {
    if (!modules.has(module)) return;
    const set = touched.get(module) ?? new Set<string>();
    set.add(entity);
    touched.set(module, set);
  };
  const byId = new Map(input.graph.nodes.map((node) => [node.id, node]));
  /** Import links into each file: the importer and the specifier it wrote. */
  const importersOf = new Map<
    string,
    { from: string; specifier: string | null }[]
  >();
  for (const link of input.graph.links) {
    if (!IMPORT_RELATIONS.has(link.relation)) continue;
    const source = byId.get(link.source);
    const target = byId.get(link.target);
    if (source === undefined || target === undefined) continue;
    const from = fileOf(source);
    const to = fileOf(target);
    if (from === null || to === null || from === to) continue;
    const list = importersOf.get(to) ?? [];
    list.push({ from, specifier: link.specifier });
    importersOf.set(to, list);
  }
  const kept = new Set(input.entities.map((entity) => entity.name));

  // Drizzle: the names each importer takes from a defining file or barrel.
  const definitions = new Map(
    [...input.drizzle].map(([file, names]) => [
      file,
      new Map([...names].filter(([, entity]) => kept.has(entity))),
    ]),
  );
  const definers = new Set(definitions.keys());
  let frontier = [...definitions.keys()].sort();
  for (
    let depth = 0;
    depth <= BARREL_DEPTH && frontier.length > 0;
    depth += 1
  ) {
    const next: string[] = [];
    for (const defining of frontier) {
      const names = definitions.get(defining);
      if (names === undefined || names.size === 0) continue;
      for (const { from, specifier } of importersOf.get(defining) ?? []) {
        if (specifier === null) continue;
        const text = await input.read(from);
        if (text === null) continue;
        const facts = moduleFacts(from, text);
        const taken = facts.imports.get(specifier);
        if (taken !== undefined && !definers.has(from))
          for (const [exported, entity] of names)
            if (taken.has(ALL) || taken.has(exported)) touch(from, entity);
        const passed = facts.reexports.get(specifier);
        if (passed === undefined) continue;
        const forwarded = definitions.get(from) ?? new Map<string, string>();
        const before = forwarded.size;
        for (const [exported, entity] of names) {
          const alias = passed.get(exported);
          if (alias !== undefined) forwarded.set(alias, entity);
          if (passed.has(ALL)) forwarded.set(exported, entity);
        }
        definitions.set(from, forwarded);
        if (forwarded.size > before) next.push(from);
      }
    }
    frontier = [...new Set(next)].sort();
  }

  // Prisma: delegate calls and type imports in files that reach the client.
  const models = input.entities.filter((entity) => entity.source === "prisma");
  if (models.length > 0) {
    const clients = new Set(
      input.graph.nodes
        .filter(
          (node) =>
            node.kind === "dependency" &&
            packageNameOf(node.label) === "@prisma/client",
        )
        .map((node) => node.sourceFile),
    );
    const candidates = new Set(clients);
    for (const client of clients)
      for (const { from } of importersOf.get(client) ?? [])
        candidates.add(from);
    const delegates = new Map(
      models.map((model) => [
        `${model.name.slice(0, 1).toLowerCase()}${model.name.slice(1)}`,
        model.name,
      ]),
    );
    const call = new RegExp(
      `\\.\\s*(${[...delegates.keys()].join("|")})\\s*\\.\\s*(?:${PRISMA_METHODS.join("|")})\\b`,
      "g",
    );
    for (const file of [...candidates].sort()) {
      const text = await input.read(file);
      if (text === null) continue;
      for (const match of text.matchAll(call)) {
        const model = delegates.get(match[1] ?? "");
        if (model !== undefined) touch(file, model);
      }
      const typed = moduleFacts(file, text).imports.get("@prisma/client");
      for (const model of models)
        if (typed?.has(model.name) === true) touch(file, model.name);
    }
  }

  // Raw SQL, whatever declared the table: table names in query strings.
  const tables = new Map(
    input.entities.map((entity) => [
      (entity.table.split(".").at(-1) ?? entity.table).toLowerCase(),
      entity.name,
    ]),
  );
  if (tables.size > 0) {
    const query =
      /\b(?:from|join|into|update)\s+(?:only\s+)?[`"[]?(?:[A-Za-z_][\w$]*[`"\]]?\s*\.\s*[`"[]?)?([A-Za-z_][\w$]*)/gi;
    for (const file of input.modules) {
      const text = await input.read(file);
      if (text === null) continue;
      for (const content of stringsIn(text))
        for (const match of content.matchAll(query)) {
          const entity = tables.get((match[1] ?? "").toLowerCase());
          if (entity !== undefined) touch(file, entity);
        }
    }
  }

  return rankAccessors(
    [...touched].map(([module, entities]) => ({
      module,
      entities: [...entities],
      importers: input.importers.get(module) ?? 0,
    })),
  );
}
