import type { BountyRouteOptions } from "./options.js";
export type { BountyRouteOptions } from "./options.js";
export { sizeIfNeverSized, startRun, startTicketRun } from "./start-run.js";
export type { StartRunResult, StartTicketRunResult } from "./start-run.js";

import { followsJira } from "@sandbox-factory/db";

/**
 * The Jira site a ticket's approval is posted to: its issue's board and
 * connection, while the issue is there. Null for a ticket written here, or
 * one whose issue has gone, whose approval is recorded here only.
 */
export async function siteOf(
  options: BountyRouteOptions,
  organizationId: string,
  ticketId: string,
) {
  const ticket = await options.tickets.get(organizationId, ticketId);
  if (ticket === null || ticket.jira === null || !followsJira(ticket)) {
    return null;
  }
  const registered = await options.boards.forRun(
    organizationId,
    ticket.jira.boardId,
  );
  const connection =
    registered === null || options.connections === undefined
      ? null
      : await options.connections.get(organizationId, registered.connectionId);
  return registered === null ? null : { registered, connection };
}

/** What a proposal's review reads the ticket through. */
export function reviewOptions(options: BountyRouteOptions) {
  return {
    proposals: options.proposals,
    issues: options.issues,
    tickets: options.tickets,
    boards: options.boards,
    ...(options.clientFor === undefined
      ? {}
      : { clientFor: options.clientFor }),
  };
}
