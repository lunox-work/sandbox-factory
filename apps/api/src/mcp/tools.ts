/**
 * The MCP tools, and the toolset each endpoint serves.
 *
 * **Every tool is a thin wrapper over one public route.** It names the
 * route, calls it with the caller's own credential (`ApiCall`), and returns
 * the API's JSON as text. Read tools are GETs; write tools post work (a
 * bounty, an imported issue, a sizing, a spec change, a submission, an
 * invite) or hand back a link or a command. Approving, publishing and
 * confirming decisions have no tool: they are a person's act in the web
 * app. It holds no access logic: the credential guard, the public registry,
 * scopes and `requireMembership` decide everything, and a refusal comes
 * back as a tool error carrying the API's `code` (`insufficient_scope`,
 * `not_public`, ...). A tool that needs the workspace reads it from
 * `GET /api/v1/me/orgs`, which answers a bound credential's one workspace.
 *
 * Two audiences, as the registry has: the workspace tools (`TOOLS`, every
 * endpoint but one) over a workspace credential, and the contributor tools
 * (`CONTRIBUTOR_TOOLS`, `/mcp/contribute`) over a contributor credential,
 * which name no workspace: each finds its version through
 * `GET /api/v1/contributions`. Some share a workspace tool's name; none
 * shares its route.
 *
 * `upload_handoff` is the one tool that sends nothing: an upload is a
 * carveout hand-off folder cut and renamed on the person's machine with a
 * receipt that never leaves it, so the tool checks the bounty and answers
 * the `carveout handoff --platform` command that uploads it.
 */

