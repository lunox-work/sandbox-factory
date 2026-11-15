import assert from "node:assert/strict";
import { test } from "node:test";

import { createdApiTokenResponseSchema } from "@sandbox-factory/shared";
import { API_SCOPES, isApiScope, isContributorScope } from "sandbox-factory";
import { z } from "zod";

import {
  generateContributorSecret,
  hashSecret,
} from "../src/api-tokens/secret.js";
import { admit, DEVICE_ROUTES } from "../src/credentials.js";
import type { Principal } from "../src/principal.js";
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
  memoryContributorTokens,
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

/** Reads that take a write scope: a passing submission's files, for carry-back. */
const WRITE_SCOPED_READS = new Set([
  "GET /api/v1/orgs/:orgId/sandboxes/submissions/:sid/files",
]);

test("every registry entry declares its scope, request and response schemas", () => {
  const seen = new Set<string>();
  for (const route of PUBLIC_ROUTES) {
    const key = `${route.method} ${route.path}`;
    assert.equal(seen.has(key), false, `${key} is listed twice`);
    seen.add(key);
    assert.match(route.path, /^\/api\/v1\//, key);
    // Only a self route goes without a scope; it names no resource. A
    // contributor route takes the contributor scope, any other an API scope.
    const audience = route.audience ?? "workspace";
    assert.equal(
      route.scope === null
        ? /\/self\//.test(route.path) && audience === "any"
        : audience === "contributor"
          ? isContributorScope(route.scope)
          : audience === "workspace" && isApiScope(route.scope),
      true,
      key,
    );
    // The contributor routes are exactly `/contributions` and the claim.
    assert.equal(
      audience === "contributor",
      /^\/api\/v1\/(contributions(\/|$)|invites\/claim$)/.test(route.path),
      key,
    );
    assert.ok(route.summary.length > 0, key);
    // `null` is a decision (no body); `undefined` is an omission.
    assert.notEqual(route.request, undefined, `${key} has no request schema`);
    if (route.method === "GET" || route.method === "DELETE")
      assert.equal(route.request, null, `${key} cannot take a body`);
    if (route.request !== null)
      assert.ok(
        route.request instanceof z.ZodType ||
          /^application\/zip$/.test(route.request.file),
        `${key} request`,
      );
    const { response } = route;
    if ("file" in response) {
      // A file to save is only ever read.
      assert.equal(route.method, "GET", key);
      assert.match(response.file, /^[a-z]+\/[a-z0-9.+-]+$/, key);
    } else if (response.status !== 204 && response.status !== 302) {
      assert.ok(
        response.schema instanceof z.ZodType,
        `${key} has no response schema`,
      );
    }
    // Reads need only `workspace:read`, but for the one that hands a
    // contributor's work back (`submissions:write`); writes never take it.
    if (
      route.scope !== null &&
      audience === "workspace" &&
      !WRITE_SCOPED_READS.has(key)
    )
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
    const scopes = route.scope === null ? [] : [route.scope];
    assert.deepEqual(
      operation.security,
      route.audience === "any"
        ? [{ apiToken: scopes }, { contributorToken: scopes }]
        : route.audience === "contributor"
          ? [{ contributorToken: scopes }]
          : [{ apiToken: scopes }],
    );
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
  // And the URL as JSON, for a client that asks for it.
  assert.ok((connect?.["responses"] as Record<string, unknown>)["200"]);
  const remove =
    document.paths["/api/v1/orgs/{orgId}/bounties/{id}"]?.["delete"];
  assert.ok((remove?.["responses"] as Record<string, unknown>)["204"]);
  // A file to save is described as bytes of its type, not JSON.
  const archive =
    document.paths["/api/v1/orgs/{orgId}/sandboxes/versions/{vid}/archive"]?.[
      "get"
    ];
  assert.deepEqual(
    (archive?.["responses"] as Record<string, { content: unknown }>)["200"]
      ?.content,
    { "application/zip": { schema: { type: "string", format: "binary" } } },
  );
  // A zipped folder is a binary body, not JSON, and says how to preview.
  const zipped =
    document.paths["/api/v1/contributions/{vid}/submissions/zip"]?.["post"];
  assert.deepEqual(
    (zipped?.["requestBody"] as { content: unknown } | undefined)?.content,
    { "application/zip": { schema: { type: "string", format: "binary" } } },
  );
  assert.ok(
    (zipped?.["parameters"] as Array<{ name: string }>).some(
      ({ name }) => name === "dryRun",
    ),
  );
  assert.equal(zipped?.["x-audience"], "contributor");
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

test("a workspace credential reaches no contributor route, a contributor credential no workspace route", () => {
  const workspace: Principal = {
    user: ada,
    organizationId: ORG,
    scopes: [...API_SCOPES],
    via: "token",
    credentialId: "tok_1",
    role: "owner",
  };
  const contributor: Principal = {
    user: ada,
    organizationId: null,
    scopes: ["contributions:write"],
    via: "contributor",
    credentialId: "ctk_1",
    contributor: true,
  };
  const grant: Principal = {
    ...contributor,
    via: "oauth",
    credentialId: "at_1",
  };
  for (const route of PUBLIC_ROUTES) {
    const key = `${route.method} ${route.path}`;
    const audience = route.audience ?? "workspace";
    const asWorkspace = admit(workspace, route);
    const asContributor = admit(contributor, route);
    if (audience === "contributor")
      assert.equal(asWorkspace?.code, "workspace_credential", key);
    else assert.equal(asWorkspace, undefined, key);
    if (audience === "workspace")
      assert.equal(asContributor?.code, "contributor_credential", key);
    else assert.equal(asContributor, undefined, key);
    assert.deepEqual(admit(grant, route), asContributor, key);
  }
  // Scopes never widen it: a contributor credential holding every API
  // scope still reaches no workspace route.
  const widened = { ...contributor, scopes: [...API_SCOPES] };
  assert.equal(
    admit(widened, { method: "GET", path: "/api/v1/orgs/:orgId" })?.code,
    "contributor_credential",
  );
  // And a contributor credential without its scope reaches nothing of its own.
  assert.equal(
    admit(
      { ...contributor, scopes: [] },
      { method: "GET", path: "/api/v1/contributions" },
    )?.code,
    "insufficient_scope",
  );
});

test("no route outside the registry answers a token, and every entry is a route", async () => {
  const stub = anything();
  const tokens = memoryTokens();
  const contributorTokens = memoryContributorTokens();
  const contributorSecret = generateContributorSecret();
  await contributorTokens.create(ada.id, {
    name: "Editor",
    prefix: contributorSecret.slice(0, 13),
    hash: hashSecret(contributorSecret),
    expiresAt: null,
  });
  const server = createApp({
    corsOrigins: [],
    auth: fakeAuth(),
    organizations: roleStore({ [`${ada.id}:${ORG}`]: "owner" }),
    apiTokens: tokens,
    contributorTokens,
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
    audit: stub as AppOptions["audit"],
    webhooks: stub as AppOptions["webhooks"],
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
    // Nor a contributor token.
    const contributorRes = await server.request(url, {
      method,
      headers: { authorization: `Bearer ${contributorSecret}` },
    });
    assert.equal(contributorRes.status, 403, key);
    refused += 1;
  }
  // Through the whole app: each registry route refuses the other kind.
  for (const route of PUBLIC_ROUTES) {
    const audience = route.audience ?? "workspace";
    if (audience === "any") continue;
    const url = route.path
      .replace(":orgId", ORG)
      .replace(/:[A-Za-z]+(\{[^}]*\})?/g, "x1");
    const other = audience === "workspace" ? contributorSecret : secret;
    const res = await server.request(url, {
      method: route.method,
      headers: { authorization: `Bearer ${other}` },
    });
    assert.equal(res.status, 403, `${route.method} ${route.path}`);
    assert.equal(
      ((await res.json()) as { code: string }).code,
      audience === "workspace"
        ? "contributor_credential"
        : "workspace_credential",
      `${route.method} ${route.path}`,
    );
  }
  // The private surface is most of the API; a handful would mean the
  // modules did not mount.
  assert.ok(refused > 40, `only ${refused} private routes were found`);
});
