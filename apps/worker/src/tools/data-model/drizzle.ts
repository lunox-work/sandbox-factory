/**
 * The Drizzle recognizer: tables declared with `pgTable`, `mysqlTable` or
 * `sqliteTable` (or a `pgSchema(...).table`), read from the syntax of the
 * files that import a Drizzle core module.
 *
 * Only what the call arguments say is read: the column builders and their
 * chained modifiers, `.references(() => other.column)`, and the extra
 * config's `primaryKey`, `unique`, `uniqueIndex` and `foreignKey`. A spread
 * of a constant object in the same file is followed; anything that would
 * need evaluation is an omission. Nothing is compiled or run.
 */

import { normalizeReferentialAction, normalizeSqlType } from "sandbox-factory";
import type {
  DataEntity,
  DataEnum,
  DataField,
  DataModelOmission,
  DataRelation,
  RecognizedSource,
} from "sandbox-factory";
import ts from "typescript-compiler";

const TABLE_FACTORIES: Readonly<Record<string, string>> = {
  pgTable: "postgresql",
  mysqlTable: "mysql",
  sqliteTable: "sqlite",
};
const VIEW_FACTORIES = new Set([
  "pgView",
  "pgMaterializedView",
  "mysqlView",
  "sqliteView",
]);

/** Column builders, by the SQL type each writes. */
const BUILDERS: Readonly<Record<string, string>> = {
  text: "text",
  varchar: "varchar",
  char: "char",
  integer: "integer",
  int: "integer",
  smallint: "smallint",
  tinyint: "tinyint",
  mediumint: "mediumint",
  bigint: "bigint",
  serial: "serial",
  smallserial: "smallserial",
  bigserial: "bigserial",
  numeric: "numeric",
  decimal: "decimal",
  real: "real",
  doublePrecision: "double precision",
  double: "double",
  float: "float",
  boolean: "boolean",
  date: "date",
  datetime: "datetime",
  timestamp: "timestamp",
  time: "time",
  year: "year",
  interval: "interval",
  json: "json",
  jsonb: "jsonb",
  uuid: "uuid",
  bytea: "bytea",
  blob: "blob",
  binary: "binary",
  varbinary: "varbinary",
  inet: "inet",
  cidr: "cidr",
  macaddr: "macaddr",
  tinytext: "tinytext",
  mediumtext: "mediumtext",
  longtext: "longtext",
};

const literal = (node: ts.Node | undefined): string | null =>
  node !== undefined && ts.isStringLiteralLike(node) ? node.text : null;

/** An object literal's property, by name. */
function property(
  node: ts.Node | undefined,
  name: string,
): ts.Expression | undefined {
  if (node === undefined || !ts.isObjectLiteralExpression(node))
    return undefined;
  for (const element of node.properties)
    if (
      ts.isPropertyAssignment(element) &&
      (ts.isIdentifier(element.name) || ts.isStringLiteralLike(element.name)) &&
      element.name.text === name
    )
      return element.initializer;
  return undefined;
}

/** `t.id`, `users.id` → the column's property name; `columns: [a, b]` → names. */
function columnKey(node: ts.Expression | undefined): string | null {
  if (node === undefined) return null;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  return null;
}
function columnKeys(node: ts.Expression | undefined): string[] {
  if (node === undefined || !ts.isArrayLiteralExpression(node)) return [];
  return node.elements.flatMap((element) => {
    const key = columnKey(element);
    return key === null ? [] : [key];
  });
}

/** A call chain, innermost first: `text("a").notNull()` → base and modifiers. */
function unchain(expression: ts.Expression): {
  base: ts.CallExpression | null;
  calls: { name: string; args: readonly ts.Expression[] }[];
} {
  const calls: { name: string; args: readonly ts.Expression[] }[] = [];
  let current: ts.Expression = expression;
  // A modifier is a method called on another call. `t.text("a")` (a
  // builder on a callback parameter) is a base: its receiver is a name.
  while (
    ts.isCallExpression(current) &&
    ts.isPropertyAccessExpression(current.expression) &&
    ts.isCallExpression(current.expression.expression)
  ) {
    calls.unshift({
      name: current.expression.name.text,
      args: current.arguments,
    });
    current = current.expression.expression;
  }
  return { base: ts.isCallExpression(current) ? current : null, calls };
}