import { randomUUID } from "node:crypto";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  CONTRIBUTOR_INVITE_MAX_CLAIMS,
  CONTRIBUTOR_INVITE_MAX_DAYS,
  HANDOUT_PAGE_DEFAULT_BYTES,
  HANDOUT_PAGE_LIMITS,
  respecRequestSchema,
  SUBMISSION_LIMITS,
  UPLOAD_CARVEOUT_MIN_VERSION,
  postedSpecSchema,
} from "@sandbox-factory/shared";
import {
  API_SCOPES,
  BOUNTY_LIMITS,
  CONTRIBUTOR_SCOPE,
  CONTRIBUTOR_SCOPES,
  MCP_CONTRIBUTOR_PATH,
  MCP_DEFAULT_SCOPES,
  MCP_TOOLSETS,
  PRICED_BOUNTY_COMPLEXITIES,
  type CredentialScope,
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

/** What a tool knows of where it is served, besides the caller's credential. */
export interface ToolContext {
  /** The API's public origin, which a command a tool answers names. */
  readonly baseUrl: string;
}

/** Whose tools: a workspace's credential's, or a contributor's. */
export type ToolAudience = "workspace" | "contributor";

interface Tool {
  readonly name: string;
  /** The scope its one route needs (the public registry's), null for none. */
  readonly scope: CredentialScope | null;
  /**
   * Scopes its route reads beyond that one, which widen what it does
   * without being needed to call it (`decisions:confirm` on post_bounty):
   * asked for at sign-in too.
   */
  readonly alsoScopes: readonly CredentialScope[];
  /** The registry audience of its route. */
  readonly audience: ToolAudience;
  /** The route it calls, from its arguments and the workspace id. */
  route(args: Record<string, unknown>, organizationId: string): string;
  readonly method: "GET" | "POST";
  register(server: McpServer, call: ApiCall, context: ToolContext): void;
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
  scope: CredentialScope | null;
  alsoScopes?: readonly CredentialScope[];
  /** A contributor tool; a workspace tool when left out. */
  audience?: "contributor";
  description: string;
  input: Shape;
  scoped: boolean;
  path: (args: z.infer<z.ZodObject<Shape>>, organizationId: string) => string;
  method?: "POST";
  /** A POST that stores nothing (a dry run): annotated as a read. */
  readOnly?: true;
  body?: (args: z.infer<z.ZodObject<Shape>>) => unknown;
  accept?: string;
  answer?: (
    body: unknown,
    args: z.infer<z.ZodObject<Shape>>,
    context: ToolContext & { organizationId: string },
  ) => CallToolResult;
}): Tool {
  const writes =
    definition.method !== undefined && definition.readOnly !== true;
  return {
    name: definition.name,
    scope: definition.scope,
    alsoScopes: definition.alsoScopes ?? [],
    audience: definition.audience ?? "workspace",
    method: definition.method ?? "GET",
    route: (args, organizationId) =>
      definition.path(args as z.infer<z.ZodObject<Shape>>, organizationId),
    register(server, call, context) {
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
          return definition.answer === undefined
            ? text(body)
            : definition.answer(body, parsed, { ...context, organizationId });
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

/** Each file changed or added, whole: what a submission, retry or preview sends. */
const filesInput = z
  .array(
    z.object({
      path: z.string().min(1).max(500),
      text: z.string(),
    }),
  )
  .min(1)
  .max(SUBMISSION_LIMITS.files)
  .describe(
    "Each file the work changed or added, whole, at its path in the project. Leave out what you did not change: a file left out keeps the version's text (a submission cannot delete one).",
  );

/** A page query for the handout's files: `cursor` and `maxBytes`. */
const pageInput = {
  cursor: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe("The previous page's nextCursor; left out, the first page."),
  maxBytes: z
    .number()
    .int()
    .min(HANDOUT_PAGE_LIMITS.min)
    .max(HANDOUT_PAGE_LIMITS.max)
    .optional()
    .describe(
      `About how much content one page holds; ${HANDOUT_PAGE_DEFAULT_BYTES} when left out. A page always holds at least one file.`,
    ),
};

function pageQuery({
  cursor,
  maxBytes,
}: {
  cursor?: string | undefined;
  maxBytes?: number | undefined;
}): string {
  const query = new URLSearchParams();
  if (cursor !== undefined) query.set("cursor", cursor);
  if (maxBytes !== undefined) query.set("maxBytes", String(maxBytes));
  const search = query.toString();
  return search === "" ? "" : `?${search}`;
}

/** One shell word, quoted when it needs to be (POSIX `sh`). */
export function shellWord(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The commands that upload a carveout hand-off folder as a draft version
 * of `bountyId`: sign carveout in to this platform, then cut, check and
 * upload in one step. Run in the repository's checkout.
 */
export function handoffCommands(input: {
  readonly platform: string;
  readonly organizationId: string;
  readonly bountyId: string;
  readonly entryPoints: readonly string[];
  readonly accept: readonly string[];
  readonly out: string;
  readonly title?: string | undefined;
  readonly task?: string | undefined;
}): string[] {
  const carveout = "npx -y carveout@latest";
  const handoff = [
    carveout,
    "handoff",
    ...input.entryPoints.map(shellWord),
    "--out",
    shellWord(input.out),
    ...(input.task === undefined ? [] : ["--task", shellWord(input.task)]),
    "--accept",
    ...input.accept.map(shellWord),
    "--platform",
    shellWord(input.platform),
    "--bounty",
    shellWord(input.bountyId),
    ...(input.title === undefined ? [] : ["--title", shellWord(input.title)]),
  ];
  return [
    `${carveout} login --platform ${shellWord(input.platform)} --org ${shellWord(input.organizationId)}`,
    handoff.join(" "),
  ];
}

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
      "Count the workspace's sizing and analysis runs by kind and state over recent days, and show the model tokens and evaluator seconds its runs spent this calendar month (UTC), each against its monthly limit and when that resets, with the month's grading attempts and uploads. Runs are refused with quota_exceeded (and the kind that ran out) once a limit is reached.",
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
      "Read what a proposal's spec decided where the bounty was silent: its decisions (d1, d2…), whether a person confirmed them, and the spec as Gherkin with its Decided: list. Hidden tests are written to confirmed decisions: until a person confirms them (confirm_link), approving the price, prepare and publishing are refused with decisions_unconfirmed. A spec with no decisions needs nothing.",
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
    // A spec posted confirmed records its decisions confirmed only with it.
    alsoScopes: ["decisions:confirm"],
    description:
      "Write a new bounty in the workspace from a title and a description of the work. It is not sized; call size_bounty with its id to price it. With spec, post a spec confirmed in duediligence (spec.md as written, format duediligence, confirmed true once its Decided: items were confirmed): sizing prices that spec and drafts none, and its decisions need no second confirmation. A spec that cannot be stored as written is refused (invalid_spec) with each problem's path. Without a description, the bounty's description is the spec.",
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
      spec: postedSpecSchema
        .optional()
        .describe(
          "A spec confirmed in duediligence: { document: spec.md's text, format: 'duediligence', confirmed: true once a person confirmed its Decided: items, engine?: { name: 'duediligence', version } }.",
        ),
    },
    scoped: true,
    method: "POST",
    path: (_args, workspace) => `${org(workspace)}/bounties`,
    body: ({ title, description, stack, spec }) => ({
      title,
      ...(description === undefined ? {} : { description }),
      ...(stack === undefined ? {} : { stack }),
      ...(spec === undefined ? {} : { spec }),
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
      "Size and price one bounty with a model call; it runs in the background. Poll get_bounty until it has a proposal, then read it with get_proposal. Approving the price is a person's act in the web app: it waits for the proposal's complexity profile to settle (profile_pending) and for its spec's decisions to be confirmed (decisions_unconfirmed, see get_decisions).",
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
      "Slice a connected repository from entry points: which files a sandbox copies, which modules it cuts to stubs, its public surface and what blocks it. With carryTests (the default), a version built from it carries the repository's own node:test tests of those files as read-only public tests, those that pass on the untouched project, at most 20 by default; the build records the rest with why. It runs in the background; read it with get_run. Nothing is cut or published.",
    input: {
      repositoryId: id("repository"),
      entryPoints: z
        .array(z.string().min(1).max(500))
        .min(1)
        .max(20)
        .describe("Repository paths the slice starts from."),
      maxFiles: z.number().int().min(1).max(200).optional(),
      maxDepth: z.number().int().min(0).max(10).optional(),
      carryTests: z
        .boolean()
        .optional()
        .describe(
          "Carry the repository's own tests of the slice into its versions (default true).",
        ),
    },
    scoped: true,
    method: "POST",
    path: ({ repositoryId }, workspace) =>
      `${org(workspace)}/github/repositories/${enc(repositoryId)}/slices`,
    body: ({ entryPoints, maxFiles, maxDepth, carryTests }) => ({
      entryPoints: [...new Set(entryPoints)].sort(),
      ...(maxFiles === undefined && maxDepth === undefined
        ? {}
        : { budget: { maxFiles: maxFiles ?? 40, maxDepth: maxDepth ?? 3 } }),
      ...(carryTests === undefined ? {} : { carryTests }),
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
      "Cut a draft version of a sandbox from a succeeded slice run (plan_slice), priced from the bounty's approved proposal. Its build carries the repository's own tests when the slice was planned with carryTests (plan_slice's default). A wide slice still waits for a person's approval in the web app.",
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
      "Build a draft version: the standalone project, its baseline, and, when it has none, hidden tests written from the approved spec and its confirmed decisions, and calibrated by a reference implementation (duediligence's rule). Refused with decisions_unconfirmed while the spec's decisions wait for a person (confirm_link). It runs in the background; read it with get_run, then get_handout. Publishing stays a person's act in the web app.",
    input: { versionId: id("version") },
    scoped: true,
    method: "POST",
    path: ({ versionId }, workspace) =>
      `${org(workspace)}/sandboxes/versions/${enc(versionId)}/build`,
  }),
  tool({
    name: "upload_handoff",
    title: "Get hand-off upload commands",
    scope: "workspace:read",
    description:
      "Get the exact commands that upload a carveout hand-off folder as a draft version of a bounty. MCP does not carry the upload: carveout cuts the folder on your machine, renames it into pseudonyms and renames the acceptance tests with a receipt that never leaves it, then uploads (POST …/sandboxes/uploads). This tool checks the bounty exists and answers the commands to run in the repository's checkout: `carveout login`, then `carveout handoff … --platform … --bounty …`. After the upload, read the version with get_sandbox and its import run with get_run; publishing stays a person's act in the web app. Take a passing submission's files back with get_submission_files (or `carveout patch --from <submission id>`).",
    input: {
      bountyId: id("bounty"),
      entryPoints: z
        .array(z.string().min(1).max(500))
        .min(1)
        .max(20)
        .describe("Repository paths the slice starts from."),
      accept: z
        .array(z.string().min(1).max(500))
        .min(1)
        .max(20)
        .describe(
          "The acceptance tests (.test.ts or .spec.ts, repository paths) that fail before the work and must pass after it.",
        ),
      out: z
        .string()
        .min(1)
        .max(200)
        .default("handoff")
        .describe("The folder carveout writes the hand-off to."),
      title: z.string().trim().min(1).max(120).optional(),
      task: z
        .string()
        .min(1)
        .max(4_000)
        .optional()
        .describe("A file or text for the folder's TASK.md."),
    },
    scoped: true,
    path: ({ bountyId }, workspace) =>
      `${org(workspace)}/bounties/${enc(bountyId)}`,
    answer: (_body, args, { baseUrl, organizationId }) => {
      const platform = new URL(baseUrl).origin;
      const commands = handoffCommands({
        platform,
        organizationId,
        bountyId: args.bountyId,
        entryPoints: [...new Set(args.entryPoints)],
        accept: [...new Set(args.accept)],
        out: args.out,
        title: args.title,
        task: args.task,
      });
      return {
        content: [
          {
            type: "text",
            text: [
              `Run these in the repository's checkout (carveout ${UPLOAD_CARVEOUT_MIN_VERSION} or later; the platform refuses an older one with carveout_too_old). The first signs carveout in to this workspace in a browser; the second cuts the folder, checks that its tests pass and the acceptance tests fail before any edit, and uploads it with the acceptance tests as a draft version of the bounty. The receipt stays on this machine: keep it for \`carveout patch --from\`.`,
              "",
              ...commands,
            ].join("\n"),
          },
        ],
      };
    },
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
    name: "get_project_files",
    title: "Get project files",
    scope: "workspace:read",
    description:
      "Read a built version's public project, the files get_handout lists, with their contents, one page at a time, so you can write the project to disk and run it (npm ci, npm test). Write each file at `root`/`path`: `encoding` utf8 is text as is, base64 is any other file. Pass the page's `nextCursor` as `cursor` until it is null. A file listed with omitted too_large has no content here; the workspace's web app downloads the whole project as a .zip. No hidden test is ever among the files.",
    input: { versionId: id("version"), ...pageInput },
    scoped: true,
    path: ({ versionId, ...page }, workspace) =>
      `${org(workspace)}/sandboxes/versions/${enc(versionId)}/handout/files${pageQuery(page)}`,
  }),
  tool({
    name: "create_contributor_invite",
    title: "Create contributor invite",
    scope: "sandboxes:write",
    description:
      "Invite one person outside the workspace to work on a sandbox's current published version: answers the claim link and its secret, once (only its hash is kept). Give the person the link; they sign in to Lunox, claim it, and see only that version's public project and their own submissions: never the workspace, its private files or other people's work. They submit from the web app, with a contributor token (lnxc_), or over MCP at /mcp/contribute. One first submission and one retry each. A version that is not the current published one is refused (not_published).",
    input: {
      versionId: id("published version"),
      label: z
        .string()
        .trim()
        .min(1)
        .max(100)
        .optional()
        .describe("Who it is for, shown to the workspace only."),
      email: z
        .email()
        .max(320)
        .optional()
        .describe("A hint of the address it goes to; not checked at claim."),
      expiresInDays: z
        .number()
        .int()
        .min(1)
        .max(CONTRIBUTOR_INVITE_MAX_DAYS)
        .optional()
        .describe("How long it admits claims; 14 days when left out."),
      maxClaims: z
        .number()
        .int()
        .min(1)
        .max(CONTRIBUTOR_INVITE_MAX_CLAIMS)
        .optional()
        .describe("How many people it admits; one when left out."),
    },
    scoped: true,
    method: "POST",
    path: ({ versionId }, workspace) =>
      `${org(workspace)}/sandboxes/versions/${enc(versionId)}/invites`,
    body: ({ label, email, expiresInDays, maxClaims }) => ({
      ...(label === undefined ? {} : { label }),
      ...(email === undefined ? {} : { email }),
      ...(expiresInDays === undefined ? {} : { expiresInDays }),
      ...(maxClaims === undefined ? {} : { maxClaims }),
    }),
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
      "Retry a failed submission once: submit the files again, changed, after reading its failing scenario keys with get_verdict. A submission has one retry, a passed one none. An errored submission (grading could not run) sent with the same files is graded again without spending its retry. Read the new verdict with get_verdict.",
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
    name: "regrade",
    title: "Regrade submission",
    scope: "submissions:write",
    description:
      "Grade an errored submission again with its own files: its grading could not run (timed out, interrupted, or failed on the platform's side), which is not the contributor's doing, so its one retry is not spent. Any other state is refused (not_errored). Read the new verdict with get_verdict.",
    input: { submissionId: id("submission") },
    scoped: true,
    method: "POST",
    path: ({ submissionId }, workspace) =>
      `${org(workspace)}/sandboxes/submissions/${enc(submissionId)}/regrade`,
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
    name: "get_submission_files",
    title: "Get submission files",
    scope: "submissions:write",
    description:
      "Take a passing submission's changed files back, never a hidden test: on an uploaded version (carveout hand-off) at the folder's paths, with the receipt's hash, for `carveout patch --from <submission id>` to judge and rename back against the receipt on your machine; on a generated (starter) version at the version's own paths. A version sliced from a connected repository merges back by pull request from the web app instead, and is refused here.",
    input: { submissionId: id("submission") },
    scoped: true,
    path: ({ submissionId }, workspace) =>
      `${org(workspace)}/sandboxes/submissions/${enc(submissionId)}/files`,
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

/** A contributor's own route for one version they were invited to. */
const contribution = (versionId: string, rest = "") =>
  `/api/v1/contributions/${enc(versionId)}${rest}`;

/** What every contributor tool's rules come back to, said once. */
const RULES =
  "One first submission per version, then one retry if it did not pass; a retry is not retried, a passed one has none. An errored submission (grading could not run: timed out, interrupted, failed on the platform's side) is the platform's failure: regrade it, or retry it with the same files, and the retry is not spent. Only the task's editable files (and new .ts files beside them) count: never change tests/ (the public tests), package.json, the lockfile, tsconfig.json, .npmrc or other config, or the submission is refused.";

/**
 * The contributor tools, `/mcp/contribute`: an invited contributor's own
 * versions, each one's project, and their own submissions, over their
 * contributor credential. Each names a version by the id
 * `list_contributions` answers; none names a workspace.
 */
export const CONTRIBUTOR_TOOLS = [
  tool({
    name: "list_contributions",
    title: "List contributions",
    scope: CONTRIBUTOR_SCOPE,
    audience: "contributor",
    description:
      "List the versions you were invited to work on: each one's versionId, title, task summary, size, commands, editable paths and whether it still takes submissions. Call it first; every other tool takes a versionId from here.",
    input: {},
    scoped: false,
    path: () => "/api/v1/contributions",
  }),
  tool({
    name: "get_contribution",
    title: "Get contribution",
    scope: CONTRIBUTOR_SCOPE,
    audience: "contributor",
    description: `Read one version you were invited to: the task summary (TASK.md in the project holds it in full, with its scenarios and rules), the commands to install, build, test and run it, the editable paths (the only files a submission may change) and whether it takes submissions now. ${RULES}`,
    input: { versionId: id("version") },
    scoped: false,
    path: ({ versionId }) => contribution(versionId),
  }),
  tool({
    name: "get_project_files",
    title: "Get project files",
    scope: CONTRIBUTOR_SCOPE,
    audience: "contributor",
    description:
      "Read the version's public project with its contents, one page at a time, to write it to disk and work in it (npm ci, npm test). Write each file at `root`/`path`: `encoding` utf8 is text as is, base64 is any other file. Pass the page's `nextCursor` as `cursor` until it is null. A file listed with omitted too_large has no content here: download the whole project as a .zip from your Contributions page, or GET /api/v1/contributions/<versionId>/archive with your token. No hidden test is ever among the files.",
    input: { versionId: id("version"), ...pageInput },
    scoped: false,
    path: ({ versionId, ...page }) =>
      contribution(versionId, `/handout/files${pageQuery(page)}`),
  }),
  tool({
    name: "preview_submission",
    title: "Preview submission",
    scope: CONTRIBUTOR_SCOPE,
    audience: "contributor",
    description:
      "See what files would be submitted, and what would get them refused, without submitting: the files changed or added, the guide and editor files left out (TASK.md, AGENTS.md, CLAUDE.md, README.md, .vscode/), and each refusal by path with its reason (a changed test or config file, a file where none may go). Nothing is stored and no attempt is spent. Pass retryOf to preview a retry. Call it before submit or retry.",
    input: {
      versionId: id("version"),
      files: filesInput,
      retryOf: id("submission to retry").optional(),
    },
    scoped: false,
    method: "POST",
    readOnly: true,
    path: ({ versionId, retryOf }) =>
      contribution(
        versionId,
        retryOf === undefined
          ? "/submissions?dryRun=1"
          : `/submissions/${enc(retryOf)}/retry?dryRun=1`,
      ),
    body: ({ files }) => ({ files }),
  }),
  tool({
    name: "submit",
    title: "Submit work",
    scope: CONTRIBUTOR_SCOPE,
    audience: "contributor",
    description: `Submit your work on a version for grading against its public and hidden tests: the files you changed or added, each whole. Guide and editor files, and build output beside its source (a .js beside its .ts, .map), are dropped. It runs in the background: poll get_my_submission for the verdict (passed, incomplete, overfit with the failing scenarios' keys, or refused with each file's reason). A second first submission is refused already_submitted, naming the first: retry that one instead. ${RULES} A command-line client may instead POST the zipped project folder to /api/v1/contributions/<versionId>/submissions/zip (application/zip, ?dryRun=1 to preview) with an lnxc_ token.`,
    input: { versionId: id("version"), files: filesInput },
    scoped: false,
    method: "POST",
    path: ({ versionId }) => contribution(versionId, "/submissions"),
    body: ({ files }) => ({ files }),
  }),
  tool({
    name: "list_my_submissions",
    title: "List my submissions",
    scope: CONTRIBUTOR_SCOPE,
    audience: "contributor",
    description:
      "List your own submissions to a version, newest first, with each one's status and verdict; a retry names the submission it retried.",
    input: { versionId: id("version") },
    scoped: false,
    path: ({ versionId }) => contribution(versionId, "/submissions"),
  }),
  tool({
    name: "get_my_submission",
    title: "Get my submission",
    scope: CONTRIBUTOR_SCOPE,
    audience: "contributor",
    description:
      "Read one of your submissions: queued, running, passed, failed or errored; the verdict, the public and hidden test counts, the keys of the spec scenarios a failing hidden test covers, and each refused file's reason. Never a hidden test's name, code or output. Poll it after submit, retry or regrade.",
    input: { versionId: id("version"), submissionId: id("submission") },
    scoped: false,
    path: ({ versionId, submissionId }) =>
      contribution(versionId, `/submissions/${enc(submissionId)}`),
  }),
  tool({
    name: "retry",
    title: "Retry submission",
    scope: CONTRIBUTOR_SCOPE,
    audience: "contributor",
    description: `Retry your submission that did not pass, once, with changed files, after reading its failing scenario keys with get_my_submission. Sent with the same files to an errored submission, it is graded again without spending the retry (or call regrade). ${RULES}`,
    input: {
      versionId: id("version"),
      submissionId: id("submission"),
      files: filesInput,
    },
    scoped: false,
    method: "POST",
    path: ({ versionId, submissionId }) =>
      contribution(versionId, `/submissions/${enc(submissionId)}/retry`),
    body: ({ files }) => ({ files }),
  }),
  tool({
    name: "regrade",
    title: "Regrade submission",
    scope: CONTRIBUTOR_SCOPE,
    audience: "contributor",
    description:
      "Grade your errored submission again with its own files: its grading could not run, which is the platform's failure, so no retry is spent. Taken while your access stands, even after the version stops taking new work. Any other state is refused (not_errored).",
    input: { versionId: id("version"), submissionId: id("submission") },
    scoped: false,
    method: "POST",
    path: ({ versionId, submissionId }) =>
      contribution(versionId, `/submissions/${enc(submissionId)}/regrade`),
  }),
] as const;

export type ToolName =
  (typeof TOOLS)[number]["name"] | (typeof CONTRIBUTOR_TOOLS)[number]["name"];

/**
 * The tools each MCP endpoint serves, by path: `MCP_TOOLSETS` in core,
 * shared with the web app's MCP page. `/mcp` names every workspace tool
 * and `/mcp/contribute` every contributor tool; a toolset names no other
 * (`mcp.test.ts`).
 */
export const TOOLSETS: Readonly<Record<string, readonly ToolName[]>> =
  MCP_TOOLSETS;

/** Whose tools an endpoint serves. */
export function toolsetAudience(path: string): ToolAudience {
  return path === MCP_CONTRIBUTOR_PATH ? "contributor" : "workspace";
}

/** The tools `path` serves, from its audience's list. */
export function toolsAt(path: string): readonly Tool[] {
  const names = new Set<string>(TOOLSETS[path] ?? []);
  const pool: readonly Tool[] =
    toolsetAudience(path) === "contributor" ? CONTRIBUTOR_TOOLS : TOOLS;
  return pool.filter((entry) => names.has(entry.name));
}

/**
 * The scopes an endpoint's tools need, in `API_SCOPES` order: what its
 * sign-in challenge and protected-resource metadata ask an MCP client to
 * request, so a client signed in through one plugin can use every tool
 * that plugin's skill names. The person may still untick any of them.
 * The contributor endpoint asks for the contributor scope alone.
 */
export function toolsetScopes(path: string): CredentialScope[] {
  const tools = toolsAt(path);
  if (toolsetAudience(path) === "contributor") {
    const needed = new Set<CredentialScope>(
      tools.flatMap((entry) => (entry.scope === null ? [] : [entry.scope])),
    );
    return CONTRIBUTOR_SCOPES.filter((scope) => needed.has(scope));
  }
  const needed = new Set<CredentialScope>(MCP_DEFAULT_SCOPES);
  for (const entry of tools) {
    if (entry.scope !== null) needed.add(entry.scope);
    for (const scope of entry.alsoScopes) needed.add(scope);
  }
  return API_SCOPES.filter((scope) => needed.has(scope));
}

/** Registers the tools `path` serves on `server`, calling through `call`. */
export function registerTools(
  server: McpServer,
  path: string,
  call: ApiCall,
  context: ToolContext,
): void {
  for (const entry of toolsAt(path)) entry.register(server, call, context);
}
