/**
 * What a machine credential may do in a workspace: the public API's scopes,
 * and the command-line clients that sign in by device flow.
 *
 * A scope widens nothing a role forbids. A route that only owners and admins
 * may use stays theirs whatever a credential's scopes say; a scope only lets
 * a credential reach the routes declared public with it.
 */

/** Every scope, readers first. The order is the order shown to a person. */
export const API_SCOPES = [
  "workspace:read",
  "integrations:write",
  "bounties:write",
  "pricing:write",
  "specs:write",
  "sandboxes:write",
  "submissions:write",
  "judge",
  "webhooks:write",
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

export function isApiScope(value: string): value is ApiScope {
  return (API_SCOPES as readonly string[]).includes(value);
}

/**
 * What a contributor credential holds: an invited contributor's own
 * versions (`/api/v1/contributions`), never a workspace's. Kept apart from
 * `API_SCOPES` so no workspace token, CLI client or workspace OAuth grant
 * can hold it, and a contributor credential holds nothing else.
 */
export const CONTRIBUTOR_SCOPES = ["contributions:write"] as const;

export type ContributorScope = (typeof CONTRIBUTOR_SCOPES)[number];

/** The one contributor scope: list, read, download and submit. */
export const CONTRIBUTOR_SCOPE: ContributorScope = "contributions:write";

/** Any scope a credential may carry: a workspace's, or a contributor's. */
export type CredentialScope = ApiScope | ContributorScope;

export function isContributorScope(value: string): value is ContributorScope {
  return (CONTRIBUTOR_SCOPES as readonly string[]).includes(value);
}

/** The prefix every workspace API token carries, so a leaked one is findable. */
export const API_TOKEN_PREFIX = "lnx_";

/**
 * The prefix on a contributor token: a person's own, bound to no
 * workspace, reaching only the contributor routes. Not `lnx_…`, so a
 * bearer value still names its kind.
 */
export const CONTRIBUTOR_TOKEN_PREFIX = "lnxc_";

/**
 * The prefixes on OAuth access and refresh tokens the platform issues to
 * MCP clients and other apps. Distinct from `lnx_`, and never in a session
 * token (those are bare alphanumerics), so a bearer value names its kind.
 */
export const OAUTH_ACCESS_TOKEN_PREFIX = "lnxat_";
export const OAUTH_REFRESH_TOKEN_PREFIX = "lnxrt_";

/**
 * The OAuth-only scope a client adds to get a refresh token. Granted with
 * the API scopes it accompanies, never on its own; it reaches no route.
 */
export const OFFLINE_ACCESS_SCOPE = "offline_access";

/**
 * What the OAuth consent page sends as the chosen workspace when the
 * person signs in as a contributor instead: the grant then binds no
 * workspace (its `reference_id` stays empty) and holds only
 * `CONTRIBUTOR_SCOPES`. See the API's `oauth/provider.ts`.
 */
export const CONTRIBUTOR_CONSENT = "contributor";

/**
 * The scope every workspace MCP endpoint asks for; each also asks for the
 * scopes its own write tools need (`toolsetScopes` in the API). The
 * contributor endpoint asks for `CONTRIBUTOR_SCOPES` alone.
 */
export const MCP_DEFAULT_SCOPES = [
  "workspace:read",
] as const satisfies readonly ApiScope[];

/**
 * The command-line clients that may sign in by device flow, and the most
 * each may be granted. A client asks for a subset; anything outside its
 * list is refused rather than trimmed, so a request never silently gets
 * less than it said.
 */
export const CLI_CLIENTS = {
  duediligence: [
    "workspace:read",
    "bounties:write",
    "specs:write",
    "sandboxes:write",
    "submissions:write",
    "judge",
  ],
  carveout: ["workspace:read", "sandboxes:write", "submissions:write"],
} as const satisfies Record<string, readonly ApiScope[]>;

export type CliClient = keyof typeof CLI_CLIENTS;

export const CLI_CLIENT_IDS = Object.keys(CLI_CLIENTS) as readonly CliClient[];

export function isCliClient(value: string): value is CliClient {
  return Object.hasOwn(CLI_CLIENTS, value);
}

/** The scopes `client` may hold. */
export function cliScopes(client: CliClient): readonly ApiScope[] {
  return CLI_CLIENTS[client];
}

/** The MCP endpoint for invited contributors, over their own credential. */
export const MCP_CONTRIBUTOR_PATH = "/mcp/contribute";

/**
 * The tools each MCP endpoint serves, by path: `/mcp` serves every
 * workspace tool, and each plugin's endpoint what its skill's hosted mode
 * names. `/mcp/contribute` serves the contributor tools, a set of their
 * own (some share a workspace tool's name, never its route). The API
 * registers them (`apps/api/src/mcp/tools.ts`, which checks every name is a
 * tool) and the web app's MCP page lists them.
 */
export const MCP_TOOLSETS = {
  "/mcp": [
    "list_workspaces",
    "get_usage",
    "list_bounties",
    "get_bounty",
    "get_proposal",
    "get_decisions",
    "confirm_link",
    "list_repositories",
    "get_snapshot",
    "list_boards",
    "search_issues",
    "list_sandboxes",
    "get_sandbox",
    "get_run",
    "post_bounty",
    "import_github_issue",
    "import_jira_issue",
    "size_bounty",
    "respec",
    "plan_slice",
    "start_sandbox",
    "cut_slice",
    "prepare",
    "get_handout",
    "get_project_files",
    "upload_handoff",
    "create_contributor_invite",
    "submit_patch",
    "judge",
    "retry",
    "regrade",
    "get_verdict",
    "get_submission_files",
    "connect_github",
    "connect_jira",
  ],
  "/mcp/duediligence": [
    "list_workspaces",
    "list_bounties",
    "get_bounty",
    "get_proposal",
    "get_run",
    "get_usage",
    "post_bounty",
    "import_github_issue",
    "import_jira_issue",
    "size_bounty",
    "respec",
    "get_decisions",
    "confirm_link",
    "list_sandboxes",
    "get_sandbox",
    "start_sandbox",
    "prepare",
    "get_handout",
    "get_project_files",
    "create_contributor_invite",
    "judge",
    "retry",
    "regrade",
    "get_verdict",
    "get_submission_files",
  ],
  // A slice is cut for a bounty with an approved proposal and built before
  // it is handed out, so carveout reaches the bounty, its sizing and
  // decisions, and the build, not only the slice.
  "/mcp/carveout": [
    "list_workspaces",
    "get_usage",
    "list_bounties",
    "get_bounty",
    "get_proposal",
    "get_decisions",
    "confirm_link",
    "post_bounty",
    "import_github_issue",
    "import_jira_issue",
    "size_bounty",
    "list_repositories",
    "get_snapshot",
    "list_sandboxes",
    "get_sandbox",
    "get_run",
    "plan_slice",
    "start_sandbox",
    "cut_slice",
    "prepare",
    "upload_handoff",
    "get_handout",
    "get_project_files",
    "create_contributor_invite",
    "submit_patch",
    "judge",
    "retry",
    "regrade",
    "get_verdict",
    "get_submission_files",
  ],
  // An invited contributor's own tools: their versions, each one's
  // project, and their submissions. No workspace tool is here, and no
  // workspace credential reaches these.
  [MCP_CONTRIBUTOR_PATH]: [
    "list_contributions",
    "get_contribution",
    "get_project_files",
    "preview_submission",
    "submit",
    "list_my_submissions",
    "get_my_submission",
    "retry",
    "regrade",
  ],
} as const satisfies Readonly<Record<string, readonly string[]>>;

export type McpPath = keyof typeof MCP_TOOLSETS;
