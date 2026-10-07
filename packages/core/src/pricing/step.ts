/**
 * The scenario step: what a reviewer's additions to a spec do to its size.
 *
 * A bounty's base size is the model's, from the bounty alone, or a
 * reviewer's resize. The step moves it up by half sizes (S → S+ → M) as
 * the spec gains weight after the base was set, and back down as that
 * weight is trimmed. A fresh draft has added nothing, so a fresh sizing is
 * always a step of zero.
 *
 * **This file is meant to be edited**, as the category registry is: the
 * defaults are at the top, and a board can override any of them in its
 * own settings (`pricing.step`) without a change here.
 *
 * Why a difference of points and not a count of added scenarios:
 *
 * - trimming an added scenario takes its points back;
 * - trimming a draft scenario cannot take the size below its base, since
 *   the base already priced the draft in;
 * - an answer that rewrites a light scenario into a heavy one counts the
 *   growth;
 * - swapping one scenario for another of the same weight moves nothing.
 */

import {
  PRICED_BOUNTY_COMPLEXITIES,
  type PricedComplexity,
  type WholeComplexity,
} from "../sizing.js";
import { scenarioKey, type ScenarioKind, type SpecDraft } from "./spec.js";
import {
  pointsOf,
  SCENARIO_WEIGHTS,
  WEIGHT_POINTS,
  type ScenarioWeight,
} from "./weight.js";

/** Stored with every step, so an explanation is read from what was computed. */
export const STEP_VERSION = "step-v1";

export interface StepSettings {
  /** Points of added weight per half step. */
  readonly pointsPerStep: number;
  /** What each weight counts for. */
  readonly weightPoints: Readonly<Record<ScenarioWeight, number>>;
}

export const DEFAULT_STEP_SETTINGS: StepSettings = {
  pointsPerStep: 4,
  weightPoints: WEIGHT_POINTS,
};

/**
 * The range a setting may take. A half step needs at least one point, or
 * every scenario would be infinitely many steps; a weight may count for
 * nothing. The ceiling only keeps a typo from meaning anything.
 */
export const STEP_SETTING_LIMITS = {
  minPointsPerStep: 1,
  minWeightPoints: 0,
  maxPoints: 1_000,
} as const;

/**
 * A board's overrides, as stored. Absent means the default; in an update,
 * `null` clears an override.
 */
export interface StepConfig {
  readonly pointsPerStep?: number | null | undefined;
  readonly weightPoints?:
    Readonly<Record<string, number | null | undefined>> | undefined;
}

function within(value: unknown, min: number): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= min &&
    value <= STEP_SETTING_LIMITS.maxPoints
  );
}

/**
 * The settings in force: the defaults, with a board's overrides laid over
 * them. An override out of range, or for a weight the rubric no longer has,
 * is ignored, so settings saved against an older rubric cannot break the
 * step.
 */
export function resolveStepSettings(config: StepConfig = {}): StepSettings {
  const weights = config.weightPoints ?? {};
  return {
    pointsPerStep: within(
      config.pointsPerStep,
      STEP_SETTING_LIMITS.minPointsPerStep,
    )
      ? config.pointsPerStep
      : DEFAULT_STEP_SETTINGS.pointsPerStep,
    weightPoints: Object.fromEntries(
      SCENARIO_WEIGHTS.map((weight) => {
        // `Object.hasOwn`: the config is stored JSON, and a bare lookup
        // would find `constructor` on any object.
        const value = Object.hasOwn(weights, weight)
          ? weights[weight]
          : undefined;
        return [
          weight,
          within(value, STEP_SETTING_LIMITS.minWeightPoints)
            ? value
            : DEFAULT_STEP_SETTINGS.weightPoints[weight],
        ];
      }),
    ) as Record<ScenarioWeight, number>,
  };
}

/** A scenario one revision has and the other did not. */
export interface StepScenario {
  readonly id: string;
  readonly kind: ScenarioKind;
  readonly title: string;
  readonly weight: ScenarioWeight;
}

