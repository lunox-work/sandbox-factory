/**
 * Which tickets are worth offering as bounties, and why.
 *
 * A run does not take a fixed number of tickets. It takes every open ticket
 * that fits at least one **category** below, and records the reason with it,
 * so a person reviewing a proposal sees "Blocks 3 open tickets, unassigned"
 * rather than a bare list of old tickets.
 *
 * **This file is the one place the categories live, and it is meant to be
 * edited.** The categories and their criteria are expected to change:
 *
 * - To change a number, edit a category's `defaults`. A board can also
 *   override any of them in its own settings without a change here.
 * - To change what a category looks for, edit its `rule`: add, drop or
 *   regroup the signals. `silent(...)` keeps a criterion out of the reason.
 * - To add a category, append an entry. To retire one, delete it. Nothing
 *   outside this file names a category: the settings schema, the selection
 *   and the UI all read this list.
 * - A criterion no signal covers yet is a new signal in `signals.ts`, and a
 *   new fact in `facts.ts` if a ticket does not already carry it.
 *
 * A category's `id` is stored on runs and in board settings, so renaming one
 * orphans those settings (they are ignored, not an error). `label` is free
 * to change: it is copied onto each match when the match is made.
 */

import type { IssueFacts } from "./facts.js";
import { all, any, evaluate, silent, type Rule } from "./rules.js";
import {
  blocksAtLeast,
  bug,
  carriedAtLeast,
  commentsAtLeast,
  deadlineWithin,
  duplicatesAtLeast,
  neverInSprint,
  notInSprint,
  openAtLeast,
  priorityAtMost,
  quietAtLeast,
  unassigned,
  votesAtLeast,
  watchersAtLeast,
} from "./signals.js";

/** A category's tunable numbers, by name. */
export type Thresholds = Readonly<Record<string, number>>;

export interface Category {
  /** Stable, stored. Kebab-case. */
  readonly id: string;
  /** What a person sees. */
  readonly label: string;
  /** Why a ticket like this is worth outsourcing, for the UI to explain. */
  readonly why: string;
  /** Every threshold the rule reads, at its default. */
  readonly defaults: Thresholds;
  /** The criteria, built from the thresholds in force. */
  readonly rule: (thresholds: Thresholds) => Rule;
}

/**
 * Declares a category with its thresholds typed from its own defaults, so a
 * rule that reads a threshold the defaults do not declare fails to compile.
 */
function defineCategory<T extends Thresholds>(definition: {
  readonly id: string;
  readonly label: string;
  readonly why: string;
  readonly defaults: T;
  readonly rule: (thresholds: T) => Rule;
}): Category {
  // Sound because `thresholdsFor` always starts from `defaults`: a rule is
  // never handed an object missing one of the keys it was typed against.
  return definition as unknown as Category;
}

export const CATEGORIES: readonly Category[] = [
  defineCategory({
    id: "left-behind",
    label: "Left behind",
    why: "The team has shown it won't reach this, so outsourcing takes nothing off the roadmap.",
    defaults: { minAgeDays: 180, minQuietDays: 90 },
    rule: (t) =>
      all(
        openAtLeast(t.minAgeDays),
        neverInSprint,
        unassigned,
        silent(quietAtLeast(t.minQuietDays)),
      ),
  }),
  defineCategory({
    id: "always-next-sprint",
    label: "Always next sprint",
    why: "Already planned and wanted; the only blocker is capacity.",
    defaults: { minSprints: 2 },
    rule: (t) => carriedAtLeast(t.minSprints),
  }),
  defineCategory({
    id: "quietly-wanted",
    label: "Quietly wanted",
    why: "Shows demand that the priority field hides, which justifies a higher bounty.",
    defaults: { minVotes: 3, minWatchers: 5, minDuplicates: 1, minComments: 5 },
    rule: (t) =>
      all(
        any(
          votesAtLeast(t.minVotes),
          watchersAtLeast(t.minWatchers),
          commentsAtLeast(t.minComments),
          duplicatesAtLeast(t.minDuplicates),
        ),
        priorityAtMost("low"),
      ),
  }),
  defineCategory({
    id: "holding-others-up",
    label: "Holding others up",
    why: "One bounty unblocks several tickets the team will do in-house.",
    defaults: { minBlocked: 1 },
    rule: (t) => all(blocksAtLeast(t.minBlocked), unassigned),
  }),
  defineCategory({
    id: "paper-cuts",
    label: "Paper cuts",
    why: "Small, self-contained bugs are what agents fix most reliably, and users notice when they're gone.",
    defaults: { minAgeDays: 90 },
    rule: (t) =>
      all(bug, silent(priorityAtMost("medium")), openAtLeast(t.minAgeDays)),
  }),
  defineCategory({
    id: "deadline-exposed",
    label: "Deadline exposed",
    why: "The deadline justifies paying now rather than waiting for capacity.",
    defaults: { withinDays: 30 },
    rule: (t) =>
      all(deadlineWithin(t.withinDays), silent(unassigned), notInSprint),
  }),
];

