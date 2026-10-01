/**
 * A ticket's behaviour, written down as scenarios.
 *
 * A spec is the first link of the pricing chain: what the ticket asks for,
 * as Given/When/Then scenarios a reviewer can read, plus what the ticket
 * left unsaid (open questions) and what the draft decided in that silence
 * (assumptions). Later links count it; nothing here prices anything.
 *
 * **The structured form is what is stored and compared.** `renderGherkin`
 * turns it into `.feature` text for a person to read, and the text is never
 * parsed back.
 *
 * Nothing outside this file names a scenario kind: the schemas, the draft
 * prompt and the UI all read `SCENARIO_KINDS`. A kind's id is stored on
 * every scenario, so renaming one orphans the scenarios that carry it;
 * `label` and `covers` are free to change.
 */

export interface ScenarioKindDefinition {
  /** Stable, stored. Kebab-case. */
  readonly id: string;
  /** What a person sees as the group's heading. */
  readonly label: string;
  /** What a scenario of this kind covers, for the draft and for the reader. */
  readonly covers: string;
}

/**
 * The kinds a draft is measured against, in the order a reader meets them.
 * "Exhaustive" means at least one scenario of every kind that applies.
 */
export const SCENARIO_KIND_DEFINITIONS = [
  {
    id: "happy",
    label: "Happy path",
    covers: "the behaviour working as intended for a typical input",
  },
  {
    id: "boundary",
    label: "Boundary",
    covers: "limits, empty and maximum values, first and last of a range",
  },
  {
    id: "unhappy",
    label: "Unhappy path",
    covers: "invalid input, a missing precondition, a dependency that fails",
  },
  {
    id: "recovery",
    label: "Recovery",
    covers: "what happens after a failure: a retry, a rollback, a resumed step",
  },
  {
    id: "permission",
    label: "Permission",
    covers: "who may and who may not, and what the refused party sees",
  },
  {
    id: "concurrency",
    label: "Concurrency",
    covers: "two actors or two requests at once, ordering and duplicates",
  },
  {
    id: "non-functional",
    label: "Non-functional",
    covers: "performance, security, accessibility or compliance expectations",
  },
] as const satisfies readonly ScenarioKindDefinition[];

export type ScenarioKind = (typeof SCENARIO_KIND_DEFINITIONS)[number]["id"];

/** The kind ids alone, in registry order, as a tuple a schema can take. */
export const SCENARIO_KINDS = SCENARIO_KIND_DEFINITIONS.map(
  ({ id }) => id,
) as unknown as readonly [ScenarioKind, ...ScenarioKind[]];

export const STEP_KEYWORDS = ["Given", "When", "Then", "And", "But"] as const;
export type StepKeyword = (typeof STEP_KEYWORDS)[number];

/** How a scenario came to be in the spec. */
export const SCENARIO_ORIGINS = ["draft", "expansion", "reviewer"] as const;
export type ScenarioOrigin = (typeof SCENARIO_ORIGINS)[number];

export interface ScenarioStep {
  readonly keyword: StepKeyword;
  readonly text: string;
}

export interface Scenario {
  /** "s1", stable within a spec revision. */
  readonly id: string;
  readonly kind: ScenarioKind;
  readonly title: string;
  readonly steps: readonly ScenarioStep[];
  readonly origin: ScenarioOrigin;
}

export interface SpecDraft {
  /** What the ticket is about, as a Gherkin feature name. */
  readonly feature: string;
  /** Given-steps shared by every scenario, without the keyword. May be empty. */
  readonly background: readonly string[];
  readonly scenarios: readonly Scenario[];
  /** What the ticket does not say and the draft needed. */
  readonly openQuestions: readonly string[];
  /** What the draft decided in the ticket's silence. */
  readonly assumptions: readonly string[];
}

/**
 * How large a spec may be. One set of numbers for the wire schema, the
 * draft tool's schema and the prompt, so they cannot drift apart.
 *
 * `draftScenarios` is the cap on a single draft and is smaller than
 * `scenarios`, the cap on a stored spec, on purpose: a model asked for an
 * exhaustive list will produce thirty, and a first pass that long is noise,
 * while a spec a reviewer has expanded is allowed to grow past it.
 */
export const SPEC_LIMITS = {
  featureChars: 120,
  titleChars: 160,
  stepChars: 240,
  noteChars: 240,
  steps: 12,
  background: 6,
  draftScenarios: 12,
  scenarios: 40,
  openQuestions: 8,
  assumptions: 8,
} as const;

export interface ScenarioCounts {
  readonly total: number;
  /** Every kind is present, zero when the spec has none of it. */
  readonly byKind: Readonly<Record<ScenarioKind, number>>;
}

export function countScenarios(draft: SpecDraft): ScenarioCounts {
  const byKind = Object.fromEntries(
    SCENARIO_KINDS.map((kind) => [kind, 0]),
  ) as Record<ScenarioKind, number>;
  let total = 0;
  for (const scenario of draft.scenarios) {
    // Stored JSON's kinds are not trusted to be ones this registry still
    // has: a retired kind is left out of the count rather than invented.
    if (!Object.hasOwn(byKind, scenario.kind)) continue;
    byKind[scenario.kind] += 1;
    total += 1;
  }
  return { total, byKind };
}

export interface ScenarioGroup {
  readonly kind: ScenarioKind;
  readonly label: string;
  readonly scenarios: readonly Scenario[];
}

/**
 * The scenarios by kind, in registry order, each group in the order the
 * spec lists its scenarios. A kind the spec has none of is left out.
 */
export function groupScenarios(draft: SpecDraft): ScenarioGroup[] {
  return SCENARIO_KIND_DEFINITIONS.flatMap(({ id, label }) => {
    const scenarios = draft.scenarios.filter(({ kind }) => kind === id);
    return scenarios.length === 0 ? [] : [{ kind: id, label, scenarios }];
  });
}

const INDENT = "  ";

/** One line: a line break inside a step would end it as far as Gherkin reads. */
function line(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * The spec as `.feature` text.
 *
 * Kinds and non-draft origins are tags, which is where Gherkin puts what a
 * scenario is rather than what it does. Open questions and assumptions are
 * comments under the scenarios: they belong to the spec, and Gherkin has no
 * keyword for either.
 */
export function renderGherkin(draft: SpecDraft): string {
  const lines: string[] = [`Feature: ${line(draft.feature)}`];

  if (draft.background.length > 0) {
    lines.push("", `${INDENT}Background:`);
    draft.background.forEach((step, index) => {
      lines.push(
        `${INDENT}${INDENT}${index === 0 ? "Given" : "And"} ${line(step)}`,
      );
    });
  }

  for (const scenario of draft.scenarios) {
    const tags = [
      `@${scenario.kind}`,
      ...(scenario.origin === "draft" ? [] : [`@${scenario.origin}`]),
    ];
    lines.push(
      "",
      `${INDENT}${tags.join(" ")}`,
      `${INDENT}Scenario: ${line(scenario.title)}`,
    );
    for (const step of scenario.steps) {
      lines.push(`${INDENT}${INDENT}${step.keyword} ${line(step.text)}`);
    }
  }

  for (const [heading, notes] of [
    ["Open questions", draft.openQuestions],
    ["Assumptions", draft.assumptions],
  ] as const) {
    if (notes.length === 0) continue;
    lines.push("", `${INDENT}# ${heading}`);
    for (const note of notes) lines.push(`${INDENT}# - ${line(note)}`);
  }

  return `${lines.join("\n")}\n`;
}
