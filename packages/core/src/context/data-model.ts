/**
 * What a `data_model` run writes: the entities, fields, enums and relations
 * a repository stores, and the modules that touch them. It is what fake
 * data must obey, and where `database` seams sit.
 *
 * Recognizers run only on evidence: a package the graph shows imported, a
 * schema file by name, or a migration directory the tree facts list. Each
 * reports the entities of one source; when two sources define the same
 * table (a Prisma schema and the migrations it generated), the declared
 * schema wins and the other source counts the table as shadowed. Accessors
 * are the modules the graph shows reaching an entity's definition, ranked
 * by how many entities they touch. Everything here is a pure function of
 * what the recognizers found.
 */

export const DATA_MODEL_SCHEMA_VERSION = 1;

/** Recognizers, from the most authoritative source of a table to the least. */
export const DATA_SOURCE_KINDS = [
  "prisma",
  "drizzle",
  "sql_migrations",
] as const;
export type DataSourceKind = (typeof DATA_SOURCE_KINDS)[number];

/** What a field holds, whatever the source calls it. */
export const FIELD_TYPES = [
  "string",
  "integer",
  "bigint",
  "decimal",
  "float",
  "boolean",
  "date",
  "datetime",
  "time",
  "interval",
  "json",
  "uuid",
  "bytes",
  "enum",
  "unknown",
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const RELATION_CARDINALITIES = [
  "many-to-one",
  "one-to-one",
  "many-to-many",
] as const;
export type RelationCardinality = (typeof RELATION_CARDINALITIES)[number];

export interface DataField {
  /** As the code names it: a Prisma field, a Drizzle property, a column. */
  readonly name: string;
  /** The column it is stored in. */
  readonly column: string;
  readonly type: FieldType;
  /** The type as the source writes it, such as `VarChar(200)` or `timestamp with time zone`. */
  readonly nativeType: string;
  readonly list: boolean;
  readonly nullable: boolean;
  /** The default as written; null when there is none. */
  readonly default: string | null;
  readonly unique: boolean;
  readonly primaryKey: boolean;
  /** The enum it holds, when `type` is `enum`. */
  readonly enum: string | null;
}

export interface DataEntity {
  /** As the code names it; the table name for a source with no code names. */
  readonly name: string;
  /** Where it is stored: a table or view, schema-qualified outside `public`. */
  readonly table: string;
  readonly kind: "table" | "view";
  readonly source: DataSourceKind;
  readonly file: string;
  readonly line: number;
  /** In declaration order. */
  readonly fields: readonly DataField[];
  /** Field names, in key order. */
  readonly primaryKey: readonly string[];
  /** Unique field sets of more than one field, sorted. */
  readonly uniques: readonly (readonly string[])[];
}

export interface DataEnum {
  readonly name: string;
  readonly values: readonly string[];
  readonly source: DataSourceKind;
  readonly file: string;
  readonly line: number;
}

/** One end of a relation. */
export interface DataRelationEnd {
  readonly entity: string;
  readonly fields: readonly string[];
  /**
   * The table of the entity meant, as `mergeSources` resolved it. Names
   * are only unique within one source: a Prisma `Account` and a Drizzle
   * `Account` on another table are both kept, and only the table says which
   * one a relation means. Absent on a recognizer's own relations and on
   * documents written before it; those are matched by name.
   */
  readonly table?: string;
}

export interface DataRelation {
  readonly name: string | null;
  /** The entity holding the foreign key, and its fields. */
  readonly from: DataRelationEnd;
  readonly to: DataRelationEnd;
  readonly cardinality: RelationCardinality;
  /** Lower-case, as SQL spells it: `cascade`, `set null`, `restrict`, `no action`, `set default`. */
  readonly onDelete: string | null;
  readonly onUpdate: string | null;
  readonly source: DataSourceKind;
}

export interface DataSource {
  readonly kind: DataSourceKind;
  /** `postgresql`, `mysql`, `sqlite`, `mongodb`, … or `unknown`. */
  readonly storage: string;
  /** The files it was read from, sorted. */
  readonly files: readonly string[];
  /** What made the recognizer run, such as `dependency:@prisma/client`. */
  readonly evidence: readonly string[];
  readonly entities: number;
  /** Tables it defines that a more authoritative source also defines. */
  readonly shadowed: number;
}

/** A module that reads or writes entities: a candidate `database` seam. */
export interface DataAccessor {
  readonly module: string;
  /** Entity names, sorted. */
  readonly entities: readonly string[];
  /** Repository files importing the module, from the graph. */
  readonly importers: number;
}

export const DATA_MODEL_OMISSION_CODES = [
  "parse_failed",
  "statement_skipped",
  "unknown_table",
  "unresolved_relation",
  "read_failed",
  "expression_skipped",
] as const;
export type DataModelOmissionCode = (typeof DATA_MODEL_OMISSION_CODES)[number];

export interface DataModelOmission {
  readonly code: DataModelOmissionCode;
  readonly file: string | null;
  readonly detail: string;
}

/** `data-model.json`. */
export interface DataModel {
  readonly schemaVersion: typeof DATA_MODEL_SCHEMA_VERSION;
  readonly toolVersion: string;
  readonly sourceSnapshotId: string;
  readonly sourceCommitSha: string;
  readonly graphRunId: string;
  readonly graphSha256: string;
  readonly sources: readonly DataSource[];
  /** Sorted by name. */
  readonly entities: readonly DataEntity[];
  readonly enums: readonly DataEnum[];
  readonly relations: readonly DataRelation[];
  /** Most entities first, then most importers, then by path. */
  readonly accessors: readonly DataAccessor[];
  readonly omissions: readonly DataModelOmission[];
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const NUMERIC_ATTRIBUTES = new Set(["unsigned", "signed", "zerofill"]);

/** A type without its `(…)`, from the first `(` to the last `)`. */
function withoutParameters(type: string): string {
  const open = type.indexOf("(");
  const close = type.lastIndexOf(")");
  return open < 0 || close < open
    ? type
    : type.slice(0, open) + type.slice(close + 1);
}

/** What a SQL type, as any dialect writes it, holds. */
export function normalizeSqlType(native: string): FieldType {
  const words = withoutParameters(native.toLowerCase().replace(/\[\]$/, ""))
    .replace(/^pg_catalog\./, "")
    .split(/\s+/)
    .filter((word) => word !== "");
  // MySQL's numeric attributes say how a number is stored or shown, not
  // what it holds: `int(11) unsigned zerofill` is an integer. Dropped word
  // by word rather than by a repeated pattern, which backtracks.
  while (words.length > 1 && NUMERIC_ATTRIBUTES.has(words.at(-1) ?? ""))
    words.pop();
  const type = words.join(" ");
  if (
    /^(text|varchar|varchar2|character varying|char|character|bpchar|citext|name|nvarchar|nvarchar2|nchar|tinytext|mediumtext|longtext|string|clob)$/.test(
      type,
    )
  )
    return "string";
  if (
    /^(smallint|int2|integer|int|int4|serial|serial4|smallserial|serial2|tinyint|mediumint)$/.test(
      type,
    )
  )
    return "integer";
  if (/^(bigint|int8|bigserial|serial8)$/.test(type)) return "bigint";
  if (/^(numeric|decimal|money|dec)$/.test(type)) return "decimal";
  if (/^(real|float4|double precision|float8|float|double)$/.test(type))
    return "float";
  if (/^(boolean|bool|bit)$/.test(type)) return "boolean";
  if (type === "date") return "date";
  if (
    /^(timestamp|timestamptz|datetime|datetime2|smalldatetime|timestamp (with|without) time zone)$/.test(
      type,
    )
  )
    return "datetime";
  if (/^(time|timetz|time (with|without) time zone)$/.test(type)) return "time";
  if (type === "interval") return "interval";
  if (/^(json|jsonb)$/.test(type)) return "json";
  if (type === "uuid") return "uuid";
  if (/^(bytea|blob|binary|varbinary|longblob|mediumblob|tinyblob)$/.test(type))
    return "bytes";
  return "unknown";
}

/** How SQL spells a referential action, from any source's spelling. */
export function normalizeReferentialAction(action: string): string {
  return action
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]/g, " ")
    .toLowerCase()
    .trim();
}

