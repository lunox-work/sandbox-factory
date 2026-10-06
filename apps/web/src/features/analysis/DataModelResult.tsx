/**
 * What a Data model run found: the storage and the sources it was read
 * from, every entity with its fields, the relations, the enums, and the
 * accessor modules that read or write entities, which are where a
 * `database` seam belongs. Drawn from the bounded summary on the
 * `manifest` and `data_model` artifacts; the model and its Mermaid ERD
 * open through signed URLs. The diagram itself is not drawn here yet; the
 * entity list stands in for it.
 */

import { Braces, Network } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ArtifactDto, DataModelSummaryDto } from "@sandbox-factory/shared";

import { PathChip, StatTiles, SubHeading, TruncatedNote } from "./Blocks";
import { artifactOfKind } from "./artifacts";

/** What each source is called on the page. */
export const sourceLabels: Record<
  DataModelSummaryDto["sources"][number]["kind"],
  string
> = {
  prisma: "Prisma schema",
  drizzle: "Drizzle tables",
  sql_migrations: "SQL migrations",
};

type Entity = DataModelSummaryDto["entities"][number];
type Field = Entity["fields"][number];

/** A field's keys and nullability, as short marks. */
function marks(field: Field): string[] {
  return [
    ...(field.primaryKey ? ["PK"] : []),
    ...(field.foreignKey ? ["FK"] : []),
    ...(field.unique && !field.primaryKey ? ["unique"] : []),
    ...(field.nullable ? ["nullable"] : []),
  ];
}

