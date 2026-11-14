/**
 * The MCP tools, and the toolset each endpoint serves.
 *
 * **Every tool is a thin wrapper over one public route.** It names the
 * route, calls it with the caller's own credential (`ApiCall`), and returns
 * the API's JSON as text. Read tools are GETs; write tools post work (a
 * bounty, an imported issue, a sizing, a spec change) or hand back a
 * connect link. Approving, publishing and confirming decisions have no
 * tool: they are a person's act in the web app. It holds no access logic: the credential guard,
 * the public registry, scopes and `requireMembership` decide everything,
 * and a refusal comes back as a tool error carrying the API's `code`
 * (`insufficient_scope`, `not_public`, ...). A tool that needs the
 * workspace reads it from `GET /api/v1/me/orgs`, which answers a bound
 * credential's one workspace.
 */

import { randomUUID } from "node:crypto";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { respecRequestSchema } from "@sandbox-factory/shared";
import {
  API_SCOPES,
  BOUNTY_LIMITS,
  MCP_DEFAULT_SCOPES,
  MCP_TOOLSETS,
  PRICED_BOUNTY_COMPLEXITIES,
  type ApiScope,
} from "sandbox-factory";
import { z } from "zod";

/** What a call sends besides the caller's credential; a GET by default. */
export interface ApiCallInit {
  readonly method?: "GET" | "POST";
  /** Sent as JSON. */
  readonly body?: unknown;
  readonly accept?: string;
}

/** A call to the API in-process, as the caller; JSON body or null. */
export type ApiCall = (
  path: string,
  init?: ApiCallInit,
) => Promise<{ status: number; body: unknown }>;

