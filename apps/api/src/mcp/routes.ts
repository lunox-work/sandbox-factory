/**
 * The remote MCP server: `POST /mcp` (every workspace tool),
 * `/mcp/duediligence` and `/mcp/carveout` (toolsets), and `/mcp/contribute`
 * (an invited contributor's own tools); see `tools.ts`.
 *
 * - **Stateless.** Each POST builds a server and a Streamable HTTP
 *   transport (the SDK's Web-standard one, which takes Hono's `Request`
 *   as is) with no session id and JSON responses, answers, and closes. No
 *   SSE stream outlives a request, so a Fargate Spot restart or the CDN's
 *   read timeout loses nothing. GET and DELETE answer 405.
 * - **The API decides access.** A request must carry a bearer API token
 *   (`lnx_…`), contributor token (`lnxc_…`) or OAuth access token
 *   (`lnxat_…`); without one, or when the API refuses it (401), the answer
 *   is 401 with a `WWW-Authenticate` naming this endpoint's
 *   protected-resource metadata and scopes, which is how an MCP client
 *   finds where to sign in (as a contributor at `/mcp/contribute`). Tools
 *   call the API in-process with the same `Authorization` header, through
 *   the same guard as any client: a workspace credential's call to a
 *   contributor tool's route is refused there (`workspace_credential`), and
 *   the other way round (`contributor_credential`).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Context, Hono } from "hono";
import { OFFLINE_ACCESS_SCOPE } from "sandbox-factory";

import {
  bearerApiToken,
  bearerContributorToken,
} from "../api-tokens/secret.js";
import type { AuthVariables } from "../http-context.js";
import { resourceMetadataUrl } from "../oauth/discovery.js";
import { bearerOAuthToken } from "../oauth/provider.js";
import {
  registerTools,
  toolsetAudience,
  toolsetScopes,
  TOOLSETS,
  type ApiCall,
} from "./tools.js";

type Env = { Variables: AuthVariables };

export const MCP_INSTRUCTIONS =
  "Lunox turns software work into priced bounties: each bounty is scoped, " +
  "sized and priced, then given a sandbox (a sliced repository, a carveout " +
  "hand-off upload, or a project generated from the bounty) that a " +
  "contributor builds and is judged in by public and hidden tests. These " +
  "tools act in one workspace: read its bounties, proposals, repositories, " +
  "Jira boards, sandboxes and runs; write or import a bounty, size it, " +
  "change its spec, slice and build a sandbox, read its project, invite a " +
  "contributor to a published version, submit and judge work, and take a " +
  "passing submission's files back. A person acts in the web app: " +
  "approving a price (it waits for the complexity profile and for the " +
  "spec's decisions to be confirmed), approving a slice, confirming " +
  "decisions and publishing. Uploads run on the person's machine with " +
  "carveout (upload_handoff gives the command). A refusal comes back as a " +
  "tool error with the API's code.";

/** What a contributor's MCP client is told: their own work, nothing else. */
export const CONTRIBUTOR_MCP_INSTRUCTIONS =
  "Lunox: you are signed in as an invited contributor. These tools reach " +
  "only the versions you were invited to (list_contributions) and your own " +
  "submissions, never a workspace. For a version: read it (get_contribution " +
  "and TASK.md), write its project to disk (get_project_files), install, " +
  "build and test it locally with its commands, change only its editable " +
  "files, then preview_submission and submit the changed files; poll " +
  "get_my_submission for the verdict. One first submission, then one retry " +
  "if it did not pass; an errored submission (grading could not run) is " +
  "regraded without spending the retry. Never edit the public tests, " +
  "package.json, the lockfile or config: the submission is refused.";

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
  for (const path of Object.keys(TOOLSETS)) {
    const metadata = resourceMetadataUrl(baseUrl, path);
    const scope = challengeScope(path);
    const contributor = toolsetAudience(path) === "contributor";

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
              error: contributor
                ? "Sign in as a contributor, or send your contributor token (lnxc_) as a bearer."
                : "Sign in, or send a workspace API token as a bearer.",
              code: "unauthorized",
            },
        401,
      );
    };

    app.post(path, async (c) => {
      const authorization = c.req.header("authorization");
      if (
        bearerApiToken(authorization) === undefined &&
        bearerContributorToken(authorization) === undefined &&
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
      // a client refreshes or signs in again only on an HTTP 401. The guard
      // resolves a credential before it admits a route, so a valid
      // contributor credential is a 403 here, not a 401: any answer but 401
      // leaves the verdict to each tool's own call.
      if ((await call("/api/v1/me")).status === 401) return challenge(c, true);

      const server = new McpServer(
        { name: "lunox", version: "1.0.0" },
        {
          instructions: contributor
            ? CONTRIBUTOR_MCP_INSTRUCTIONS
            : MCP_INSTRUCTIONS,
        },
      );
      registerTools(server, path, call, { baseUrl });
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
