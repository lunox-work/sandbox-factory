/**
 * The SQL migrations recognizer: Postgres migrations replayed, not executed.
 *
 * Each file is parsed with libpg-query, Postgres's own parser compiled to
 * WebAssembly, and its `CREATE`, `ALTER`, `DROP` and `RENAME` statements are
 * applied in the migration tool's order to an in-memory catalog of tables,
 * columns, constraints and enum types. Functions, triggers and data
 * statements are skipped and recorded as omissions. A `DO` block is opened
 * only for the idempotent-DDL idiom migration tools write (`BEGIN <ddl>
 * EXCEPTION WHEN duplicate_object THEN null; END`). Nothing is sent to a
 * database.
 */

import { posix } from "node:path";
import pg from "libpg-query";
import { normalizeSqlType } from "sandbox-factory";
import type {
  DataEntity,
  DataEnum,
  DataModelOmission,
  DataRelation,
  FieldType,
  RecognizedSource,
} from "sandbox-factory";

type Node = Record<string, unknown>;

let loaded: Promise<void> | undefined;
/** The parser's WebAssembly, loaded once per process. */
export function loadSqlParser(): Promise<void> {
  loaded ??= pg.loadModule();
  return loaded;
}

const isRecord = (value: unknown): value is Node =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const record = (value: unknown): Node => (isRecord(value) ? value : {});
const text = (value: unknown): string | null =>
  typeof value === "string" ? value : null;
/** `{ String: { sval } }` items, as names and keys are spelled. */
const strings = (value: unknown): string[] =>
  list(value).flatMap((item) => {
    const sval = text(record(record(item)["String"])["sval"]);
    return sval === null ? [] : [sval];
  });
/** A node's single kind and body: `{ CreateStmt: {...} }`. */
function kindOf(node: unknown): [string, Node] {
  const [entry] = Object.entries(record(node));
  return entry === undefined ? ["", {}] : [entry[0], record(entry[1])];
}

const qualified = (schema: string | null, name: string) =>
  schema === null || schema === "public" || schema === "pg_catalog"
    ? name
    : `${schema}.${name}`;
const relationName = (relation: unknown) => {
  const value = record(relation);
  return qualified(text(value["schemaname"]), text(value["relname"]) ?? "");
};
const nameOfList = (names: readonly string[]) =>
  names.length === 0
    ? ""
    : qualified(
        names.length > 1 ? (names.at(-2) ?? null) : null,
        names.at(-1) ?? "",
      );

/** How Postgres spells an internal type name in SQL. */
const SQL_NAMES: Readonly<Record<string, string>> = {
  int2: "smallint",
  int4: "integer",
  int8: "bigint",
  float4: "real",
  float8: "double precision",
  bool: "boolean",
  bpchar: "char",
  timestamptz: "timestamp with time zone",
  timetz: "time with time zone",
};

const ACTIONS: Readonly<Record<string, string>> = {
  a: "no action",
  r: "restrict",
  c: "cascade",
  n: "set null",
  d: "set default",
};

const SQL_VALUE_FUNCTIONS: Readonly<Record<string, string>> = {
  SVFOP_CURRENT_DATE: "CURRENT_DATE",
  SVFOP_CURRENT_TIME: "CURRENT_TIME",
  SVFOP_CURRENT_TIMESTAMP: "CURRENT_TIMESTAMP",
  SVFOP_LOCALTIME: "LOCALTIME",
  SVFOP_LOCALTIMESTAMP: "LOCALTIMESTAMP",
  SVFOP_CURRENT_USER: "CURRENT_USER",
};