const calleeName = (call: ts.CallExpression): string | null =>
  ts.isIdentifier(call.expression)
    ? call.expression.text
    : ts.isPropertyAccessExpression(call.expression)
      ? call.expression.name.text
      : null;

interface FileScope {
  readonly path: string;
  readonly source: ts.SourceFile;
  /** Top-level constants, by name. */
  readonly constants: ReadonlyMap<string, ts.Expression>;
}

interface TableDeclaration {
  readonly variable: string;
  readonly sqlName: string;
  readonly schema: string | null;
  readonly storage: string;
  readonly kind: "table" | "view";
  readonly scope: FileScope;
  readonly line: number;
  readonly columns: ts.Expression | undefined;
  readonly extra: ts.Expression | undefined;
}

/** The builder a column's base call names, following a local helper once. */
function builderOf(
  base: ts.CallExpression,
  scope: FileScope,
  enums: ReadonlyMap<string, { name: string }>,
): {
  builder: string;
  enumName: string | null;
  call: ts.CallExpression;
} | null {
  const name = calleeName(base);
  if (name === null) return null;
  const enumType = enums.get(name);
  if (enumType !== undefined)
    return { builder: "enum", enumName: enumType.name, call: base };
  if (name in BUILDERS) return { builder: name, enumName: null, call: base };
  // `const ts = (name: string) => timestamp(name, { withTimezone: true })`
  const helper = scope.constants.get(name);
  if (
    helper !== undefined &&
    ts.isArrowFunction(helper) &&
    !ts.isBlock(helper.body)
  ) {
    const inner = unchain(helper.body).base;
    const innerName = inner === null ? null : calleeName(inner);
    if (inner !== null && innerName !== null && innerName in BUILDERS)
      return { builder: innerName, enumName: null, call: inner };
  }
  return null;
}

function nativeTypeOf(builder: string, call: ts.CallExpression): string {
  const sql = BUILDERS[builder] ?? builder;
  const options = call.arguments.find((arg) =>
    ts.isObjectLiteralExpression(arg),
  );
  const number = (key: string) => {
    const value = property(options, key);
    return value !== undefined && ts.isNumericLiteral(value)
      ? value.text
      : null;
  };
  if (builder === "timestamp" || builder === "time") {
    const zoned = property(options, "withTimezone");
    return zoned?.kind === ts.SyntaxKind.TrueKeyword
      ? `${sql} with time zone`
      : sql;
  }
  const length = number("length");
  if (length !== null) return `${sql}(${length})`;
  const precision = number("precision");
  const scale = number("scale");
  if (precision !== null)
    return `${sql}(${precision}${scale === null ? "" : `, ${scale}`})`;
  return sql;
}

