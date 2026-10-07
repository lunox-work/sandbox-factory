/**
 * A reviewer's change to a spec: grow it, answer its open questions, or
 * trim it. Every change is a new revision, and the scenario step reads the
 * new revision against the one the size was set from.
 *
 * Three requests, and what each may touch:
 *
 * - **expand** adds scenarios and nothing else: the ones the spec has stay
 *   exactly as they are, so asking for more cannot quietly reword or
 *   re-weigh what was there. The model writes only the new ones.
 * - **answer** settles open questions, which can change any scenario the
 *   answer bears on, so the model returns the whole spec. A scenario it
 *   keeps (same kind, same title) keeps its id and its origin.
 * - **trim** removes scenarios by id. No model is asked.
 *
 * What came from the model is merged here, so the merge is the same
 * whichever provider answered, and a test can pin it without one.
 */

import {
  SCENARIO_KIND_DEFINITIONS,
  scenarioKey,
  SPEC_LIMITS,
  type Scenario,
  type ScenarioKind,
  type SpecDraft,
} from "./spec.js";
import { pointsOf, type ScenarioWeight } from "./weight.js";

export const RESPEC_MODES = ["expand", "answer", "trim"] as const;
export type RespecMode = (typeof RESPEC_MODES)[number];

/**
 * How much a reviewer may write. The text goes into a prompt, so it is
 * capped; a sentence or two is what an instruction or an answer needs.
 */
export const RESPEC_LIMITS = {
  instructionChars: 500,
  answerChars: 500,
} as const;

export interface ExpandRequest {
  readonly mode: "expand";
  /** The kinds to write more of. Absent or empty: any kind the bounty needs. */
  readonly kinds?: readonly ScenarioKind[] | undefined;
  /** What the reviewer wants covered, in their words. */
  readonly instruction?: string | undefined;
}

export interface AnswerRequest {
  readonly mode: "answer";
  /** Each open question answered, by its text in the current revision. */
  readonly answers: readonly {
    readonly question: string;
    readonly answer: string;
  }[];
}

export interface TrimRequest {
  readonly mode: "trim";
  /** Scenarios of the current revision to take out. */
  readonly removeScenarioIds: readonly string[];
}

export type RespecRequest = ExpandRequest | AnswerRequest | TrimRequest;

/** Why a request cannot be made of this revision. */
export type RespecRefusal =
  /** The spec already holds as many scenarios as a revision may. */
  | "spec_full"
  /** An answer names a question the revision does not ask. */
  | "unknown_question"
  /** A removal names a scenario the revision does not have. */
  | "unknown_scenario"
  /** The removal would leave a spec with no scenario and no question. */
  | "spec_emptied";

