import assert from "node:assert/strict";
import { test } from "node:test";

import {
  answerSpec,
  checkRespec,
  describeRespec,
  expandSpec,
  pointsDelta,
  sameSpec,
  scenarioKey,
  SPEC_LIMITS,
  stepUp,
  trimSpec,
  type Scenario,
  type ScenarioWeight,
  type SpecDraft,
} from "../src/index.js";

function scenario(
  id: string,
  weight: ScenarioWeight | undefined = "light",
  overrides: Partial<Scenario> = {},
): Scenario {
  return {
    id,
    kind: "happy",
    title: `Scenario ${id}`,
    steps: [{ keyword: "Then", text: "it works" }],
    origin: "draft",
    ...(weight === undefined ? {} : { weight }),
    ...overrides,
  };
}

function spec(
  scenarios: Scenario[],
  overrides: Partial<SpecDraft> = {},
): SpecDraft {
  return {
    feature: "Invitations",
    background: ["a recruiter is signed in"],
    scenarios,
    openQuestions: ["Should a declined invitation be resent?"],
    assumptions: ["Invitations expire after a week."],
    ...overrides,
  };
}

const current = spec([
  scenario("s1", "moderate"),
  scenario("s2", "light", { kind: "boundary", title: "An empty list" }),
]);

test("a scenario is the same one across revisions by kind and title", () => {
  assert.equal(
    scenarioKey({ kind: "happy", title: "Send  An Invitation " }),
    scenarioKey({ kind: "happy", title: "send an invitation" }),
  );
  assert.notEqual(
    scenarioKey({ kind: "happy", title: "Send" }),
    scenarioKey({ kind: "boundary", title: "Send" }),
  );
});

test("an expansion adds after the spec's own scenarios and touches nothing else", () => {
  const expanded = expandSpec(current, {
    scenarios: [
      scenario("s1", "heavy", { kind: "recovery", title: "A retry" }),
      // Already in the spec, under different spacing and case.
      scenario("s2", "heavy", { kind: "boundary", title: "an  EMPTY list" }),
      // Twice in one answer.
      scenario("s3", "light", { kind: "recovery", title: "A retry" }),
    ],
    openQuestions: [
      "How many retries?",
      "should a declined invitation be resent?",
    ],
    assumptions: [],
  });
  assert.deepEqual(expanded.scenarios.slice(0, 2), current.scenarios);
  assert.deepEqual(expanded.scenarios.slice(2), [
    {
      ...scenario("s3", "heavy", { kind: "recovery", title: "A retry" }),
      origin: "expansion",
    },
  ]);
  assert.equal(expanded.feature, current.feature);
  assert.deepEqual(expanded.background, current.background);
  // New questions are appended; one the spec already asks is not repeated.
  assert.deepEqual(expanded.openQuestions, [
    "Should a declined invitation be resent?",
    "How many retries?",
  ]);
  assert.deepEqual(expanded.assumptions, current.assumptions);
});

test("an expansion stops at the cap on a revision, scenarios and notes alike", () => {
  const full = spec(
    Array.from({ length: SPEC_LIMITS.scenarios - 1 }, (_, index) =>
      scenario(`s${index + 1}`),
    ),
    {
      openQuestions: Array.from(
        { length: SPEC_LIMITS.openQuestions },
        (_, index) => `Question ${index + 1}?`,
      ),
    },
  );
  const expanded = expandSpec(full, {
    scenarios: [
      scenario("s1", "heavy", { title: "First new" }),
      scenario("s2", "heavy", { title: "Second new" }),
    ],
    openQuestions: ["One too many?"],
    assumptions: ["A new assumption."],
  });
  assert.equal(expanded.scenarios.length, SPEC_LIMITS.scenarios);
  assert.equal(expanded.scenarios.at(-1)?.title, "First new");
  assert.equal(expanded.openQuestions.length, SPEC_LIMITS.openQuestions);
  assert.ok(!expanded.openQuestions.includes("One too many?"));
  assert.deepEqual(expanded.assumptions, [
    "Invitations expire after a week.",
    "A new assumption.",
  ]);
});

