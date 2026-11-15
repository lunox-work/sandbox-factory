import assert from "node:assert/strict";
import { test } from "node:test";

import { specDraftSchema } from "@sandbox-factory/shared";
import { decisionItems, scenarios } from "duediligence/api";
import { renderSpecDocument, type SpecDraft } from "sandbox-factory";

import {
  DUEDILIGENCE_VERSION,
  postedSpecSource,
  readPostedSpec,
} from "../src/bounties/posted-spec.js";

/** duediligence's own example spec, cut to two rules, as `spec.md` has it. */
const DURATION_SPEC = `# Duration strings

A job scheduler takes timeouts as short strings such as \`1h30m\`.

\`\`\`gherkin
Feature: Duration strings

  Rule: R1. A duration is one or more components, each a count and a unit
    A component is a decimal integer followed by one of the units.

    @happy
    Scenario Outline: Components add up
      When I parse "<text>"
      Then the result is <ms>

      Examples:
        | text        | ms        |
        | 250ms       | 250       |
        | 1h30m       | 5400000   |

    @boundary
    Scenario: Surrounding whitespace is ignored
      When I parse "  45m\\n"
      Then the result is 2700000

  Rule: R2. Units run from largest to smallest, each at most once

    @unhappy
    Scenario Outline: Out-of-order or repeated units are rejected
      When I parse "<text>"
      Then it throws an Error whose message contains "duration"

      Examples:
        | text      |
        | 30m1h     |
        | 1h1h      |
\`\`\`

Decided:

- Leading and trailing whitespace is trimmed; whitespace anywhere else is
  invalid.
  Ticket: silent.
  Instead: reject surrounding whitespace too.
- Units are lowercase only: \`3S\` is invalid.
`;

test("a duediligence spec.md reads as the spec its parser sees, decisions word for word", () => {
  const read = readPostedSpec(DURATION_SPEC);
  assert.ok(read.ok, JSON.stringify(read));
  assert.ok(specDraftSchema.safeParse(read.draft).success);
  assert.equal(read.draft.feature, "Duration strings");
  // Each scenario where duediligence keys it: kind, then position.
  assert.deepEqual(
    read.draft.scenarios.map(({ kind, title }) => `${kind}:${title}`),
    scenarios(DURATION_SPEC).map(
      ({ key, title }) => `${key.replace(/-\d+$/, "")}:${title}`,
    ),
  );
  assert.deepEqual(
    read.draft.assumptions,
    decisionItems(DURATION_SPEC).map(({ text }) => text),
  );
  assert.deepEqual(read.draft.assumptions, [
    "Leading and trailing whitespace is trimmed; whitespace anywhere else is invalid.",
    "Units are lowercase only: `3S` is invalid.",
  ]);
  assert.deepEqual(read.draft.scenarios[0]?.steps, [
    { keyword: "When", text: 'I parse "<text>"' },
    { keyword: "Then", text: "the result is <ms>" },
    {
      keyword: "And",
      text: "examples (text | ms) — 250ms | 250; 1h30m | 5400000",
    },
  ]);
});

test("the platform's own spec document posts back as the spec it renders", () => {
  const draft: SpecDraft = {
    feature: "Fee by amount",
    background: ["a ledger entry in cents"],
    scenarios: [
      {
        id: "s1",
        kind: "happy",
        title: "a debit pays one percent",
        steps: [
          { keyword: "Given", text: "a debit of 4250 cents" },
          { keyword: "Then", text: "its fee is 43 cents" },
        ],
        origin: "draft",
        weight: "moderate",
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
        weight: "light",
      },
    ],
    openQuestions: ["Which currency?"],
    assumptions: ["Half a cent rounds up.", "A credit is free."],
  };
  const read = readPostedSpec(renderSpecDocument(draft));
  assert.ok(read.ok, JSON.stringify(read));
  assert.equal(read.draft.feature, draft.feature);
  assert.deepEqual(read.draft.background, draft.background);
  assert.deepEqual(read.draft.openQuestions, draft.openQuestions);
  assert.deepEqual(read.draft.assumptions, draft.assumptions);
  assert.deepEqual(
    read.draft.scenarios.map(({ id, kind, title, steps }) => ({
      id,
      kind,
      title,
      steps,
    })),
    draft.scenarios.map(({ id, kind, title, steps }) => ({
      id,
      kind,
      title,
      steps,
    })),
  );
});

test("a document with nothing in it is refused, with where", () => {
  const read = readPostedSpec("Just a note, no spec.");
  assert.equal(read.ok, false);
  assert.deepEqual(read.ok ? [] : read.problems.map(({ path }) => path), [
    "feature",
    "scenarios",
  ]);
});

test("a posted spec's source is the engine named, else the parser's version", () => {
  assert.equal(
    postedSpecSource({
      document: "x",
      format: "duediligence",
      confirmed: true,
      engine: { name: "duediligence", version: "0.6.0" },
    }),
    "duediligence@0.6.0",
  );
  assert.equal(
    postedSpecSource({
      document: "x",
      format: "duediligence",
      confirmed: true,
    }),
    `duediligence@${DUEDILIGENCE_VERSION}`,
  );
});