export interface StepResult {
  /** The size the step starts from: the model's, or a reviewer's resize. */
  readonly base: WholeComplexity;
  /** The base moved `steps` half sizes up. What the proposal is priced at. */
  readonly complexity: PricedComplexity;
  /** How far it moved, which the XL cap may cut short. */
  readonly steps: number;
  /** The current revision's points less the sized one's, never below zero. */
  readonly addedPoints: number;
  /**
   * The scenarios behind the points, for a reader: those of the current
   * revision with no scenario of the same kind and title in the sized one.
   * A scenario rewritten to a heavier weight under the same title is
   * counted in `addedPoints` without being listed here.
   */
  readonly added: readonly StepScenario[];
  /**
   * The scenarios of the sized revision with no scenario of the same kind
   * and title in the current one: what was trimmed, for a reader. Absent on
   * a step stored before removals were listed.
   */
  readonly removed?: readonly StepScenario[];
  /** Points still to add for the next half step; null at XL. */
  readonly nextStepIn: number | null;
  /** The settings it was computed with, so it can be read, and rebased, later. */
  readonly settings: StepSettings;
  readonly stepVersion: string;
  /**
   * The spec revision a reviewer's resize set the base against. The step
   * counts from there rather than from the sizing draft, since the size a
   * reviewer chose already covers the spec as it then stood. Absent for a
   * base the model set.
   */
  readonly baseRevision?: number;
}

/** A size moved `steps` positions up the half-size order, stopping at XL. */
export function halfStepsUp(
  base: PricedComplexity,
  steps: number,
): PricedComplexity {
  const last = PRICED_BOUNTY_COMPLEXITIES.length - 1;
  const at = Math.min(
    PRICED_BOUNTY_COMPLEXITIES.indexOf(base) + Math.max(0, steps),
    last,
  );
  return PRICED_BOUNTY_COMPLEXITIES[at] ?? "XL";
}

/** The size after this one, or null at XL. */
export function nextHalfStep(size: PricedComplexity): PricedComplexity | null {
  return size === "XL" ? null : halfStepsUp(size, 1);
}

/** The weighed scenarios of `to` with no scenario of the same key in `from`. */
function scenariosOnlyIn(to: SpecDraft, from: SpecDraft): StepScenario[] {
  const before = new Set(from.scenarios.map(scenarioKey));
  return to.scenarios.flatMap((scenario) => {
    const { id, kind, title, weight } = scenario;
    return weight === undefined || before.has(scenarioKey(scenario))
      ? []
      : [{ id, kind, title, weight }];
  });
}

function stepFrom(
  base: WholeComplexity,
  addedPoints: number,
  added: readonly StepScenario[],
  removed: readonly StepScenario[],
  settings: StepSettings,
): StepResult {
  const start = PRICED_BOUNTY_COMPLEXITIES.indexOf(base);
  const room = PRICED_BOUNTY_COMPLEXITIES.length - 1 - start;
  const wanted = Math.floor(addedPoints / settings.pointsPerStep);
  const steps = Math.min(wanted, room);
  return {
    base,
    complexity: halfStepsUp(base, steps),
    steps,
    addedPoints,
    added,
    removed,
    nextStepIn:
      wanted >= room
        ? null
        : settings.pointsPerStep * (wanted + 1) - addedPoints,
    settings,
    stepVersion: STEP_VERSION,
  };
}

/**
 * The size a base comes to once the weight added since it was set is
 * counted.
 *
 * `sized` is the revision the base was set against: the draft of the run
 * that sized the bounty. `current` is the revision the proposal points at
 * now. Null when either has a scenario without a weight: a spec drafted
 * before weights has no step until the proposal is re-priced.
 */
export function stepUp(
  base: WholeComplexity,
  sized: SpecDraft,
  current: SpecDraft,
  settings: StepSettings = DEFAULT_STEP_SETTINGS,
): StepResult | null {
  const before = pointsOf(sized, settings.weightPoints);
  const after = pointsOf(current, settings.weightPoints);
  if (before === null || after === null) return null;
  return stepFrom(
    base,
    Math.max(0, after - before),
    scenariosOnlyIn(current, sized),
    scenariosOnlyIn(sized, current),
    settings,
  );
}

/**
 * A reviewer's resize: the size chosen is the size, for the spec as it
 * stands at `revision`. Nothing added before it counts on top, so the step
 * starts again from zero there, with the settings it was computed with.
 */
export function resetStep(
  step: StepResult,
  base: WholeComplexity,
  revision: number,
): StepResult {
  return {
    ...stepFrom(base, 0, [], [], step.settings),
    baseRevision: revision,
  };
}

/**
 * The same step from a different base. The
 * added weight is the spec's, not the base's, so it carries over, counted
 * with the settings it was computed with.
 */
export function rebaseStep(
  step: StepResult,
  base: WholeComplexity,
): StepResult {
  return stepFrom(
    base,
    step.addedPoints,
    step.added,
    step.removed ?? [],
    step.settings,
  );
}