/** An expression as SQL, for the shapes defaults take; others read `(expression)`. */
export function renderExpression(node: unknown): string {
  const [kind, body] = kindOf(node);
  switch (kind) {
    case "A_Const": {
      if (body["isnull"] === true) return "NULL";
      if ("sval" in body)
        return `'${(text(record(body["sval"])["sval"]) ?? "").replace(/'/g, "''")}'`;
      if ("ival" in body) return String(record(body["ival"])["ival"] ?? 0);
      if ("fval" in body) return text(record(body["fval"])["fval"]) ?? "0";
      if ("boolval" in body)
        return record(body["boolval"])["boolval"] === true ? "true" : "false";
      return "(expression)";
    }
    case "FuncCall":
      return `${strings(body["funcname"]).join(".")}(${
        body["agg_star"] === true
          ? "*"
          : list(body["args"]).map(renderExpression).join(", ")
      })`;
    case "TypeCast":
      return `${renderExpression(body["arg"])}::${typeOf(body["typeName"], new Set()).nativeType}`;
    case "ColumnRef":
      return strings(body["fields"]).join(".");
    case "SQLValueFunction":
      return SQL_VALUE_FUNCTIONS[text(body["op"]) ?? ""] ?? "(expression)";
    case "A_Expr":
      return text(body["kind"]) === "AEXPR_OP"
        ? `${"lexpr" in body ? `${renderExpression(body["lexpr"])} ` : ""}${strings(body["name"]).join("")} ${renderExpression(body["rexpr"])}`
        : "(expression)";
    case "A_ArrayExpr":
      return `ARRAY[${list(body["elements"]).map(renderExpression).join(", ")}]`;
    default:
      return "(expression)";
  }
}

interface Column {
  name: string;
  nativeType: string;
  type: FieldType;
  list: boolean;
  enumName: string | null;
  nullable: boolean;
  default: string | null;
  primaryKey: boolean;
  unique: boolean;
}
interface ForeignKey {
  name: string | null;
  columns: string[];
  target: string;
  targetColumns: string[];
  onDelete: string | null;
  onUpdate: string | null;
}
interface Table {
  name: string;
  kind: "table" | "view";
  file: string;
  line: number;
  columns: Column[];
  primaryKey: { name: string | null; columns: string[] } | null;
  uniques: { name: string | null; columns: string[] }[];
  foreignKeys: ForeignKey[];
}
interface EnumType {
  name: string;
  values: string[];
  file: string;
  line: number;
}

/** A column type as written, normalized, and whether it names an enum. */
function typeOf(
  typeName: unknown,
  enums: ReadonlySet<string>,
): {
  nativeType: string;
  type: FieldType;
  list: boolean;
  enumName: string | null;
} {
  const body = record(typeName);
  const names = strings(body["names"]);
  const last = names.at(-1) ?? "unknown";
  const base = SQL_NAMES[last] ?? last;
  const mods = list(body["typmods"]).map(renderExpression);
  const isList = list(body["arrayBounds"]).length > 0;
  const nativeType = `${base}${mods.length > 0 ? `(${mods.join(", ")})` : ""}${isList ? "[]" : ""}`;
  const enumName = nameOfList(names);
  if (enums.has(enumName))
    return { nativeType, type: "enum", list: isList, enumName };
  return {
    nativeType,
    type: normalizeSqlType(base),
    list: isList,
    enumName: null,
  };
}

/** Migration files in the tool's own order. */
export function orderMigrations(
  directories: readonly {
    readonly directory: string;
    readonly files: readonly string[];
    /** Drizzle Kit's `meta/_journal.json` tags, in order, when there is one. */
    readonly journal: readonly string[] | null;
  }[],
): string[] {
  const ordered: string[] = [];
  for (const { directory, files, journal } of [...directories].sort((a, b) =>
    naturalCompare(a.directory, b.directory),
  )) {
    const up = files.filter(isUpMigration);
    const listed = (journal ?? [])
      .map((tag) => posix.join(directory, `${tag}.sql`))
      .filter((path) => up.includes(path));
    ordered.push(
      ...listed,
      ...up.filter((path) => !listed.includes(path)).sort(naturalCompare),
    );
  }
  return ordered;
}

/**
 * Where a file's rollback starts, for the tools that keep both directions
 * in one file: goose's `-- +goose Down` and dbmate's `-- migrate:down`.
 * Replayed, its `DROP TABLE` would undo the `CREATE` above it.
 */