/** What one recognizer found in one source. */
export interface RecognizedSource {
  readonly kind: DataSourceKind;
  readonly storage: string;
  readonly files: readonly string[];
  readonly evidence: readonly string[];
  readonly entities: readonly DataEntity[];
  readonly enums: readonly DataEnum[];
  readonly relations: readonly DataRelation[];
  readonly omissions: readonly DataModelOmission[];
}

const precedence = (kind: DataSourceKind) => DATA_SOURCE_KINDS.indexOf(kind);

/**
 * The sources merged: a table, or an enum, comes from the most
 * authoritative source that defines it, and a relation is kept when its
 * entity was. Sorted throughout, so the order recognizers ran in is
 * irrelevant.
 */
export function mergeSources(recognized: readonly RecognizedSource[]): {
  sources: DataSource[];
  entities: DataEntity[];
  enums: DataEnum[];
  relations: DataRelation[];
  omissions: DataModelOmission[];
} {
  const ordered = [...recognized].sort(
    (a, b) =>
      precedence(a.kind) - precedence(b.kind) ||
      compare(a.files.join("\n"), b.files.join("\n")),
  );
  const tables = new Map<string, DataEntity>();
  const enumNames = new Map<string, DataEnum>();
  const kept = new Set<DataEntity>();
  const sources: DataSource[] = [];
  for (const source of ordered) {
    let shadowed = 0;
    for (const entity of source.entities) {
      const key = entity.table.toLowerCase();
      if (tables.has(key)) shadowed += 1;
      else {
        tables.set(key, entity);
        kept.add(entity);
      }
    }
    for (const value of source.enums)
      if (!enumNames.has(value.name.toLowerCase()))
        enumNames.set(value.name.toLowerCase(), value);
    sources.push({
      kind: source.kind,
      storage: source.storage,
      files: [...source.files].sort(compare),
      evidence: [...new Set(source.evidence)].sort(compare),
      entities: source.entities.length - shadowed,
      shadowed,
    });
  }
  // A relation's names are resolved within the source that recorded it:
  // two sources of one kind (two Prisma schemas) may each have a `User`.
  // Each end is then pinned to the kept entity's table, since that is what
  // tells two kept entities of one name apart. A relation's target may be a
  // table a more authoritative source named differently; it points at the
  // entity that was kept for that table.
  const relations = ordered
    .flatMap((source) => {
      const byName = new Map(
        source.entities.map((entity) => [entity.name, entity] as const),
      );
      return source.relations.flatMap((relation): DataRelation[] => {
        const from = byName.get(relation.from.entity);
        if (from === undefined || !kept.has(from)) return [];
        const declared = byName.get(relation.to.entity);
        const target =
          declared === undefined
            ? undefined
            : tables.get(declared.table.toLowerCase());
        return [
          {
            ...relation,
            from: { ...relation.from, table: from.table },
            to:
              target === undefined
                ? relation.to
                : { ...relation.to, entity: target.name, table: target.table },
          },
        ];
      });
    })
    .sort(compareRelations);
  return {
    sources,
    entities: [...kept].sort(
      (a, b) => compare(a.name, b.name) || compare(a.table, b.table),
    ),
    enums: [...enumNames.values()].sort((a, b) => compare(a.name, b.name)),
    relations,
    omissions: ordered
      .flatMap((source) => source.omissions)
      .sort(
        (a, b) =>
          compare(a.file ?? "", b.file ?? "") ||
          compare(a.code, b.code) ||
          compare(a.detail, b.detail),
      ),
  };
}