export function DataModelResult({
  summary,
  artifacts,
  onOpen,
}: {
  summary: DataModelSummaryDto;
  artifacts: readonly ArtifactDto[];
  onOpen: (artifactId: string) => void;
}) {
  const document = artifactOfKind(artifacts, "data_model");
  const erd = artifactOfKind(artifacts, "erd_mermaid");
  return (
    <div className="flex flex-col gap-4">
      <StatTiles
        stats={[
          { label: "Entities", value: summary.counts.entities },
          { label: "Fields", value: summary.counts.fields },
          { label: "Relations", value: summary.counts.relations },
          { label: "Enums", value: summary.counts.enums },
          { label: "Accessors", value: summary.counts.accessors },
          { label: "Omissions", value: summary.counts.omissions },
        ]}
      />
      {summary.sources.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No schema, ORM or migration directory was found in this snapshot.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <SubHeading>Sources</SubHeading>
          <ul aria-label="Sources" className="flex flex-col gap-1 text-sm">
            {summary.sources.map((source) => (
              <li
                key={source.kind}
                className="flex flex-wrap items-baseline gap-x-2"
              >
                <span className="font-medium">{sourceLabels[source.kind]}</span>
                <span className="text-muted-foreground">
                  {source.storage} · {source.entities}{" "}
                  {source.entities === 1 ? "entity" : "entities"}
                  {source.shadowed > 0
                    ? ` · ${source.shadowed} also declared above`
                    : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {summary.entities.length > 0 && (
        <div className="flex flex-col gap-2">
          <SubHeading>Entities</SubHeading>
          <ul aria-label="Entities" className="flex flex-col gap-1.5">
            {summary.entities.map((entity) => (
              <li key={entity.name}>
                <details className="group rounded-[6px] border">
                  <summary className="hover:bg-muted/40 flex cursor-pointer flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-3 py-2 text-sm">
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className="font-medium">{entity.name}</span>
                      {entity.table !== entity.name && (
                        <span className="text-muted-foreground font-mono text-xs">
                          {entity.table}
                        </span>
                      )}
                      {entity.kind === "view" && (
                        <Badge variant="outline" className="rounded-[4px]">
                          View
                        </Badge>
                      )}
                    </span>
                    <span className="text-muted-foreground text-xs">
                      {entity.fieldCount}{" "}
                      {entity.fieldCount === 1 ? "field" : "fields"} ·{" "}
                      <span className="font-mono">
                        {entity.file}:{entity.line}
                      </span>
                    </span>
                  </summary>
                  <table className="w-full border-t text-xs">
                    <thead className="text-muted-foreground text-left">
                      <tr>
                        <th className="px-3 py-1.5 font-medium">Field</th>
                        <th className="px-3 py-1.5 font-medium">Type</th>
                        <th className="px-3 py-1.5 font-medium">Keys</th>
                      </tr>
                    </thead>
                    <tbody>
                      {entity.fields.map((field) => (
                        <tr key={field.name} className="border-t">
                          <td className="px-3 py-1.5 font-mono">
                            {field.name}
                          </td>
                          <td className="px-3 py-1.5">
                            {field.type === "enum" && field.enum !== null
                              ? field.enum
                              : field.type}
                            {field.list ? "[]" : ""}{" "}
                            <span className="text-muted-foreground font-mono">
                              {field.nativeType}
                            </span>
                          </td>
                          <td className="text-muted-foreground px-3 py-1.5">
                            {marks(field).join(" · ")}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {entity.fieldCount > entity.fields.length && (
                    <p className="text-muted-foreground border-t px-3 py-1.5 text-xs">
                      {entity.fieldCount - entity.fields.length === 1
                        ? "1 more field is"
                        : `${entity.fieldCount - entity.fields.length} more fields are`}{" "}
                      in the data model JSON.
                    </p>
                  )}
                </details>
              </li>
            ))}
          </ul>
        </div>
      )}
      {summary.relations.length > 0 && (
        <div className="flex flex-col gap-2">
          <SubHeading>Relations</SubHeading>
          <ul aria-label="Relations" className="flex flex-col gap-1 text-xs">
            {summary.relations.map((relation, position) => (
              <li key={position} className="font-mono break-all">
                {relation.from}
                {relation.fromFields.length > 0
                  ? `.${relation.fromFields.join(", ")}`
                  : ""}{" "}
                → {relation.to}
                {relation.toFields.length > 0
                  ? `.${relation.toFields.join(", ")}`
                  : ""}{" "}
                <span className="text-muted-foreground font-sans">
                  {relation.cardinality}
                  {relation.onDelete === null
                    ? ""
                    : ` · on delete ${relation.onDelete}`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {summary.enums.length > 0 && (
        <div className="flex flex-col gap-2">
          <SubHeading>Enums</SubHeading>
          <ul aria-label="Enums" className="flex flex-col gap-1 text-xs">
            {summary.enums.map((value) => (
              <li key={value.name}>
                <span className="font-medium">{value.name}</span>{" "}
                <span className="text-muted-foreground font-mono">
                  {value.values.join(" | ")}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {summary.accessors.length > 0 && (
        <div className="flex flex-col gap-2">
          <SubHeading>Accessors</SubHeading>
          <p className="text-muted-foreground text-xs">
            The modules that read or write entities, most entities first: where
            a database seam belongs.
          </p>
          <ul aria-label="Accessors" className="flex flex-col gap-2">
            {summary.accessors.map((accessor) => (
              <li key={accessor.module} className="flex flex-col gap-1">
                <span className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs">
                  <span className="font-mono break-all">{accessor.module}</span>
                  <span className="text-muted-foreground">
                    imported by {accessor.importers}
                  </span>
                </span>
                <ul className="flex flex-wrap gap-1.5">
                  {accessor.entities.map((name) => (
                    <PathChip key={name}>{name}</PathChip>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      )}
      {summary.omissions.length > 0 && (
        <div className="flex flex-col gap-2">
          <SubHeading>Omissions</SubHeading>
          <ul aria-label="Omissions" className="flex flex-col gap-1 text-xs">
            {summary.omissions.map((omission, position) => (
              <li key={position} className="break-words">
                <span className="font-mono">
                  {omission.file ?? "(repository)"}
                </span>{" "}
                <span className="text-muted-foreground">{omission.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {summary.truncated && <TruncatedNote whole="the data model JSON" />}
      {(document !== undefined || erd !== undefined) && (
        <div className="flex flex-wrap gap-2">
          {document !== undefined && (
            <Button size="sm" onClick={() => onOpen(document.id)}>
              <Braces />
              Open data model JSON
            </Button>
          )}
          {erd !== undefined && (
            <Button variant="outline" size="sm" onClick={() => onOpen(erd.id)}>
              <Network />
              Open ERD (Mermaid)
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
