/**
 * The pricing arithmetic's laws, checked over every input in a bounded
 * domain rather than by example. The inputs are small integers and short
 * lists, so enumeration is complete: within the bounds, these are proofs.
 *
 * The example tests beside this file pin what the numbers are; this one
 * pins what must stay true of them however the numbers are tuned, which is
 * what the rubric's band edges and a board's step settings are for.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import * as fc from "fast-check";

import {
  assessRubric,
  checksOf,
  DEFAULT_RATE_CARD,
  formatMinorUnits,
  halfStepsUp,
  nextHalfStep,
  parseMinorUnits,
  PRICED_BOUNTY_COMPLEXITIES,
  priceFor,
  rebaseStep,
  resolveStepSettings,
  RUBRIC_BANDS,
  RUBRIC_POINTS,
  rubricBand,
  rubricNeedsReview,
  rubricSize,
  SCENARIO_WEIGHTS,
  stepUp,
  validateRateCard,
  WEIGHT_POINTS,
  WHOLE_BOUNTY_COMPLEXITIES,
  type PricedComplexity,
  type RateCardValues,
  type Scenario,
  type ScenarioStep,
  type ScenarioWeight,
  type SpecDraft,
} from "../src/index.js";

const PRICED = PRICED_BOUNTY_COMPLEXITIES;
const LAST = PRICED.length - 1;
const position = (size: PricedComplexity) => PRICED.indexOf(size);
const bandFrom = (size: PricedComplexity) =>
  RUBRIC_BANDS.find((band) => band.size === size)?.from ?? Number.NaN;

const outcome: ScenarioStep = { keyword: "Then", text: "it works" };

function scenario(
  index: number,
  weight: ScenarioWeight | undefined,
  steps: readonly ScenarioStep[] = [outcome],
): Scenario {
  return {
    id: `s${index}`,
    kind: "happy",
    title: `Scenario ${index}`,
    steps,
    origin: "draft",
    ...(weight === undefined ? {} : { weight }),
  };
}

function spec(...scenarios: Scenario[]): SpecDraft {
  return {
    feature: "Laws",
    background: [],
    scenarios,
    openQuestions: [],
    assumptions: [],
  };
}

/** `count` light scenarios, titled apart from any sized draft's. */
const light = (count: number) =>
  Array.from({ length: count }, (_, i) => scenario(100 + i, "light"));

test("the step: for every base, every added weight and every points-per-step", () => {
  const sized = spec();
  for (const base of WHOLE_BOUNTY_COMPLEXITIES) {
    for (let pointsPerStep = 1; pointsPerStep <= 8; pointsPerStep += 1) {
      const settings = resolveStepSettings({ pointsPerStep });
      let previous = position(base);
      for (let added = 0; added <= 60; added += 1) {
        const result = stepUp(base, sized, spec(...light(added)), settings);
        assert.ok(result !== null);
        const at = position(result.complexity);
        // The arithmetic the module documents.
        assert.equal(
          at,
          Math.min(position(base) + Math.floor(added / pointsPerStep), LAST),
        );
        assert.equal(result.addedPoints, added);
        assert.equal(halfStepsUp(base, result.steps), result.complexity);
        // Never below the base, never down as weight is added.
        assert.ok(at >= position(base));
        assert.ok(at >= previous);
        previous = at;
        // The next step is named exactly when there is one, and it is exact.
        assert.equal(result.nextStepIn === null, result.complexity === "XL");
        if (result.nextStepIn !== null) {
          assert.ok(
            result.nextStepIn >= 1 && result.nextStepIn <= pointsPerStep,
          );
          const reached = stepUp(
            base,
            sized,
            spec(...light(added + result.nextStepIn)),
            settings,
          );
          assert.equal(position(reached?.complexity ?? "XS"), at + 1);
          const short = stepUp(
            base,
            sized,
            spec(...light(added + result.nextStepIn - 1)),
            settings,
          );
          assert.equal(short?.complexity, result.complexity);
          assert.equal(nextHalfStep(result.complexity), reached?.complexity);
        }
        // Rebasing keeps the weight and recomputes from the new base.
        for (const other of WHOLE_BOUNTY_COMPLEXITIES) {
          const rebased = rebaseStep(result, other);
          assert.equal(rebased.addedPoints, added);
          assert.deepEqual(
            rebased,
            stepUp(other, sized, spec(...light(added)), settings),
          );
        }
      }
    }
  }
});

/** Every multiset of up to `size` picks from `items`, as sorted index lists. */
function multisets(count: number, size: number): number[][] {
  const result: number[][] = [[]];
  const grow = (prefix: number[], from: number) => {
    if (prefix.length === size) return;
    for (let i = from; i < count; i += 1) {
      const next = [...prefix, i];
      result.push(next);
      grow(next, i);
    }
  };
  grow([], 0);
  return result;
}

