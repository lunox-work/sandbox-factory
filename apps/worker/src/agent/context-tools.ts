/**
 * Read-only tools over the context builders' documents: a module's callable
 * surface and what it reaches outside from an `abstractions` run, and the
 * entities from a `data_model` run. They only describe; `check_scope` and
 * `check_fixtures` still decide. Every answer is capped, so one call cannot
 * fill the context window.
 */

import { lookupSeams } from "sandbox-factory";
import type {
  AbstractionIndex,
  DataModel,
  SeamsIndex,
  SliceExternals,
} from "sandbox-factory";
import { z } from "zod";
import { inputText, type AgentTool, type AgentToolResult } from "./loop.js";
import { REPO_TOOL_LIMITS, invalidInput } from "./repo-tools.js";

/** Accessors and entities an overview lists before it says how many more. */
export const CONTEXT_TOOL_LIMITS = {
  overviewEntities: 80,
  accessors: 15,
  /** Files under a directory `module_seams` lists one by one. */
  seamFiles: 30,
} as const;

const error = (content: string): AgentToolResult => ({
  content,
  isError: true,
});
/** Cut at the read limit, and say so. */
function capped(text: string): string {
  return text.length <= REPO_TOOL_LIMITS.readChars
    ? text
    : `${text.slice(0, REPO_TOOL_LIMITS.readChars)}\n(Cut at ${REPO_TOOL_LIMITS.readChars} characters.)`;
}
const more = (total: number, shown: number) =>
  total > shown ? `\n(${total - shown} more.)` : "";

const pathInput = z.strictObject({ path: z.string().min(1).max(1_000) });
const entityInput = z.strictObject({
  entity: z.string().min(1).max(200).nullable(),
});

/** A module's exports with their signatures, from the abstractions index. */
export function moduleSurfaceTool(index: AbstractionIndex): AgentTool {
  const modules = new Map(index.modules.map((module) => [module.path, module]));
  return {
    name: "module_surface",
    concurrent: true,
    description:
      "Show a repository module's exported surface: each export's kind, signature (bodies elided) and line, and the types it names. Coverage says how it was read: `typed` is the TypeScript compiler's declaration, `syntactic` a signature as written with no type resolved, `names-only` names alone. This is what a stub for the module would declare.",
    inputSchema: {
      properties: {
        path: { type: "string", description: "A repository file path." },
      },
      required: ["path"],
      additionalProperties: false,
    },
    describe: (input, result) => {
      if (result.isError === true) return null;
      const path = inputText(input, "path");
      return path === null ? null : `Read the surface of ${path}`;
    },
    async run(raw) {
      const parsed = pathInput.safeParse(raw);
      if (!parsed.success) return invalidInput(parsed.error.issues);
      const module = modules.get(parsed.data.path);
      if (module === undefined)
        return error(
          `${parsed.data.path} is not a module in the abstractions index; test files and files in no supported language are not.`,
        );
      const lines = [
        `${module.path}: ${module.language}, ${module.coverage}, imported by ${module.importers} ${module.importers === 1 ? "file" : "files"}, ${module.exports.length} exports.`,
      ];
      for (const entry of module.exports)
        lines.push(
          "",
          `${entry.name} (${entry.kind}, L${entry.line}) ${entry.id}`,
          entry.signature ?? "(no signature)",
          ...(entry.references.length === 0
            ? []
            : [`names: ${entry.references.join(", ")}`]),
        );
      return { content: capped(lines.join("\n")) };
    },
  };
}

const seamsInput = z.strictObject({
  paths: z.array(z.string().min(1).max(1_000)).min(1).max(20),
});

/** The services and environment names externals list, on one line. */
function describeSeams(
  externals: SliceExternals,
  unknown: readonly string[],
): string {
  const services = new Map<string, string[]>();
  for (const entry of externals.packages)
    services.set(entry.service, [
      ...(services.get(entry.service) ?? []),
      entry.specifier,
    ]);
  const parts = [
    ...(services.size === 0
      ? []
      : [
          `services ${[...services]
            .map(
              ([service, specifiers]) =>
                `${service} (${specifiers.join(", ")})`,
            )
            .join(", ")}`,
        ]),
    ...(externals.environment.length === 0
      ? []
      : [
          `environment ${externals.environment.map((entry) => entry.name).join(", ")}`,
        ]),
  ];
  const known =
    parts.length === 0
      ? "no services or environment variables"
      : parts.join("; ");
  return unknown.length === 0
    ? known
    : `${known}; not indexed, so only check_scope can tell: ${unknown.join(", ")}`;
}

