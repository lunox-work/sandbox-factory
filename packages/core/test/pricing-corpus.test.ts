/**
 * The invented pricing corpus (`pricing-corpus/corpus.ts`), scored with the
 * rubric as it is. Disagreements with the expected bands are reported, not
 * failed: the expected bands are judgement. Only the corpus's own shape and
 * each ticket's gross `bounds` are asserted. The full table:
 * `npm run pricing-corpus --workspace sandbox-factory`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  hasOwnTest,
  PRICED_BOUNTY_COMPLEXITIES,
  RUBRIC_BANDS,
  SPEC_LIMITS,
  type PricedComplexity,
} from "../src/index.js";
import { PRICING_CORPUS, specOf } from "./pricing-corpus/corpus.js";
import {
  formatReport,
  parseBands,
  scoreCorpus,
  sizeWith,
  summarize,
} from "./pricing-corpus/report.js";

const position = (size: PricedComplexity) =>
  PRICED_BOUNTY_COMPLEXITIES.indexOf(size);

test("the corpus is 20 to 30 distinct tickets spanning XS to XL", () => {
  assert.ok(PRICING_CORPUS.length >= 20 && PRICING_CORPUS.length <= 30);
  const ids = PRICING_CORPUS.map(({ id }) => id);
  assert.equal(new Set(ids).size, ids.length);
  for (const { id, rationale } of PRICING_CORPUS) {
    assert.match(id, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.ok(rationale.length > 0 && rationale.length <= 80, id);
  }
  const expected = new Set(PRICING_CORPUS.map(({ expected }) => expected));
  assert.ok(expected.has("XS") && expected.has("XL"));
});

test("every ticket's spec is one the draft step could have written", () => {
  for (const ticket of PRICING_CORPUS) {
    const spec = specOf(ticket);
    assert.ok(spec.scenarios.length <= SPEC_LIMITS.draftScenarios, ticket.id);
    assert.ok(spec.openQuestions.length <= SPEC_LIMITS.openQuestions);
    // A whole spec of covered scenarios is refused by the draft schema.
    assert.ok(
      spec.scenarios.some(({ weight }) => hasOwnTest(weight)),
      ticket.id,
    );
    for (const { steps } of spec.scenarios) {
      assert.ok(steps.length >= 2 && steps.length <= 6, ticket.id);
      assert.ok(
        ["Given", "When", "Then"].includes(steps[0]?.keyword ?? ""),
        ticket.id,
      );
    }
  }
});

test("no ticket breaks its gross bounds, spec-only or code-informed", () => {
  for (const { ticket, spec, code } of scoreCorpus()) {
    const { atMost, atLeast } = ticket.bounds ?? {};
    for (const [label, scored] of [
      ["spec-only", spec],
      ["code-informed", code],
    ] as const) {
      const where = `${ticket.id} ${label}: ${scored.points} points, ${scored.size}`;
      if (atMost !== undefined)
        assert.ok(position(scored.size) <= position(atMost), where);
      if (atLeast !== undefined)
        assert.ok(position(scored.size) >= position(atLeast), where);
    }
  }
});

test("the report has a row per ticket and both summaries", (t) => {
  const rows = scoreCorpus();
  const report = formatReport(rows, RUBRIC_BANDS);
  const lines = report.split("\n");
  // Bands, the judgement note, the header, a row each, two summaries.
  assert.equal(lines.length, PRICING_CORPUS.length + 5);
  for (const { id } of PRICING_CORPUS)
    assert.ok(
      lines.some((row) => row.startsWith(`${id} `)),
      id,
    );
  // The summaries, so a test run shows how far the rubric is from the
  // judgement without failing on it.
  for (const summary of lines.slice(-2)) t.diagnostic(summary);
});

test("candidate bands are parsed strictly and change only the band", () => {
  const same = parseBands(
    RUBRIC_BANDS.map(({ size, from }) => `${size}:${from}`).join(","),
  );
  assert.deepEqual(same, RUBRIC_BANDS);
  assert.deepEqual(scoreCorpus(same), scoreCorpus());
  assert.throws(() => parseBands("XS:0,S:7"), /must name/);
  assert.throws(() => parseBands("XS:0,XS+:x"), /not a band/);
  assert.throws(
    () =>
      parseBands(same.map(({ size, from }) => `${size}:${from + 1}`).join(",")),
    /XS must start at 0/,
  );
  assert.throws(
    () =>
      parseBands(
        same
          .map(({ size }, index) => `${size}:${index === 2 ? 1 : index * 5}`)
          .join(","),
      ),
    /must rise/,
  );
  assert.equal(sizeWith(0, same), "XS");
  assert.equal(sizeWith(1000, same), "XL");
  assert.deepEqual(summarize([]), {
    tickets: 0,
    exact: 0,
    withinHalf: 0,
    above: 0,
    below: 0,
    meanGap: 0,
  });
});