const DOWN_MARKER = /^[ \t]*--[ \t]*(?:\+goose[ \t]+down|migrate:down)\b/im;

/** The text up to its rollback section; all of it when it has none. */
export function upSection(text: string): string {
  const marker = DOWN_MARKER.exec(text);
  return marker === null ? text : text.slice(0, marker.index);
}

/** A rollback is not part of the schema's history. */
function isUpMigration(path: string): boolean {
  const name = posix.basename(path).toLowerCase();
  return (
    name.endsWith(".sql") &&
    !name.endsWith(".down.sql") &&
    name !== "down.sql" &&
    !/^u\d/.test(name)
  );
}

/** Digit runs compare as numbers, so `V10` follows `V9`. */
export function naturalCompare(a: string, b: string): number {
  const split = (value: string) => value.split(/(\d+)/);
  const left = split(a);
  const right = split(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const x = left[index] ?? "";
    const y = right[index] ?? "";
    if (x === y) continue;
    if (/^\d+$/.test(x) && /^\d+$/.test(y) && Number(x) !== Number(y))
      return Number(x) - Number(y);
    return x < y ? -1 : 1;
  }
  return 0;
}

/** Statements that change nothing the model records, passed over silently. */
const IGNORED = new Set([
  "TransactionStmt",
  "VariableSetStmt",
  "CreateSchemaStmt",
  "CreateExtensionStmt",
  "CommentStmt",
  "GrantStmt",
  "GrantRoleStmt",
  "CreateSeqStmt",
  "AlterSeqStmt",
  "AlterOwnerStmt",
  "CreatePolicyStmt",
  "AlterPolicyStmt",
  "CreateRoleStmt",
  "AlterRoleStmt",
  "AlterDefaultPrivilegesStmt",
  "SelectStmt",
  "VacuumStmt",
  "AlterTableSpaceOptionsStmt",
]);
/** What a skipped statement is called in an omission. */
const SKIPPED: Readonly<Record<string, string>> = {
  CreateFunctionStmt: "CREATE FUNCTION",
  CreateTrigStmt: "CREATE TRIGGER",
  InsertStmt: "INSERT",
  UpdateStmt: "UPDATE",
  DeleteStmt: "DELETE",
  MergeStmt: "MERGE",
  CopyStmt: "COPY",
  DoStmt: "DO",
};

/** What closes the idempotent idiom, from its `EXCEPTION` to the end. */
const IDEMPOTENT_TAIL =
  /^EXCEPTION\s+WHEN\s+duplicate_(?:object|table|column)\s+THEN\s+null\s*;\s*END\s*;?\s*$/i;

/**
 * The DDL inside the idempotent `DO` idiom, or null for any other block.
 *
 * Scanned rather than matched whole: one pattern with a lazy body between
 * two runs of whitespace backtracks about cubically, and a migration of a
 * few thousand spaces held the worker's thread for seconds, its heartbeat
 * and deadline with it. Here only the short tail is a pattern.
 */
function idempotentBody(body: Node): string | null {
  const code = list(body["args"])
    .map((arg) => record(record(arg)["DefElem"]))
    .find((element) => element["defname"] === "as");
  const source = text(record(record(code?.["arg"])["String"])["sval"]);
  if (source === null) return null;
  const block = source.trimStart();
  if (!/^BEGIN\s/i.test(block)) return null;
  // The last `EXCEPTION`: the tail runs to the end, so it is the one.
  let tail = -1;
  for (const found of block.matchAll(/EXCEPTION/gi)) tail = found.index;
  if (tail < 0 || !IDEMPOTENT_TAIL.test(block.slice(tail))) return null;
  return block.slice("BEGIN".length, tail).trim();
}

