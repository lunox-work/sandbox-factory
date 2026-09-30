/**
 * The signals categories are built from.
 *
 * Each is one comparison against a ticket's facts, plus the clause it adds to
 * a reason. The ones that take a number are functions of that number, so the
 * registry passes a threshold in and a board can override it.
 *
 * Clauses start lower-case. The reason capitalises whichever comes first, so
 * the same signal reads correctly anywhere in a sentence.
 */

import type { IssueFacts, PriorityRank } from "./facts.js";
import { signal, type Signal } from "./rules.js";

function count(value: number, noun: string, plural = `${noun}s`): string {
  return `${value} ${value === 1 ? noun : plural}`;
}

/** Nobody is assigned. */
export const unassigned: Signal = signal(
  "unassigned",
  (facts) => !facts.assigned,
  () => "unassigned",
);

/** Not in a sprint now, and never carried through one. */
export const neverInSprint: Signal = signal(
  "never-in-sprint",
  (facts) => !facts.inSprint && facts.closedSprintCount === 0,
  () => "never in a sprint",
);

/** Not in an active or future sprint, whatever its history. */
export const notInSprint: Signal = signal(
  "not-in-sprint",
  (facts) => !facts.inSprint,
  () => "not in any sprint",
);

/** A defect, by issue type. Says its priority when it has one. */
export const bug: Signal = signal(
  "bug",
  (facts) => facts.isBug,
  (facts) =>
    facts.priorityName === null ? "bug" : `${facts.priorityName}-priority bug`,
);

export function openAtLeast(days: number): Signal {
  return signal(
    "open-at-least",
    (facts) => facts.ageDays >= days,
    (facts) => `open ${count(facts.ageDays, "day")}`,
  );
}

export function quietAtLeast(days: number): Signal {
  return signal(
    "quiet-at-least",
    (facts) => facts.daysSinceUpdate >= days,
    (facts) => `no update in ${count(facts.daysSinceUpdate, "day")}`,
  );
}

export function carriedAtLeast(sprints: number): Signal {
  return signal(
    "carried-at-least",
    (facts) => facts.closedSprintCount >= sprints,
    (facts) =>
      `carried over ${count(facts.closedSprintCount, "sprint")}${
        facts.carriedSince === null ? "" : ` since ${facts.carriedSince}`
      }`,
  );
}

export function votesAtLeast(votes: number): Signal {
  return signal(
    "votes-at-least",
    (facts) => facts.votes >= votes,
    (facts) => count(facts.votes, "vote"),
  );
}

export function watchersAtLeast(watchers: number): Signal {
  return signal(
    "watchers-at-least",
    (facts) => facts.watchers >= watchers,
    (facts) => count(facts.watchers, "watcher"),
  );
}

export function duplicatesAtLeast(links: number): Signal {
  return signal(
    "duplicates-at-least",
    (facts) => facts.duplicateLinks >= links,
    (facts) => `${count(facts.duplicateLinks, "duplicate")} linked`,
  );
}

/** Never holds while the comment count is unread; see `IssueFacts`. */
export function commentsAtLeast(comments: number): Signal {
  return signal(
    "comments-at-least",
    (facts) => facts.commentCount !== null && facts.commentCount >= comments,
    (facts) => count(facts.commentCount ?? 0, "comment"),
  );
}

export function blocksAtLeast(tickets: number): Signal {
  return signal(
    "blocks-at-least",
    (facts) => facts.blocksOpenCount >= tickets,
    (facts) => `blocks ${count(facts.blocksOpenCount, "open ticket")}`,
  );
}

const RANK_ORDER: Readonly<Record<PriorityRank, number>> = {
  none: Number.POSITIVE_INFINITY,
  low: 0,
  medium: 1,
  high: 2,
};

/**
 * Priority no higher than `rank`. A ticket with no priority never holds: the
 * absence of a priority is not a statement that the ticket is unimportant.
 */
export function priorityAtMost(rank: "low" | "medium"): Signal {
  return signal(
    `priority-at-most-${rank}`,
    (facts) => RANK_ORDER[facts.priorityRank] <= RANK_ORDER[rank],
    (facts) => `priority ${facts.priorityName ?? "unset"}`,
  );
}

function within(days: number | null, limit: number): days is number {
  return days !== null && days >= 0 && days <= limit;
}

function inDays(days: number): string {
  return days === 0 ? "today" : `in ${count(days, "day")}`;
}

/**
 * A due date or a release within `days`, and still ahead. Something already
 * overdue is not approaching, so it does not hold.
 */
export function deadlineWithin(days: number): Signal {
  const releaseDays = (facts: IssueFacts) => facts.release?.inDays ?? null;
  return signal(
    "deadline-within",
    (facts) =>
      within(facts.dueInDays, days) || within(releaseDays(facts), days),
    (facts) => {
      const due = within(facts.dueInDays, days) ? facts.dueInDays : null;
      const release =
        facts.release !== null && within(facts.release.inDays, days)
          ? facts.release
          : null;
      // Whichever comes first is the deadline that matters.
      if (release !== null && (due === null || release.inDays < due)) {
        return `release ${release.name} ${inDays(release.inDays)}`;
      }
      return `due ${inDays(due ?? 0)}`;
    },
  );
}