function compareRelations(a: DataRelation, b: DataRelation): number {
  return (
    compare(a.from.entity, b.from.entity) ||
    compare(a.from.table ?? "", b.from.table ?? "") ||
    compare(a.from.fields.join(","), b.from.fields.join(",")) ||
    compare(a.to.entity, b.to.entity) ||
    compare(a.to.table ?? "", b.to.table ?? "") ||
    compare(a.name ?? "", b.name ?? "")
  );
}

/** What tells two entities apart: names repeat across sources, tables do not. */
type EntityIdentity = Pick<DataEntity, "name" | "table" | "source">;

/**
 * Whether a relation end means this entity: by table when the end carries
 * one, else by name within the relation's own source, the only place a
 * name is unique.
 */
function endMeans(
  end: DataRelationEnd,
  source: DataSourceKind,
  entity: EntityIdentity,
): boolean {
  if (end.entity !== entity.name) return false;
  return end.table === undefined
    ? entity.source === source
    : end.table === entity.table;
}

/**
 * The entity a relation end means: by table when it carries one, else the
 * one of that name from the relation's source, else any of that name, for
 * a target a more authoritative source defined.
 */
function entityAt<T extends EntityIdentity>(
  entities: readonly T[],
  end: DataRelationEnd,
  source: DataSourceKind,
): T | undefined {
  return (
    entities.find((entity) => endMeans(end, source, entity)) ??
    (end.table === undefined
      ? entities.find((entity) => entity.name === end.entity)
      : undefined)
  );
}

