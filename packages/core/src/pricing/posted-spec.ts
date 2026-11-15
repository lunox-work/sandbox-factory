/**
 * A spec posted with its bounty instead of drafted for it: a duediligence
 * `spec.md` (or the platform's own `renderSpecDocument` text, which reads
 * the same), turned into the `SpecDraft` sizing prices and hidden tests
 * are written to.
 *
 * duediligence reads the document; this maps what it read. The API calls
 * duediligence's own `scenarios` and `decisionItems` (`duediligence/api`,
 * pinned) so a scenario's key and a decision's text are the ones the
 * person confirmed locally, and hands them here with the parts it does
 * not read (`documentFeature`, `documentBackground`,
 * `documentOpenQuestions`). Nothing is cut to fit: a part past
 * `SPEC_LIMITS` is a problem the poster is told about, so what is stored
 * is what was confirmed. The one exception is a table or doc string, which
 * a stored step cannot hold whole: it is folded into its step as far as
 * the step's cap allows and says how many rows it left out; the posted
 * document stays the bounty's description, where the rest is read.
 *
 * Defaults where duediligence says nothing: a scenario's kind is its first
 * tag (`@happy`), and `happy` with no tag; a tag that is not one of
 * `SCENARIO_KINDS` is a problem. Every scenario weighs `moderate`, the
 * weight a spec drafted before weights is counted at (`rubric.ts`), with a
 * reason saying so, and its origin is `draft`.
 */

import {
  SCENARIO_KINDS,
  SPEC_LIMITS,
  STEP_KEYWORDS,
  type Scenario,
  type ScenarioKind,
  type ScenarioStep,
  type SpecDraft,
  type StepKeyword,
} from "./spec.js";

/** A scenario as duediligence's `scenarios` reads one: `{ key, title, body }`. */
export interface DocumentScenario {
  /** `kind-n`: the first tag and the position among that kind's. */
  readonly key: string;
  readonly title: string;
  /** Its lines after the `Scenario:` line, trimmed, one per line. */
  readonly body: string;
}

/** A decision as duediligence's `decisionItems` reads one. */
export interface DocumentDecision {
  readonly text: string;
}

/** What a posted document holds, as duediligence and this file read it. */
export interface ReadSpecDocument {
  readonly feature: string | null;
  readonly background: readonly string[];
  readonly scenarios: readonly DocumentScenario[];
  readonly decisions: readonly DocumentDecision[];
  readonly openQuestions: readonly string[];
}

/** One thing wrong with a posted spec, by where it is. */
export interface PostedSpecProblem {
  /** `feature`, `scenarios[2].steps`, `decisions[0]`… */
  readonly path: string;
  readonly message: string;
}

export type PostedSpecResult =
  | { readonly ok: true; readonly draft: SpecDraft }
  | { readonly ok: false; readonly problems: readonly PostedSpecProblem[] };

/** The weight every posted scenario takes, and why, for the reader. */
export const POSTED_SCENARIO_WEIGHT = "moderate" as const;
export const POSTED_WEIGHT_REASON =
  "Not weighed in the posted spec; counted as moderate.";

const STEP = new RegExp(`^(${STEP_KEYWORDS.join("|")})\\s+(.+)$`);
const DECIDED = /^\W*decided:?\W*$/i;

/** One line, its runs of whitespace one space. */
const line = (value: string) => value.replace(/\s+/g, " ").trim();

/** The Gherkin block a duediligence spec fences, else the whole text. */
function gherkinOf(text: string): string {
  return /```gherkin\n([\s\S]*?)```/.exec(text)?.[1] ?? text;
}

/**
 * The `Feature:` name, else the document's first `# ` heading; null with
 * neither.
 */
export function documentFeature(text: string): string | null {
  const feature = /^\s*Feature:\s*(\S.*)$/m.exec(gherkinOf(text))?.[1];
  if (feature !== undefined && line(feature) !== "") return line(feature);
  const heading = /^#\s+(\S.*)$/m.exec(text)?.[1];
  return heading === undefined || line(heading) === "" ? null : line(heading);
}

/**
 * The `Background:` steps, without their keywords, a table under one
 * folded into it. Empty when there is none.
 */