export async function replaySqlMigrations(
  files: readonly { readonly path: string; readonly text: string }[],
  evidence: readonly string[],
): Promise<RecognizedSource> {
  await loadSqlParser();
  const tables = new Map<string, Table>();
  const enums = new Map<string, EnumType>();
  const omissions: DataModelOmission[] = [];
  for (const whole of files) {
    // The rollback is cut off; it is at the end, so no location moves.
    const file = { path: whole.path, text: upSection(whole.text) };
    const skipped = new Map<string, number>();
    // Locations are byte offsets into the UTF-8 text.
    const bytes = Buffer.from(file.text);
    const newlines: number[] = [];
    for (
      let index = bytes.indexOf(10);
      index >= 0;
      index = bytes.indexOf(10, index + 1)
    )
      newlines.push(index);
    /** The line a statement's text starts on, past whitespace and comments. */
    const lineAt = (offset: number) => {
      const ahead = bytes.subarray(offset, offset + 4096).toString("utf8");
      const leading =
        /^(?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)*/.exec(ahead)?.[0] ?? "";
      const start = offset + Buffer.byteLength(leading);
      let low = 0;
      let high = newlines.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if ((newlines[middle] ?? 0) < start) low = middle + 1;
        else high = middle;
      }
      return low + 1;
    };
    let statements: unknown[];
    try {
      statements = list(pg.parseSync(file.text).stmts);
    } catch (error) {
      omissions.push({
        code: "parse_failed",
        file: file.path,
        detail: `Not Postgres SQL the parser accepts: ${error instanceof Error ? error.message : "unreadable"}`,
      });
      continue;
    }
    const apply = (statement: unknown, line: number) => {
      const [kind, body] = kindOf(statement);
      const enumNames = new Set(enums.keys());
      const columnOf = (definition: Node): Column => {
        const typed = typeOf(definition["typeName"], enumNames);
        const column: Column = {
          name: text(definition["colname"]) ?? "",
          nativeType: typed.nativeType,
          type: typed.type,
          list: typed.list,
          enumName: typed.enumName,
          nullable: true,
          default: null,
          primaryKey: false,
          unique: false,
        };
        return column;
      };
      /** A constraint on a table, from its definition or an `ALTER`. */
      const constrain = (table: Table, constraint: Node, column?: Column) => {
        const name = text(constraint["conname"]);
        const keys =
          column === undefined ? strings(constraint["keys"]) : [column.name];
        switch (text(constraint["contype"])) {
          case "CONSTR_NOTNULL":
            if (column !== undefined) column.nullable = false;
            break;
          case "CONSTR_NULL":
            if (column !== undefined) column.nullable = true;
            break;
          case "CONSTR_DEFAULT":
            if (column !== undefined)
              column.default = renderExpression(constraint["raw_expr"]);
            break;
          case "CONSTR_IDENTITY":
            if (column !== undefined) {
              column.default = "identity";
              column.nullable = false;
            }
            break;
          case "CONSTR_GENERATED":
            if (column !== undefined) column.default = "generated";
            break;
          case "CONSTR_PRIMARY":
            table.primaryKey = { name, columns: keys };
            for (const key of keys) {
              const target = table.columns.find((c) => c.name === key);
              if (target !== undefined) {
                target.primaryKey = true;
                target.nullable = false;
              }
            }
            break;
          case "CONSTR_UNIQUE":
            table.uniques.push({ name, columns: keys });
            break;
          case "CONSTR_FOREIGN":
            table.foreignKeys.push({
              name,
              columns:
                column === undefined
                  ? strings(constraint["fk_attrs"])
                  : [column.name],
              target: relationName(constraint["pktable"]),
              targetColumns: strings(constraint["pk_attrs"]),
              onDelete:
                ACTIONS[text(constraint["fk_del_action"]) ?? "a"] ?? null,
              onUpdate:
                ACTIONS[text(constraint["fk_upd_action"]) ?? "a"] ?? null,
            });
            break;
        }
      };
      const addColumn = (table: Table, definition: Node) => {
        const column = columnOf(definition);
        table.columns.push(column);
        for (const item of list(definition["constraints"]))
          constrain(table, record(record(item)["Constraint"]), column);
        if (/^(small|big)?serial[248]?$/.test(column.nativeType)) {
          column.nullable = false;
          column.default ??= "autoincrement";
        }
      };
      const dropColumn = (table: Table, name: string) => {
        table.columns = table.columns.filter((column) => column.name !== name);
        table.uniques = table.uniques.filter(
          (unique) => !unique.columns.includes(name),
        );
        table.foreignKeys = table.foreignKeys.filter(
          (key) => !key.columns.includes(name),
        );
        if (table.primaryKey?.columns.includes(name) === true)
          table.primaryKey = null;
      };
      const tableOf = (relation: unknown): Table | undefined => {
        const name = relationName(relation);
        const table = tables.get(name);
        if (table === undefined)
          omissions.push({
            code: "unknown_table",
            file: file.path,
            detail: `${kind} names ${name}, which no earlier migration created.`,
          });
        return table;
      };
      switch (kind) {
        case "CreateStmt": {
          const name = relationName(body["relation"]);
          if (tables.has(name) && body["if_not_exists"] === true) return;
          const table: Table = {
            name,
            kind: "table",
            file: file.path,
            line,
            columns: [],
            primaryKey: null,
            uniques: [],
            foreignKeys: [],
          };
          tables.set(name, table);
          for (const element of list(body["tableElts"])) {
            const [elementKind, definition] = kindOf(element);
            if (elementKind === "ColumnDef") addColumn(table, definition);
            else if (elementKind === "Constraint") constrain(table, definition);
          }
          return;
        }
        case "CreateTableAsStmt":
        case "ViewStmt": {
          const relation =
            kind === "ViewStmt" ? body["view"] : record(body["into"])["rel"];
          const name = relationName(relation);
          tables.set(name, {
            name,
            kind: kind === "ViewStmt" ? "view" : "table",
            file: file.path,
            line,
            columns: [],
            primaryKey: null,
            uniques: [],
            foreignKeys: [],
          });
          omissions.push({
            code: "expression_skipped",
            file: file.path,
            detail: `${name}'s columns come from a query, which is not evaluated.`,
          });
          return;
        }
        case "AlterTableStmt": {
          if (text(body["objtype"]) !== "OBJECT_TABLE") return;
          const table = tables.get(relationName(body["relation"]));
          if (table === undefined) {
            if (body["missing_ok"] !== true) tableOf(body["relation"]);
            return;
          }
          for (const item of list(body["cmds"])) {
            const command = record(record(item)["AlterTableCmd"]);
            const columnName = text(command["name"]) ?? "";
            const column = table.columns.find((c) => c.name === columnName);
            switch (text(command["subtype"])) {
              case "AT_AddColumn": {
                const definition = record(record(command["def"])["ColumnDef"]);
                if (
                  !table.columns.some((c) => c.name === definition["colname"])
                )
                  addColumn(table, definition);
                break;
              }
              case "AT_DropColumn":
                dropColumn(table, columnName);
                break;
              case "AT_AlterColumnType":
                if (column !== undefined) {
                  const typed = typeOf(
                    record(record(command["def"])["ColumnDef"])["typeName"],
                    enumNames,
                  );
                  Object.assign(column, typed);
                }
                break;
              case "AT_SetNotNull":
                if (column !== undefined) column.nullable = false;
                break;
              case "AT_DropNotNull":
                if (column !== undefined) column.nullable = true;
                break;
              case "AT_ColumnDefault":
                if (column !== undefined)
                  column.default =
                    command["def"] === undefined
                      ? null
                      : renderExpression(command["def"]);
                break;
              case "AT_AddConstraint":
                constrain(table, record(record(command["def"])["Constraint"]));
                break;
              case "AT_DropConstraint": {
                table.uniques = table.uniques.filter(
                  (u) => u.name !== columnName,
                );
                table.foreignKeys = table.foreignKeys.filter(
                  (k) => k.name !== columnName,
                );
                if (table.primaryKey?.name === columnName) {
                  for (const c of table.columns)
                    if (table.primaryKey.columns.includes(c.name))
                      c.primaryKey = false;
                  table.primaryKey = null;
                }
                break;
              }
            }
          }
          return;
        }
        case "RenameStmt": {
          const type = text(body["renameType"]);
          const newName = text(body["newname"]) ?? "";
          if (type === "OBJECT_TABLE" || type === "OBJECT_VIEW") {
            const table = tableOf(body["relation"]);
            if (table === undefined) return;
            const schema = text(record(body["relation"])["schemaname"]);
            const renamed = qualified(schema, newName);
            tables.delete(table.name);
            for (const other of tables.values())
              for (const key of other.foreignKeys)
                if (key.target === table.name) key.target = renamed;
            table.name = renamed;
            tables.set(renamed, table);
          } else if (type === "OBJECT_COLUMN") {
            const table = tableOf(body["relation"]);
            const old = text(body["subname"]) ?? "";
            if (table === undefined) return;
            const rename = (names: string[]) =>
              names.map((name) => (name === old ? newName : name));
            for (const column of table.columns)
              if (column.name === old) column.name = newName;
            if (table.primaryKey !== null)
              table.primaryKey.columns = rename(table.primaryKey.columns);
            for (const unique of table.uniques)
              unique.columns = rename(unique.columns);
            for (const key of table.foreignKeys)
              key.columns = rename(key.columns);
            for (const other of tables.values())
              for (const key of other.foreignKeys)
                if (key.target === table.name)
                  key.targetColumns = rename(key.targetColumns);
          } else if (type === "OBJECT_TABCONSTRAINT") {
            const table = tableOf(body["relation"]);
            const old = text(body["subname"]);
            if (table === undefined) return;
            for (const named of [
              ...table.uniques,
              ...table.foreignKeys,
              ...(table.primaryKey === null ? [] : [table.primaryKey]),
            ])
              if (named.name === old) named.name = newName;
          }
          return;
        }
        case "DropStmt": {
          const type = text(body["removeType"]);
          for (const object of list(body["objects"])) {
            if (type === "OBJECT_TABLE" || type === "OBJECT_VIEW")
              tables.delete(
                nameOfList(strings(record(record(object)["List"])["items"])),
              );
            else if (type === "OBJECT_TYPE")
              enums.delete(
                nameOfList(
                  strings(record(record(object)["TypeName"])["names"]),
                ),
              );
            else if (type === "OBJECT_INDEX") {
              const index = nameOfList(
                strings(record(record(object)["List"])["items"]),
              );
              for (const table of tables.values())
                table.uniques = table.uniques.filter(
                  (unique) => unique.name !== index.split(".").at(-1),
                );
            }
          }
          return;
        }
        case "IndexStmt": {
          if (body["unique"] !== true || body["whereClause"] !== undefined)
            return;
          const table = tableOf(body["relation"]);
          const columns = list(body["indexParams"]).map((param) =>
            text(record(record(param)["IndexElem"])["name"]),
          );
          if (table === undefined || columns.some((column) => column === null))
            return;
          table.uniques.push({
            name: text(body["idxname"]),
            columns: columns.filter(
              (column): column is string => column !== null,
            ),
          });
          return;
        }
        case "CreateEnumStmt": {
          const name = nameOfList(strings(body["typeName"]));
          enums.set(name, {
            name,
            values: strings(body["vals"]),
            file: file.path,
            line,
          });
          return;
        }
        case "AlterEnumStmt": {
          const type = enums.get(nameOfList(strings(body["typeName"])));
          if (type === undefined) return;
          const oldValue = text(body["oldVal"]);
          const newValue = text(body["newVal"]) ?? "";
          if (oldValue !== null) {
            type.values = type.values.map((value) =>
              value === oldValue ? newValue : value,
            );
            return;
          }
          if (type.values.includes(newValue)) return;
          const neighbour = text(body["newValNeighbor"]);
          const at = neighbour === null ? -1 : type.values.indexOf(neighbour);
          if (at < 0) type.values.push(newValue);
          else
            type.values.splice(
              body["newValIsAfter"] === true ? at + 1 : at,
              0,
              newValue,
            );
          return;
        }
        case "DoStmt": {
          const inner = idempotentBody(body);
          if (inner !== null) {
            try {
              for (const nested of list(pg.parseSync(inner).stmts))
                apply(record(nested)["stmt"], line);
              return;
            } catch {
              // Not plain DDL after all; counted as a skipped block below.
            }
          }
          break;
        }
      }
      if (IGNORED.has(kind)) return;
      const label = SKIPPED[kind] ?? kind.replace(/Stmt$/, "");
      skipped.set(label, (skipped.get(label) ?? 0) + 1);
    };
    for (const raw of statements) {
      const statement = record(raw);
      // A statement's location starts where the one before ended.
      const offset =
        typeof statement["stmt_location"] === "number"
          ? statement["stmt_location"]
          : 0;
      apply(statement["stmt"], lineAt(offset));
    }
    for (const [label, count] of [...skipped].sort(([a], [b]) =>
      a < b ? -1 : 1,
    ))
      omissions.push({
        code: "statement_skipped",
        file: file.path,
        detail: `${count} ${label} ${count === 1 ? "statement was" : "statements were"} not replayed.`,
      });
  }
  const entities: DataEntity[] = [];
  const relations: DataRelation[] = [];
  for (const table of tables.values()) {
    const keys = table.primaryKey?.columns ?? [];
    const singleUnique = new Set(
      table.uniques.flatMap((unique) =>
        unique.columns.length === 1 ? unique.columns : [],
      ),
    );
    entities.push({
      name: table.name,
      table: table.name,
      kind: table.kind,
      source: "sql_migrations",
      file: table.file,
      line: table.line,
      fields: table.columns.map((column) => ({
        name: column.name,
        column: column.name,
        type: column.type,
        nativeType: column.nativeType,
        list: column.list,
        nullable: column.nullable,
        default: column.default,
        unique: column.unique || singleUnique.has(column.name),
        primaryKey: column.primaryKey || keys.includes(column.name),
        enum: column.enumName,
      })),
      primaryKey: keys,
      uniques: table.uniques
        .filter((unique) => unique.columns.length > 1)
        .map((unique) => unique.columns)
        .sort((a, b) => (a.join(",") < b.join(",") ? -1 : 1)),
    });
    for (const key of table.foreignKeys) {
      const target = tables.get(key.target);
      if (target === undefined) {
        omissions.push({
          code: "unresolved_relation",
          file: table.file,
          detail: `${table.name} references ${key.target}, which the migrations do not create.`,
        });
        continue;
      }
      const sets = [keys, ...table.uniques.map((unique) => unique.columns)];
      const unique = sets.some(
        (set) =>
          set.length > 0 &&
          set.length === key.columns.length &&
          set.every((column) => key.columns.includes(column)),
      );
      relations.push({
        name: key.name,
        from: { entity: table.name, fields: key.columns },
        to: {
          entity: target.name,
          fields:
            key.targetColumns.length > 0
              ? key.targetColumns
              : (target.primaryKey?.columns ?? []),
        },
        cardinality: unique ? "one-to-one" : "many-to-one",
        onDelete: key.onDelete,
        onUpdate: key.onUpdate,
        source: "sql_migrations",
      });
    }
  }
  const enumList: DataEnum[] = [...enums.values()].map((type) => ({
    name: type.name,
    values: type.values,
    source: "sql_migrations",
    file: type.file,
    line: type.line,
  }));
  return {
    kind: "sql_migrations",
    storage: "postgresql",
    files: files.map((file) => file.path),
    evidence,
    entities,
    enums: enumList,
    relations,
    omissions,
  };
}
