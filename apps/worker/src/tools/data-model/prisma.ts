/**
 * The Prisma recognizer: models, enums and relations from `.prisma` schema
 * files, read with a small parser for the schema language.
 *
 * The parser is written here rather than taken from a package: it reads
 * text into blocks, fields and attributes and nothing else, so no
 * configuration is looked up and nothing is evaluated. A file it cannot
 * read is an omission; the rest of the schema still counts.
 */

import { normalizeReferentialAction, normalizeSqlType } from "sandbox-factory";
import type {
  DataEntity,
  DataEnum,
  DataField,
  DataModelOmission,
  DataRelation,
  FieldType,
  RecognizedSource,
} from "sandbox-factory";

export type PrismaValue =
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "number"; readonly value: string }
  | { readonly kind: "name"; readonly value: string }
  | { readonly kind: "array"; readonly items: readonly PrismaValue[] }
  | {
      readonly kind: "call";
      readonly name: string;
      readonly args: readonly PrismaArgument[];
    };
export interface PrismaArgument {
  readonly key: string | null;
  readonly value: PrismaValue;
}
export interface PrismaAttribute {
  /** `id`, `default`, `db.VarChar`, `relation`, `map`, … */
  readonly name: string;
  readonly args: readonly PrismaArgument[];
}
export interface PrismaField {
  readonly name: string;
  /** The type as written; `Unsupported("…")` keeps its call. */
  readonly type: string;
  readonly list: boolean;
  readonly optional: boolean;
  readonly attributes: readonly PrismaAttribute[];
  readonly line: number;
}
export interface PrismaBlock {
  /** `model`, `view`, `type`, `enum`, `datasource`, `generator`. */
  readonly keyword: string;
  readonly name: string;
  readonly line: number;
  readonly fields: readonly PrismaField[];
  /** `@@` attributes of a model or enum. */
  readonly attributes: readonly PrismaAttribute[];
  readonly assignments: ReadonlyMap<string, PrismaValue>;
  readonly values: readonly {
    readonly name: string;
    readonly attributes: readonly PrismaAttribute[];
  }[];
}

export class PrismaSyntaxError extends Error {
  constructor(
    readonly line: number,
    detail: string,
  ) {
    super(`Line ${line}: ${detail}`);
  }
}

type Token =
  | { readonly type: "newline"; readonly line: number }
  | { readonly type: "punct"; readonly value: string; readonly line: number }
  | { readonly type: "string"; readonly value: string; readonly line: number }
  | { readonly type: "number"; readonly value: string; readonly line: number }
  | { readonly type: "name"; readonly value: string; readonly line: number };

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let line = 1;
  let index = 0;
  while (index < text.length) {
    const char = text[index] ?? "";
    if (char === "\n") {
      tokens.push({ type: "newline", line });
      line += 1;
      index += 1;
    } else if (/\s/.test(char)) index += 1;
    else if (text.startsWith("//", index)) {
      while (index < text.length && text[index] !== "\n") index += 1;
    } else if (char === '"') {
      let value = "";
      index += 1;
      for (;;) {
        const next = text[index];
        if (next === undefined || next === "\n")
          throw new PrismaSyntaxError(line, "unterminated string");
        index += 1;
        if (next === '"') break;
        if (next === "\\") {
          const escaped = text[index] ?? "";
          index += 1;
          value += escaped === "n" ? "\n" : escaped === "t" ? "\t" : escaped;
        } else value += next;
      }
      tokens.push({ type: "string", value, line });
    } else if (text.startsWith("@@", index)) {
      tokens.push({ type: "punct", value: "@@", line });
      index += 2;
    } else if ("{}[]()=,:?.@".includes(char)) {
      tokens.push({ type: "punct", value: char, line });
      index += 1;
    } else {
      const number = /^-?\d+(\.\d+)?/.exec(text.slice(index, index + 64));
      if (number !== null) {
        tokens.push({ type: "number", value: number[0], line });
        index += number[0].length;
        continue;
      }
      const name = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(
        text.slice(index, index + 256),
      );
      if (name === null)
        throw new PrismaSyntaxError(
          line,
          `unexpected character ${JSON.stringify(char)}`,
        );
      tokens.push({ type: "name", value: name[0], line });
      index += name[0].length;
    }
  }
  return tokens;
}

