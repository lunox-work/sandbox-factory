import { followsJira } from "@sandbox-factory/db";

import type { PricingRouteOptions } from "./options.js";

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

/**
 * Whether a Jira update for the proposal is still unresolved: queued,
 * being sent, or sent without knowing whether it arrived. A decision made
 * over one would race it to the bounty, or contradict it there.
 */
export function writebackBusy(
  operations: readonly { readonly status: string }[],
): boolean {
  return operations.some(
    ({ status }) =>
      status === "pending" || status === "running" || status === "uncertain",
  );
}