/**
 * What stands where a category id would for the tickets in no category:
 * one somebody picked by hand, or one sized before there were categories.
 *
 * Not a category. It has no rule, nothing is ever matched to it and no
 * board can configure it. But it travels where a category id does — the
 * list's filter, a link to a view — so no category may take it as its id.
 */
export const UNCATEGORIZED = "uncategorized";

/** One category's settings on a board. Everything absent means "default". */
export interface CategorySettings {
  readonly enabled?: boolean | undefined;
  readonly thresholds?:
    Readonly<Record<string, number | null | undefined>> | undefined;
}

/** A board's category settings, by category id. */
export type CategoryConfig = Readonly<
  Record<string, CategorySettings | undefined>
>;

/** A category as one board runs it: on or off, with its numbers resolved. */
export interface ResolvedCategory {
  readonly id: string;
  readonly label: string;
  readonly why: string;
  readonly enabled: boolean;
  readonly thresholds: Thresholds;
}

/** Why one ticket was selected. */
export interface CategoryMatch {
  readonly id: string;
  readonly label: string;
  /** One line a reviewer reads: "Open 412 days, never in a sprint, unassigned". */
  readonly reason: string;
}

/**
 * The thresholds in force: the category's defaults, with a board's overrides
 * laid over them. An override for a threshold the category does not declare
 * is ignored, as is anything that is not a finite number, so settings saved
 * against an older definition cannot break a rule.
 */
function thresholdsFor(
  category: Category,
  settings: CategorySettings | undefined,
): Thresholds {
  const thresholds: Record<string, number> = { ...category.defaults };
  for (const [key, value] of Object.entries(settings?.thresholds ?? {})) {
    if (
      key in category.defaults &&
      typeof value === "number" &&
      Number.isFinite(value)
    ) {
      thresholds[key] = value;
    }
  }
  return thresholds;
}

/** Every category as a board's settings resolve it. */
export function resolveCategories(
  config: CategoryConfig = {},
  categories: readonly Category[] = CATEGORIES,
): ResolvedCategory[] {
  return categories.map((category) => {
    // `Object.hasOwn`, not a bare lookup: the config arrives from stored
    // JSON, and a lookup would find `constructor` on any object.
    const settings = Object.hasOwn(config, category.id)
      ? config[category.id]
      : undefined;
    return {
      id: category.id,
      label: category.label,
      why: category.why,
      enabled: settings?.enabled ?? true,
      thresholds: thresholdsFor(category, settings),
    };
  });
}

function sentence(clauses: readonly string[], fallback: string): string {
  const text = clauses.join(", ");
  return text === "" ? fallback : text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * A classifier for one board's settings: the rules are built once, then
 * applied to each ticket. Returns every category a ticket fits, in registry
 * order; an empty list means the ticket is not selected.
 */
export function createClassifier(
  config: CategoryConfig = {},
  categories: readonly Category[] = CATEGORIES,
): (facts: IssueFacts) => CategoryMatch[] {
  const resolved = new Map(
    resolveCategories(config, categories).map((entry) => [entry.id, entry]),
  );
  const active = categories.flatMap((category) => {
    const entry = resolved.get(category.id);
    return entry === undefined || !entry.enabled
      ? []
      : [{ category, rule: category.rule(entry.thresholds) }];
  });

  return (facts) =>
    active.flatMap(({ category, rule }) => {
      const result = evaluate(rule, facts);
      return result.matched
        ? [
            {
              id: category.id,
              label: category.label,
              reason: sentence(result.clauses, category.label),
            },
          ]
        : [];
    });
}

/** Classifies one ticket. For many, build a classifier once instead. */
export function classify(
  facts: IssueFacts,
  config: CategoryConfig = {},
  categories: readonly Category[] = CATEGORIES,
): CategoryMatch[] {
  return createClassifier(config, categories)(facts);
}