/** The blocks of one schema file, in order. */
export function parsePrismaSchema(text: string): PrismaBlock[] {
  const tokens = tokenize(text);
  let position = 0;
  const peek = () => tokens[position];
  const lineOf = () => peek()?.line ?? tokens.at(-1)?.line ?? 1;
  const skipNewlines = () => {
    while (peek()?.type === "newline") position += 1;
  };
  const isPunct = (value: string) => {
    const token = peek();
    return token?.type === "punct" && token.value === value;
  };
  const expectPunct = (value: string) => {
    if (!isPunct(value))
      throw new PrismaSyntaxError(lineOf(), `expected ${value}`);
    position += 1;
  };
  const name = (): string => {
    const token = peek();
    if (token?.type !== "name")
      throw new PrismaSyntaxError(lineOf(), "expected a name");
    position += 1;
    return token.value;
  };
  /** `a` or `a.b`, as attribute and type names are written. */
  const dotted = (): string => {
    let value = name();
    while (isPunct(".")) {
      position += 1;
      value += `.${name()}`;
    }
    return value;
  };
  const value = (): PrismaValue => {
    skipNewlines();
    const token = peek();
    if (token === undefined)
      throw new PrismaSyntaxError(lineOf(), "expected a value");
    if (token.type === "string" || token.type === "number") {
      position += 1;
      return { kind: token.type, value: token.value };
    }
    if (token.type === "punct" && token.value === "[") {
      position += 1;
      const items: PrismaValue[] = [];
      skipNewlines();
      while (!isPunct("]")) {
        items.push(value());
        skipNewlines();
        if (isPunct(",")) position += 1;
        skipNewlines();
      }
      position += 1;
      return { kind: "array", items };
    }
    const called = dotted();
    if (isPunct("("))
      return { kind: "call", name: called, args: argumentsOf() };
    return { kind: "name", value: called };
  };
  const argumentsOf = (): PrismaArgument[] => {
    expectPunct("(");
    const args: PrismaArgument[] = [];
    skipNewlines();
    while (!isPunct(")")) {
      const token = peek();
      const next = tokens[position + 1];
      let key: string | null = null;
      if (
        token?.type === "name" &&
        next?.type === "punct" &&
        next.value === ":"
      ) {
        key = token.value;
        position += 2;
      }
      args.push({ key, value: value() });
      skipNewlines();
      if (isPunct(",")) position += 1;
      skipNewlines();
    }
    position += 1;
    return args;
  };
  const attribute = (): PrismaAttribute => {
    const attributeName = dotted();
    return { name: attributeName, args: isPunct("(") ? argumentsOf() : [] };
  };
  const blocks: PrismaBlock[] = [];
  for (;;) {
    skipNewlines();
    const head = peek();
    if (head === undefined) break;
    const line = head.line;
    const keyword = name();
    const blockName = name();
    expectPunct("{");
    const fields: PrismaField[] = [];
    const attributes: PrismaAttribute[] = [];
    const assignments = new Map<string, PrismaValue>();
    const values: { name: string; attributes: PrismaAttribute[] }[] = [];
    for (;;) {
      skipNewlines();
      if (isPunct("}")) {
        position += 1;
        break;
      }
      if (peek() === undefined)
        throw new PrismaSyntaxError(
          line,
          `${keyword} ${blockName} is not closed`,
        );
      if (isPunct("@@")) {
        position += 1;
        attributes.push(attribute());
        continue;
      }
      const memberLine = lineOf();
      const memberName = name();
      if (isPunct("=")) {
        position += 1;
        assignments.set(memberName, value());
        continue;
      }
      const memberAttributes: PrismaAttribute[] = [];
      if (keyword === "enum") {
        while (isPunct("@")) {
          position += 1;
          memberAttributes.push(attribute());
        }
        values.push({ name: memberName, attributes: memberAttributes });
        continue;
      }
      let type = dotted();
      if (isPunct("(")) {
        const args = argumentsOf();
        type = `${type}(${args.map((arg) => renderPrismaValue(arg.value)).join(", ")})`;
      }
      let list = false;
      let optional = false;
      if (isPunct("[")) {
        position += 1;
        expectPunct("]");
        list = true;
      }
      if (isPunct("?")) {
        position += 1;
        optional = true;
      }
      while (isPunct("@")) {
        position += 1;
        memberAttributes.push(attribute());
      }
      fields.push({
        name: memberName,
        type,
        list,
        optional,
        attributes: memberAttributes,
        line: memberLine,
      });
      const after = peek();
      if (after !== undefined && after.type !== "newline" && !isPunct("}"))
        throw new PrismaSyntaxError(
          after.line,
          `unexpected text after ${memberName}`,
        );
    }
    blocks.push({
      keyword,
      name: blockName,
      line,
      fields,
      attributes,
      assignments,
      values,
    });
  }
  return blocks;
}

/** A value as the schema writes it. */
export function renderPrismaValue(value: PrismaValue): string {
  switch (value.kind) {
    case "string":
      return JSON.stringify(value.value);
    case "number":
    case "name":
      return value.value;
    case "array":
      return `[${value.items.map(renderPrismaValue).join(", ")}]`;
    case "call":
      return `${value.name}(${value.args
        .map(
          (arg) =>
            `${arg.key === null ? "" : `${arg.key}: `}${renderPrismaValue(arg.value)}`,
        )
        .join(", ")})`;
  }
}