/**
 * Per module, the services and environment variables the slice would list,
 * from the seams index: a lookup, where `check_scope` slices.
 */
export function moduleSeamsTool(
  index: SeamsIndex,
  files: readonly string[],
): AgentTool {
  const known = new Set(files);
  return {
    name: "module_seams",
    concurrent: true,
    description:
      "Look up, without slicing, the services (SDKs, database and HTTP clients) and environment variables that the given files reach, exactly as `check_scope` would list them for a slice that includes those files. A path may be a directory, for every file under it. Use it to find where the outside world is touched before spending a check.",
    inputSchema: {
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Repository file or directory paths, at most 20.",
        },
      },
      required: ["paths"],
      additionalProperties: false,
    },
    describe: (_input, result) =>
      result.isError === true ? null : "Looked up where the code reaches out",
    async run(raw) {
      const parsed = seamsInput.safeParse(raw);
      if (!parsed.success) return invalidInput(parsed.error.issues);
      const lines: string[] = [];
      const all = new Set<string>();
      for (const path of parsed.data.paths) {
        const trimmed = path.replace(/\/+$/, "");
        if (known.has(trimmed)) {
          all.add(trimmed);
          const found = lookupSeams(index, [trimmed]);
          lines.push(
            `${trimmed}: ${describeSeams(found.externals, found.unknown)}.`,
          );
          continue;
        }
        const prefix = `${trimmed}/`;
        const under = files.filter((file) => file.startsWith(prefix));
        if (under.length === 0) {
          lines.push(`${path} names no file in the structure analysis.`);
          continue;
        }
        for (const file of under) all.add(file);
        const found = lookupSeams(index, under);
        const reaching = [
          ...new Set([
            ...found.externals.packages.flatMap((entry) => entry.files),
            ...found.externals.environment.flatMap((entry) => entry.files),
          ]),
        ].sort();
        const shown = reaching.slice(0, CONTEXT_TOOL_LIMITS.seamFiles);
        lines.push(
          `${prefix} (${under.length} ${under.length === 1 ? "file" : "files"}): ${describeSeams(found.externals, found.unknown)}.`,
          ...shown.map((file) => {
            const one = lookupSeams(index, [file]);
            return `- ${file}: ${describeSeams(one.externals, one.unknown)}`;
          }),
          more(reaching.length, shown.length),
        );
      }
      if (parsed.data.paths.length > 1 && all.size > 0) {
        const found = lookupSeams(index, [...all]);
        lines.push(
          `Together: ${describeSeams(found.externals, found.unknown)}.`,
        );
      }
      return {
        content: capped(lines.filter((line) => line !== "").join("\n")),
      };
    },
  };
}

