/**
 * Which tickets a run considers: the coarse filter Jira applies before the
 * categories are tested.
 *
 * Selection happens in two steps, and this is only the first. Most of what a
 * category looks for cannot be said in JQL at all: how many sprints a ticket
 * was carried through, how many open tickets it blocks, how many people
 * watch it. So the JQL here only narrows a board to its **candidates** —
 * open work of a kind that can carry a bounty — and every candidate is then
 * classified in code against the category registry in `sandbox-factory`.
 *
 * The query is always run against `/board/{id}/issue`, for every kind of
 * board. The backlog endpoint would be the natural choice for a Scrum board,
 * but it returns only tickets outside every sprint, which hides precisely the
 * tickets that keep being planned and never finished.
 */

import type { BoardSelection } from "@sandbox-factory/shared";

/**
 * A label a client can put on a ticket to keep it out of every run.
 *
 * Deliberately a label rather than a setting: it needs no UI on our side, and
 * the person who knows a ticket should not be priced is looking at the ticket.
 */
export const SKIP_LABEL = "bounty-skip";

/**
 * Escapes a value for a JQL string literal.
 *
 * `issueTypes` reaches here from a request body, so this is the boundary
 * between user input and a query language. JQL strings are double-quoted with
 * backslash escapes, so a name containing a quote would otherwise end the
 * literal and let the rest be read as JQL.
 */
function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export interface SelectionJqlOptions {
  /** Restrict to one project. The agile endpoints already scope to a board. */
  projectKey?: string | undefined;
  /** Injectable so a run's window does not shift while it executes. */
  now?: Date;
}

/** The JQL a run appends to the board's own filter. */
export function selectionJql(
  selection: Pick<
    BoardSelection,
    "issueTypes" | "unassignedOnly" | "minAgeDays" | "maxAgeDays"
  >,
  options: SelectionJqlOptions = {},
): string {
  const clauses: string[] = [];

  if (options.projectKey !== undefined && options.projectKey !== "") {
    clauses.push(`project = ${quote(options.projectKey)}`);
  }

  // Epics are containers for work rather than work; sub-tasks are priced with
  // their parent. `subTaskIssueTypes()` is a JQL function, so it covers
  // whatever a site calls its sub-task types.
  clauses.push("issuetype not in (Epic, subTaskIssueTypes())");

  if (selection.issueTypes.length > 0) {
    clauses.push(
      `issuetype in (${selection.issueTypes.map(quote).join(", ")})`,
    );
  }

  // `/board/{id}/issue` returns everything on the board, finished work
  // included. "Not done" rather than "to do": a ticket started three sprints
  // ago and never finished is still open work.
  clauses.push("statusCategory != Done");

  if (selection.unassignedOnly) {
    clauses.push("assignee is EMPTY");
  }

  // `not in` rather than `!=`: a ticket carrying the label among several
  // others must still be excluded.
  clauses.push(`(labels is EMPTY OR labels not in (${quote(SKIP_LABEL)}))`);

  const now = options.now ?? new Date();
  if (selection.minAgeDays > 0) {
    clauses.push(`created <= ${quote(isoDate(now, -selection.minAgeDays))}`);
  }
  if (selection.maxAgeDays !== undefined) {
    clauses.push(`created >= ${quote(isoDate(now, -selection.maxAgeDays))}`);
  }

  // The order no longer decides *which* tickets are taken: every match is.
  // It is kept because paging needs a stable one, and `key ASC` breaks ties
  // so a run twice over an unchanged board plans the same tickets in the
  // same order — several created in the same minute is common after an
  // import.
  return `${clauses.join(" AND ")} ORDER BY created ASC, key ASC`;
}

/** `yyyy/MM/dd`, which is what JQL's date comparisons take. */
function isoDate(from: Date, offsetDays: number): string {
  const date = new Date(from.getTime() + offsetDays * 86_400_000);
  const month = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${date.getUTCDate()}`.padStart(2, "0");
  return `${date.getUTCFullYear()}/${month}/${day}`;
}
