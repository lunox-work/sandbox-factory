import assert from "node:assert/strict";
import { test } from "node:test";

import {
  documentBackground,
  documentFeature,
  documentOpenQuestions,
  POSTED_SCENARIO_WEIGHT,
  POSTED_WEIGHT_REASON,
  renderSpecDocument,
  SPEC_LIMITS,
  specFromDocument,
  type ReadSpecDocument,
  type SpecDraft,
} from "../src/index.js";

/** What duediligence's `scenarios` and `decisionItems` read, by hand. */
function read(overrides: Partial<ReadSpecDocument> = {}): ReadSpecDocument {
  return {
    feature: "Duration strings",
    background: [],
    scenarios: [
      {
        key: "happy-1",
        title: "A count may exceed the next unit",
        body: 'When I parse "90m"\nThen the result is 5400000\n',
      },
      {
        key: "unhappy-1",
        title: "One millisecond more is rejected",
        body: 'When I parse "104249991d8h59m992ms"\nThen it throws an Error\n',
      },
    ],
    decisions: [{ text: "Units are lowercase only: `3S` is invalid." }],
    openQuestions: [],
    ...overrides,
  };
}

test("a read document is a spec: keys' kinds, steps, decisions as assumptions", () => {
  const result = specFromDocument(read());
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.draft.feature, "Duration strings");
  assert.deepEqual(
    result.draft.scenarios.map(({ id, kind, title, origin }) => ({
      id,
      kind,
      title,
      origin,
    })),
    [
      {
        id: "s1",
        kind: "happy",
        title: "A count may exceed the next unit",
        origin: "draft",
      },
      {
        id: "s2",
        kind: "unhappy",
        title: "One millisecond more is rejected",
        origin: "draft",
      },
    ],
  );
  assert.deepEqual(result.draft.scenarios[0]?.steps, [
    { keyword: "When", text: 'I parse "90m"' },
    { keyword: "Then", text: "the result is 5400000" },
  ]);
  // duediligence weighs nothing: every scenario takes the default, said so.
  for (const scenario of result.draft.scenarios) {
    assert.equal(scenario.weight, POSTED_SCENARIO_WEIGHT);
    assert.equal(scenario.weightReason, POSTED_WEIGHT_REASON);
  }
  assert.deepEqual(result.draft.assumptions, [
    "Units are lowercase only: `3S` is invalid.",
  ]);
});

test("an Examples table is one last step; a step's table folds into it", () => {
  const result = specFromDocument(
    read({
      scenarios: [
        {
          key: "happy-1",
          title: "Components add up",
          body: [
            'When I parse "<text>"',
            "And the units are:",
            "| unit | ms |",
            "| s | 1000 |",
            "Then the result is <ms>",
            "Examples:",
            "| text | ms |",
            "| 250ms | 250 |",
            "| 90s | 90000 |",
          ].join("\n"),
        },
      ],
    }),
  );
  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(result.draft.scenarios[0]?.steps, [
    { keyword: "When", text: 'I parse "<text>"' },
    { keyword: "And", text: "the units are: — unit | ms; s | 1000" },
    { keyword: "Then", text: "the result is <ms>" },
    { keyword: "And", text: "examples (text | ms) — 250ms | 250; 90s | 90000" },
  ]);
});

test("a table too long for a step keeps the rows that fit and says how many it left", () => {
  const rows = Array.from(
    { length: 40 },
    (_, index) => `| ${index}d | ${index * 86_400_000} |`,
  );
  const result = specFromDocument(
    read({
      scenarios: [
        {
          key: "happy-1",
          title: "Many",
          body: [
            'When I parse "<text>"',
            "Examples:",
            "| text | ms |",
            ...rows,
          ].join("\n"),
        },
      ],
    }),
  );
  assert.ok(result.ok, JSON.stringify(result));
  const examples = result.draft.scenarios[0]?.steps.at(-1)?.text ?? "";
  assert.ok(examples.length <= SPEC_LIMITS.stepChars, examples);
  assert.match(examples, /^examples \(text \| ms\) — 0d \| 0; 1d \| 86400000/);
  assert.match(examples, / \(\d+ more rows in the posted spec\)$/);
});

test("an untagged scenario is happy; a description before its steps is not a step", () => {
  const result = specFromDocument(
    read({
      scenarios: [
        {
          key: "untagged-1",
          title: "Plain",
          body: "Some words about it.\nGiven a thing\n# a comment\nThen it works\n",
        },
      ],
    }),
  );
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.draft.scenarios[0]?.kind, "happy");
  assert.deepEqual(
    result.draft.scenarios[0]?.steps.map(({ keyword }) => keyword),
    ["Given", "Then"],
  );
});

test("an unfenced document's last scenario stops at its Decided: list", () => {
  const result = specFromDocument(
    read({
      scenarios: [
        {
          key: "happy-1",
          title: "Last",
          body: "Given a thing\nThen it works\n# Assumptions\n# - Half rounds up.\nDecided:\n- Half rounds up.\n",
        },
      ],
    }),
  );
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.draft.scenarios[0]?.steps.length, 2);
});

