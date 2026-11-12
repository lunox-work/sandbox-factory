import assert from "node:assert/strict";
import { test } from "node:test";

import { createdApiTokenResponseSchema } from "@sandbox-factory/shared";
import { API_SCOPES, isApiScope } from "sandbox-factory";
import { z } from "zod";

import { admit, DEVICE_ROUTES } from "../src/credentials.js";
import {
  buildOpenApiDocument,
  openApiPath,
  operationId,
} from "../src/public-api/openapi.js";
import { PUBLIC_ROUTES, publicRoute } from "../src/public-api/registry.js";
import { createApp, type AppOptions } from "../src/routes.js";
import {
  ada,
  fakeAuth,
  memoryTokens,
  ORG,
  roleStore,
  signedIn,
} from "./token-fakes.js";

/**
 * The public registry is the only door a token has, so these pin it: each
 * entry is complete, the document built from it is valid and whole, and no
 * route outside it answers a token.
 */

test("every registry entry declares its scope, request and response schemas", () => {
  const seen = new Set<string>();
  for (const route of PUBLIC_ROUTES) {
    const key = `${route.method} ${route.path}`;
    assert.equal(seen.has(key), false, `${key} is listed twice`);
    seen.add(key);
    assert.match(route.path, /^\/api\/v1\//, key);
    // Only a self route goes without a scope; it names no resource.
    assert.equal(
      route.scope === null
        ? /\/self\//.test(route.path)
        : isApiScope(route.scope),
      true,
      key,
    );
    assert.ok(route.summary.length > 0, key);
    // `null` is a decision (no body); `undefined` is an omission.
    assert.notEqual(route.request, undefined, `${key} has no request schema`);
    if (route.method === "GET" || route.method === "DELETE")
      assert.equal(route.request, null, `${key} cannot take a body`);
    if (route.request !== null)
      assert.ok(route.request instanceof z.ZodType, `${key} request`);
    const { response } = route;
    if (response.status !== 204 && response.status !== 302) {
      assert.ok(
        response.schema instanceof z.ZodType,
        `${key} has no response schema`,
      );
    }
    // Reads need only `workspace:read`; writes never take it.
    if (route.scope !== null)
      assert.equal(
        route.scope === "workspace:read",
        route.method === "GET" && response.status !== 302,
        `${key} has the wrong kind of scope`,
      );
    assert.equal(publicRoute(route.method, route.path), route);
  }
  assert.equal(publicRoute("GET", "/api/v1/orgs/:orgId/tokens"), undefined);
});

test("no public route manages credentials or is a person's act", () => {
  for (const route of PUBLIC_ROUTES) {
    // A credential may end itself, and manage nothing else.
    if (route.path === "/api/v1/tokens/self/revoke") continue;
    assert.doesNotMatch(route.path, /\/tokens|\/oauth/, route.path);
    assert.doesNotMatch(
      route.path,
      /\/proposals\/:id\/(approve|unapprove)$|\/publish$|\/unpublish$|\/slice\/approve$|\/writebacks\/:id\/cancel$/,
      route.path,
    );
  }
});

test("the device routes are exactly who-am-I, where, and mint", () => {
  assert.deepEqual([...DEVICE_ROUTES].sort(), [
    "GET /api/v1/me",
    "GET /api/v1/me/orgs",
    "POST /api/v1/orgs/:orgId/tokens/cli",
  ]);
  const device = {
    user: ada,
    organizationId: null,
    scopes: [],
    via: "device" as const,
    credentialId: "session_1",
    client: "carveout",
  };
  assert.equal(admit(device, { method: "GET", path: "/api/v1/me" }), undefined);
  assert.equal(admit(device, undefined)?.code, "device_session");
});

test("GET /api/v1/openapi.json is served without a credential, valid and whole", async () => {
  const server = createApp({ corsOrigins: [], auth: fakeAuth() });
  const res = await server.request("/api/v1/openapi.json");
  assert.equal(res.status, 200);
  const document = JSON.parse(await res.text()) as {
    openapi: string;
    paths: Record<
      string,
      Record<string, { operationId: string; security: unknown }>
    >;
    components: { schemas: Record<string, unknown> };
  };
  assert.equal(document.openapi, "3.1.0");
  const operations = new Set<string>();
  for (const route of PUBLIC_ROUTES) {
    const operation =
      document.paths[openApiPath(route.path)]?.[route.method.toLowerCase()];
    assert.ok(operation, `${route.method} ${route.path} is missing`);
    assert.deepEqual(operation.security, [
      { apiToken: route.scope === null ? [] : [route.scope] },
    ]);
    assert.equal(
      operations.has(operation.operationId),
      false,
      operation.operationId,
    );
    operations.add(operation.operationId);
  }
  assert.equal(operations.size, PUBLIC_ROUTES.length);
  // Nothing but the registry is described.
  const described = Object.values(document.paths).reduce(
    (count, methods) => count + Object.keys(methods).length,
    0,
  );
  assert.equal(described, PUBLIC_ROUTES.length);
  // Every reference resolves inside the document.
  const refs = [...JSON.stringify(document).matchAll(/"\$ref":"([^"]+)"/g)].map(
    ([, ref]) => ref ?? "",
  );
  assert.ok(refs.length > 0);
  for (const ref of refs) {
    assert.match(ref, /^#\/components\/schemas\//, ref);
    assert.ok(
      ref.slice("#/components/schemas/".length) in document.components.schemas,
      `${ref} does not resolve`,
    );
  }
  // Served again from the same build.
  assert.deepEqual(
    await (await server.request("/api/v1/openapi.json")).json(),
    document,
  );
});

test("the document describes bodies, queries, redirects and removals", () => {
  const document = buildOpenApiDocument() as {
    paths: Record<string, Record<string, Record<string, unknown>>>;
  };
  const post = document.paths["/api/v1/orgs/{orgId}/bounties"]?.["post"];
  assert.ok(post?.["requestBody"]);
  assert.ok((post?.["responses"] as Record<string, unknown>)["201"]);
  const tree =
    document.paths["/api/v1/orgs/{orgId}/github/snapshots/{id}/tree"]?.["get"];
  const names = (
    tree?.["parameters"] as Array<{ name: string; in: string }>
  ).map(({ name, in: where }) => `${where}:${name}`);
  assert.deepEqual(names, [
    "path:orgId",
    "path:id",
    "query:prefix",
    "query:cursor",
    "query:limit",
  ]);
  const connect =
    document.paths["/api/v1/orgs/{orgId}/github/connect"]?.["get"];
  assert.ok((connect?.["responses"] as Record<string, unknown>)["302"]);
  const remove =
    document.paths["/api/v1/orgs/{orgId}/bounties/{id}"]?.["delete"];
  assert.ok((remove?.["responses"] as Record<string, unknown>)["204"]);
  assert.equal(
    operationId({
      method: "GET",
      path: "/api/v1/orgs/:orgId/jira/boards/:id/backlog-preview",
    } as (typeof PUBLIC_ROUTES)[number]),
    "getOrgsOrgIdJiraBoardsIdBacklogPreview",
  );
});

test("a recursive schema's definitions are hoisted into components", () => {
  interface Node {
    children: Node[];
  }
  const node: z.ZodType<Node> = z.lazy(() =>
    z.object({ children: z.array(node) }),
  );
  const document = buildOpenApiDocument([
    {
      method: "GET",
      path: "/api/v1/tree",
      scope: "workspace:read",
      summary: "A tree",
      tag: "Workspace",
      request: null,
      response: { status: 200, schema: z.object({ root: node }) },
    },
  ]) as { components: { schemas: Record<string, unknown> } };
  const text = JSON.stringify(document);
  assert.doesNotMatch(text, /#\/\$defs\//);
  assert.ok(
    Object.keys(document.components.schemas).some((name) =>
      name.startsWith("getTree_response_"),
    ),
  );
});

/**
 * Every collaborator as one object that answers anything: enough to mount
 * every route module, so the routes can be listed. No handler runs here
 * with it; the guard refuses first. Configuration a module reads while
 * mounting (addresses, names, secrets) comes back as a URL string.
 */
const STRING_OPTIONS = new Set([
  "apiUrl",
  "appUrl",
  "appSlug",
  "clientId",
  "clientSecret",
  "secret",
  "webhookSecret",
]);

function anything(): unknown {
  const target = function () {
    return undefined;
  };
  const proxy: unknown = new Proxy(target, {
    get: (_target, key) =>
      key === "then"
        ? undefined
        : typeof key === "string" && STRING_OPTIONS.has(key)
          ? "http://stub.test"
          : proxy,
    apply: () => proxy,
  });
  return proxy;
}

/** Spread options: a plain object, since spreading a proxy copies nothing. */
function spreadable(...keys: string[]): unknown {
  const stub = anything();
  return Object.fromEntries(
    keys.map((key) => [
      key,
      STRING_OPTIONS.has(key) ? "http://stub.test" : stub,
    ]),
  );
}

test("no route outside the registry answers a token, and every entry is a route", async () => {
  const stub = anything();
  const tokens = memoryTokens();
  const server = createApp({
    corsOrigins: [],
    auth: fakeAuth(),
    organizations: roleStore({ [`${ada.id}:${ORG}`]: "owner" }),
    apiTokens: tokens,
    emails: stub as AppOptions["emails"],
    profiles: stub as AppOptions["profiles"],
    jira: spreadable(
      ...["connections", "boards", "proposals", "fetch"],
      ...["clientId", "clientSecret", "secret", "apiUrl", "appUrl"],
    ) as AppOptions["jira"],
    github: spreadable(
      ...["connections", "grants", "repos", "installations", "snapshots"],
      ...["appSlug", "clientId", "clientSecret", "secret", "apiUrl", "appUrl"],
      ...["webhookSecret", "background", "onBackgroundError", "log"],
    ) as AppOptions["github"],
    pricing: spreadable(
      ...["rateCards", "runs", "boards", "proposals", "specs", "issues"],
      ...["bounties", "contexts", "repos", "profiles", "connections"],
      ...["writebacks", "delivery", "executor", "clientFor", "appUrl"],
      ...["organizationSlug", "githubContext", "onApproved"],
    ) as AppOptions["pricing"],
    analysis: stub as AppOptions["analysis"],
    sandbox: stub as AppOptions["sandbox"],
    settings: stub as AppOptions["settings"],
    avatars: stub as AppOptions["avatars"],
    events: stub as AppOptions["events"],
    flows: stub as AppOptions["flows"],
    usage: stub as AppOptions["usage"],
  });
  const minted = await server.request(`/api/v1/orgs/${ORG}/tokens`, {
    method: "POST",
    headers: { ...signedIn, "content-type": "application/json" },
    body: JSON.stringify({ name: "everything", scopes: [...API_SCOPES] }),
  });
  const { secret } = createdApiTokenResponseSchema.parse(await minted.json());

  const routes = new Set(
    server.routes
      .filter(
        ({ method, path }) =>
          method !== "ALL" &&
          path.startsWith("/api/v1/") &&
          path !== "/api/v1/openapi.json",
      )
      .map(({ method, path }) => `${method} ${path}`),
  );
  for (const route of PUBLIC_ROUTES) {
    assert.ok(
      routes.has(`${route.method} ${route.path}`),
      `${route.method} ${route.path} is not a mounted route`,
    );
  }

  let refused = 0;
  for (const key of routes) {
    const [method = "", path = ""] = key.split(" ");
    if (publicRoute(method, path) !== undefined) continue;
    const url = path
      .replace(":orgId", ORG)
      .replace(/:[A-Za-z]+(\{[^}]*\})?/g, "x1");
    const res = await server.request(url, {
      method,
      headers: { authorization: `Bearer ${secret}` },
    });
    assert.equal(res.status, 403, key);
    assert.equal(
      ((await res.json()) as { code: string }).code,
      "not_public",
      key,
    );
    refused += 1;
  }
  // The private surface is most of the API; a handful would mean the
  // modules did not mount.
  assert.ok(refused > 40, `only ${refused} private routes were found`);
});
