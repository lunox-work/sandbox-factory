import assert from "node:assert/strict";
import { test } from "node:test";

import {
  formatMinorUnits,
  parseMinorUnits,
  priceFor,
  validateRateCard,
} from "../src/bounty.js";

const usd = new Set(["USD"]);

test("validates and normalizes a nondecreasing rate card", () => {
  assert.deepEqual(
    validateRateCard(
      {
        currency: " usd ",
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
      { currency: "EUR", sMinor: 100, mMinor: 200, lMinor: 300, xlMinor: 400 },
      usd,
    ).ok,
    false,
  );
  assert.equal(
    validateRateCard(
      { currency: "USD", sMinor: 0, mMinor: 200, lMinor: 300, xlMinor: 400 },
      usd,
    ).ok,
    false,
  );
  assert.equal(
    validateRateCard(
      { currency: "USD", sMinor: 300, mMinor: 200, lMinor: 400, xlMinor: 500 },
      usd,
    ).ok,
    false,
  );
});

test("maps sizes to the card and leaves unsized unpriced", () => {
  const card = { currency: "USD", sMinor: 1, mMinor: 2, lMinor: 3, xlMinor: 4 };
  assert.equal(priceFor("S", card), 1);
  assert.equal(priceFor("M", card), 2);
  assert.equal(priceFor("L", card), 3);
  assert.equal(priceFor("XL", card), 4);
  assert.equal(priceFor("unsized", card), null);
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