test("every problem is named by where it is", () => {
  const result = specFromDocument({
    feature: null,
    background: Array.from(
      { length: SPEC_LIMITS.background + 1 },
      () => "a step",
    ),
    scenarios: [
      { key: "edge-1", title: "Tagged wrong", body: "Given a thing\n" },
      { key: "happy-1", title: "No steps", body: "Just words.\n" },
      {
        key: "happy-2",
        title: "x".repeat(SPEC_LIMITS.titleChars + 1),
        body: "Given a thing\nnot a step after one\n",
      },
    ],
    decisions: Array.from(
      { length: SPEC_LIMITS.assumptions + 1 },
      (_, index) => ({
        text: `Decision ${index}.`,
      }),
    ),
    openQuestions: [],
  });
  assert.equal(result.ok, false);
  const paths = result.ok ? [] : result.problems.map(({ path }) => path);
  assert.deepEqual(paths, [
    "feature",
    "background",
    "scenarios[0].kind",
    "scenarios[1].steps",
    "scenarios[2].title",
    "scenarios[2].steps",
    "decisions",
  ]);
  assert.match(
    result.ok ? "" : (result.problems[2]?.message ?? ""),
    /@edge is not a scenario kind/,
  );
});

test("a document with no scenario and no open question is refused", () => {
  const result = specFromDocument(read({ scenarios: [] }));
  assert.equal(result.ok, false);
  assert.deepEqual(result.ok ? [] : result.problems.map(({ path }) => path), [
    "scenarios",
  ]);
});

test("decisions longer than a note, or empty, are problems", () => {
  const result = specFromDocument(
    read({
      decisions: [
        { text: "y".repeat(SPEC_LIMITS.noteChars + 1) },
        { text: "  " },
      ],
    }),
  );
  assert.deepEqual(result.ok ? [] : result.problems.map(({ path }) => path), [
    "decisions[0]",
    "decisions[1]",
  ]);
});

test("the feature, the background and open questions are read off the text", () => {
  const fenced = [
    "# Duration strings",
    "",
    "Context.",
    "",
    "```gherkin",
    "Feature: Durations",
    "",
    "  Background:",
    "    Given a scheduler",
    "    And a clock",
    "      | zone |",
    "      | UTC |",
    "",
    "  @happy",
    "  Scenario: One",
    "    Then it works",
    "```",
  ].join("\n");
  assert.equal(documentFeature(fenced), "Durations");
  assert.deepEqual(documentBackground(fenced), [
    "a scheduler",
    "a clock — zone; UTC",
  ]);
  assert.equal(documentFeature("# Only a heading\n\ntext"), "Only a heading");
  assert.equal(documentFeature("no heading at all"), null);
  assert.deepEqual(documentBackground("Feature: x\n  Scenario: y\n"), []);
  assert.deepEqual(documentOpenQuestions(fenced), []);
});

test("the platform's own spec document reads back as the spec it renders", () => {
  const draft: SpecDraft = {
    feature: "Fee by amount",
    background: ["a ledger entry in cents"],
    scenarios: [
      {
        id: "s1",
        kind: "happy",
        title: "a credit is free",
        steps: [
          { keyword: "Given", text: "a credit of 10000 cents" },
          { keyword: "Then", text: "its fee is 0 cents" },
        ],
        origin: "draft",
      },
      {
        id: "s2",
        kind: "boundary",
        title: "a small debit pays the minimum",
        steps: [
          { keyword: "Given", text: "a debit of 100 cents" },
          { keyword: "Then", text: "its fee is 25 cents" },
        ],
        origin: "expansion",
      },
    ],
    openQuestions: ["Which currency?"],
    assumptions: ["Half a cent rounds up."],
  };
  const document = renderSpecDocument(draft);
  assert.equal(documentFeature(document), draft.feature);
  assert.deepEqual(documentBackground(document), draft.background);
  assert.deepEqual(documentOpenQuestions(document), draft.openQuestions);
});

test("past the stored caps: scenarios, steps, an empty title and open questions", () => {
  const result = specFromDocument(
    read({
      scenarios: [
        {
          key: "happy-1",
          title: " ",
          body: Array.from(
            { length: SPEC_LIMITS.steps + 1 },
            (_, index) => `Given step ${index}`,
          ).join("\n"),
        },
        ...Array.from({ length: SPEC_LIMITS.scenarios }, (_, index) => ({
          key: `happy-${index + 2}`,
          title: `Scenario ${index}`,
          body: "Then it works\n",
        })),
      ],
      openQuestions: Array.from(
        { length: SPEC_LIMITS.openQuestions + 1 },
        (_, index) => `Question ${index}?`,
      ),
    }),
  );
  assert.deepEqual(result.ok ? [] : result.problems.map(({ path }) => path), [
    "scenarios",
    "scenarios[0].title",
    "scenarios[0].steps",
    "openQuestions",
  ]);
});