test("new scenarios are numbered past every id the revision has", () => {
  // s2 was trimmed earlier: its id is not given to a different scenario.
  const gapped = spec([scenario("s1"), scenario("s3")]);
  const expanded = expandSpec(gapped, {
    scenarios: [scenario("s1", "light", { title: "New" })],
    openQuestions: [],
    assumptions: [],
  });
  assert.equal(expanded.scenarios.at(-1)?.id, "s4");

  // Past s999 the lowest free number is used, so the id stays valid.
  const high = spec([scenario("s1"), scenario("s999")]);
  const wrapped = expandSpec(high, {
    scenarios: [
      scenario("s1", "light", { title: "New one" }),
      scenario("s2", "light", { title: "New two" }),
    ],
    openQuestions: [],
    assumptions: [],
  });
  assert.deepEqual(
    wrapped.scenarios.map(({ id }) => id),
    ["s1", "s999", "s2", "s3"],
  );
});

test("ids that are not s<digits> are skipped when numbering, not read as NaN", () => {
  // Read as numbers these were NaN, which a Set finds in itself, so the
  // search for a free number never ended.
  const odd = spec([
    scenario("x"),
    scenario("s2"),
    scenario("s1e3", "light", { title: "Exponent" }),
    scenario(`s${"9".repeat(20)}`, "light", { title: "Huge" }),
    scenario("legacy-7", "light", { title: "Legacy" }),
  ]);
  const expanded = expandSpec(odd, {
    scenarios: [scenario("s1", "light", { title: "New" })],
    openQuestions: [],
    assumptions: [],
  });
  assert.equal(expanded.scenarios.at(-1)?.id, "s3");
});

test("an answered spec keeps the scenarios it kept, and drops the answered questions", () => {
  const revised = spec(
    [
      // Kept, rewritten for the answer and weighed heavier.
      scenario("s1", "heavy", {
        steps: [{ keyword: "Then", text: "it resends" }],
      }),
      // New, for the answer.
      scenario("s2", "moderate", { kind: "recovery", title: "A resend" }),
      // Returned twice by the model.
      scenario("s3", "moderate", { kind: "recovery", title: "a resend" }),
    ],
    {
      feature: "Invitation delivery",
      // The model left the answered question in.
      openQuestions: [
        "should a declined invitation be resent? ",
        "Who may resend?",
      ],
      assumptions: [],
    },
  );
  const answered = answerSpec(current, revised, [
    "Should a declined invitation be resent?",
  ]);
  assert.deepEqual(answered.scenarios, [
    {
      ...scenario("s1", "heavy", {
        steps: [{ keyword: "Then", text: "it resends" }],
      }),
    },
    {
      ...scenario("s3", "moderate", { kind: "recovery", title: "A resend" }),
      origin: "expansion",
    },
  ]);
  assert.equal(answered.feature, "Invitation delivery");
  assert.deepEqual(answered.openQuestions, ["Who may resend?"]);
  assert.deepEqual(answered.assumptions, []);

  // A kept scenario keeps the origin it had, not the model's.
  const added = spec([scenario("s1", "light", { origin: "expansion" })]);
  assert.equal(
    answerSpec(
      added,
      spec([scenario("s9", "light", { title: "Scenario s1" })]),
      [],
    ).scenarios[0]?.origin,
    "expansion",
  );
});

test("an answered spec is cut at the cap on a revision", () => {
  const many = spec(
    Array.from({ length: SPEC_LIMITS.scenarios + 3 }, (_, index) =>
      scenario(`s${index + 1}`),
    ),
  );
  assert.equal(
    answerSpec(current, many, []).scenarios.length,
    SPEC_LIMITS.scenarios,
  );
});

test("a trim takes scenarios out and leaves the rest with their ids", () => {
  const trimmed = trimSpec(current, ["s1"]);
  assert.deepEqual(trimmed.scenarios, [current.scenarios[1]]);
  assert.deepEqual(trimmed.openQuestions, current.openQuestions);
});

