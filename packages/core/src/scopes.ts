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

/** The prefix every workspace API token carries, so a leaked one is findable. */
export const API_TOKEN_PREFIX = "lnx_";

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
