/**
 * How much work a scenario adds to its ticket.
 *
 * Every scenario carries a weight, the drafting model's judgement made in
 * the same call that wrote the scenario. A judgement, not a fact: it is
 * made without the repository. What makes it usable is that it is cheap
 * (the model has just written the scenario) and reviewable (the reason
 * sits beside the scenario in the Scenarios tab).
 *
 * **This file is the rubric, and it is meant to be edited.** The draft
 * prompt reads `SCENARIO_WEIGHT_DEFINITIONS`, so a change to what a weight
 * covers reaches the model with no change elsewhere. A weight's `id` is
 * stored on every scenario, so renaming one orphans the scenarios that
 * carry it; `label` and `covers` are free to change. The points a weight
 * is worth are the step's to decide, and a board can override them
 * (`pricing/step`).
 */

import type { Scenario, SpecDraft } from "./spec.js";

export interface ScenarioWeightDefinition {
  /** Stable, stored. */
  readonly id: string;
  /** What a person sees on the badge. */
  readonly label: string;
  /** What makes a scenario this weight, for the model and for the reader. */
  readonly covers: string;
}

/** Lightest first, which is the order a reader compares them in. */
export const SCENARIO_WEIGHT_DEFINITIONS = [
  {
    id: "light",
    label: "Light",
    covers:
      "exercised by code the other scenarios already need: a new assertion, a copy change, a guard clause",
  },
  {
    id: "moderate",
    label: "Moderate",
    covers:
      "its own branch or state: a new validation, a new error path, a new query",
  },
  {
    id: "heavy",
    label: "Heavy",
    covers:
      "its own mechanism: a new integration, a job, a migration, a concurrency or recovery path that needs infrastructure to test",
  },
] as const satisfies readonly ScenarioWeightDefinition[];

export type ScenarioWeight = (typeof SCENARIO_WEIGHT_DEFINITIONS)[number]["id"];

/** The weight ids alone, lightest first, as a tuple a schema can take. */
export const SCENARIO_WEIGHTS = SCENARIO_WEIGHT_DEFINITIONS.map(
  ({ id }) => id,
) as unknown as readonly [ScenarioWeight, ...ScenarioWeight[]];

/** How long a weight's reason may be: one short phrase. */
export const WEIGHT_REASON_CHARS = 120;

/**
 * What each weight counts for, by default. With the step's default of four
 * points a half size, a heavy scenario is a half step on its own, two
 * moderate ones are, and four light ones are.
 */
export const WEIGHT_POINTS: Readonly<Record<ScenarioWeight, number>> = {
  light: 1,
  moderate: 2,
  heavy: 4,
};

/**
 * The points these scenarios add up to, or null when any of them has no
 * weight: a spec drafted before weights existed (`draft-v1`) cannot be
 * counted, and counting it as zero would make every scenario a later
 * revision added look like growth.
 *
 * A weight this registry no longer has counts as unweighed, for the same
 * reason a retired kind is left out of `countScenarios`.
 */
export function pointsOfScenarios(
  scenarios: readonly Scenario[],
  points: Readonly<Record<ScenarioWeight, number>> = WEIGHT_POINTS,
): number | null {
  let total = 0;
  for (const { weight } of scenarios) {
    if (weight === undefined || !Object.hasOwn(points, weight)) return null;
    total += points[weight];
  }
  return total;
}

/** The points a whole spec adds up to; see `pointsOfScenarios`. */
export function pointsOf(
  draft: SpecDraft,
  points: Readonly<Record<ScenarioWeight, number>> = WEIGHT_POINTS,
): number | null {
  return pointsOfScenarios(draft.scenarios, points);
}