export function documentBackground(text: string): string[] {
  const lines = gherkinOf(text).split("\n");
  const start = lines.findIndex((each) => /^\s*Background:/.test(each));
  if (start === -1) return [];
  const steps: string[] = [];
  const end = lines.findIndex(
    (each, index) =>
      index > start &&
      /^\s*(?:@|Scenario|Rule:|Feature:|Examples:)/.test(each.trim()),
  );
  const extras = new Map<number, string[]>();
  for (const raw of lines.slice(start + 1, end === -1 ? undefined : end)) {
    const each = raw.trim();
    if (each === "" || each.startsWith("#")) continue;
    const step = STEP.exec(each) ?? /^(\*)\s+(.+)$/.exec(each);
    if (step?.[2] !== undefined) steps.push(line(step[2]));
    else if (steps.length > 0)
      extras.set(steps.length - 1, [
        ...(extras.get(steps.length - 1) ?? []),
        each,
      ]);
  }
  return steps.map((step, index) =>
    fold(step, extras.get(index) ?? [], SPEC_LIMITS.stepChars),
  );
}

/**
 * The open questions a `renderGherkin` document carries as comments
 * (`# Open questions` over `# - …`), so the platform's own spec posts back
 * whole. A duediligence spec has none.
 */
export function documentOpenQuestions(text: string): string[] {
  const lines = text.split("\n").map((each) => each.trim());
  const start = lines.findIndex((each) =>
    /^#\s*Open questions\s*$/i.test(each),
  );
  if (start === -1) return [];
  const notes: string[] = [];
  for (const each of lines.slice(start + 1)) {
    const note = /^#\s*-\s+(\S.*)$/.exec(each)?.[1];
    if (note === undefined) break;
    notes.push(line(note));
  }
  return notes;
}

/**
 * Table rows and doc string lines folded onto the step they belong to:
 * `step — a | b; c | d`, as many rows as fit `max`, then how many were
 * left out.
 */
function fold(step: string, extras: readonly string[], max: number): string {
  const rows = extras
    .filter((each) => each !== '"""' && each !== "```")
    .map((each) =>
      each.startsWith("|")
        ? each
            .replace(/^\||\|$/g, "")
            .split("|")
            .map((cell) => line(cell))
            .join(" | ")
        : line(each),
    )
    .filter((each) => each !== "");
  if (rows.length === 0) return step;
  const note = (left: number) =>
    left === 0 ? "" : ` (${left} more rows in the posted spec)`;
  let folded = step;
  let kept = 0;
  for (const row of rows) {
    const next = `${folded}${kept === 0 ? " — " : "; "}${row}`;
    if (`${next}${note(rows.length - kept - 1)}`.length > max) break;
    folded = next;
    kept += 1;
  }
  const noted = `${folded}${note(rows.length - kept)}`;
  return noted.length > max ? folded : noted;
}

/**
 * A scenario's steps out of its body. Lines before its first step are its
 * description and are not steps; an `Examples:` table becomes one last
 * `And examples — …` step; a table or doc string under a step is folded
 * into it (`fold`). A body that runs past the Gherkin into a `Decided:`
 * list (an unfenced document) stops there; comments are skipped.
 */
function stepsOf(
  body: string,
  path: string,
  problems: PostedSpecProblem[],
): ScenarioStep[] {
  const steps: { keyword: StepKeyword; text: string; extras: string[] }[] = [];
  let examples: string[] | null = null;
  for (const raw of body.split("\n")) {
    const each = raw.trim();
    if (DECIDED.test(each)) break;
    if (each === "" || each.startsWith("#")) continue;
    if (/^(?:Examples|Scenarios):/.test(each)) {
      examples = [];
      continue;
    }
    if (examples !== null) {
      examples.push(each);
      continue;
    }
    const step = STEP.exec(each);
    const star = /^\*\s+(\S.*)$/.exec(each);
    if (step?.[1] !== undefined && step[2] !== undefined)
      steps.push({
        keyword: step[1] as StepKeyword,
        text: line(step[2]),
        extras: [],
      });
    else if (star?.[1] !== undefined)
      steps.push({ keyword: "And", text: line(star[1]), extras: [] });
    else if (steps.length > 0) {
      const last = steps.at(-1);
      if (last !== undefined) {
        if (each.startsWith("|") || each === '"""' || last.extras.length > 0)
          last.extras.push(each);
        else
          problems.push({
            path,
            message: `"${each.slice(0, 80)}" is not a step: start it with ${STEP_KEYWORDS.join(", ")}.`,
          });
      }
    }
  }
  const stored: ScenarioStep[] = steps.map(({ keyword, text, extras }) => ({
    keyword,
    text: fold(text, extras, SPEC_LIMITS.stepChars),
  }));
  if (examples !== null && examples.length > 0) {
    const [header, ...rows] = examples;
    const names = (header ?? "")
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((cell) => line(cell))
      .join(" | ");
    stored.push({
      keyword: "And",
      text: fold(`examples (${names})`, rows, SPEC_LIMITS.stepChars),
    });
  }
  return stored;
}

