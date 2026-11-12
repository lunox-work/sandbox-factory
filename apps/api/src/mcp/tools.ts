/**
 * The MCP tools, and the toolset each endpoint serves.
 *
 * **Every tool is a thin wrapper over one public route.** It names the
 * route, calls it with the caller's own credential (`ApiCall`), and returns
 * the API's JSON as text. It holds no access logic: the credential guard,
 * the public registry, scopes and `requireMembership` decide everything,
 * and a refusal comes back as a tool error carrying the API's `code`
 * (`insufficient_scope`, `not_public`, ...). A tool that needs the
 * workspace reads it from `GET /api/v1/me/orgs`, which answers a bound
 * credential's one workspace.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

/** A call to the API in-process, as the caller; JSON body or null. */
export type ApiCall = (
  path: string,
) => Promise<{ status: number; body: unknown }>;

interface Tool {
  readonly name: string;
  register(server: McpServer, call: ApiCall): void;
}

const enc = encodeURIComponent;

function text(body: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
}

/** A refusal or failure as a tool error, keeping the API's code. */
export function toolError(status: number, body: unknown): CallToolResult {
  const fields = (typeof body === "object" && body !== null ? body : {}) as {
    error?: unknown;
    code?: unknown;
  };
  const code =
    typeof fields.code === "string"
      ? fields.code
      : status === 404
        ? "not_found"
        : `http_${status}`;
  const error =
    typeof fields.error === "string"
      ? fields.error
      : `The API answered ${status}.`;
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error, code, status }) }],
  };
}

/** The one workspace the credential is bound to, or a tool error. */
async function workspaceOf(
  call: ApiCall,
): Promise<{ id: string } | { refused: CallToolResult }> {
  const { status, body } = await call("/api/v1/me/orgs");
  if (status !== 200) return { refused: toolError(status, body) };
  const organizations = (body as { organizations?: Array<{ id: string }> })
    .organizations;
  if (organizations?.length !== 1 || organizations[0] === undefined) {
    return {
      refused: toolError(409, {
        error:
          "This connection is not bound to exactly one workspace. Connect with an API token or OAuth grant for one workspace.",
        code: "workspace_unresolved",
      }),
    };
  }
  return { id: organizations[0].id };
}

/**
 * A tool over one route. `path` builds the route from the arguments and,
 * for `scoped` tools, the workspace id.
 */
