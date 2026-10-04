import type { PricingRouteOptions } from "./options.js";
export type { PricingRouteOptions } from "./options.js";
export { sizeIfNeverSized, startRun, startBountyRun } from "./start-run.js";
export type { StartRunResult, StartBountyRunResult } from "./start-run.js";

import { followsJira } from "@sandbox-factory/db";

/**
 * The Jira site a bounty's approval is posted to: its issue's board and
 * connection, while the issue is there. Null for a bounty written here, or
 * one whose issue has gone, whose approval is recorded here only.
 */
export async function siteOf(
  options: PricingRouteOptions,
  organizationId: string,
  bountyId: string,
) {
  const bounty = await options.bounties.get(organizationId, bountyId);
  if (bounty === null || bounty.jira === null || !followsJira(bounty)) {
    return null;
  }
  const registered = await options.boards.forRun(
    organizationId,
    bounty.jira.boardId,
  );
  const connection =
    registered === null || options.connections === undefined
      ? null
      : await options.connections.get(organizationId, registered.connectionId);
  return registered === null ? null : { registered, connection };
}

/** What a proposal's review reads the bounty through. */
export function reviewOptions(options: PricingRouteOptions) {
  return {
    proposals: options.proposals,
    issues: options.issues,
    bounties: options.bounties,
    boards: options.boards,
    ...(options.clientFor === undefined
      ? {}
      : { clientFor: options.clientFor }),
  };
}