const PRISMA_SCALARS: Readonly<Record<string, FieldType>> = {
  String: "string",
  Boolean: "boolean",
  Int: "integer",
  BigInt: "bigint",
  Float: "float",
  Decimal: "decimal",
  DateTime: "datetime",
  Json: "json",
  Bytes: "bytes",
};

const attributeOf = (
  attributes: readonly PrismaAttribute[],
  name: string,
): PrismaAttribute | undefined =>
  attributes.find((attribute) => attribute.name === name);

/** An attribute's argument by key, or its first unkeyed one. */
function argument(
  attribute: PrismaAttribute | undefined,
  key: string,
): PrismaValue | undefined {
  if (attribute === undefined) return undefined;
  return (
    attribute.args.find((arg) => arg.key === key)?.value ??
    (key === "name" || key === "fields" || key === "map"
      ? attribute.args.find((arg) => arg.key === null)?.value
      : undefined)
  );
}

const stringOf = (value: PrismaValue | undefined) =>
  value?.kind === "string" ? value.value : null;
const namesOf = (value: PrismaValue | undefined): string[] =>
  value?.kind === "array"
    ? value.items.flatMap((item) =>
        item.kind === "name"
          ? [item.value]
          : item.kind === "call"
            ? [item.name]
            : [],
      )
    : [];