test("a request is checked against the revision it changes", () => {
  assert.equal(checkRespec({ mode: "expand" }, current), null);
  const full = spec(
    Array.from({ length: SPEC_LIMITS.scenarios }, (_, index) =>
      scenario(`s${index + 1}`),
    ),
  );
  assert.equal(checkRespec({ mode: "expand" }, full), "spec_full");

  assert.equal(
    checkRespec(
      {
        mode: "answer",
        answers: [
          {
            question: " should a declined invitation be RESENT?",
            answer: "No.",
          },
        ],
      },
      current,
    ),
    null,
  );
  assert.equal(
    checkRespec(
      {
        mode: "answer",
        answers: [{ question: "Who pays?", answer: "Nobody." }],
      },
      current,
    ),
    "unknown_question",
  );

  assert.equal(
    checkRespec({ mode: "trim", removeScenarioIds: ["s2"] }, current),
    null,
  );
  assert.equal(
    checkRespec({ mode: "trim", removeScenarioIds: ["s7"] }, current),
    "unknown_scenario",
  );
  // Every scenario may go while a question remains: the spec still says
  // what it is missing.
  assert.equal(
    checkRespec({ mode: "trim", removeScenarioIds: ["s1", "s2"] }, current),
    null,
  );
  assert.equal(
    checkRespec(
      { mode: "trim", removeScenarioIds: ["s1", "s2"] },
      spec(current.scenarios.slice(), { openQuestions: [] }),
    ),
    "spec_emptied",
  );
});

test("a change's points can go either way, and need weights on both sides", () => {
  const grown = expandSpec(current, {
    scenarios: [scenario("s1", "heavy", { title: "Heavy one" })],
    openQuestions: [],
    assumptions: [],
  });
  assert.equal(pointsDelta(current, grown), 4);
  assert.equal(pointsDelta(grown, trimSpec(grown, ["s1", "s3"])), -6);
  assert.equal(
    pointsDelta(spec([{ ...scenario("s1"), weight: undefined }]), current),
    null,
  );
  assert.equal(
    pointsDelta(current, grown, { light: 0, moderate: 0, heavy: 10 }),
    10,
  );
});

test("an expansion and a trim move the step, and a trim never goes below the base", () => {
  const grown = expandSpec(current, {
    scenarios: [scenario("s1", "heavy", { title: "Heavy one" })],
    openQuestions: [],
    assumptions: [],
  });
  assert.equal(stepUp("S", current, grown)?.complexity, "S+");
  const back = trimSpec(grown, ["s3"]);
  assert.equal(stepUp("S", current, back)?.complexity, "S");
  // A draft scenario trimmed: fewer points than sized, still the base.
  assert.equal(
    stepUp("S", current, trimSpec(current, ["s1"]))?.complexity,
    "S",
  );
});

test("two revisions are the same when they say the same thing", () => {
  assert.ok(sameSpec(current, spec(current.scenarios.slice())));
  assert.ok(!sameSpec(current, trimSpec(current, ["s1"])));
});

test("a request is described for the spec's history", () => {
  assert.equal(describeRespec({ mode: "expand" }, current), "More scenarios");
  assert.equal(
    describeRespec({ mode: "expand", kinds: ["boundary"] }, current),
    "More boundary scenarios",
  );
  assert.equal(
    describeRespec(
      { mode: "expand", kinds: ["happy", "unhappy", "non-functional"] },
      current,
    ),
    "More happy path, unhappy path and non-functional scenarios",
  );
  assert.equal(
    describeRespec(
      { mode: "expand", instruction: "Cover a recruiter on mobile." },
      current,
    ),
    "Cover a recruiter on mobile.",
  );
  assert.equal(
    describeRespec(
      {
        mode: "expand",
        kinds: ["permission"],
        instruction: "Include guests.",
      },
      current,
    ),
    "More permission scenarios: Include guests.",
  );
  assert.equal(
    describeRespec(
      {
        mode: "answer",
        answers: [
          { question: "Resend?", answer: "No." },
          { question: "Who?", answer: "Admins." },
        ],
      },
      current,
    ),
    "Resend? → No.\nWho? → Admins.",
  );
  assert.equal(
    describeRespec({ mode: "trim", removeScenarioIds: ["s2", "s1"] }, current),
    "Removed Scenario s1; An empty list",
  );
});
