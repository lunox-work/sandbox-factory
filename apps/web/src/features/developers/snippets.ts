/**
 * What the portal tells someone to paste: the MCP endpoints and the install
 * and quickstart snippets, all written against `origin`, the address the
 * app is served from. The API and MCP share it (nginx and CloudFront route
 * `/api` and `/mcp` to the API), so a dev stack's snippets name the dev
 * stack and production's name production.
 */

import { MCP_TOOLSETS } from "sandbox-factory";

/** The MCP endpoints, each a toolset (`MCP_TOOLSETS` in core, as the API serves them). */
export const MCP_SERVERS = [
  {
    path: "/mcp",
    title: "Everything",
    description:
      "Every tool: read the workspace, post and size bounties, slice, build and hand out sandboxes, submit and read verdicts, and connect GitHub or Jira.",
    tools: MCP_TOOLSETS["/mcp"],
  },
  {
    path: "/mcp/duediligence",
    title: "duediligence",
    description:
      "What the duediligence plugin uses: bounties and their specs' decisions, sizing, building a sandbox with calibrated hidden tests, and judging an implementation against them.",
    tools: MCP_TOOLSETS["/mcp/duediligence"],
  },
  {
    path: "/mcp/carveout",
    title: "carveout",
    description:
      "What the carveout plugin uses: bounties, repositories, slicing one into a sandbox, building and handing it out, and grading a contractor's patch.",
    tools: MCP_TOOLSETS["/mcp/carveout"],
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
