/**
 * What selection knows about one ticket, in the units the signals compare.
 *
 * Two shapes, deliberately apart. `SelectionIssue` is the ticket as a tracker
 * hands it over: dates as strings, links as a list, a priority by name.
 * `IssueFacts` is the same ticket reduced to numbers and flags: how many days
 * old, how many open tickets it blocks, whether anyone owns it. A signal only
 * ever reads facts, so a signal is one comparison, and a test can hand it
 * plain numbers without building a ticket.
 *
 * `factsFor` is the only function that reads the tracker's shape. A new
 * signal that needs something a ticket already carries is one new fact here.
 */

/** A link from the ticket to another one. */
export interface SelectionLink {
  /** The link type's name as the tracker spells it: `Blocks`, `Duplicate`. */
  readonly type: string;
  /** `outward` is this ticket acting on the other: it blocks, it duplicates. */
  readonly direction: "inward" | "outward";
  /** The other ticket's status category. `done` means it is closed. */
  readonly statusCategory: string;
}

/** A sprint that closed with the ticket still open in it. */
export interface SelectionClosedSprint {
  readonly startDate: string | null;
  readonly endDate: string | null;
}

/** A release the ticket is slated for. */
export interface SelectionRelease {
  readonly name: string;
  readonly releaseDate: string | null;
  readonly released: boolean;
}

/** One ticket, as selection needs it. Structural, so any DTO with these fits. */
export interface SelectionIssue {
  readonly assignee: string | null;
  readonly priority: string | null;
  readonly issueType: string;
  readonly created: string | null;
  readonly updated: string | null;
  readonly dueDate: string | null;
  /** The sprint the ticket sits in now, if any. */
  readonly sprint: { readonly state: string } | null;
  readonly closedSprints: readonly SelectionClosedSprint[];
  readonly votes: number | null;
  readonly watchers: number | null;
  /** Not read yet by any tracker client; see `IssueFacts.commentCount`. */
  readonly commentCount?: number | null;
  readonly links: readonly SelectionLink[];
  readonly releases: readonly SelectionRelease[];
}

export type PriorityRank = "low" | "medium" | "high" | "none";

export interface IssueFacts {
  /** Whole days since it was created. 0 when the date is unknown. */
  readonly ageDays: number;
  /** Whole days since anything on it changed. 0 when the date is unknown. */
  readonly daysSinceUpdate: number;
  readonly assigned: boolean;
  /** In an active or future sprint right now. */
  readonly inSprint: boolean;
  /** Sprints that closed with the ticket unfinished in them. */
  readonly closedSprintCount: number;
  /** When the first of those began, as a reader says it: `March`. */
  readonly carriedSince: string | null;
  readonly votes: number;
  readonly watchers: number;
  /** Other tickets filed as duplicates of this one. */
  readonly duplicateLinks: number;
  /** Open tickets this one blocks. */
  readonly blocksOpenCount: number;
  /**
   * Null until a client reads it. A tracker's comment field carries comment
   * bodies, and a list read must not carry ticket text, so counting comments
   * needs a read of its own. The signal exists; this fact is what it waits on.
   */
  readonly commentCount: number | null;
  /** The priority as the tracker names it, for a reason a person reads. */
  readonly priorityName: string | null;
  readonly priorityRank: PriorityRank;
  readonly isBug: boolean;
  /** Calendar days to the due date. Negative once it has passed. */
  readonly dueInDays: number | null;
  /** The nearest unreleased version still ahead, if one has a date. */
  readonly release: { readonly name: string; readonly inDays: number } | null;
}

/**
 * Priority names, ranked. Trackers let a site rename its priorities, so this
 * is by name and case-insensitive, and anything not listed ranks `high`:
 * an unrecognised priority must not be mistaken for an unimportant one.
 */
export const PRIORITY_RANKS: Readonly<Record<string, PriorityRank>> = {
  lowest: "low",
  trivial: "low",
  low: "low",
  minor: "low",
  medium: "medium",
  normal: "medium",
};