/** Accessors ranked: most entities, then most importers, then by path. */
export function rankAccessors(
  accessors: readonly DataAccessor[],
): DataAccessor[] {
  return accessors
    .filter((accessor) => accessor.entities.length > 0)
    .map((accessor) => ({
      ...accessor,
      entities: [...new Set(accessor.entities)].sort(compare),
    }))
    .sort(
      (a, b) =>
        b.entities.length - a.entities.length ||
        b.importers - a.importers ||
        compare(a.module, b.module),
    );
}

/**
 * The field names of an entity that are foreign keys. Given the entity
 * rather than its name, only relations from that very entity count, not
 * from another source's entity of the same name.
 */
export function foreignKeyFields(
  model: Pick<DataModel, "relations">,
  entity: string | Pick<DataEntity, "name" | "table" | "source">,
): Set<string> {
  return new Set(
    model.relations
      .filter(
        (relation) =>
          (typeof entity === "string"
            ? relation.from.entity === entity
            : endMeans(relation.from, relation.source, entity)) &&
          relation.cardinality !== "many-to-many",
      )
      .flatMap((relation) => relation.from.fields),
  );
}

const mermaidName = (name: string) => name.replace(/[^A-Za-z0-9_-]/g, "_");
/** An attribute type may also carry brackets and parentheses. */
const mermaidType = (type: string) =>
  type.replace(/[^A-Za-z0-9_\-[\]()]/g, "_");
