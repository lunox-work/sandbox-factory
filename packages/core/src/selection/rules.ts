/**
 * The grammar a category's criteria are written in.
 *
 * A **signal** is one observation about a ticket: a test, and the clause it
 * contributes to the reason when it holds. A **rule** combines signals with
 * `all` and `any`, nested as deep as the criteria need. Evaluating a rule
 * answers two things at once: whether the ticket matched, and the clauses
 * that say why, in the order the rule lists them.
 *
 * Nothing here knows a category or a threshold. A signal is built with its
 * threshold already in hand (`openAtLeast(180)`), so changing a criterion is
 * changing the arguments or the composition, never this file.
 */

import type { IssueFacts } from "./facts.js";

export interface Signal {
  /** Names the observation, for tests and for a reader of the registry. */
  readonly id: string;
  readonly test: (facts: IssueFacts) => boolean;
  /** The clause for the reason. Null when the signal has nothing to say. */
  readonly describe: (facts: IssueFacts) => string | null;
}

export type Rule =
  | Signal
  | { readonly all: readonly Rule[] }
  | { readonly any: readonly Rule[] };

/** Every rule must hold. */
export function all(...rules: Rule[]): Rule {
  return { all: rules };
}

/** At least one rule must hold. Each that does adds to the reason. */
export function any(...rules: Rule[]): Rule {
  return { any: rules };
}

/**
 * The same test, contributing nothing to the reason.
 *
 * For a criterion that must hold but that the reader does not need told: a
 * reason reads better as the two or three facts that make the case than as
 * every condition the ticket passed.
 */
export function silent(signal: Signal): Signal {
  return { ...signal, describe: () => null };
}

export function signal(
  id: string,
  test: Signal["test"],
  describe: Signal["describe"],
): Signal {
  return { id, test, describe };
}

export interface Evaluation {
  readonly matched: boolean;
  /** The clauses of the signals that held. Empty when the rule did not. */
  readonly clauses: readonly string[];
}

const MISSED: Evaluation = { matched: false, clauses: [] };

/**
 * Evaluates a rule against a ticket's facts.
 *
 * `any` evaluates every branch rather than stopping at the first that holds:
 * a ticket with nine watchers *and* three duplicates should say both.
 */
export function evaluate(rule: Rule, facts: IssueFacts): Evaluation {
  if ("all" in rule) {
    const parts = rule.all.map((part) => evaluate(part, facts));
    return parts.every((part) => part.matched)
      ? { matched: true, clauses: parts.flatMap((part) => part.clauses) }
      : MISSED;
  }
  if ("any" in rule) {
    const held = rule.any
      .map((part) => evaluate(part, facts))
      .filter((part) => part.matched);
    return held.length === 0
      ? MISSED
      : { matched: true, clauses: held.flatMap((part) => part.clauses) };
  }
  if (!rule.test(facts)) return MISSED;
  const clause = rule.describe(facts);
  return { matched: true, clauses: clause === null ? [] : [clause] };
}