/** The kind a duediligence key names: its part before the last `-n`. */
function kindOf(key: string): string {
  return key.replace(/-\d+$/, "");
}

const isKind = (value: string): value is ScenarioKind =>
  (SCENARIO_KINDS as readonly string[]).includes(value);

/**
 * The spec a posted document holds, or every problem with it. Checks the
 * stored spec's limits (`SPEC_LIMITS`) and the rules `specDraftSchema`
 * holds a stored spec to, so a draft returned `ok` is one the schema takes.
 */
export function specFromDocument(read: ReadSpecDocument): PostedSpecResult {
  const problems: PostedSpecProblem[] = [];
  const within = (path: string, value: string, max: number) => {
    if (value.length > max)
      problems.push({
        path,
        message: `${value.length} characters; at most ${max}.`,
      });
  };

  const feature = read.feature ?? "";
  if (feature === "")
    problems.push({
      path: "feature",
      message:
        "No `Feature:` line or `# ` heading names what the spec is about.",
    });
  within("feature", feature, SPEC_LIMITS.featureChars);

  if (read.background.length > SPEC_LIMITS.background)
    problems.push({
      path: "background",
      message: `${read.background.length} steps; at most ${SPEC_LIMITS.background}.`,
    });
  read.background.forEach((step, index) =>
    within(`background[${index}]`, step, SPEC_LIMITS.stepChars),
  );

  if (read.scenarios.length > SPEC_LIMITS.scenarios)
    problems.push({
      path: "scenarios",
      message: `${read.scenarios.length} scenarios; at most ${SPEC_LIMITS.scenarios}.`,
    });
  const scenarios: Scenario[] = read.scenarios.map((scenario, index) => {
    const path = `scenarios[${index}]`;
    const tag = kindOf(scenario.key);
    const kind: ScenarioKind =
      tag === "untagged" ? "happy" : isKind(tag) ? tag : "happy";
    if (tag !== "untagged" && !isKind(tag))
      problems.push({
        path: `${path}.kind`,
        message: `@${tag} is not a scenario kind; tag it ${SCENARIO_KINDS.map((each) => `@${each}`).join(", ")}.`,
      });
    const title = line(scenario.title);
    if (title === "")
      problems.push({
        path: `${path}.title`,
        message: "The scenario has no title.",
      });
    within(`${path}.title`, title, SPEC_LIMITS.titleChars);
    const steps = stepsOf(scenario.body, `${path}.steps`, problems);
    if (steps.length === 0)
      problems.push({
        path: `${path}.steps`,
        message: "The scenario has no Given, When or Then step.",
      });
    if (steps.length > SPEC_LIMITS.steps)
      problems.push({
        path: `${path}.steps`,
        message: `${steps.length} steps; at most ${SPEC_LIMITS.steps}.`,
      });
    steps.forEach((step, at) =>
      within(`${path}.steps[${at}]`, step.text, SPEC_LIMITS.stepChars),
    );
    return {
      id: `s${index + 1}`,
      kind,
      title,
      steps,
      origin: "draft",
      weight: POSTED_SCENARIO_WEIGHT,
      weightReason: POSTED_WEIGHT_REASON,
    };
  });

  const assumptions = read.decisions.map(({ text }) => line(text));
  if (assumptions.length > SPEC_LIMITS.assumptions)
    problems.push({
      path: "decisions",
      message: `${assumptions.length} decisions; at most ${SPEC_LIMITS.assumptions}.`,
    });
  assumptions.forEach((text, index) => {
    if (text === "")
      problems.push({
        path: `decisions[${index}]`,
        message: "An empty decision.",
      });
    within(`decisions[${index}]`, text, SPEC_LIMITS.noteChars);
  });

  const openQuestions = read.openQuestions.map(line);
  if (openQuestions.length > SPEC_LIMITS.openQuestions)
    problems.push({
      path: "openQuestions",
      message: `${openQuestions.length} open questions; at most ${SPEC_LIMITS.openQuestions}.`,
    });
  openQuestions.forEach((text, index) =>
    within(`openQuestions[${index}]`, text, SPEC_LIMITS.noteChars),
  );

  if (scenarios.length === 0 && openQuestions.length === 0)
    problems.push({
      path: "scenarios",
      message:
        "No scenario found: write them as `Scenario:` blocks, each tagged with its kind, inside a ```gherkin block.",
    });

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    draft: {
      feature,
      background: [...read.background],
      scenarios,
      openQuestions,
      assumptions,
    },
  };
}
