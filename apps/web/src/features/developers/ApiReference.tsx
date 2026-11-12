/**
 * The API reference, laid out from `GET /api/v1/openapi.json`: operations
 * grouped by tag, each with its method, path, required scope and summary,
 * and its parameters and request and response schemas folded away until
 * opened.
 *
 * No OpenAPI renderer: the document is generated here from zod with a known,
 * small vocabulary (objects, arrays, unions, enums, `$ref`s into
 * `components.schemas`), and a reader for that is a page of code where a
 * renderer is a dependency. Near a megabyte of schema, so an operation's
 * schemas are rendered only once it is opened, and this module is its own
 * chunk, loaded when the reference is.
 */

import { ChevronRight, ExternalLink, Search } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { LoadingLine, RetryableError } from "@/components/Message";
import { SectionHeader } from "@/components/Page";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import { CopyValue } from "./CodeBlock";
import { failureText, useOpenApiDocument } from "./data";
import { appOrigin } from "./snippets";

type Json = Record<string, unknown>;

const METHODS = ["get", "post", "put", "patch", "delete"] as const;

/** How deep nested fields are drawn before the rest is elided. */
const MAX_DEPTH = 8;

export interface Operation {
  method: (typeof METHODS)[number];
  path: string;
  tag: string;
  summary: string;
  scope: string | null;
  parameters: Json[];
  request: Json | null;
  response: { status: string; description: string; schema: Json | null };
}

