/**
 * `GET /api/v1/openapi.json`: the public registry as an OpenAPI 3.1
 * document, its schemas generated from the same zod schemas the routes and
 * clients parse with (`z.toJSONSchema`), so the two cannot drift.
 *
 * Request bodies and query parameters are described as the route reads
 * them (zod's input), responses as they are written (its output). What
 * JSON Schema cannot say, a transform or a date object, is left open
 * rather than guessed. Definitions zod emits for shared or recursive
 * schemas are hoisted into `components.schemas`, so every `$ref` resolves
 * against this document.
 */

import { z } from "zod";

import { PUBLIC_ROUTES, type PublicRoute } from "./registry.js";

type Json = Record<string, unknown>;

const ERROR_SCHEMA_REF = { $ref: "#/components/schemas/Error" };

/** `/orgs/:orgId` as OpenAPI writes it: `/orgs/{orgId}`. */
export function openApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

function pathParameters(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z0-9_]+)/g)].flatMap(([, name]) =>
    name === undefined ? [] : [name],
  );
}

/** `POST /orgs/:orgId/bounties` → `postOrgsOrgIdBounties`. */
export function operationId(route: PublicRoute): string {
  const words = route.path
    .replace(/^\/api\/v1\//, "")
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word !== "");
  return (
    route.method.toLowerCase() +
    words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join("")
  );
}

/**
 * Moves `$defs` into `components` under `prefix` and points the refs at
 * them there.
 */
function hoist(schema: Json, prefix: string, components: Json): Json {
  const { $defs, $schema: _dialect, ...rest } = schema;
  const rename = (name: string) => `${prefix}_${name}`;
  const rewrite = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rewrite);
    if (typeof value !== "object" || value === null) return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) =>
        key === "$ref" &&
        typeof inner === "string" &&
        inner.startsWith("#/$defs/")
          ? [
              key,
              `#/components/schemas/${rename(inner.slice("#/$defs/".length))}`,
            ]
          : [key, rewrite(inner)],
      ),
    );
  };
  if (typeof $defs === "object" && $defs !== null) {
    for (const [name, definition] of Object.entries($defs)) {
      components[rename(name)] = rewrite(definition);
    }
  }
  return rewrite(rest) as Json;
}

function jsonSchema(
  schema: z.ZodType,
  io: "input" | "output",
  prefix: string,
  components: Json,
): Json {
  return hoist(
    z.toJSONSchema(schema, { io, unrepresentable: "any" }) as Json,
    prefix,
    components,
  );
}

function queryParameters(
  route: PublicRoute,
  id: string,
  components: Json,
): Json[] {
  if (route.query === undefined) return [];
  const object = jsonSchema(route.query, "input", `${id}_query`, components);
  const properties = (object["properties"] ?? {}) as Record<string, Json>;
  const required = new Set((object["required"] ?? []) as string[]);
  return Object.entries(properties).map(([name, schema]) => ({
    name,
    in: "query",
    required: required.has(name),
    schema,
  }));
}

function successResponse(
  route: PublicRoute,
  id: string,
  components: Json,
): Json {
  const { response } = route;
  if (response.status === 204) return { description: "Done; no body." };
  if (response.status === 302)
    return {
      description:
        "A browser step: follow `Location` while signed in as the acting person.",
      headers: { Location: { schema: { type: "string", format: "uri" } } },
    };
  return {
    description: "Success.",
    content: {
      "application/json": {
        schema: jsonSchema(
          response.schema,
          "output",
          `${id}_response`,
          components,
        ),
      },
    },
  };
}

function operation(route: PublicRoute, components: Json): Json {
  const id = operationId(route);
  const errors = (description: string) => ({
    description,
    content: { "application/json": { schema: ERROR_SCHEMA_REF } },
  });
  return {
    operationId: id,
    summary: route.summary,
    tags: [route.tag],
    ...(route.scope === null ? {} : { "x-required-scope": route.scope }),
    security: [{ apiToken: route.scope === null ? [] : [route.scope] }],
    parameters: [
      ...pathParameters(route.path).map((name) => ({
        name,
        in: "path",
        required: true,
        schema: { type: "string" },
      })),
      ...queryParameters(route, id, components),
      ...(route.idempotent === true
        ? [
            {
              name: "Idempotency-Key",
              in: "header",
              required: false,
              description:
                "Replays this request's first answer to a retry with the same key for 24 hours; another request under the key is 422 `idempotency_key_reused`.",
              schema: { type: "string", minLength: 1, maxLength: 255 },
            },
          ]
        : []),
    ],
    ...(route.request === null
      ? {}
      : {
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: jsonSchema(
                  route.request,
                  "input",
                  `${id}_request`,
                  components,
                ),
              },
            },
          },
        }),
    responses: {
      [String(route.response.status)]: successResponse(route, id, components),
      // A browser step that also answers JSON to an API client.
      ...(route.response.status === 302 && route.response.schema !== undefined
        ? {
            "200": {
              description:
                "With `Accept: application/json`: the URL, for a person to open while signed in.",
              content: {
                "application/json": {
                  schema: jsonSchema(
                    route.response.schema,
                    "output",
                    `${id}_json`,
                    components,
                  ),
                },
              },
            },
          }
        : {}),
      "400": errors("The request was malformed."),
      "401": errors("No valid credential."),
      "403": errors(
        "The credential lacks the scope, the route is not public, or the acting role may not do this.",
      ),
      "404": errors(
        "No such resource in this workspace, or not this token's workspace.",
      ),
    },
  };
}

/** The document, built from `routes` (the whole registry by default). */
export function buildOpenApiDocument(
  routes: readonly PublicRoute[] = PUBLIC_ROUTES,
  version = "1",
): Json {
  const components: Json = {
    Error: {
      type: "object",
      properties: {
        error: { type: "string" },
        code: { type: "string" },
      },
      required: ["error"],
    },
  };
  const paths: Record<string, Json> = {};
  for (const route of routes) {
    const path = openApiPath(route.path);
    paths[path] = {
      ...paths[path],
      [route.method.toLowerCase()]: operation(route, components),
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Lunox platform API",
      version,
      description:
        "Workspace API tokens (`Authorization: Bearer lnx_…`) reach these routes, each with the scope it names. A token belongs to one workspace: any other workspace's id answers 404. Routes not listed here are refused to tokens.",
    },
    paths,
    components: {
      securitySchemes: {
        apiToken: {
          type: "http",
          scheme: "bearer",
          description:
            "A workspace API token, `lnx_` and 40 characters, made by an owner or admin.",
        },
      },
      schemas: components,
    },
  };
}
