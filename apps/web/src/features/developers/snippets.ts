/**
 * What the portal tells someone to paste: the MCP endpoints and the install
 * and quickstart snippets, all written against `origin`, the address the
 * app is served from. The API and MCP share it (nginx and CloudFront route
 * `/api` and `/mcp` to the API), so a dev stack's snippets name the dev
 * stack and production's name production.
 */

/**
 * The MCP endpoints, each a toolset (`TOOLSETS` in the API's
 * `mcp/tools.ts`). Restated here because apps do not import each other;
 * read tools only for now.
 */
export const MCP_SERVERS = [
  {
    path: "/mcp",
    title: "Everything",
    description:
      "Every read tool: workspaces, bounties, proposals, repositories, boards, sandboxes, runs and usage.",
    tools: [
      "list_workspaces",
      "get_usage",
      "list_bounties",
      "get_bounty",
      "get_proposal",
      "list_repositories",
      "get_snapshot",
      "list_boards",
      "search_issues",
      "list_sandboxes",
      "get_sandbox",
      "get_run",
    ],
  },
  {
    path: "/mcp/duediligence",
    title: "duediligence",
    description:
      "What the duediligence plugin reads: bounties, their proposals and runs, and usage.",
    tools: [
      "list_workspaces",
      "list_bounties",
      "get_bounty",
      "get_proposal",
      "get_run",
      "get_usage",
    ],
  },
  {
    path: "/mcp/carveout",
    title: "carveout",
    description:
      "What the carveout plugin reads: repositories, snapshots, sandboxes and runs.",
    tools: [
      "list_workspaces",
      "list_repositories",
      "get_snapshot",
      "list_sandboxes",
      "get_sandbox",
      "get_run",
    ],
  },
] as const;

/** The Claude Code plugins that bring their own MCP server and skills. */
export const PLUGIN_INSTALLS = [
  "claude plugin install duediligence@duediligence",
  "claude plugin install carveout@carveout",
] as const;

/** The command-line clients that sign in by device flow at `/device`. */
export const CLI_LOGINS = [
  "npx duediligence login",
  "npx carveout login",
] as const;

/** The address the snippets name; the window's, outside tests' control. */
export function appOrigin(): string {
  return window.location.origin;
}

export function curlMe(origin: string): string {
  return [
    `curl ${origin}/api/v1/me \\`,
    `  -H "Authorization: Bearer lnx_…"`,
  ].join("\n");
}

export function claudeMcpAdd(origin: string, name = "lunox", path = "/mcp") {
  return `claude mcp add --transport http ${name} ${origin}${path}`;
}

export function cursorConfig(origin: string, name = "lunox", path = "/mcp") {
  return JSON.stringify(
    { mcpServers: { [name]: { url: `${origin}${path}` } } },
    null,
    2,
  );
}

export function codexConfig(origin: string, name = "lunox", path = "/mcp") {
  return [`[mcp_servers.${name}]`, `url = "${origin}${path}"`].join("\n");
}
