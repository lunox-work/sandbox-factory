/**
 * Which tickets a run prices: the oldest still sitting in a board's backlog.
 *
 * Two Jira concepts are in play and they are not interchangeable:
 *
 * - **The backlog endpoint** (`/board/{id}/backlog`) returns incomplete issues
 *   *not in an active or future sprint*. That is the real backlog, and it is
 *   what a Scrum board — or a Kanban board with the backlog feature enabled —
 *   answers.
 * - **A plain Kanban board has no backlog at all.** Its first column *is* the
 *   backlog, so the endpoint either errors or returns nothing, and the tickets
 *   have to be read through `/board/{id}/issue` filtered to the To Do
 *   category instead.
 *
 * `backlogJql` builds the filter; `backlogSource` decides which endpoint to
 * ask. The ordering is always `created ASC`, which is the whole point: oldest
 * first.
 */

import type { BoardSelection } from "@sandbox-factory/shared";

/**
 * A label a client can put on a ticket to keep it out of every run.
 *
 * Deliberately a label rather than a setting: it needs no UI on our side, and
 * the person who knows a ticket should not be priced is looking at the ticket.
 */
export const SKIP_LABEL = "bounty-skip";

/** Which endpoint serves a board's backlog. */
export type BacklogSource = "backlog" | "board-issues";

/**
 * Which endpoint to read, from the board's type.
 *
 * `unknown` takes the backlog endpoint: most boards are Scrum, and the caller
 * falls back to `board-issues` if it answers with an error. Guessing the other
 * way would silently read sprint-assigned tickets as though they were backlog.
 */
export function backlogSource(boardType: string): BacklogSource {
  return boardType.toLowerCase() === "kanban" ? "board-issues" : "backlog";
}

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

export interface BacklogJqlOptions {
  /** Restrict to one project. The agile endpoints already scope to a board. */
  projectKey?: string | undefined;
  /**
   * For `board-issues`, which does not filter to the backlog by itself: a
   * plain Kanban board's incomplete work is everything not Done.
   */
  source?: BacklogSource;
  /** Injectable so a run's window does not shift while it executes. */
  now?: Date;
}

/**
 * The JQL a run appends to the endpoint's own board filter.
 *
 * Note what is *not* here: `statusCategory != Done` for the backlog endpoint.
 * That endpoint returns incomplete issues by definition, and restating it
 * would be a claim that could drift from what Jira means by it.
 */
export function backlogJql(
  selection: BoardSelection,
  options: BacklogJqlOptions = {},
): string {
  const clauses: string[] = [];
  const source = options.source ?? "backlog";

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

  if (source === "board-issues") {
    // The backlog endpoint means "incomplete" on its own; this one does not.
    clauses.push('statusCategory = "To Do"');
  }

  if (selection.excludeAssigned) {
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

  // The ordering is the feature. Oldest first, and `key ASC` breaks ties so a
  // run twice over an unchanged board reads the same tickets in the same
  // order — several tickets created in the same minute are common after an
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