const mermaidText = (text: string) => text.replace(/"/g, "'");

/** `erd.mmd`: a Mermaid `erDiagram` of the entities and relations. */
export function renderErdMermaid(
  model: Pick<DataModel, "entities" | "relations">,
): string {
  // Two names that sanitise alike, or two entities of one name from
  // different sources, keep apart with a numeric suffix. Keyed by the
  // entity itself: keyed by name, both would draw under one box and
  // Mermaid would merge them.
  const names = new Map<DataEntity, string>();
  const taken = new Set<string>();
  for (const entity of model.entities) {
    const base = mermaidName(entity.name) || "entity";
    let name = base;
    for (let index = 2; taken.has(name); index += 1) name = `${base}_${index}`;
    taken.add(name);
    names.set(entity, name);
  }
  const lines = ["erDiagram"];
  for (const entity of model.entities) {
    const foreign = foreignKeyFields(model, entity);
    lines.push(`  ${names.get(entity) ?? entity.name} {`);
    for (const field of entity.fields) {
      const keys = [
        ...(field.primaryKey ? ["PK"] : []),
        ...(foreign.has(field.name) ? ["FK"] : []),
        ...(field.unique && !field.primaryKey ? ["UK"] : []),
      ];
      const type = `${field.type === "enum" && field.enum !== null ? mermaidName(field.enum) : field.type}${field.list ? "[]" : ""}`;
      lines.push(
        `    ${mermaidType(type)} ${mermaidName(field.name) || "field"}${keys.length > 0 ? ` ${keys.join(",")}` : ""} "${mermaidText(`${field.nativeType}${field.nullable ? ", nullable" : ""}`)}"`,
      );
    }
    lines.push("  }");
  }
  for (const relation of model.relations) {
    const entity = entityAt(model.entities, relation.from, relation.source);
    const target = entityAt(model.entities, relation.to, relation.source);
    if (entity === undefined || target === undefined) continue;
    const from = names.get(entity);
    const to = names.get(target);
    if (from === undefined || to === undefined) continue;
    const optional = relation.from.fields.some(
      (name) => entity.fields.find((field) => field.name === name)?.nullable,
    );
    const arrow =
      relation.cardinality === "many-to-many"
        ? "}o--o{"
        : relation.cardinality === "one-to-one"
          ? optional
            ? "|o--o|"
            : "|o--||"
          : optional
            ? "}o--o|"
            : "}o--||";
    const label =
      relation.name ?? (relation.from.fields.join(", ") || "relates");
    lines.push(`  ${from} ${arrow} ${to} : "${mermaidText(label)}"`);
  }
  return `${lines.join("\n")}\n`;
}

/** What the summary may list before it is cut short. */
export const DATA_MODEL_SUMMARY_LIMITS = {
  entities: 60,
  fields: 40,
  enums: 40,
  enumValues: 30,
  relations: 120,
  accessors: 25,
  accessorEntities: 20,
  sourceFiles: 10,
  omissions: 25,
} as const;

/** What the `manifest.json` and `data_model` artifacts' `meta` carry for the console. */
export interface DataModelSummary {
  readonly schemaVersion: 1;
  readonly toolVersion: string;
  /** Sorted, distinct. */
  readonly storage: readonly string[];
  readonly sources: readonly (Omit<DataSource, "files"> & {
    readonly files: readonly string[];
  })[];
  readonly counts: {
    readonly entities: number;
    readonly fields: number;
    readonly enums: number;
    readonly relations: number;
    readonly accessors: number;
    readonly omissions: number;
  };
  readonly entities: readonly {
    readonly name: string;
    readonly table: string;
    readonly kind: "table" | "view";
    readonly source: DataSourceKind;
    readonly file: string;
    readonly line: number;
    readonly fieldCount: number;
    readonly fields: readonly {
      readonly name: string;
      readonly type: FieldType;
      readonly nativeType: string;
      readonly nullable: boolean;
      readonly list: boolean;
      readonly primaryKey: boolean;
      readonly unique: boolean;
      readonly foreignKey: boolean;
      readonly enum: string | null;
    }[];
  }[];
  readonly enums: readonly {
    readonly name: string;
    readonly values: readonly string[];
  }[];
  readonly relations: readonly {
    readonly from: string;
    readonly fromFields: readonly string[];
    readonly to: string;
    readonly toFields: readonly string[];
    readonly cardinality: RelationCardinality;
    readonly onDelete: string | null;
  }[];
  readonly accessors: readonly DataAccessor[];
  readonly omissions: readonly DataModelOmission[];
  readonly truncated: boolean;
}

export function dataModelSummary(model: DataModel): DataModelSummary {
  const limits = DATA_MODEL_SUMMARY_LIMITS;
  let truncated = false;
  const cut = <T>(list: readonly T[], limit: number): T[] => {
    if (list.length > limit) truncated = true;
    return list.slice(0, limit);
  };
  return {
    schemaVersion: 1,
    toolVersion: model.toolVersion,
    storage: [...new Set(model.sources.map((source) => source.storage))].sort(
      compare,
    ),
    sources: model.sources.map((source) => ({
      ...source,
      files: cut(source.files, limits.sourceFiles),
    })),
    counts: {
      entities: model.entities.length,
      fields: model.entities.reduce(
        (total, entity) => total + entity.fields.length,
        0,
      ),
      enums: model.enums.length,
      relations: model.relations.length,
      accessors: model.accessors.length,
      omissions: model.omissions.length,
    },
    entities: cut(model.entities, limits.entities).map((entity) => {
      const foreign = foreignKeyFields(model, entity);
      return {
        name: entity.name,
        table: entity.table,
        kind: entity.kind,
        source: entity.source,
        file: entity.file,
        line: entity.line,
        fieldCount: entity.fields.length,
        fields: cut(entity.fields, limits.fields).map((field) => ({
          name: field.name,
          type: field.type,
          nativeType: field.nativeType,
          nullable: field.nullable,
          list: field.list,
          primaryKey: field.primaryKey,
          unique: field.unique,
          foreignKey: foreign.has(field.name),
          enum: field.enum,
        })),
      };
    }),
    enums: cut(model.enums, limits.enums).map((value) => ({
      name: value.name,
      values: cut(value.values, limits.enumValues),
    })),
    relations: cut(model.relations, limits.relations).map((relation) => ({
      from: relation.from.entity,
      fromFields: relation.from.fields,
      to: relation.to.entity,
      toFields: relation.to.fields,
      cardinality: relation.cardinality,
      onDelete: relation.onDelete,
    })),
    accessors: cut(model.accessors, limits.accessors).map((accessor) => ({
      ...accessor,
      entities: cut(accessor.entities, limits.accessorEntities),
    })),
    omissions: cut(model.omissions, limits.omissions),
    truncated,
  };
}
