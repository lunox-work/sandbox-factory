/**
 * OAuth discovery, served at the API's origin outside `/api` where clients
 * look for it:
 *
 * - `/.well-known/oauth-authorization-server` (RFC 8414), at the root and
 *   with the issuer's path appended (`/api/auth`), from the plugin. No
 *   `openid-configuration`: the server issues no ID tokens.
 * - `/.well-known/oauth-protected-resource` (RFC 9728) for the API, and
 *   `/.well-known/oauth-protected-resource/mcp…` for each MCP endpoint,
 *   naming the authorization server and the scopes to ask for.
 *
 * All sessionless and readable cross-origin without credentials: they
 * describe the server, never anyone's data.
 */

import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
import type { Hono } from "hono";
import { API_SCOPES, OFFLINE_ACCESS_SCOPE } from "sandbox-factory";

import type { Auth } from "../auth.js";
import type { AuthVariables } from "../http-context.js";
import { toolsetScopes } from "../mcp/tools.js";
import { issuerOf, MCP_PATHS, publicOrigin } from "./provider.js";

const WELL_KNOWN_RESOURCE = "/.well-known/oauth-protected-resource";

/** Discovery documents are public; any page may read them, without cookies. */
const PUBLIC_READ = { "Access-Control-Allow-Origin": "*" } as const;

/** Where the protected-resource metadata for `path` (`""` for the API) lives. */
export function resourceMetadataUrl(baseUrl: string, path = ""): string {
  return `${publicOrigin(baseUrl)}${WELL_KNOWN_RESOURCE}${path}`;
}

/** The RFC 9728 document for the API (`path` `""`) or one MCP endpoint. */
export function protectedResource(baseUrl: string, path: string) {
  const mcp = path !== "";
  return {
    resource: `${publicOrigin(baseUrl)}${path}`,
    authorization_servers: [issuerOf(baseUrl)],
    // An MCP client asks for what its endpoint's tools need, and for a
    // refresh token; the person may untick any of them on the consent page.
    scopes_supported: mcp
      ? [...toolsetScopes(path), OFFLINE_ACCESS_SCOPE]
      : [...API_SCOPES, OFFLINE_ACCESS_SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: mcp ? "Lunox MCP" : "Lunox API",
  };
}

export function mountDiscoveryRoutes(
  app: Hono<{ Variables: AuthVariables }>,
  { auth, baseUrl }: { auth: Pick<Auth, "api">; baseUrl: string },
): void {
  const authServer = oauthProviderAuthServerMetadata(auth, {
    headers: PUBLIC_READ,
  });
  const issuerPath = new URL(issuerOf(baseUrl)).pathname;
  for (const path of [
    "/.well-known/oauth-authorization-server",
    `/.well-known/oauth-authorization-server${issuerPath}`,
  ]) {
    app.get(path, (c) => authServer(c.req.raw));
  }
  for (const path of ["", ...MCP_PATHS]) {
    app.get(`${WELL_KNOWN_RESOURCE}${path}`, (c) => {
      for (const [name, value] of Object.entries(PUBLIC_READ))
        c.header(name, value);
      return c.json(protectedResource(baseUrl, path));
    });
  }
}
