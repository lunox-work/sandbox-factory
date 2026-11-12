/**
 * The remote MCP server: `POST /mcp` (every tool), `/mcp/duediligence` and
 * `/mcp/carveout` (toolsets; see `tools.ts`).
 *
 * - **Stateless.** Each POST builds a server and a Streamable HTTP
 *   transport (the SDK's Web-standard one, which takes Hono's `Request`
 *   as is) with no session id and JSON responses, answers, and closes. No
 *   SSE stream outlives a request, so a Fargate Spot restart or the CDN's
 *   read timeout loses nothing. GET and DELETE answer 405.
 * - **The API decides access.** A request must carry a bearer API token
 *   (`lnx_…`) or OAuth access token (`lnxat_…`); without one, or when the
 *   API refuses it (401), the answer is 401 with a `WWW-Authenticate`
 *   naming this endpoint's protected-resource metadata, which is how an
 *   MCP client finds where to sign in. Tools call the API in-process with
 *   the same `Authorization` header, through the same guard as any client.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Context, Hono } from "hono";
import { OFFLINE_ACCESS_SCOPE } from "sandbox-factory";

import { bearerApiToken } from "../api-tokens/secret.js";
import type { AuthVariables } from "../http-context.js";
import { resourceMetadataUrl } from "../oauth/discovery.js";
import { bearerOAuthToken } from "../oauth/provider.js";
import {
  registerTools,
  toolsetScopes,
  TOOLSETS,
  type ApiCall,
} from "./tools.js";

type Env = { Variables: AuthVariables };

export const MCP_INSTRUCTIONS =
  "Lunox turns software work into priced bounties: each bounty is scoped, " +
  "sized and priced, then given a sandbox sliced from the workspace's " +
  "repositories that a contributor can build and be judged in. These tools " +
  "read one workspace's bounties, proposals, repositories, Jira boards, " +
  "sandboxes and runs. Posting work is available: write a bounty or " +
  "import one from a GitHub or Jira issue, size it, change its spec, and " +
  "get the link that connects GitHub or Jira. Approvals happen in the web " +
  "app: approving a price or a slice, publishing a sandbox and confirming " +
  "decisions are a person's act there.";

/** What an MCP client signing in at `path` is told to ask for. */
export function challengeScope(path: string): string {
  return [...toolsetScopes(path), OFFLINE_ACCESS_SCOPE].join(" ");
}

/** Headers an in-process call carries over from the caller's request. */
const FORWARDED = ["authorization", "x-origin-verify"] as const;

export function mountMcpRoutes(
  app: Hono<Env>,
  { baseUrl }: { baseUrl: string },
): void {
  for (const [path, toolset] of Object.entries(TOOLSETS)) {
    const metadata = resourceMetadataUrl(baseUrl, path);
    const scope = challengeScope(path);

    /** RFC 6750 and RFC 9728: where to sign in, and why this failed. */
    const challenge = (c: Context<Env>, invalid: boolean) => {
      c.header(
        "WWW-Authenticate",
        `Bearer resource_metadata="${metadata}", scope="${scope}"` +
          (invalid ? ', error="invalid_token"' : ""),
      );
      return c.json(
        invalid
          ? {
              error: "This credential is not valid. Sign in again.",
              code: "invalid_token",
            }
          : {
              error: "Sign in, or send a workspace API token as a bearer.",
              code: "unauthorized",
            },
        401,
      );
    };

    app.post(path, async (c) => {
      const authorization = c.req.header("authorization");
      if (
        bearerApiToken(authorization) === undefined &&
        bearerOAuthToken(authorization) === undefined
      ) {
        return challenge(c, false);
      }

      const headers = new Headers();
      for (const name of FORWARDED) {
        const value = c.req.header(name);
        if (value !== undefined) headers.set(name, value);
      }
      const call: ApiCall = async (target, init = {}) => {
        const sent = new Headers(headers);
        if (init.accept !== undefined) sent.set("accept", init.accept);
        if (init.body !== undefined)
          sent.set("content-type", "application/json");
        const response = await app.request(target, {
          method: init.method ?? "GET",
          headers: sent,
          ...(init.body === undefined
            ? {}
            : { body: JSON.stringify(init.body) }),
        });
        const body: unknown = await response.json().catch(() => null);
        return { status: response.status, body };
      };

      // The guard's verdict on the credential itself, before any tool runs:
      // a client refreshes or signs in again only on an HTTP 401.
      if ((await call("/api/v1/me")).status === 401) return challenge(c, true);

      const server = new McpServer(
        { name: "lunox", version: "1.0.0" },
        { instructions: MCP_INSTRUCTIONS },
      );
      registerTools(server, toolset, call);
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      try {
        return await transport.handleRequest(c.req.raw);
      } finally {
        await server.close();
      }
    });

    // Stateless: no stream to open with GET, no session to end with DELETE.
    app.on(["GET", "DELETE"], path, (c) => {
      c.header("Allow", "POST");
      return c.json(
        {
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed." },
          id: null,
        },
        405,
      );
    });
  }
}