/** A note, compared as a reader would: without case or spacing. */
function noteKey(note: string): string {
  return note.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Whether the request can be made of this revision, or why not. Checked
 * when the request arrives, and again against the revision the run reads,
 * since that is the one it changes.
 */
export function checkRespec(
  request: RespecRequest,
  current: SpecDraft,
): RespecRefusal | null {
  switch (request.mode) {
    case "expand":
      return current.scenarios.length >= SPEC_LIMITS.scenarios
        ? "spec_full"
        : null;
    case "answer": {
      const asked = new Set(current.openQuestions.map(noteKey));
      return request.answers.every(({ question }) =>
        asked.has(noteKey(question)),
      )
        ? null
        : "unknown_question";
    }
    case "trim": {
      const ids = new Set(current.scenarios.map(({ id }) => id));
      if (!request.removeScenarioIds.every((id) => ids.has(id))) {
        return "unknown_scenario";
      }
      const left = trimSpec(current, request.removeScenarioIds);
      return left.scenarios.length === 0 && left.openQuestions.length === 0
        ? "spec_emptied"
        : null;
    }
  }
}

/** The highest id a scenario may carry: `s999`. */
const MAX_SCENARIO_ID = 999;

/**
 * Ids for scenarios new to a revision: past every id the revision has, so
 * none takes a number a scenario of this revision still holds or skipped.
 * Ids are stable within a revision only: one trimmed in an earlier
 * revision may see its number again. Past `s999`, the lowest free number.
 */
function newIds(current: SpecDraft): () => string {
  // Only `s<digits>` ids hold a number. Any other id read as one is NaN,
  // which would make `next` NaN; and since a Set finds NaN in itself, the
  // search for a free number below would then never end.
  const used = new Set(
    current.scenarios.flatMap(({ id }) => {
      const number = /^s(\d+)$/.test(id) ? Number(id.slice(1)) : Number.NaN;
      return Number.isSafeInteger(number) ? [number] : [];
    }),
  );
  let next = Math.max(0, ...used) + 1;
  return () => {
    if (next > MAX_SCENARIO_ID) next = 1;
    while (used.has(next)) next += 1;
    used.add(next);
    return `s${next}`;
  };
}

/** `current` followed by those of `added` it does not hold, up to `max`. */
function appendNotes(
  current: readonly string[],
  added: readonly string[],
  max: number,
): string[] {
  const seen = new Set(current.map(noteKey));
  const notes = [...current];
  for (const note of added) {
    if (notes.length >= max) break;
    if (seen.has(noteKey(note))) continue;
    seen.add(noteKey(note));
    notes.push(note);
  }
  return notes;
}

/** What an expansion's model call returns: only what is new. */
export interface SpecAddition {
  readonly scenarios: readonly Scenario[];
  readonly openQuestions: readonly string[];
  readonly assumptions: readonly string[];
}

/**
 * The current revision with an expansion's scenarios after its own. A
 * scenario the spec already has (same kind and title) is not added twice,
 * and nothing is added past the cap on a revision. Every added scenario is
 * an `expansion`, numbered after the spec's own.
 */
export function expandSpec(
  current: SpecDraft,
  addition: SpecAddition,
): SpecDraft {
  const known = new Set(current.scenarios.map(scenarioKey));
  const id = newIds(current);
  const room = SPEC_LIMITS.scenarios - current.scenarios.length;
  const added: Scenario[] = [];
  for (const scenario of addition.scenarios) {
    if (added.length >= room) break;
    const key = scenarioKey(scenario);
    if (known.has(key)) continue;
    known.add(key);
    added.push({ ...scenario, id: id(), origin: "expansion" });
  }
  return {
    ...current,
    scenarios: [...current.scenarios, ...added],
    openQuestions: appendNotes(
      current.openQuestions,
      addition.openQuestions,
      SPEC_LIMITS.openQuestions,
    ),
    assumptions: appendNotes(
      current.assumptions,
      addition.assumptions,
      SPEC_LIMITS.assumptions,
    ),
  };
}

/**
 * The spec the model revised for the reviewer's answers, made a revision of
 * `current`. A scenario it kept (same kind and title) keeps its id and its
 * origin, whatever it now says; any other is an `expansion` with a new id.
 * The answered questions are gone whether or not the model removed them.
 */
export function answerSpec(
  current: SpecDraft,
  revised: SpecDraft,
  answered: readonly string[],
): SpecDraft {
  const before = new Map(
    current.scenarios.map((scenario) => [scenarioKey(scenario), scenario]),
  );
  const id = newIds(current);
  const seen = new Set<string>();
  const scenarios: Scenario[] = [];
  for (const scenario of revised.scenarios) {
    if (scenarios.length >= SPEC_LIMITS.scenarios) break;
    const key = scenarioKey(scenario);
    if (seen.has(key)) continue;
    seen.add(key);
    const kept = before.get(key);
    scenarios.push({
      ...scenario,
      id: kept?.id ?? id(),
      origin: kept?.origin ?? "expansion",
    });
  }
  const settled = new Set(answered.map(noteKey));
  return {
    feature: revised.feature,
    background: revised.background,
    scenarios,
    openQuestions: revised.openQuestions.filter(
      (question) => !settled.has(noteKey(question)),
    ),
    assumptions: revised.assumptions,
  };
}

/** The current revision without these scenarios; the rest keep their ids. */
export function trimSpec(
  current: SpecDraft,
  removeScenarioIds: readonly string[],
): SpecDraft {
  const removed = new Set(removeScenarioIds);
  return {
    ...current,
    scenarios: current.scenarios.filter(({ id }) => !removed.has(id)),
  };
}

/** Whether two revisions say the same thing. */
export function sameSpec(a: SpecDraft, b: SpecDraft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * How many points a change moved the spec by, which can be negative: a
 * trim takes points away. Null when either side has a scenario without a
 * weight, as `pointsOf` is.
 */
export function pointsDelta(
  before: SpecDraft,
  after: SpecDraft,
  weightPoints?: Readonly<Record<ScenarioWeight, number>>,
): number | null {
  const was = pointsOf(before, weightPoints);
  const is = pointsOf(after, weightPoints);
  return was === null || is === null ? null : is - was;
}

const KIND_LABEL: Readonly<Record<string, string>> = Object.fromEntries(
  SCENARIO_KIND_DEFINITIONS.map(({ id, label }) => [id, label.toLowerCase()]),
);

/** "a", "a and b", "a, b and c". */
function listOf(items: readonly string[]): string {
  return items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}`;
}

/**
 * What a request asked, as the revision it made records it for a reader of
 * the spec's history: the reviewer's ask, the questions with their
 * answers, or the titles taken out.
 */
export function describeRespec(
  request: RespecRequest,
  current: SpecDraft,
): string {
  switch (request.mode) {
    case "expand": {
      const kinds = (request.kinds ?? []).map(
        (kind) => KIND_LABEL[kind] ?? kind,
      );
      const ask = kinds.length === 0 ? null : `More ${listOf(kinds)} scenarios`;
      if (request.instruction === undefined) return ask ?? "More scenarios";
      return ask === null
        ? request.instruction
        : `${ask}: ${request.instruction}`;
    }
    case "answer":
      return request.answers
        .map(({ question, answer }) => `${question} → ${answer}`)
        .join("\n");
    case "trim": {
      const removed = new Set(request.removeScenarioIds);
      const titles = current.scenarios
        .filter(({ id }) => removed.has(id))
        .map(({ title }) => title);
      return `Removed ${titles.join("; ")}`;
    }
  }
}