/** The data model: an overview, or one entity with its relations and accessors. */
export function dataModelTool(model: DataModel): AgentTool {
  const entities = new Map(
    model.entities.map((entity) => [entity.name, entity]),
  );
  const byTable = new Map(
    model.entities.map((entity) => [entity.table.toLowerCase(), entity]),
  );
  const enums = new Map(model.enums.map((value) => [value.name, value]));
  return {
    name: "data_model",
    concurrent: true,
    description:
      "Read the repository's data model, from its schema and migrations. With entity null: the storage, every entity with its table and field count, and the accessor modules that read or write entities, which are where a database seam belongs. With an entity's name or table: its fields (type, nullability, default, keys, enum values), its relations both ways with their delete behaviour, and the modules that touch it.",
    inputSchema: {
      properties: {
        entity: {
          type: ["string", "null"],
          description: "An entity's name or table, or null for the overview.",
        },
      },
      required: ["entity"],
      additionalProperties: false,
    },
    describe: (input, result) => {
      if (result.isError === true) return null;
      const entity = inputText(input, "entity");
      return entity === null
        ? "Read the data model"
        : `Read the data model of ${entity}`;
    },
    async run(raw) {
      const parsed = entityInput.safeParse(raw);
      if (!parsed.success) return invalidInput(parsed.error.issues);
      const name = parsed.data.entity;
      if (name === null) {
        const shown = model.entities.slice(
          0,
          CONTEXT_TOOL_LIMITS.overviewEntities,
        );
        const accessors = model.accessors.slice(
          0,
          CONTEXT_TOOL_LIMITS.accessors,
        );
        return {
          content: capped(
            [
              model.sources.length === 0
                ? "No schema, ORM or migration was found; the repository has no data model this builder can read."
                : `Sources: ${model.sources
                    .map(
                      (source) =>
                        `${source.kind} (${source.storage}, ${source.entities} entities${source.shadowed > 0 ? `, ${source.shadowed} also defined above` : ""})`,
                    )
                    .join("; ")}.`,
              "",
              `Entities (${model.entities.length}):`,
              ...shown.map(
                (entity) =>
                  `${entity.name} → ${entity.table} (${entity.fields.length} fields) ${entity.file}:${entity.line}`,
              ),
              more(model.entities.length, shown.length),
              `Relations: ${model.relations.length}. Enums: ${model.enums.map((value) => value.name).join(", ") || "(none)"}.`,
              "",
              `Accessors, most entities first (${model.accessors.length}):`,
              ...accessors.map(
                (accessor) =>
                  `${accessor.module} (imported by ${accessor.importers}): ${accessor.entities.join(", ")}`,
              ),
              more(model.accessors.length, accessors.length),
            ]
              .filter((line) => line !== "")
              .join("\n"),
          ),
        };
      }
      const entity = entities.get(name) ?? byTable.get(name.toLowerCase());
      if (entity === undefined)
        return error(
          `${name} is not an entity in the data model. Call data_model with null for the list.`,
        );
      const outgoing = model.relations.filter(
        (relation) => relation.from.entity === entity.name,
      );
      const incoming = model.relations.filter(
        (relation) =>
          relation.to.entity === entity.name &&
          relation.from.entity !== entity.name,
      );
      const touching = model.accessors.filter((accessor) =>
        accessor.entities.includes(entity.name),
      );
      const lines = [
        `${entity.name} → ${entity.kind} ${entity.table}, from ${entity.source} at ${entity.file}:${entity.line}.`,
        `Primary key: ${entity.primaryKey.join(", ") || "(none)"}.${
          entity.uniques.length === 0
            ? ""
            : ` Unique together: ${entity.uniques.map((set) => `(${set.join(", ")})`).join(", ")}.`
        }`,
        "",
        "Fields:",
        ...entity.fields.map((field) => {
          const values =
            field.enum === null ? undefined : enums.get(field.enum)?.values;
          return `- ${field.name}${field.column === field.name ? "" : ` (column ${field.column})`}: ${field.type}${field.list ? "[]" : ""} as ${field.nativeType}, ${field.nullable ? "nullable" : "required"}${field.default === null ? "" : `, default ${field.default}`}${field.primaryKey ? ", primary key" : ""}${field.unique ? ", unique" : ""}${values === undefined ? "" : `, one of ${values.join(" | ")}`}`;
        }),
        "",
        "Relations:",
        ...(outgoing.length + incoming.length === 0 ? ["(none)"] : []),
        ...outgoing.map(
          (relation) =>
            `- ${relation.from.fields.join(", ") || "(join table)"} → ${relation.to.entity}.${relation.to.fields.join(", ") || "*"} (${relation.cardinality}${relation.onDelete === null ? "" : `, on delete ${relation.onDelete}`})`,
        ),
        ...incoming.map(
          (relation) =>
            `- ${relation.from.entity}.${relation.from.fields.join(", ") || "*"} → this (${relation.cardinality}${relation.onDelete === null ? "" : `, on delete ${relation.onDelete}`})`,
        ),
        "",
        `Accessors: ${touching.map((accessor) => accessor.module).join(", ") || "(none found)"}`,
      ];
      return { content: capped(lines.join("\n")) };
    },
  };
}

/** A line for the first prompt: where the database seams are. */
export function accessorHint(model: DataModel): string {
  if (model.entities.length === 0)
    return "The data model found no entities; `data_model` has nothing to add.";
  const top = model.accessors.slice(0, CONTEXT_TOOL_LIMITS.accessors);
  return `The data model has ${model.entities.length} entities (${model.sources.map((source) => source.storage).join(", ")}). The modules that read or write them, most entities first, are where a \`database\` seam belongs:\n${
    top
      .map((accessor) => `${accessor.module}: ${accessor.entities.join(", ")}`)
      .join("\n") ||
    "(no accessor was found; read the code that uses the schema)"
  }${more(model.accessors.length, top.length)}`;
}
