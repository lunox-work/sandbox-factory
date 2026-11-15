import assert from "node:assert/strict";
import { test } from "node:test";
import { orvantaFee } from "../src/orvanta/fees.js";

// What the Orvanta fee already does, and must keep doing.
test("a credit pays nothing, whatever its amount", () => {
  for (const amountCents of [1, 4_250, 10_000])
    assert.equal(orvantaFee({ amountCents, kind: "credit" }), 0);
});