const WEIGHT_OPTIONS: readonly (ScenarioWeight | undefined)[] = [
  ...SCENARIO_WEIGHTS,
  undefined,
];
const pointsOfWeight = (weight: ScenarioWeight | undefined) =>
  WEIGHT_POINTS[weight ?? "moderate"];

test("the step counts the difference of points, trimmed below the base counts nothing", () => {
  const sizedSets = multisets(WEIGHT_OPTIONS.length, 3);
  for (const before of sizedSets) {
    for (const after of sizedSets) {
      const sized = spec(
        ...before.map((w, i) => scenario(i, WEIGHT_OPTIONS[w])),
      );
      const current = spec(
        ...after.map((w, i) => scenario(50 + i, WEIGHT_OPTIONS[w])),
      );
      const result = stepUp("S", sized, current);
      const unweighed = [...before, ...after].some(
        (w) => WEIGHT_OPTIONS[w] === undefined,
      );
      if (unweighed) {
        assert.equal(result, null);
        continue;
      }
      assert.ok(result !== null);
      const sum = (set: number[]) =>
        set.reduce((total, w) => total + pointsOfWeight(WEIGHT_OPTIONS[w]), 0);
      assert.equal(result.addedPoints, Math.max(0, sum(after) - sum(before)));
      // Titles differ, so every current scenario is listed as added and
      // every sized one as removed; the points still say the net change.
      assert.equal(result.added.length, after.length);
      assert.equal(result.removed?.length, before.length);
    }
  }
  // A subset of the sized draft is a trim: zero points, the base stands.
  const draft = [
    scenario(1, "light"),
    scenario(2, "moderate"),
    scenario(3, "heavy"),
    scenario(4, "covered"),
  ];
  for (let mask = 0; mask < 1 << draft.length; mask += 1) {
    const kept = draft.filter((_, i) => (mask & (1 << i)) !== 0);
    for (const base of WHOLE_BOUNTY_COMPLEXITIES) {
      const result = stepUp(base, spec(...draft), spec(...kept));
      assert.ok(result !== null);
      assert.equal(result.addedPoints, 0);
      assert.equal(result.complexity, base);
      assert.equal(result.added.length, 0);
      assert.equal(result.removed?.length, draft.length - kept.length);
    }
  }
});

test("the rubric's bands tile the points line in size order, and the discounts fit under the two smallest", () => {
  assert.deepEqual(
    RUBRIC_BANDS.map((band) => band.size),
    [...PRICED],
  );
  assert.equal(RUBRIC_BANDS[0]?.from, 0);
  for (let i = 1; i < RUBRIC_BANDS.length; i += 1) {
    const previous = RUBRIC_BANDS[i - 1];
    const band = RUBRIC_BANDS[i];
    assert.ok(previous !== undefined && band !== undefined);
    assert.ok(band.from > previous.from);
    assert.equal(rubricBand(previous.size).to, band.from - 1);
  }
  assert.equal(rubricBand("XL").to, null);
  let last = -1;
  for (let points = 0; points <= 300; points += 1) {
    const size = rubricSize(points);
    const band = rubricBand(size);
    assert.ok(band.from <= points);
    assert.ok(band.to === null || points <= band.to);
    assert.ok(position(size) >= last);
    last = position(size);
  }
  // The documented bound: the discounts together are less than XS and XS+.
  const discounts = Object.values(RUBRIC_POINTS)
    .map((value) => (typeof value === "number" ? value : 0))
    .filter((value) => value < 0)
    .reduce((sum: number, value: number) => sum + value, 0);
  assert.ok(-discounts < bandFrom("S"));
  // Review distance is symmetric, and a size never needs review of itself.
  for (const a of PRICED)
    for (const b of PRICED) {
      assert.equal(rubricNeedsReview(a, b), rubricNeedsReview(b, a));
      if (a === b) assert.equal(rubricNeedsReview(a, b), false);
    }
});

const STEP_PATTERNS: readonly (readonly ScenarioStep["keyword"][])[] = [
  ["Then"],
  ["When", "Then", "And"],
  ["Given", "When", "Then", "And", "But"],
];