/** Issue type names that mean a defect rather than planned work. */
export const BUG_ISSUE_TYPES: readonly string[] = ["bug", "defect"];

/** Link type names, matched as a case-insensitive substring. */
const BLOCKS_LINK = "block";
const DUPLICATE_LINK = "duplicate";

const DAY_MS = 86_400_000;

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

function timestamp(value: string | null): number | null {
  if (value === null) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

/** Whole days elapsed. A date in the future counts as today. */
function daysSince(value: string | null, now: Date): number {
  const at = timestamp(value);
  return at === null
    ? 0
    : Math.max(0, Math.floor((now.getTime() - at) / DAY_MS));
}

function utcDay(at: number): number {
  const date = new Date(at);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/**
 * Calendar days until a date, in UTC. A due date is a day, not an instant:
 * something due tomorrow is one day away at any hour of today.
 */
function daysUntil(value: string | null, now: Date): number | null {
  const at = timestamp(value);
  return at === null
    ? null
    : Math.round((utcDay(at) - utcDay(now.getTime())) / DAY_MS);
}

/** `March`, or `March 2025` when it was not this year. */
function monthOf(at: number, now: Date): string {
  const date = new Date(at);
  const month = MONTHS[date.getUTCMonth()] as string;
  return date.getUTCFullYear() === now.getUTCFullYear()
    ? month
    : `${month} ${date.getUTCFullYear()}`;
}

function rankOf(priority: string | null): PriorityRank {
  if (priority === null || priority.trim() === "") return "none";
  return PRIORITY_RANKS[priority.trim().toLowerCase()] ?? "high";
}

/** The facts about one ticket as of `now`. Pure, so a run can pin its clock. */
export function factsFor(issue: SelectionIssue, now: Date): IssueFacts {
  const sprintStarts = issue.closedSprints
    .map((sprint) => timestamp(sprint.startDate) ?? timestamp(sprint.endDate))
    .filter((at): at is number => at !== null);

  let release: IssueFacts["release"] = null;
  for (const candidate of issue.releases) {
    if (candidate.released) continue;
    const inDays = daysUntil(candidate.releaseDate, now);
    if (inDays === null || inDays < 0) continue;
    if (release === null || inDays < release.inDays) {
      release = { name: candidate.name, inDays };
    }
  }

  const priorityName =
    issue.priority === null || issue.priority.trim() === ""
      ? null
      : issue.priority.trim();

  return {
    ageDays: daysSince(issue.created, now),
    daysSinceUpdate: daysSince(issue.updated, now),
    assigned: issue.assignee !== null,
    inSprint: issue.sprint !== null && issue.sprint.state !== "closed",
    closedSprintCount: issue.closedSprints.length,
    carriedSince:
      sprintStarts.length === 0
        ? null
        : monthOf(Math.min(...sprintStarts), now),
    votes: issue.votes ?? 0,
    watchers: issue.watchers ?? 0,
    // Inward only: tickets that duplicate *this* one. The outward side is
    // this ticket being the duplicate, which is no evidence anyone wants it
    // and would offer the same work once per copy.
    duplicateLinks: issue.links.filter(
      (link) =>
        link.direction === "inward" &&
        link.type.toLowerCase().includes(DUPLICATE_LINK),
    ).length,
    blocksOpenCount: issue.links.filter(
      (link) =>
        link.direction === "outward" &&
        link.type.toLowerCase().includes(BLOCKS_LINK) &&
        link.statusCategory !== "done",
    ).length,
    commentCount: issue.commentCount ?? null,
    priorityName,
    priorityRank: rankOf(issue.priority),
    isBug: BUG_ISSUE_TYPES.includes(issue.issueType.trim().toLowerCase()),
    dueInDays: daysUntil(issue.dueDate, now),
    release,
  };
}
