import assert from "node:assert/strict";
import { test } from "node:test";
import { orvantaFee } from "../src/orvanta/fees.js";
import { orvantaBalance } from "../src/orvanta/ledger.js";

test("a debit pays one percent, rounded, and never less than 25 cents", () => {
  assert.equal(orvantaFee({ amountCents: 10_000, kind: "debit" }), 100);
  assert.equal(orvantaFee({ amountCents: 4_250, kind: "debit" }), 43);
  assert.equal(orvantaFee({ amountCents: 100, kind: "debit" }), 25);
});

test("a credit is free", () => {
  assert.equal(orvantaFee({ amountCents: 10_000, kind: "credit" }), 0);
});

test("the balance nets credits against debits", () => {
  assert.equal(
    orvantaBalance([
      { amountCents: 500, kind: "credit" },
      { amountCents: 200, kind: "debit" },
    ]),
    300,
  );
});