export interface OperationGroup {
  name: string;
  operations: Operation[];
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * The group an operation without a tag falls in: the first segment of its
 * path under the workspace (`/orgs/{orgId}/bounties/…` → `bounties`), or
 * under `/api/v1`.
 */
function pathGroup(path: string): string {
  const parts = path.replace(/^\/api\/v1\//, "").split("/");
  const rest =
    parts[0] === "orgs" && parts[1] === "{orgId}" ? parts.slice(2) : parts;
  return rest[0] ?? "other";
}

/** The success response: the lowest 2xx or 3xx status the operation lists. */
function successOf(responses: unknown): Operation["response"] {
  const entries = isObject(responses) ? Object.entries(responses) : [];
  const [status, response] =
    entries
      .filter(([code]) => /^[23]\d\d$/.test(code))
      .sort(([a], [b]) => a.localeCompare(b))[0] ?? [];
  if (status === undefined || !isObject(response)) {
    return { status: "200", description: "", schema: null };
  }
  const content = isObject(response["content"]) ? response["content"] : {};
  const json = content["application/json"];
  return {
    status,
    description: text(response["description"]) ?? "",
    schema: isObject(json) && isObject(json["schema"]) ? json["schema"] : null,
  };
}

/** The document's operations, grouped by tag in the order tags first appear. */
export function groupOperations(document: Json): OperationGroup[] {
  const groups = new Map<string, Operation[]>();
  const paths = isObject(document["paths"]) ? document["paths"] : {};
  for (const [path, item] of Object.entries(paths)) {
    if (!isObject(item)) continue;
    for (const method of METHODS) {
      const operation = item[method];
      if (!isObject(operation)) continue;
      const tags = Array.isArray(operation["tags"]) ? operation["tags"] : [];
      const tag = text(tags[0]) ?? pathGroup(path);
      const body = isObject(operation["requestBody"])
        ? operation["requestBody"]
        : null;
      const content =
        body !== null && isObject(body["content"]) ? body["content"] : {};
      const json = content["application/json"];
      const entry: Operation = {
        method,
        path,
        tag,
        summary: text(operation["summary"]) ?? "",
        scope: text(operation["x-required-scope"]),
        parameters: (Array.isArray(operation["parameters"])
          ? operation["parameters"]
          : []
        ).filter(isObject),
        request:
          isObject(json) && isObject(json["schema"]) ? json["schema"] : null,
        response: successOf(operation["responses"]),
      };
      groups.set(tag, [...(groups.get(tag) ?? []), entry]);
    }
  }
  return [...groups].map(([name, operations]) => ({ name, operations }));
}

/** Follows a `#/components/schemas/…` reference, once; anything else as it is. */
function resolve(schema: Json, document: Json): Json {
  const ref = text(schema["$ref"]);
  if (ref === null || !ref.startsWith("#/components/schemas/")) return schema;
  const components = isObject(document["components"])
    ? document["components"]
    : {};
  const schemas = isObject(components["schemas"]) ? components["schemas"] : {};
  const target = schemas[ref.slice("#/components/schemas/".length)];
  return isObject(target) ? target : {};
}

function variantsOf(schema: Json): Json[] | null {
  const union = schema["anyOf"] ?? schema["oneOf"];
  return Array.isArray(union) ? union.filter(isObject) : null;
}

function isNull(schema: Json): boolean {
  return schema["type"] === "null";
}

/** A schema's type as one short line: `string | null`, `"a" | "b"`, `Run[]`. */
export function typeLabel(schema: Json, document: Json, depth = 0): string {
  if (depth > MAX_DEPTH) return "…";
  const ref = text(schema["$ref"]);
  if (ref !== null) {
    return ref.startsWith("#/components/schemas/")
      ? ref.slice("#/components/schemas/".length)
      : ref;
  }
  if (schema["const"] !== undefined) return JSON.stringify(schema["const"]);
  if (Array.isArray(schema["enum"])) {
    const values = schema["enum"].map((value) => JSON.stringify(value));
    return values.length > 6
      ? `${values.slice(0, 6).join(" | ")} | …`
      : values.join(" | ");
  }
  const variants = variantsOf(schema);
  if (variants !== null) {
    return [
      ...new Set(
        variants.map((entry) => typeLabel(entry, document, depth + 1)),
      ),
    ].join(" | ");
  }
  if (Array.isArray(schema["allOf"])) {
    return schema["allOf"]
      .filter(isObject)
      .map((entry) => typeLabel(entry, document, depth + 1))
      .join(" & ");
  }
  const types = Array.isArray(schema["type"])
    ? schema["type"].filter(
        (entry): entry is string => typeof entry === "string",
      )
    : typeof schema["type"] === "string"
      ? [schema["type"]]
      : [];
  if (types.length === 0)
    return isObject(schema["properties"]) ? "object" : "any";
  return types
    .map((type) => {
      if (type === "array") {
        const items = isObject(schema["items"]) ? schema["items"] : {};
        const inner = typeLabel(items, document, depth + 1);
        return inner.includes(" ") ? `(${inner})[]` : `${inner}[]`;
      }
      if (
        type === "object" &&
        !isObject(schema["properties"]) &&
        isObject(schema["additionalProperties"])
      ) {
        return `record<${typeLabel(schema["additionalProperties"], document, depth + 1)}>`;
      }
      const format = text(schema["format"]);
      return format === null ? type : `${type} (${format})`;
    })
    .join(" | ");
}

interface Field {
  name: string;
  required: boolean;
  schema: Json;
}

/**
 * What a schema has inside to draw: its fields (an object's, an array's
 * items', a nullable object's), or the variants of a union of objects.
 */
function expand(
  schema: Json,
  document: Json,
  depth = 0,
): { fields: Field[] } | { variants: Json[] } | null {
  if (depth > MAX_DEPTH) return null;
  const resolved = resolve(schema, document);
  const properties = resolved["properties"];
  if (isObject(properties)) {
    const required = new Set(
      Array.isArray(resolved["required"]) ? resolved["required"] : [],
    );
    return {
      fields: Object.entries(properties)
        .filter((entry): entry is [string, Json] => isObject(entry[1]))
        .map(([name, field]) => ({
          name,
          required: required.has(name),
          schema: field,
        })),
    };
  }
  if (isObject(resolved["items"])) {
    return expand(resolved["items"], document, depth + 1);
  }
  const variants = variantsOf(resolved);
  if (variants !== null) {
    const real = variants.filter((entry) => !isNull(entry));
    if (real.length === 1 && real[0] !== undefined) {
      return expand(real[0], document, depth + 1);
    }
    return real.some((entry) => expand(entry, document, depth + 1) !== null)
      ? { variants: real }
      : null;
  }
  if (Array.isArray(resolved["allOf"])) {
    const fields = resolved["allOf"].filter(isObject).flatMap((entry) => {
      const inner = expand(entry, document, depth + 1);
      return inner !== null && "fields" in inner ? inner.fields : [];
    });
    return fields.length > 0 ? { fields } : null;
  }
  if (isObject(resolved["additionalProperties"])) {
    return expand(resolved["additionalProperties"], document, depth + 1);
  }
  return null;
}

function SchemaTree({
  schema,
  document,
  depth = 0,
}: {
  schema: Json;
  document: Json;
  depth?: number;
}) {
  const inside = expand(schema, document);
  if (inside === null) return null;
  if (depth >= MAX_DEPTH) {
    return <p className="text-muted-foreground pl-3 text-xs">…</p>;
  }
  if ("variants" in inside) {
    return (
      <ol className="flex flex-col gap-2 border-l pl-3">
        {inside.variants.map((variant, index) => (
          <li key={index} className="flex min-w-0 flex-col gap-1">
            <p className="text-muted-foreground text-xs">
              One of ({index + 1}/{inside.variants.length}):{" "}
              <span className="font-mono">{typeLabel(variant, document)}</span>
            </p>
            <SchemaTree
              schema={variant}
              document={document}
              depth={depth + 1}
            />
          </li>
        ))}
      </ol>
    );
  }
  return (
    <ul className="flex flex-col gap-1.5 border-l pl-3">
      {inside.fields.map((field) => {
        const description = text(field.schema["description"]);
        return (
          <li key={field.name} className="flex min-w-0 flex-col gap-1">
            <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-xs">
              <code className="text-foreground font-mono font-medium">
                {field.name}
              </code>
              <span className="text-muted-foreground font-mono break-all">
                {typeLabel(field.schema, document)}
              </span>
              {!field.required && (
                <span className="text-muted-foreground/80">optional</span>
              )}
            </p>
            {description !== null && (
              <p className="text-muted-foreground text-xs text-pretty">
                {description}
              </p>
            )}
            <SchemaTree
              schema={field.schema}
              document={document}
              depth={depth + 1}
            />
          </li>
        );
      })}
    </ul>
  );
}

function SchemaBlock({
  title,
  schema,
  document,
}: {
  title: ReactNode;
  schema: Json;
  document: Json;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="eyebrow">{title}</p>
      <p className="font-mono text-xs break-all">
        {typeLabel(schema, document)}
      </p>
      <SchemaTree schema={schema} document={document} />
    </div>
  );
}

const METHOD_TONE: Record<Operation["method"], string> = {
  get: "text-foreground",
  post: "text-foreground",
  put: "text-foreground",
  patch: "text-foreground",
  delete: "text-destructive",
};

function OperationItem({
  operation,
  document,
}: {
  operation: Operation;
  document: Json;
}) {
  // Rendered once opened, and kept: closing again need not rebuild it.
  const [opened, setOpened] = useState(false);
  const parameters = operation.parameters.filter(
    (parameter) => text(parameter["in"]) !== null,
  );
  return (
    <li>
      <details
        className="group"
        onToggle={(event) => {
          if (event.currentTarget.open) setOpened(true);
        }}
      >
        <summary className="hover:bg-accent/50 flex cursor-pointer list-none items-start gap-3 px-4 py-2.5 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
          <ChevronRight
            aria-hidden="true"
            className="text-muted-foreground mt-0.5 size-3.5 shrink-0 transition-transform group-open:rotate-90"
          />
          <span
            className={cn(
              "w-12 shrink-0 font-mono text-xs font-semibold uppercase",
              METHOD_TONE[operation.method],
            )}
          >
            {operation.method}
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <code className="font-mono text-xs break-all">
              {operation.path.replace(/^\/api\/v1/, "")}
            </code>
            <span className="text-muted-foreground text-xs">
              {withCode(operation.summary)}
            </span>
          </span>
          {operation.scope !== null && (
            <span className="bg-muted hidden shrink-0 rounded-sm px-1.5 font-mono text-2xs leading-5 sm:inline">
              {operation.scope}
            </span>
          )}
        </summary>
        {opened && (
          // Indented to the path column: 16px padding, a 14px chevron, a
          // 48px method and two 12px gaps.
          <div className="flex flex-col gap-5 border-t px-4 py-4 sm:pl-[6.375rem]">
            <p className="text-xs">
              <span className="text-muted-foreground">Scope </span>
              <code className="font-mono">{operation.scope ?? "none"}</code>
              <span className="text-muted-foreground"> · </span>
              <code className="font-mono break-all">
                {operation.method.toUpperCase()} {operation.path}
              </code>
            </p>
            {parameters.length > 0 && (
              <div className="flex flex-col gap-2">
                <p className="eyebrow">Parameters</p>
                <ul className="flex flex-col gap-1.5 border-l pl-3">
                  {parameters.map((parameter) => (
                    <li
                      key={`${String(parameter["in"])}:${String(parameter["name"])}`}
                      className="flex flex-wrap items-baseline gap-x-2 text-xs"
                    >
                      <code className="font-mono font-medium">
                        {String(parameter["name"])}
                      </code>
                      <span className="text-muted-foreground font-mono">
                        {isObject(parameter["schema"])
                          ? typeLabel(parameter["schema"], document)
                          : "any"}
                      </span>
                      <span className="text-muted-foreground/80">
                        {String(parameter["in"])}
                        {parameter["required"] === true ? "" : ", optional"}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {operation.request !== null && (
              <SchemaBlock
                title="Request body"
                schema={operation.request}
                document={document}
              />
            )}
            {operation.response.schema !== null ? (
              <SchemaBlock
                title={`Response ${operation.response.status}`}
                schema={operation.response.schema}
                document={document}
              />
            ) : (
              <div className="flex flex-col gap-1">
                <p className="eyebrow">Response {operation.response.status}</p>
                <p className="text-muted-foreground text-xs">
                  {operation.response.description}
                </p>
              </div>
            )}
            <p className="text-muted-foreground text-xs">
              Errors answer <code className="font-mono">400</code>,{" "}
              <code className="font-mono">401</code>,{" "}
              <code className="font-mono">403</code> or{" "}
              <code className="font-mono">404</code> with{" "}
              <code className="font-mono">{"{ error, code }"}</code>.
            </p>
          </div>
        )}
      </details>
    </li>
  );
}

/** Markdown's inline code, the one markup the document's prose uses. */
function withCode(prose: string): ReactNode {
  return prose.split("`").map((part, index) =>
    index % 2 === 1 ? (
      <code key={index} className="font-mono text-xs">
        {part}
      </code>
    ) : (
      part
    ),
  );
}

/** The reference, given the document; split from the read for the tests. */
export function ApiReferenceView({ document }: { document: Json }) {
  const [filter, setFilter] = useState("");
  const groups = useMemo(() => groupOperations(document), [document]);
  const needle = filter.trim().toLowerCase();
  const shown = groups
    .map((group) => ({
      ...group,
      operations: group.operations.filter(
        (operation) =>
          needle === "" ||
          [
            operation.method,
            operation.path,
            operation.summary,
            operation.scope ?? "",
          ]
            .join(" ")
            .toLowerCase()
            .includes(needle),
      ),
    }))
    .filter((group) => group.operations.length > 0);
  const info = isObject(document["info"]) ? document["info"] : {};
  const origin = appOrigin();

  return (
    <div className="flex min-w-0 flex-col gap-8">
      <section
        aria-labelledby="developers-reference"
        className="flex min-w-0 flex-col gap-4"
      >
        <SectionHeader
          id="developers-reference"
          title="API reference"
          description={withCode(
            text(info["description"]) ??
              "Every route a workspace token can reach, with the scope it needs.",
          )}
          actions={
            <a
              href="/api/v1/openapi.json"
              target="_blank"
              rel="noreferrer"
              className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs"
            >
              openapi.json
              <ExternalLink aria-hidden="true" className="size-3" />
            </a>
          }
        />
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-1">
            <p className="eyebrow">Base URL</p>
            <CopyValue value={`${origin}/api/v1`} label="Copy base URL" />
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <p className="eyebrow">Authentication</p>
            <CopyValue
              value="Authorization: Bearer lnx_…"
              label="Copy authorization header"
            />
          </div>
        </div>
        <label className="relative block max-w-sm">
          <span className="sr-only">Filter operations</span>
          <Search
            aria-hidden="true"
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2"
          />
          <Input
            type="search"
            value={filter}
            placeholder="Filter by path, summary or scope"
            className="pl-8"
            onChange={(event) => setFilter(event.target.value)}
          />
        </label>
      </section>

      {shown.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No operation matches “{filter.trim()}”.
        </p>
      ) : (
        shown.map((group) => (
          <section
            key={group.name}
            aria-label={group.name}
            className="flex min-w-0 flex-col gap-2"
          >
            <h3 className="text-subheading flex items-baseline gap-2">
              {group.name}
              <span className="text-muted-foreground text-xs font-normal">
                {group.operations.length}
              </span>
            </h3>
            <ul className="divide-y rounded-lg border">
              {group.operations.map((operation) => (
                <OperationItem
                  key={`${operation.method} ${operation.path}`}
                  operation={operation}
                  document={document}
                />
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}

export function ApiReference() {
  const document = useOpenApiDocument();
  if (document.isPending)
    return <LoadingLine>Loading the reference…</LoadingLine>;
  if (document.isError) {
    return (
      <RetryableError onRetry={() => void document.refetch()}>
        {failureText(document.error, "Could not load the API reference.")}
      </RetryableError>
    );
  }
  return <ApiReferenceView document={document.data} />;
}