interface Tool {
  readonly name: string;
  /** The scope its one route needs (the public registry's), null for none. */
  readonly scope: ApiScope | null;
  /** The route it calls, from its arguments and the workspace id. */
  route(args: Record<string, unknown>, organizationId: string): string;
  readonly method: "GET" | "POST";
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
  // A grant from before an endpoint asked for this scope: only a new
  // sign-in asks the person again.
  const hint =
    code === "insufficient_scope"
      ? {
          hint: "Sign in to this MCP server again (in Claude Code: /mcp, then re-authenticate) and keep this scope ticked on the consent page.",
        }
      : {};
  return {
    isError: true,
    content: [
      { type: "text", text: JSON.stringify({ error, code, status, ...hint }) },
    ],
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
 * for `scoped` tools, the workspace id; a write tool also names its
 * `method` and builds its `body`. `answer` shapes a success, the API's
 * JSON by default.
 */
function tool<Shape extends z.ZodRawShape>(definition: {
  name: string;
  /** A short human-readable name, sent as the tool's title and its `title` annotation. */
  title: string;
  scope: ApiScope | null;
  description: string;
  input: Shape;
  scoped: boolean;
  path: (args: z.infer<z.ZodObject<Shape>>, organizationId: string) => string;
  method?: "POST";
  body?: (args: z.infer<z.ZodObject<Shape>>) => unknown;
  accept?: string;
  answer?: (body: unknown) => CallToolResult;
}): Tool {
  const writes = definition.method !== undefined;
  return {
    name: definition.name,
    scope: definition.scope,
    method: definition.method ?? "GET",
    route: (args, organizationId) =>
      definition.path(args as z.infer<z.ZodObject<Shape>>, organizationId),
    register(server, call) {
      const schema = z.object(definition.input);
      server.registerTool(
        definition.name,
        {
          title: definition.title,
          description: definition.description,
          inputSchema: schema,
          annotations: writes
            ? {
                title: definition.title,
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: false,
              }
            : {
                title: definition.title,
                readOnlyHint: true,
                destructiveHint: false,
                openWorldHint: false,
              },
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
            {
              ...(definition.method === undefined
                ? {}
                : { method: definition.method }),
              ...(definition.body === undefined
                ? {}
                : { body: definition.body(parsed) }),
              ...(definition.accept === undefined
                ? {}
                : { accept: definition.accept }),
            },
          );
          if (status < 200 || status >= 300) return toolError(status, body);
          return (definition.answer ?? text)(body);
        },
      );
    },
  };
}

/** A connect route's `{ url }`, as a sentence a person can act on. */
function connectLink(what: string) {
  return (body: unknown): CallToolResult => {
    const url = (body as { url?: unknown } | null)?.url;
    return typeof url === "string"
      ? {
          content: [
            {
              type: "text",
              text: `To connect ${what}, open this link in a browser while signed in to Lunox and finish the steps there: ${url}`,
            },
          ],
        }
      : toolError(502, { error: "The API answered no link.", code: "no_url" });
  };
}

const org = (id: string) => `/api/v1/orgs/${enc(id)}`;
const id = (what: string) =>
  z.string().min(1).describe(`The ${what}'s id, as a list tool returned it.`);

export const TOOLS = [
  tool({
    name: "list_workspaces",
    title: "List workspaces",
    scope: "workspace:read",
    description:
      "Show the Lunox workspace this connection reads, your role in it and whether Jira and GitHub are connected. Call it first.",
    input: {},
    scoped: false,
    path: () => "/api/v1/me/orgs",
  }),
  tool({
    name: "get_usage",
    title: "Get usage",
    scope: "workspace:read",
    description:
      "Count the workspace's sizing and analysis runs by kind and state over recent days, and show the model tokens its runs spent this calendar month (UTC) against its monthly limit and when that resets. Runs that call a model are refused with quota_exceeded once the limit is reached.",
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
    title: "List bounties",
    scope: "workspace:read",
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
    title: "Get bounty",
    scope: "workspace:read",
    description:
      "Read one bounty in full: its scope text, acceptance criteria, linked Jira context and the steps done on it.",
    input: { bountyId: id("bounty") },
    scoped: true,
    path: ({ bountyId }, workspace) =>
      `${org(workspace)}/bounties/${enc(bountyId)}`,
  }),
  tool({
    name: "get_proposal",
    title: "Get proposal",
    scope: "workspace:read",
    description:
      "Read one priced proposal: its size, price and whether it is still fresh against the bounty it priced.",
    input: { proposalId: id("proposal") },
    scoped: true,
    path: ({ proposalId }, workspace) =>
      `${org(workspace)}/proposals/${enc(proposalId)}`,
  }),
  tool({
    name: "get_decisions",
    title: "Get decisions",
    scope: "workspace:read",
    description:
      "Read what a proposal's spec decided where the bounty was silent: its decisions (d1, d2…), whether a person confirmed them, and the spec as Gherkin with its Decided: list. Hidden tests are written to confirmed decisions.",
    input: { proposalId: id("proposal") },
    scoped: true,
    path: ({ proposalId }, workspace) =>
      `${org(workspace)}/proposals/${enc(proposalId)}/decisions`,
  }),
  tool({
    name: "confirm_link",
    title: "Get decision confirmation link",
    scope: "workspace:read",
    description:
      "Get the web page where a person confirms a proposal's decisions. Decisions are confirmed by a person, never by a tool: give them the link.",
    input: { proposalId: id("proposal") },
    scoped: true,
    path: ({ proposalId }, workspace) =>
      `${org(workspace)}/proposals/${enc(proposalId)}/decisions`,
    answer: (body: unknown): CallToolResult => {
      const read = body as {
        confirmUrl?: unknown;
        confirmation?: unknown;
        decisions?: unknown[];
      } | null;
      if (typeof read?.confirmUrl !== "string")
        return toolError(502, {
          error: "The API answered no link.",
          code: "no_url",
        });
      const done =
        read.confirmation !== null && read.confirmation !== undefined;
      return {
        content: [
          {
            type: "text",
            text: done
              ? `These decisions are already confirmed. The proposal's page: ${read.confirmUrl}`
              : (read.decisions?.length ?? 0) === 0
                ? `This proposal's spec has no decisions to confirm. Its page: ${read.confirmUrl}`
                : `Ask the person to open this link while signed in to Lunox, read the decisions and confirm them there: ${read.confirmUrl}`,
          },
        ],
      };
    },
  }),
  tool({
    name: "list_repositories",
    title: "List repositories",
    scope: "workspace:read",
    description:
      "List the GitHub repositories the workspace registered, to find a repository or its latest snapshot.",
    input: {},
    scoped: true,
    path: (_args, workspace) => `${org(workspace)}/github/repositories`,
  }),
  tool({
    name: "get_snapshot",
    title: "Get repository snapshot",
    scope: "workspace:read",
    description:
      "Read one repository snapshot: the commit it was taken at and the facts read from its file tree.",
    input: { snapshotId: id("snapshot") },
    scoped: true,
    path: ({ snapshotId }, workspace) =>
      `${org(workspace)}/github/snapshots/${enc(snapshotId)}`,
  }),
  tool({
    name: "list_boards",
    title: "List Jira boards",
    scope: "workspace:read",
    description:
      "List the Jira boards the workspace registered and how each is sized and priced.",
    input: {},
    scoped: true,
    path: (_args, workspace) => `${org(workspace)}/jira/boards`,
  }),
  tool({
    name: "search_issues",
    title: "Search Jira issues",
    scope: "workspace:read",
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
    title: "List sandboxes",
    scope: "workspace:read",
    description:
      "List the workspace's sandboxes, one per bounty that reached the Sandbox step, with their versions' states.",
    input: {},
    scoped: true,
    path: (_args, workspace) => `${org(workspace)}/sandboxes`,
  }),
  tool({
    name: "get_sandbox",
    title: "Get sandbox",
    scope: "workspace:read",
    description:
      "Read one sandbox: the bounty it belongs to, its source repository and its versions.",
    input: { sandboxId: id("sandbox") },
    scoped: true,
    path: ({ sandboxId }, workspace) =>
      `${org(workspace)}/sandboxes/${enc(sandboxId)}`,
  }),
  tool({
    name: "get_run",
    title: "Get run",
    scope: "workspace:read",
    description:
      "Read one analysis run (a context builder, a slice or a sandbox build): its state, progress and outcome. Poll it after starting work.",
    input: { runId: id("run") },
    scoped: true,
    path: ({ runId }, workspace) =>
      `${org(workspace)}/github/runs/${enc(runId)}`,
  }),

  // Posting work: each a write over one public route; the route's scope
  // and role checks decide.
  tool({
    name: "post_bounty",
    title: "Post bounty",
    scope: "bounties:write",
    description:
      "Write a new bounty in the workspace from a title and a description of the work. It is not sized; call size_bounty with its id to price it.",
    input: {
      title: z
        .string()
        .trim()
        .min(1)
        .max(BOUNTY_LIMITS.title)
        .describe("What is to be done, in a line."),
      description: z
        .string()
        .max(BOUNTY_LIMITS.description)
        .optional()
        .describe("The work in full: context, what done looks like."),
      stack: z
        .array(z.string().min(1))
        .max(30)
        .optional()
        .describe(
          "Technologies the work needs beyond what the repositories use.",
        ),
    },
    scoped: true,
    method: "POST",
    path: (_args, workspace) => `${org(workspace)}/bounties`,
    body: ({ title, description, stack }) => ({
      title,
      ...(description === undefined ? {} : { description }),
      ...(stack === undefined ? {} : { stack }),
    }),
  }),
  tool({
    name: "import_github_issue",
    title: "Import GitHub issue",
    scope: "bounties:write",
    description:
      "Make a bounty from a GitHub issue on a repository the workspace connected, taking its title, body and labels. Importing the same issue again returns the bounty it made.",
    input: {
      url: z
        .string()
        .describe("The issue's URL, https://github.com/owner/repo/issues/12."),
    },
    scoped: true,
    method: "POST",
    path: (_args, workspace) => `${org(workspace)}/bounties`,
    body: ({ url }) => ({ source: { githubIssue: url } }),
  }),
  tool({
    name: "import_jira_issue",
    title: "Import Jira issue",
    scope: "bounties:write",
    description:
      "Make a bounty from one Jira issue on a registered board, unsized. Find the board and issue ids with search_issues.",
    input: {
      boardId: id("board"),
      issueId: z
        .string()
        .regex(/^\d{1,18}$/)
        .describe("Jira's numeric issue id, as search_issues returned it."),
    },
    scoped: true,
    method: "POST",
    path: ({ boardId }, workspace) =>
      `${org(workspace)}/jira/boards/${enc(boardId)}/import`,
    body: ({ issueId }) => ({ issueId }),
  }),
  tool({
    name: "size_bounty",
    title: "Size and price bounty",
    scope: "pricing:write",
    description:
      "Size and price one bounty with a model call; it runs in the background. Poll get_bounty until it has a proposal, then read it with get_proposal.",
    input: { bountyId: id("bounty") },
    scoped: true,
    method: "POST",
    path: ({ bountyId }, workspace) =>
      `${org(workspace)}/bounties/${enc(bountyId)}/propose`,
    body: () => ({ requestId: randomUUID() }),
  }),
  tool({
    name: "respec",
    title: "Revise proposal spec",
    scope: "specs:write",
    description:
      "Change a proposal's spec: expand it with more scenarios, answer its open questions, or trim scenarios. Runs in the background against the proposal revision you read with get_proposal.",
    input: {
      proposalId: id("proposal"),
      expectedRevision: z
        .number()
        .int()
        .positive()
        .describe("The proposal's revision, as get_proposal returned it."),
      request: respecRequestSchema.describe(
        "What to change: mode expand, answer or trim, with its fields.",
      ),
    },
    scoped: true,
    method: "POST",
    path: ({ proposalId }, workspace) =>
      `${org(workspace)}/proposals/${enc(proposalId)}/respec`,
    body: ({ expectedRevision, request }) => ({
      expectedRevision,
      request,
      requestId: randomUUID(),
    }),
  }),
  tool({
    name: "plan_slice",
    title: "Plan slice",
    scope: "sandboxes:write",
    description:
      "Slice a connected repository from entry points: which files a sandbox copies, which modules it cuts to stubs, its public surface and what blocks it. It runs in the background; read it with get_run. Nothing is cut or published.",
    input: {
      repositoryId: id("repository"),
      entryPoints: z
        .array(z.string().min(1).max(500))
        .min(1)
        .max(20)
        .describe("Repository paths the slice starts from."),
      maxFiles: z.number().int().min(1).max(200).optional(),
      maxDepth: z.number().int().min(0).max(10).optional(),
    },
    scoped: true,
    method: "POST",
    path: ({ repositoryId }, workspace) =>
      `${org(workspace)}/github/repositories/${enc(repositoryId)}/slices`,
    body: ({ entryPoints, maxFiles, maxDepth }) => ({
      entryPoints: [...new Set(entryPoints)].sort(),
      ...(maxFiles === undefined && maxDepth === undefined
        ? {}
        : { budget: { maxFiles: maxFiles ?? 40, maxDepth: maxDepth ?? 3 } }),
    }),
  }),
  tool({
    name: "start_sandbox",
    title: "Start sandbox",
    scope: "sandboxes:write",
    description:
      "Start the sandbox for a bounty: where its versions are cut, built and published. Starting one that exists answers it.",
    input: { bountyId: id("bounty") },
    scoped: true,
    method: "POST",
    path: (_args, workspace) => `${org(workspace)}/sandboxes/start`,
    body: ({ bountyId }) => ({ bountyId }),
  }),
  tool({
    name: "cut_slice",
    title: "Cut slice",
    scope: "sandboxes:write",
    description:
      "Cut a draft version of a sandbox from a succeeded slice run (plan_slice), priced from the bounty's approved proposal. A wide slice still waits for a person's approval in the web app.",
    input: {
      sandboxId: id("sandbox"),
      sliceRunId: id("slice run"),
      proposalId: id("approved proposal"),
      title: z.string().trim().min(1).max(120),
      specSummary: z.string().trim().min(1).max(4_000),
      complexity: z
        .enum(PRICED_BOUNTY_COMPLEXITIES)
        .describe("The proposal's size."),
    },
    scoped: true,
    method: "POST",
    path: ({ sandboxId }, workspace) =>
      `${org(workspace)}/sandboxes/${enc(sandboxId)}/versions`,
    body: ({ sliceRunId, proposalId, title, specSummary, complexity }) => ({
      sliceRunId,
      proposalId,
      title,
      specSummary,
      complexity,
    }),
  }),
  tool({
    name: "prepare",
    title: "Build sandbox version",
    scope: "sandboxes:write",
    description:
      "Build a draft version: the standalone project, its baseline, and, when it has none, hidden tests written from the approved spec and calibrated by a reference implementation (duediligence's rule). It runs in the background; read it with get_run, then get_handout. Publishing stays a person's act in the web app.",
    input: { versionId: id("version") },
    scoped: true,
    method: "POST",
    path: ({ versionId }, workspace) =>
      `${org(workspace)}/sandboxes/versions/${enc(versionId)}/build`,
  }),
  tool({
    name: "get_handout",
    title: "Get handout",
    scope: "workspace:read",
    description:
      "Read what a developer gets of a built version: its public files, and of its hidden tests only how many there are and the commitment hash over them. No hidden test's name or body is shown.",
    input: { versionId: id("version") },
    scoped: true,
    path: ({ versionId }, workspace) =>
      `${org(workspace)}/sandboxes/versions/${enc(versionId)}/handout`,
  }),
  tool({
    name: "submit_patch",
    title: "Submit patch",
    scope: "submissions:write",
    description:
      "Submit the files changed in a published sandbox version for grading against its public and hidden tests. It runs in the background; read the verdict with get_verdict. The same files again are the submission already made.",
    input: {
      versionId: id("version"),
      files: z
        .array(
          z.object({
            path: z.string().min(1).max(500),
            text: z.string(),
          }),
        )
        .min(1)
        .max(200)
        .describe(
          "Each file the work changed or added, whole, at its path in the sandbox.",
        ),
    },
    scoped: true,
    method: "POST",
    path: ({ versionId }, workspace) =>
      `${org(workspace)}/sandboxes/versions/${enc(versionId)}/submissions`,
    body: ({ files }) => ({ files }),
  }),
  tool({
    name: "judge",
    title: "Judge implementation",
    scope: "submissions:write",
    description:
      "Judge an implementation against a published version's hidden tests, which you never see: submit the files changed, then read the verdict (passed, overfit, incomplete or refused) with get_verdict. Only counts and the failing scenarios' keys come back.",
    input: {
      versionId: id("version"),
      files: z
        .array(
          z.object({
            path: z.string().min(1).max(500),
            text: z.string(),
          }),
        )
        .min(1)
        .max(200)
        .describe(
          "Each file the work changed or added, whole, at its path in the sandbox.",
        ),
    },
    scoped: true,
    method: "POST",
    path: ({ versionId }, workspace) =>
      `${org(workspace)}/sandboxes/versions/${enc(versionId)}/submissions`,
    body: ({ files }) => ({ files }),
  }),
  tool({
    name: "retry",
    title: "Retry submission",
    scope: "submissions:write",
    description:
      "Retry a failed submission once: submit the files again, changed, after reading its failing scenario keys with get_verdict. A submission has one retry, a passed one none. Read the new verdict with get_verdict.",
    input: {
      submissionId: id("submission"),
      files: z
        .array(
          z.object({
            path: z.string().min(1).max(500),
            text: z.string(),
          }),
        )
        .min(1)
        .max(200)
        .describe(
          "Each file the work changed or added, whole, at its path in the sandbox.",
        ),
    },
    scoped: true,
    method: "POST",
    path: ({ submissionId }, workspace) =>
      `${org(workspace)}/sandboxes/submissions/${enc(submissionId)}/retry`,
    body: ({ files }) => ({ files }),
  }),
  tool({
    name: "get_verdict",
    title: "Get verdict",
    scope: "workspace:read",
    description:
      "Read a submission's verdict: passed, overfit, incomplete or refused, the public and hidden counts, and the keys of the spec scenarios a failing hidden test covers. Never a hidden test's name or body.",
    input: { submissionId: id("submission") },
    scoped: true,
    path: ({ submissionId }, workspace) =>
      `${org(workspace)}/sandboxes/submissions/${enc(submissionId)}`,
  }),
  tool({
    name: "connect_github",
    title: "Connect GitHub",
    scope: "integrations:write",
    description:
      "Get the link that connects the workspace's GitHub repositories. Connecting is a browser step: give the person the link to open.",
    input: {},
    scoped: true,
    path: (_args, workspace) => `${org(workspace)}/github/connect`,
    accept: "application/json",
    answer: connectLink("GitHub"),
  }),
  tool({
    name: "connect_jira",
    title: "Connect Jira",
    scope: "integrations:write",
    description:
      "Get the link that connects a Jira site to the workspace. Connecting is a browser step: give the person the link to open.",
    input: {},
    scoped: true,
    path: (_args, workspace) => `${org(workspace)}/jira/connect`,
    accept: "application/json",
    answer: connectLink("Jira"),
  }),
] as const;

export type ToolName = (typeof TOOLS)[number]["name"];

/**
 * The tools each MCP endpoint serves, by path: `MCP_TOOLSETS` in core,
 * shared with the web app's MCP page. `/mcp` names every tool here, and a
 * toolset names no other (`mcp.test.ts`).
 */
export const TOOLSETS: Readonly<Record<string, readonly ToolName[]>> =
  MCP_TOOLSETS;

/**
 * The scopes an endpoint's tools need, in `API_SCOPES` order: what its
 * sign-in challenge and protected-resource metadata ask an MCP client to
 * request, so a client signed in through one plugin can use every tool
 * that plugin's skill names. The person may still untick any of them.
 */
export function toolsetScopes(path: string): ApiScope[] {
  const names = new Set<string>(TOOLSETS[path] ?? []);
  const needed = new Set<ApiScope>(MCP_DEFAULT_SCOPES);
  for (const entry of TOOLS) {
    if (names.has(entry.name) && entry.scope !== null) needed.add(entry.scope);
  }
  return API_SCOPES.filter((scope) => needed.has(scope));
}

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
