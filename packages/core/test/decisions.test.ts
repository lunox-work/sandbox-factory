import assert from "node:assert/strict";
import { test } from "node:test";

import {
  decisionsText,
  renderGherkin,
  renderSpecDocument,
  specDecisions,
  type SpecDraft,
} from "../src/index.js";

const draft: SpecDraft = {
  feature: "Retry failed invoices",
  background: [],
  scenarios: [
    {
      id: "s1",
      kind: "happy",
      title: "A failed invoice is retried",
      steps: [{ keyword: "Given", text: "an invoice that failed" }],
      origin: "draft",
    },
  ],
  openQuestions: ["How often?"],
  assumptions: [
    "Retries stop  after\nthree attempts.",
    "Only card payments retry.",
  ],
};

test("a spec's decisions are its assumptions, keyed in order and on one line", () => {
  assert.deepEqual(specDecisions(draft), [
    { key: "d1", text: "Retries stop after three attempts." },
    { key: "d2", text: "Only card payments retry." },
  ]);
  assert.equal(
    decisionsText(specDecisions(draft)),
    "d1\tRetries stop after three attempts.\nd2\tOnly card payments retry.\n",
  );
  assert.deepEqual(specDecisions({ ...draft, assumptions: [] }), []);
});

test("the spec document is the Gherkin, then duediligence's Decided: list", () => {
  const text = renderSpecDocument(draft);
  assert.ok(text.startsWith(renderGherkin(draft)));
  assert.ok(
    text.endsWith(
      "\nDecided:\n\n- Retries stop after three attempts.\n- Only card payments retry.\n",
    ),
  );
  // No decisions, no heading.
  const none = { ...draft, assumptions: [] };
  assert.equal(renderSpecDocument(none), renderGherkin(none));
});
