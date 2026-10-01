import assert from "node:assert/strict";
import { test } from "node:test";

import {
  countScenarios,
  groupScenarios,
  renderGherkin,
  SCENARIO_KIND_DEFINITIONS,
  SCENARIO_KINDS,
  SPEC_LIMITS,
  type Scenario,
  type SpecDraft,
} from "../src/index.js";

function scenario(
  id: string,
  kind: Scenario["kind"],
  overrides: Partial<Scenario> = {},
): Scenario {
  return {
    id,
    kind,
    title: `Scenario ${id}`,
    steps: [
      { keyword: "Given", text: "a signed-in recruiter" },
      { keyword: "When", text: "they send the invitation" },
      { keyword: "Then", text: "the candidate receives it" },
    ],
    origin: "draft",
    ...overrides,
  };
}

function draft(overrides: Partial<SpecDraft> = {}): SpecDraft {
  return {
    feature: "Interview invitation delivery",
    background: [],
    scenarios: [scenario("s1", "happy")],
    openQuestions: [],
    assumptions: [],
    ...overrides,
  };
}

test("the kinds are one registry, in the order a reader meets them", () => {
  assert.deepEqual(SCENARIO_KINDS, [
    "happy",
    "boundary",
    "unhappy",
    "recovery",
    "permission",
    "concurrency",
    "non-functional",
  ]);
  // A kind's id is stored and rendered as a Gherkin tag, so it has to be
  // one: no spaces, nothing a tag cannot carry.
  for (const { id, label, covers } of SCENARIO_KIND_DEFINITIONS) {
    assert.match(id, /^[a-z]+(-[a-z]+)*$/);
    assert.notEqual(label, "");
    assert.notEqual(covers, "");
  }
  assert.equal(new Set(SCENARIO_KINDS).size, SCENARIO_KINDS.length);
});

test("a single draft is capped below what a stored spec may hold", () => {
  // The first pass is bounded so "exhaustive" cannot mean thirty scenarios;
  // a spec a reviewer has expanded may grow past it.
  assert.ok(SPEC_LIMITS.draftScenarios < SPEC_LIMITS.scenarios);
});

test("scenarios are counted in total and per kind, zeros included", () => {
  const counts = countScenarios(
    draft({
      scenarios: [
        scenario("s1", "happy"),
        scenario("s2", "unhappy"),
        scenario("s3", "happy"),
        scenario("s4", "non-functional"),
      ],
    }),
  );

  assert.equal(counts.total, 4);
  assert.deepEqual(counts.byKind, {
    happy: 2,
    boundary: 0,
    unhappy: 1,
    recovery: 0,
    permission: 0,
    concurrency: 0,
    "non-functional": 1,
  });
});

test("a kind the registry no longer has is counted nowhere", () => {
  // Stored JSON outlives the registry. `constructor` is the case a plain
  // object lookup would get wrong.
  const counts = countScenarios(
    draft({
      scenarios: [
        scenario("s1", "happy"),
        scenario("s2", "retired" as Scenario["kind"]),
        scenario("s3", "constructor" as Scenario["kind"]),
      ],
    }),
  );

  assert.equal(counts.total, 1);
  assert.equal(counts.byKind.happy, 1);
  assert.deepEqual(Object.keys(counts.byKind), [...SCENARIO_KINDS]);
});

test("an empty spec counts to zero", () => {
  const counts = countScenarios(draft({ scenarios: [] }));
  assert.equal(counts.total, 0);
  assert.ok(Object.values(counts.byKind).every((count) => count === 0));
});

test("groups follow the registry's order and keep each scenario's place", () => {
  const groups = groupScenarios(
    draft({
      scenarios: [
        scenario("s1", "unhappy"),
        scenario("s2", "happy"),
        scenario("s3", "unhappy"),
        scenario("s4", "retired" as Scenario["kind"]),
      ],
    }),
  );

  // Happy before unhappy whatever the draft's order; no group for a kind
  // the spec has none of, nor for one the registry does not know.
  assert.deepEqual(
    groups.map(({ kind, label, scenarios }) => ({
      kind,
      label,
      ids: scenarios.map(({ id }) => id),
    })),
    [
      { kind: "happy", label: "Happy path", ids: ["s2"] },
      { kind: "unhappy", label: "Unhappy path", ids: ["s1", "s3"] },
    ],
  );
  assert.deepEqual(groupScenarios(draft({ scenarios: [] })), []);
});

test("a spec renders as feature text a person can read", () => {
  const text = renderGherkin(
    draft({
      background: ["a recruiter is signed in", "an open requisition exists"],
      scenarios: [
        scenario("s1", "happy", { title: "Invitation is delivered" }),
        scenario("s2", "boundary", {
          title: "The last free slot",
          origin: "expansion",
          steps: [
            { keyword: "Given", text: "one slot is left" },
            { keyword: "When", text: "it is offered" },
            { keyword: "Then", text: "no further slot is offered" },
            { keyword: "But", text: "the requisition stays open" },
          ],
        }),
      ],
      openQuestions: ["Which timezone is the slot shown in?"],
      assumptions: ["Invitations go by email only."],
    }),
  );

  assert.equal(
    text,
    [
      "Feature: Interview invitation delivery",
      "",
      "  Background:",
      "    Given a recruiter is signed in",
      "    And an open requisition exists",
      "",
      "  @happy",
      "  Scenario: Invitation is delivered",
      "    Given a signed-in recruiter",
      "    When they send the invitation",
      "    Then the candidate receives it",
      "",
      "  @boundary @expansion",
      "  Scenario: The last free slot",
      "    Given one slot is left",
      "    When it is offered",
      "    Then no further slot is offered",
      "    But the requisition stays open",
      "",
      "  # Open questions",
      "  # - Which timezone is the slot shown in?",
      "",
      "  # Assumptions",
      "  # - Invitations go by email only.",
      "",
    ].join("\n"),
  );
});

test("a bare spec renders without the sections it does not have", () => {
  assert.equal(
    renderGherkin(draft({ scenarios: [] })),
    "Feature: Interview invitation delivery\n",
  );
});

test("a line break inside a step cannot start a new Gherkin line", () => {
  // Text that carried a newline would otherwise be read as a second step,
  // or as a keyword the spec never had.
  const text = renderGherkin(
    draft({
      feature: "Export\nFeature: injected",
      background: ["a user\n    When smuggled"],
      scenarios: [
        scenario("s1", "happy", {
          title: "Title\n  Scenario: injected",
          steps: [{ keyword: "Given", text: "one\r\n\tThen two" }],
        }),
      ],
      openQuestions: ["first\nsecond"],
    }),
  );

  const lines = text.trimEnd().split("\n");
  assert.deepEqual(lines, [
    "Feature: Export Feature: injected",
    "",
    "  Background:",
    "    Given a user When smuggled",
    "",
    "  @happy",
    "  Scenario: Title Scenario: injected",
    "    Given one Then two",
    "",
    "  # Open questions",
    "  # - first second",
  ]);
});