/** Every `.prisma` file read as one schema, as Prisma itself merges them. */
export function recognizePrisma(
  files: readonly { readonly path: string; readonly text: string }[],
  evidence: readonly string[],
): RecognizedSource {
  const omissions: DataModelOmission[] = [];
  const blocks: { file: string; block: PrismaBlock }[] = [];
  for (const file of files) {
    try {
      for (const block of parsePrismaSchema(file.text))
        blocks.push({ file: file.path, block });
    } catch (error) {
      omissions.push({
        code: "parse_failed",
        file: file.path,
        detail:
          error instanceof PrismaSyntaxError
            ? error.message
            : "The schema could not be read.",
      });
    }
  }
  const provider = blocks
    .filter(({ block }) => block.keyword === "datasource")
    .map(({ block }) => stringOf(block.assignments.get("provider")))
    .find((value) => value !== null);
  const enumBlocks = blocks.filter(({ block }) => block.keyword === "enum");
  const enumNames = new Set(enumBlocks.map(({ block }) => block.name));
  const models = blocks.filter(
    ({ block }) =>
      (block.keyword === "model" || block.keyword === "view") &&
      attributeOf(block.attributes, "ignore") === undefined,
  );
  const modelNames = new Set(models.map(({ block }) => block.name));
  const enums: DataEnum[] = enumBlocks.map(({ file, block }) => ({
    name: block.name,
    values: block.values.map((value) => value.name),
    source: "prisma",
    file,
    line: block.line,
  }));
  const entities: DataEntity[] = [];
  const relations: DataRelation[] = [];
  const implicit = new Map<
    string,
    { a: string; b: string; name: string | null }
  >();
  for (const { file, block } of models) {
    const schema = stringOf(
      argument(attributeOf(block.attributes, "schema"), "name"),
    );
    const mapped =
      stringOf(argument(attributeOf(block.attributes, "map"), "name")) ??
      block.name;
    const table =
      schema === null || schema === "public" ? mapped : `${schema}.${mapped}`;
    const blockKey = attributeOf(block.attributes, "id");
    const primaryKey =
      blockKey === undefined ? [] : namesOf(argument(blockKey, "fields"));
    const uniques = block.attributes
      .filter((attribute) => attribute.name === "unique")
      .map((attribute) => namesOf(argument(attribute, "fields")));
    const fields: DataField[] = [];
    for (const field of block.fields) {
      if (attributeOf(field.attributes, "ignore") !== undefined) continue;
      const baseType = field.type.replace(/\(.*$/, "");
      if (modelNames.has(baseType)) {
        const relation = attributeOf(field.attributes, "relation");
        const from = namesOf(argument(relation, "fields"));
        const relationName = stringOf(argument(relation, "name"));
        if (from.length > 0) {
          const unique =
            (from.length === 1 &&
              block.fields.some(
                (other) =>
                  other.name === from[0] &&
                  (attributeOf(other.attributes, "unique") !== undefined ||
                    attributeOf(other.attributes, "id") !== undefined),
              )) ||
            [primaryKey, ...uniques].some(
              (set) =>
                set.length === from.length &&
                set.every((name) => from.includes(name)),
            );
          const action = (key: string) => {
            const value = argument(relation, key);
            return value?.kind === "name"
              ? normalizeReferentialAction(value.value)
              : null;
          };
          relations.push({
            name: relationName,
            from: { entity: block.name, fields: from },
            to: {
              entity: baseType,
              fields: namesOf(argument(relation, "references")),
            },
            cardinality: unique ? "one-to-one" : "many-to-one",
            onDelete: action("onDelete"),
            onUpdate: action("onUpdate"),
            source: "prisma",
          });
        } else if (field.list) {
          // A list on both sides with no foreign key is Prisma's implicit
          // many-to-many; it is recorded once, from the first name.
          const back = models
            .find(({ block: other }) => other.name === baseType)
            ?.block.fields.find(
              (other) =>
                other.type === block.name &&
                other.list &&
                stringOf(
                  argument(attributeOf(other.attributes, "relation"), "name"),
                ) === relationName,
            );
          if (back !== undefined) {
            const [a, b] = [block.name, baseType].sort();
            const key = `${a}\n${b}\n${relationName ?? ""}`;
            if (a !== undefined && b !== undefined && !implicit.has(key))
              implicit.set(key, { a, b, name: relationName });
          }
        }
        continue;
      }
      if (
        blocks.some(
          ({ block: other }) =>
            other.keyword === "type" && other.name === baseType,
        )
      ) {
        // A composite type (MongoDB) is stored inside the document.
        fields.push(fieldOf(field, "json", null));
        continue;
      }
      const isEnum = enumNames.has(baseType);
      fields.push(
        fieldOf(
          field,
          isEnum
            ? "enum"
            : (nativeTypeOf(field) ?? PRISMA_SCALARS[baseType] ?? "unknown"),
          isEnum ? baseType : null,
        ),
      );
    }
    const keyFields =
      primaryKey.length > 0
        ? primaryKey
        : fields.filter((field) => field.primaryKey).map((field) => field.name);
    // `@@unique([a])` makes one field unique, as `@unique` on it would.
    const uniqueFields = new Set(
      uniques.flatMap((set) => (set.length === 1 ? set : [])),
    );
    entities.push({
      name: block.name,
      table,
      kind: block.keyword === "view" ? "view" : "table",
      source: "prisma",
      file,
      line: block.line,
      fields: fields.map((field) => ({
        ...field,
        primaryKey: field.primaryKey || keyFields.includes(field.name),
        unique: field.unique || uniqueFields.has(field.name),
      })),
      primaryKey: keyFields,
      uniques: uniques
        .filter((set) => set.length > 1)
        .map((set) => [...set])
        .sort((a, b) => (a.join(",") < b.join(",") ? -1 : 1)),
    });
  }
  for (const { a, b, name } of implicit.values())
    relations.push({
      name,
      from: { entity: a, fields: [] },
      to: { entity: b, fields: [] },
      cardinality: "many-to-many",
      onDelete: null,
      onUpdate: null,
      source: "prisma",
    });
  for (const relation of relations)
    if (!modelNames.has(relation.to.entity))
      omissions.push({
        code: "unresolved_relation",
        file:
          entities.find((e) => e.name === relation.from.entity)?.file ?? null,
        detail: `${relation.from.entity} relates to ${relation.to.entity}, which is not a model.`,
      });
  return {
    kind: "prisma",
    storage: provider ?? "unknown",
    files: files.map((file) => file.path),
    evidence,
    entities,
    enums,
    relations,
    omissions,
  };
}

/** A `@db.*` native type, normalized; undefined when the field has none. */
function nativeTypeOf(field: PrismaField): FieldType | undefined {
  const native = field.attributes.find((attribute) =>
    attribute.name.startsWith("db."),
  );
  if (native === undefined) return undefined;
  const type = normalizeSqlType(native.name.slice(3));
  return type === "unknown" ? undefined : type;
}

function fieldOf(
  field: PrismaField,
  type: FieldType,
  enumName: string | null,
): DataField {
  const native = field.attributes.find((attribute) =>
    attribute.name.startsWith("db."),
  );
  const defaultValue = attributeOf(field.attributes, "default")?.args[0]?.value;
  return {
    name: field.name,
    column:
      stringOf(argument(attributeOf(field.attributes, "map"), "name")) ??
      field.name,
    type,
    nativeType:
      native === undefined
        ? field.type
        : `${native.name.slice(3)}${native.args.length > 0 ? `(${native.args.map((arg) => renderPrismaValue(arg.value)).join(", ")})` : ""}`,
    list: field.list,
    nullable: field.optional,
    default:
      defaultValue === undefined ? null : renderPrismaValue(defaultValue),
    unique: attributeOf(field.attributes, "unique") !== undefined,
    primaryKey: attributeOf(field.attributes, "id") !== undefined,
    enum: enumName,
  };
}