function tool<Shape extends z.ZodRawShape>(definition: {
  name: string;
  description: string;
  input: Shape;
  scoped: boolean;
  path: (args: z.infer<z.ZodObject<Shape>>, organizationId: string) => string;
}): Tool {
  return {
    name: definition.name,
    register(server, call) {
      const schema = z.object(definition.input);
      server.registerTool(
        definition.name,
        {
          description: definition.description,
          inputSchema: schema,
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async (args: unknown) => {
          // The SDK validated already; parsed again for the shape's type.
          const parsed: z.infer<z.ZodObject<Shape>> = schema.parse(args ?? {});
          let organizationId = "";
          if (definition.scoped) {
            const workspace = await workspaceOf(call);
            if ("refused" in workspace) return workspace.refused;
            organizationId = workspace.id;
          }
          const { status, body } = await call(
            definition.path(parsed, organizationId),
          );
          return status >= 200 && status < 300
            ? text(body)
            : toolError(status, body);
        },
      );
    },
  };
}

const org = (id: string) => `/api/v1/orgs/${enc(id)}`;
const id = (what: string) =>
  z.string().min(1).describe(`The ${what}'s id, as a list tool returned it.`);

const TOOLS = [
  tool({
    name: "list_workspaces",
    description:
      "Show the Lunox workspace this connection reads, your role in it and whether Jira and GitHub are connected. Call it first.",
    input: {},
    scoped: false,
    path: () => "/api/v1/me/orgs",
  }),
  tool({
    name: "get_usage",
    description:
      "Count the workspace's sizing and analysis runs by kind and state over recent days, to see what has been running.",
    input: {
      days: z
        .number()
        .int()
        .min(1)
        .max(90)
        .optional()
        .describe("How many days back to count; 30 when left out."),
    },
    scoped: true,
    path: ({ days }, workspace) =>
      `${org(workspace)}/usage${days === undefined ? "" : `?days=${days}`}`,
  }),
  tool({
    name: "list_bounties",
    description:
      "List the workspace's bounties, newest first, with each one's status (new, scoped, priced, live); use it to find a bounty's id.",
    input: {
      status: z
        .enum(["new", "scoped", "priced", "live"])
        .optional()
        .describe("Only bounties whose last step done is this one."),
      cursor: z
        .string()
        .optional()
        .describe("The nextCursor of the previous page."),
    },
    scoped: true,
    path: ({ status, cursor }, workspace) => {
      const query = new URLSearchParams();
      if (status !== undefined) query.set("status", status);
      if (cursor !== undefined) query.set("cursor", cursor);
      const search = query.toString();
      return `${org(workspace)}/bounties${search === "" ? "" : `?${search}`}`;
    },
  }),
  tool({
    name: "get_bounty",
    description:
      "Read one bounty in full: its scope text, acceptance criteria, linked Jira context and the steps done on it.",
    input: { bountyId: id("bounty") },
    scoped: true,
    path: ({ bountyId }, workspace) =>
      `${org(workspace)}/bounties/${enc(bountyId)}`,
  }),
  tool({
    name: "get_proposal",
    description:
      "Read one priced proposal: its size, price and whether it is still fresh against the bounty it priced.",
    input: { proposalId: id("proposal") },
    scoped: true,
    path: ({ proposalId }, workspace) =>
      `${org(workspace)}/proposals/${enc(proposalId)}`,
  }),
  tool({
    name: "list_repositories",
    description:
      "List the GitHub repositories the workspace registered, to find a repository or its latest snapshot.",
    input: {},
    scoped: true,
    path: (_args, workspace) => `${org(workspace)}/github/repositories`,
  }),
  tool({
    name: "get_snapshot",
    description:
      "Read one repository snapshot: the commit it was taken at and the facts read from its file tree.",
    input: { snapshotId: id("snapshot") },
    scoped: true,
    path: ({ snapshotId }, workspace) =>
      `${org(workspace)}/github/snapshots/${enc(snapshotId)}`,
  }),
  tool({
    name: "list_boards",
    description:
      "List the Jira boards the workspace registered and how each is sized and priced.",
    input: {},
    scoped: true,
    path: (_args, workspace) => `${org(workspace)}/jira/boards`,
  }),
  tool({
    name: "search_issues",
    description:
      "Search the issues on every registered Jira board by key or words, to find the issue a bounty came from or should.",
    input: {
      query: z
        .string()
        .min(1)
        .max(200)
        .describe("An issue key such as PAY-12, or words from its summary."),
    },
    scoped: true,
    path: ({ query }, workspace) =>
      `${org(workspace)}/jira/search?q=${enc(query)}`,
  }),
  tool({
    name: "list_sandboxes",
    description:
      "List the workspace's sandboxes, one per bounty that reached the Sandbox step, with their versions' states.",
    input: {},
    scoped: true,
    path: (_args, workspace) => `${org(workspace)}/sandboxes`,
  }),
  tool({
    name: "get_sandbox",
    description:
      "Read one sandbox: the bounty it belongs to, its source repository and its versions.",
    input: { sandboxId: id("sandbox") },
    scoped: true,
    path: ({ sandboxId }, workspace) =>
      `${org(workspace)}/sandboxes/${enc(sandboxId)}`,
  }),
  tool({
    name: "get_run",
    description:
      "Read one analysis run (a context builder, a slice or a sandbox build): its state, progress and outcome. Poll it after starting work.",
    input: { runId: id("run") },
    scoped: true,
    path: ({ runId }, workspace) =>
      `${org(workspace)}/github/runs/${enc(runId)}`,
  }),
] as const;

export type ToolName = (typeof TOOLS)[number]["name"];

/** The tools each MCP endpoint serves, by path. */
export const TOOLSETS: Readonly<Record<string, readonly ToolName[]>> = {
  "/mcp": TOOLS.map((entry) => entry.name),
  "/mcp/duediligence": [
    "list_workspaces",
    "list_bounties",
    "get_bounty",
    "get_proposal",
    "get_run",
    "get_usage",
  ],
  "/mcp/carveout": [
    "list_workspaces",
    "list_repositories",
    "get_snapshot",
    "list_sandboxes",
    "get_sandbox",
    "get_run",
  ],
};

/** Registers the tools named in `toolset` on `server`, calling through `call`. */
export function registerTools(
  server: McpServer,
  toolset: readonly ToolName[],
  call: ApiCall,
): void {
  for (const entry of TOOLS) {
    if (toolset.includes(entry.name)) entry.register(server, call);
  }
}