test("the rubric over the spec alone: its total is its factors' sum, and adding a scenario never lowers the size", () => {
  type Kind = { weight: ScenarioWeight | undefined; steps: ScenarioStep[] };
  const kinds: Kind[] = WEIGHT_OPTIONS.flatMap((weight) =>
    STEP_PATTERNS.map((pattern) => ({
      weight,
      steps: pattern.map((keyword) => ({ keyword, text: "a step" })),
    })),
  );
  const assessed = new Map<string, number>();
  const assess = (set: number[], openQuestions: number) => {
    const scenarios = set.map((k, i) => {
      const kind = kinds[k];
      assert.ok(kind !== undefined);
      return scenario(i, kind.weight, kind.steps);
    });
    return assessRubric({
      spec: {
        scenarios,
        openQuestions: Array.from({ length: openQuestions }, () => "why?"),
      },
      code: { status: "unavailable" },
    });
  };
  // Smaller multisets first, so each one-smaller set is already assessed.
  const sets = multisets(kinds.length, 4).sort((a, b) => a.length - b.length);
  for (const set of sets) {
    for (let openQuestions = 0; openQuestions <= 2; openQuestions += 1) {
      const assessment = assess(set, openQuestions);
      const expected = set.reduce((sum, k) => {
        const kind = kinds[k];
        assert.ok(kind !== undefined);
        const ownTest = kind.weight !== "covered";
        const checks = checksOf({ steps: kind.steps });
        return (
          sum +
          pointsOfWeight(kind.weight) +
          (ownTest ? RUBRIC_POINTS.testCase : 0) +
          (ownTest ? Math.max(0, checks - 1) * RUBRIC_POINTS.extraCheck : 0)
        );
      }, openQuestions * RUBRIC_POINTS.openQuestion);
      assert.equal(assessment.points, expected);
      assert.equal(assessment.size, rubricSize(expected));
      const next = RUBRIC_BANDS[position(rubricSize(expected)) + 1];
      assert.equal(
        assessment.nextSizeIn,
        next === undefined ? null : next.from - expected,
      );
      assert.equal(assessment.counts.scenarios, set.length);
      assert.equal(
        assessment.counts.testCases,
        set.filter((k) => kinds[k]?.weight !== "covered").length,
      );
      assert.equal(assessment.code.status, "unavailable");
      assessed.set(`${set.join(",")}|${openQuestions}`, assessment.points);
      // One scenario fewer never scored more.
      for (let drop = 0; drop < set.length; drop += 1) {
        const smaller = set.filter((_, i) => i !== drop);
        const fewer = assessed.get(`${smaller.join(",")}|${openQuestions}`);
        assert.ok(fewer !== undefined);
        assert.ok(fewer <= assessment.points);
      }
    }
  }
});

const AMOUNTS = [1, 2, 3, 5, 8, 13, 100] as const;

test("every valid rate card prices the nine sizes in order, each half size between its neighbours", () => {
  const currencies = new Set(["USD", "EUR"]);
  let cards = 0;
  for (const xs of AMOUNTS)
    for (const s of AMOUNTS)
      for (const m of AMOUNTS)
        for (const l of AMOUNTS)
          for (const xl of AMOUNTS) {
            const card: RateCardValues = {
              currency: "USD",
              xsMinor: xs,
              sMinor: s,
              mMinor: m,
              lMinor: l,
              xlMinor: xl,
            };
            const valid = xs <= s && s <= m && m <= l && l <= xl;
            const checked = validateRateCard(card, currencies);
            assert.equal(checked.ok, valid);
            if (!valid) continue;
            cards += 1;
            const prices = PRICED.map((size) => priceFor(size, card));
            for (let i = 0; i < prices.length; i += 1) {
              const price = prices[i];
              assert.ok(typeof price === "number");
              if (i > 0) assert.ok(price >= (prices[i - 1] ?? 0));
              if (PRICED[i]?.endsWith("+")) {
                const lower = prices[i - 1] ?? 0;
                const upper = prices[i + 1] ?? 0;
                assert.ok(lower <= price && price <= upper);
                assert.equal(price, Math.round((lower + upper) / 2));
              }
            }
            assert.equal(priceFor("unsized", card), null);
          }
  assert.ok(cards > 0);
  assert.equal(validateRateCard(DEFAULT_RATE_CARD, currencies).ok, true);
});

test("minor units: parsing undoes formatting for every amount and precision", () => {
  for (let digits = 0; digits <= 3; digits += 1) {
    for (let value = 0; value <= 3_000; value += 1) {
      const text = formatMinorUnits(value, digits);
      assert.ok(text !== null);
      assert.equal(parseMinorUnits(text, digits), value);
      assert.match(
        text,
        digits === 0 ? /^\d+$/ : new RegExp(`^\\d+\\.\\d{${digits}}$`),
      );
    }
  }
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
      fc.integer({ min: 0, max: 3 }),
      (value, digits) => {
        const text = formatMinorUnits(value, digits);
        assert.ok(text !== null);
        assert.equal(parseMinorUnits(text, digits), value);
      },
    ),
    { numRuns: 5_000 },
  );
  // What formatting produces is the only shape parsing takes: anything
  // with more fraction digits than the precision, or not a plain decimal,
  // is refused rather than rounded.
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 10_000 }),
      fc.integer({ min: 0, max: 3 }),
      fc.integer({ min: 1, max: 3 }),
      (value, digits, extra) => {
        const text = `${formatMinorUnits(value, digits)}${digits === 0 ? "." : ""}${"0".repeat(extra)}`;
        assert.equal(parseMinorUnits(text, digits), null);
      },
    ),
  );
});
