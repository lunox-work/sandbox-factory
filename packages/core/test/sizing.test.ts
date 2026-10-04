import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BOUNTY_COMPLEXITIES,
  formatMinorUnits,
  MODEL_BOUNTY_COMPLEXITIES,
  parseMinorUnits,
  PRICED_BOUNTY_COMPLEXITIES,
  priceFor,
  validateRateCard,
  WHOLE_BOUNTY_COMPLEXITIES,
} from "../src/sizing.js";

const usd = new Set(["USD"]);

test("validates and normalizes a nondecreasing rate card", () => {
  assert.deepEqual(
    validateRateCard(
      {
        currency: " usd ",
        xsMinor: 100,
        sMinor: 100,
        mMinor: 200,
        lMinor: 300,
        xlMinor: 300,
      },
      usd,
    ),
    {
      ok: true,
      rateCard: {
        currency: "USD",
        xsMinor: 100,
        sMinor: 100,
        mMinor: 200,
        lMinor: 300,
        xlMinor: 300,
      },
    },
  );
});

test("rejects unsupported currencies, invalid amounts and descending rates", () => {
  assert.equal(
    validateRateCard(
      {
        currency: "EUR",
        xsMinor: 100,
        sMinor: 100,
        mMinor: 200,
        lMinor: 300,
        xlMinor: 400,
      },
      usd,
    ).ok,
    false,
  );
  assert.equal(
    validateRateCard(
      {
        currency: "USD",
        xsMinor: 0,
        sMinor: 0,
        mMinor: 200,
        lMinor: 300,
        xlMinor: 400,
      },
      usd,
    ).ok,
    false,
  );
  assert.equal(
    validateRateCard(
      {
        currency: "USD",
        xsMinor: 300,
        sMinor: 300,
        mMinor: 200,
        lMinor: 400,
        xlMinor: 500,
      },
      usd,
    ).ok,
    false,
  );
});

test("maps sizes to the card and leaves unsized unpriced", () => {
  const card = {
    currency: "USD",
    xsMinor: 1,
    sMinor: 1,
    mMinor: 2,
    lMinor: 3,
    xlMinor: 4,
  };
  assert.equal(priceFor("XS", card), 1);
  assert.equal(priceFor("S", card), 1);
  assert.equal(priceFor("M", card), 2);
  assert.equal(priceFor("L", card), 3);
  assert.equal(priceFor("XL", card), 4);
  assert.equal(priceFor("unsized", card), null);
});

test("prices a half size at the midpoint of its neighbours, to a whole minor unit", () => {
  const card = {
    currency: "USD",
    xsMinor: 1_000,
    sMinor: 5_800,
    mMinor: 10_500,
    lMinor: 15_300,
    xlMinor: 20_000,
  };
  assert.equal(priceFor("XS+", card), 3_400);
  // 8,150 exactly, and 12,900 and 17,650: the default card has no halves.
  assert.equal(priceFor("S+", card), 8_150);
  assert.equal(priceFor("M+", card), 12_900);
  assert.equal(priceFor("L+", card), 17_650);
  // An odd gap rounds half up rather than leaving a fraction of a cent.
  assert.equal(priceFor("S+", { ...card, sMinor: 1, mMinor: 2 }), 2);
  // Every half size sits between its neighbours, so the order holds.
  const prices = PRICED_BOUNTY_COMPLEXITIES.map((size) => priceFor(size, card));
  assert.deepEqual(
    prices,
    [...prices].sort((a, b) => (a ?? 0) - (b ?? 0)),
  );
});

test("the model and the resize keep the five whole sizes; pricing has nine", () => {
  assert.deepEqual(WHOLE_BOUNTY_COMPLEXITIES, ["XS", "S", "M", "L", "XL"]);
  assert.deepEqual(MODEL_BOUNTY_COMPLEXITIES, [
    ...WHOLE_BOUNTY_COMPLEXITIES,
    "unsized",
  ]);
  assert.deepEqual(PRICED_BOUNTY_COMPLEXITIES, [
    "XS",
    "XS+",
    "S",
    "S+",
    "M",
    "M+",
    "L",
    "L+",
    "XL",
  ]);
  assert.deepEqual(BOUNTY_COMPLEXITIES, [
    ...PRICED_BOUNTY_COMPLEXITIES,
    "unsized",
  ]);
});

test("parses decimal money exactly and rejects excess precision", () => {
  assert.equal(parseMinorUnits("12.34", 2), 1234);
  assert.equal(parseMinorUnits("12", 2), 1200);
  assert.equal(parseMinorUnits("12.3", 2), 1230);
  assert.equal(parseMinorUnits("12.345", 2), null);
  assert.equal(parseMinorUnits("1.2", 0), null);
  assert.equal(parseMinorUnits("-1", 2), null);
});

test("formats minor units exactly for zero and fractional currencies", () => {
  assert.equal(formatMinorUnits(1234, 2), "12.34");
  assert.equal(formatMinorUnits(12, 0), "12");
  assert.equal(formatMinorUnits(5, 3), "0.005");
  assert.equal(formatMinorUnits(-1, 2), null);
  assert.equal(formatMinorUnits(1.5, 2), null);
});

test("XS must be positive and no greater than S", () => {
  const card = {
    currency: "USD",
    xsMinor: 50,
    sMinor: 100,
    mMinor: 200,
    lMinor: 300,
    xlMinor: 400,
  };
  assert.equal(priceFor("XS", card), 50);
  assert.equal(validateRateCard(card, usd).ok, true);
  for (const xsMinor of [0, -1, 1.5, 101, Number.MAX_VALUE]) {
    assert.equal(validateRateCard({ ...card, xsMinor }, usd).ok, false);
  }
});

test("USD rate-card writes cap XL at 1,000 without imposing that limit on other currencies", () => {
  const card = {
    currency: " usd ",
    xsMinor: 1000,
    sMinor: 5800,
    mMinor: 10500,
    lMinor: 15300,
    xlMinor: 100000,
  };
  assert.equal(validateRateCard(card, usd).ok, true);
  assert.deepEqual(validateRateCard({ ...card, xlMinor: 100001 }, usd), {
    ok: false,
    reason: "XL cannot exceed USD 1,000.",
  });
  assert.equal(
    validateRateCard(
      { ...card, currency: "JPY", xlMinor: 200000 },
      new Set(["JPY"]),
    ).ok,
    true,
  );
});
