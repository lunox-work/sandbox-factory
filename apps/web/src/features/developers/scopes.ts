/**
 * What each API scope lets a token do, in a person's words, for the token
 * form and the lists. The scopes and their order are core's (`API_SCOPES`);
 * keyed by `ApiScope` so a new scope fails the type check until it is
 * described here.
 */

import type { ApiScope } from "sandbox-factory";

export const SCOPE_SUMMARY: Record<ApiScope, string> = {
  "workspace:read":
    "Read bounties, proposals, repositories, boards, sandboxes and runs",
  "integrations:write": "Connect and change Jira and GitHub integrations",
  "bounties:write": "Write, edit and approve bounties",
  "pricing:write": "Size and price bounties (spends model calls)",
  "specs:write": "Change specs",
  "sandboxes:write": "Analyse repositories and build sandboxes",
  "submissions:write": "Submit work",
  judge: "Judge submissions",
  "webhooks:write": "Manage webhooks",
};