export function recognizeDrizzle(
  files: readonly { readonly path: string; readonly text: string }[],
  evidence: readonly string[],
): RecognizedSource & {
  /** Each table-defining file's exported table names, by entity. */
  readonly definitions: ReadonlyMap<string, ReadonlyMap<string, string>>;
} {
  const omissions: DataModelOmission[] = [];
  const scopes: FileScope[] = [];
  const enums = new Map<
    string,
    { name: string; values: string[]; file: string; line: number }
  >();
  const schemas = new Map<string, string>();
  const declarations: TableDeclaration[] = [];
  for (const file of files) {
    const source = ts.createSourceFile(
      file.path,
      file.text,
      ts.ScriptTarget.Latest,
      true,
      /\.[cm]?jsx?$/.test(file.path) ? ts.ScriptKind.JS : ts.ScriptKind.TSX,
    );
    const constants = new Map<string, ts.Expression>();
    const scope: FileScope = { path: file.path, source, constants };
    scopes.push(scope);
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (
          !ts.isIdentifier(declaration.name) ||
          declaration.initializer === undefined
        )
          continue;
        const variable = declaration.name.text;
        let initializer: ts.Expression = declaration.initializer;
        while (
          ts.isAsExpression(initializer) ||
          ts.isSatisfiesExpression(initializer)
        )
          initializer = initializer.expression;
        constants.set(variable, initializer);
        const line =
          source.getLineAndCharacterOfPosition(statement.getStart(source))
            .line + 1;
        // Chained modifiers such as `.enableRLS()` wrap the table call.
        const call =
          unchain(initializer).base ??
          (ts.isCallExpression(initializer) ? initializer : null);
        if (call === null) continue;
        const name = calleeName(call);
        if (name === "pgEnum" || name === "mysqlEnum") {
          const values = call.arguments[1];
          enums.set(variable, {
            name: literal(call.arguments[0]) ?? variable,
            values:
              values !== undefined && ts.isArrayLiteralExpression(values)
                ? values.elements.flatMap((element) => {
                    const value = literal(element);
                    return value === null ? [] : [value];
                  })
                : [],
            file: file.path,
            line,
          });
        } else if (name === "pgSchema") {
          const schema = literal(call.arguments[0]);
          if (schema !== null) schemas.set(variable, schema);
        } else if (
          name !== null &&
          (name in TABLE_FACTORIES ||
            name === "table" ||
            VIEW_FACTORIES.has(name))
        ) {
          const receiver =
            ts.isPropertyAccessExpression(call.expression) &&
            ts.isIdentifier(call.expression.expression)
              ? call.expression.expression.text
              : null;
          if (name === "table" && (receiver === null || !schemas.has(receiver)))
            continue;
          const sqlName = literal(call.arguments[0]);
          if (sqlName === null) {
            omissions.push({
              code: "expression_skipped",
              file: file.path,
              detail: `${variable}'s table name is not a string literal.`,
            });
            continue;
          }
          declarations.push({
            variable,
            sqlName,
            schema:
              name === "table" && receiver !== null
                ? (schemas.get(receiver) ?? null)
                : null,
            storage: TABLE_FACTORIES[name] ?? "postgresql",
            kind: VIEW_FACTORIES.has(name) ? "view" : "table",
            scope,
            line,
            columns: call.arguments[1],
            extra: call.arguments[2],
          });
        }
      }
    }
  }
  // Enums declared after the tables that use them are still enums.
  const tables = new Map(declarations.map((table) => [table.variable, table]));
  const entities: DataEntity[] = [];
  const relations: DataRelation[] = [];
  const pending: {
    from: TableDeclaration;
    fields: string[];
    target: string;
    targetFields: string[];
    name: string | null;
    onDelete: string | null;
    onUpdate: string | null;
  }[] = [];
  const actionOf = (options: ts.Expression | undefined, key: string) => {
    const value = literal(property(options, key));
    return value === null ? null : normalizeReferentialAction(value);
  };
  for (const table of declarations) {
    const fields: DataField[] = [];
    let primaryKey: string[] = [];
    const uniques: string[][] = [];
    let columns = table.columns;
    // `(t) => ({ ... })`, the callback form of the columns.
    if (
      columns !== undefined &&
      ts.isArrowFunction(columns) &&
      !ts.isBlock(columns.body)
    )
      columns = ts.isParenthesizedExpression(columns.body)
        ? columns.body.expression
        : columns.body;
    const members: ts.ObjectLiteralElementLike[] = [];
    const collect = (node: ts.Expression | undefined, depth: number) => {
      if (node === undefined || !ts.isObjectLiteralExpression(node)) {
        if (node !== undefined)
          omissions.push({
            code: "expression_skipped",
            file: table.scope.path,
            detail: `${table.variable}'s columns are not an object literal.`,
          });
        return;
      }
      for (const element of node.properties) {
        if (ts.isSpreadAssignment(element)) {
          const spread = ts.isIdentifier(element.expression)
            ? table.scope.constants.get(element.expression.text)
            : undefined;
          if (spread !== undefined && depth < 3) collect(spread, depth + 1);
          else
            omissions.push({
              code: "expression_skipped",
              file: table.scope.path,
              detail: `${table.variable} spreads columns this recognizer cannot follow.`,
            });
        } else members.push(element);
      }
    };
    if (table.kind === "table") collect(columns, 0);
    for (const element of members) {
      if (!ts.isPropertyAssignment(element)) continue;
      const key =
        ts.isIdentifier(element.name) || ts.isStringLiteralLike(element.name)
          ? element.name.text
          : null;
      if (key === null) continue;
      const { base, calls } = unchain(element.initializer);
      const builder =
        base === null ? null : builderOf(base, table.scope, enums);
      if (base === null || builder === null) {
        omissions.push({
          code: "expression_skipped",
          file: table.scope.path,
          detail: `${table.variable}.${key} is not a column builder this recognizer knows.`,
        });
        continue;
      }
      let nativeType =
        builder.builder === "enum"
          ? (builder.enumName ?? "enum")
          : nativeTypeOf(builder.builder, builder.call);
      const field = {
        name: key,
        column: literal(base.arguments[0]) ?? key,
        type:
          builder.builder === "enum"
            ? ("enum" as const)
            : normalizeSqlType(nativeType),
        nativeType,
        list: false,
        nullable: true,
        default: null as string | null,
        unique: false,
        primaryKey: false,
        enum: builder.enumName,
      };
      if (/serial$/.test(builder.builder)) {
        field.nullable = false;
        field.default = "autoincrement";
      }
      for (const call of calls) {
        switch (call.name) {
          case "notNull":
            field.nullable = false;
            break;
          case "primaryKey":
            field.primaryKey = true;
            field.nullable = false;
            break;
          case "unique":
            field.unique = true;
            break;
          case "default":
            field.default = call.args[0]?.getText(table.scope.source) ?? null;
            break;
          case "defaultNow":
            field.default = "now()";
            break;
          case "defaultRandom":
            field.default = "gen_random_uuid()";
            break;
          case "$defaultFn":
          case "$default":
            field.default = "(function)";
            break;
          case "autoincrement":
            field.default = "autoincrement";
            break;
          case "generatedAlwaysAsIdentity":
          case "generatedByDefaultAsIdentity":
            field.default = "identity";
            field.nullable = false;
            break;
          case "array":
            field.list = true;
            nativeType = `${nativeType}[]`;
            field.nativeType = nativeType;
            break;
          case "references": {
            const getter = call.args[0];
            const target =
              getter !== undefined &&
              ts.isArrowFunction(getter) &&
              !ts.isBlock(getter.body)
                ? getter.body
                : undefined;
            if (
              target !== undefined &&
              ts.isPropertyAccessExpression(target) &&
              ts.isIdentifier(target.expression)
            )
              pending.push({
                from: table,
                fields: [key],
                target: target.expression.text,
                targetFields: [target.name.text],
                name: null,
                onDelete: actionOf(call.args[1], "onDelete"),
                onUpdate: actionOf(call.args[1], "onUpdate"),
              });
            else
              omissions.push({
                code: "expression_skipped",
                file: table.scope.path,
                detail: `${table.variable}.${key} references a column this recognizer cannot read.`,
              });
            break;
          }
        }
      }
      fields.push(field);
    }
    // The extra config: `(t) => ({ ... })` or `(t) => [ ... ]`.
    const extra = table.extra;
    if (extra !== undefined && ts.isArrowFunction(extra)) {
      let body: ts.Node = extra.body;
      if (ts.isBlock(body)) {
        const returned = body.statements.find(ts.isReturnStatement)?.expression;
        if (returned !== undefined) body = returned;
      }
      if (ts.isParenthesizedExpression(body)) body = body.expression;
      const items = ts.isObjectLiteralExpression(body)
        ? body.properties.flatMap((element) =>
            ts.isPropertyAssignment(element) ? [element.initializer] : [],
          )
        : ts.isArrayLiteralExpression(body)
          ? [...body.elements]
          : [];
      for (const item of items) {
        const { base, calls } = unchain(item);
        const name = base === null ? null : calleeName(base);
        if (base === null || name === null) continue;
        const on = calls.find((call) => call.name === "on");
        if (name === "primaryKey") {
          const options = base.arguments[0];
          primaryKey =
            options !== undefined && ts.isObjectLiteralExpression(options)
              ? columnKeys(property(options, "columns"))
              : base.arguments.flatMap((arg) => {
                  const column = columnKey(arg);
                  return column === null ? [] : [column];
                });
        } else if (
          (name === "unique" || name === "uniqueIndex") &&
          on !== undefined
        ) {
          const keys = on.args.flatMap((arg) => {
            const column = columnKey(arg);
            return column === null ? [] : [column];
          });
          if (keys.length > 0) uniques.push(keys);
        } else if (name === "foreignKey") {
          const options = base.arguments[0];
          const foreign = property(options, "foreignColumns");
          const firstForeign =
            foreign !== undefined && ts.isArrayLiteralExpression(foreign)
              ? foreign.elements[0]
              : undefined;
          const target =
            firstForeign !== undefined &&
            ts.isPropertyAccessExpression(firstForeign) &&
            ts.isIdentifier(firstForeign.expression)
              ? firstForeign.expression.text
              : null;
          if (target === null) continue;
          const actions = (method: string) => {
            const argumentNode = calls.find((call) => call.name === method)
              ?.args[0];
            const value = literal(argumentNode);
            return value === null ? null : normalizeReferentialAction(value);
          };
          pending.push({
            from: table,
            fields: columnKeys(property(options, "columns")),
            target,
            targetFields: columnKeys(foreign),
            name: literal(property(options, "name")),
            onDelete: actions("onDelete"),
            onUpdate: actions("onUpdate"),
          });
        }
      }
    }
    const keys =
      primaryKey.length > 0
        ? primaryKey
        : fields.filter((field) => field.primaryKey).map((field) => field.name);
    const single = new Set(
      uniques.flatMap((set) => (set.length === 1 ? set : [])),
    );
    entities.push({
      name: table.variable,
      table:
        table.schema === null || table.schema === "public"
          ? table.sqlName
          : `${table.schema}.${table.sqlName}`,
      kind: table.kind,
      source: "drizzle",
      file: table.scope.path,
      line: table.line,
      fields: fields.map((field) => ({
        ...field,
        primaryKey: field.primaryKey || keys.includes(field.name),
        nullable: keys.includes(field.name) ? false : field.nullable,
        unique: field.unique || single.has(field.name),
      })),
      primaryKey: keys,
      uniques: uniques
        .filter((set) => set.length > 1)
        .sort((a, b) => (a.join(",") < b.join(",") ? -1 : 1)),
    });
  }
  for (const relation of pending) {
    const target = tables.get(relation.target);
    if (target === undefined) {
      omissions.push({
        code: "unresolved_relation",
        file: relation.from.scope.path,
        detail: `${relation.from.variable} references ${relation.target}, which is not a table this recognizer read.`,
      });
      continue;
    }
    const entity = entities.find((e) => e.name === relation.from.variable);
    const unique =
      entity !== undefined &&
      [
        entity.primaryKey,
        ...entity.uniques,
        ...entity.fields.filter((f) => f.unique).map((f) => [f.name]),
      ].some(
        (set) =>
          set.length > 0 &&
          set.length === relation.fields.length &&
          set.every((name) => relation.fields.includes(name)),
      );
    relations.push({
      name: relation.name,
      from: { entity: relation.from.variable, fields: relation.fields },
      to: { entity: target.variable, fields: relation.targetFields },
      cardinality: unique ? "one-to-one" : "many-to-one",
      onDelete: relation.onDelete,
      onUpdate: relation.onUpdate,
      source: "drizzle",
    });
  }
  const storageCounts = new Map<string, number>();
  for (const table of declarations)
    storageCounts.set(
      table.storage,
      (storageCounts.get(table.storage) ?? 0) + 1,
    );
  const storage =
    [...storageCounts].sort(
      (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1),
    )[0]?.[0] ?? "postgresql";
  const definitions = new Map<string, Map<string, string>>();
  for (const table of declarations) {
    const exported = table.scope.source.statements.some(
      (statement) =>
        ts.isVariableStatement(statement) &&
        (ts.getModifiers(statement) ?? []).some(
          (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
        ) &&
        statement.declarationList.declarations.some(
          (declaration) =>
            ts.isIdentifier(declaration.name) &&
            declaration.name.text === table.variable,
        ),
    );
    if (!exported) continue;
    const names =
      definitions.get(table.scope.path) ?? new Map<string, string>();
    names.set(table.variable, table.variable);
    definitions.set(table.scope.path, names);
  }
  const enumList: DataEnum[] = [...enums.values()].map((value) => ({
    name: value.name,
    values: value.values,
    source: "drizzle",
    file: value.file,
    line: value.line,
  }));
  return {
    kind: "drizzle",
    storage,
    files: [...new Set(declarations.map((table) => table.scope.path))].sort(),
    evidence,
    entities,
    enums: enumList,
    relations,
    omissions,
    definitions,
  };
}
