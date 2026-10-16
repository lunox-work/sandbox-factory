/**
 * What `handle.ts` promises of every input, checked on generated strings:
 * a stem always passes the check, an accepted handle is exactly its typed
 * form lowercased with nothing outside the charset, and the normal forms
 * are fixed points of themselves.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import * as fc from "fast-check";

import {
  checkHandle,
  HANDLE_MAX_LENGTH,
  HANDLE_MIN_LENGTH,
  handleStemFromEmail,
  isValidHandle,
  normalizeHandle,
  toHandleCase,
  toHandleStem,
} from "../src/index.js";

const CHARSET = /^[a-z0-9_-]+$/;
const anyText = fc.oneof(
  fc.string({ maxLength: 80 }),
  fc.string({ unit: "grapheme", maxLength: 80 }),
  fc.string({ unit: "binary", maxLength: 80 }),
);

test("every stem is a valid handle, and stemming again changes nothing", () => {
  fc.assert(
    fc.property(anyText, (text) => {
      for (const stem of [toHandleStem(text), handleStemFromEmail(text)]) {
        assert.deepEqual(checkHandle(stem), { status: "ok" });
        assert.match(stem, CHARSET);
        assert.ok(!stem.startsWith("-") && !stem.endsWith("-"));
        assert.ok(
          stem.length >= HANDLE_MIN_LENGTH && stem.length <= HANDLE_MAX_LENGTH,
        );
        assert.equal(toHandleStem(stem), stem);
      }
    }),
    { numRuns: 3_000 },
  );
});

test("an accepted handle is its typed form lowercased, within the charset, and nothing else is accepted", () => {
  fc.assert(
    fc.property(anyText, (raw) => {
      const result = normalizeHandle(raw);
      assert.equal(isValidHandle(raw), result.status === "ok");
      if (result.status === "ok") {
        assert.equal(result.display, raw.trim());
        assert.equal(result.handle, result.display.toLowerCase());
        assert.equal(result.handle, toHandleCase(raw));
        assert.match(result.handle, CHARSET);
        // The typed text is within the charset apart from case: no
        // lookalike lowercases into someone else's name.
        assert.match(result.display, /^[A-Za-z0-9_-]+$/);
        assert.deepEqual(checkHandle(result.handle), { status: "ok" });
        // Normalizing the stored form gives the stored form.
        assert.deepEqual(normalizeHandle(result.handle), {
          status: "ok",
          handle: result.handle,
          display: result.handle,
        });
      } else {
        const stored = toHandleCase(raw);
        const checked = checkHandle(stored);
        // Refused for length or charset, and the reason is a sentence.
        assert.ok(result.problem === "length" || result.problem === "charset");
        assert.match(result.reason, /\.$/);
        if (checked.status === "invalid")
          assert.equal(result.problem, checked.problem);
        else assert.equal(result.problem, "charset");
      }
    }),
    { numRuns: 5_000 },
  );
});

test("every string drawn from the charset at a legal length is accepted, in any casing", () => {
  const handle = fc
    .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789_-"), {
      minLength: HANDLE_MIN_LENGTH,
      maxLength: HANDLE_MAX_LENGTH,
    })
    .map((chars) => chars.join(""));
  const cased = (text: string, mask: boolean[]) =>
    [...text]
      .map((char, i) => (mask[i] === true ? char.toUpperCase() : char))
      .join("");
  fc.assert(
    fc.property(
      handle,
      fc.array(fc.boolean(), { minLength: HANDLE_MAX_LENGTH }),
      (lower, mask) => {
        const typed = cased(lower, mask);
        const result = normalizeHandle(` ${typed} `);
        assert.deepEqual(result, {
          status: "ok",
          handle: lower,
          display: typed,
        });
      },
    ),
  );
  // One character over or under the bounds is refused for length.
  fc.assert(
    fc.property(
      fc.constantFrom(HANDLE_MIN_LENGTH - 1, HANDLE_MAX_LENGTH + 1),
      (length) => {
        const result = normalizeHandle("a".repeat(length));
        assert.equal(result.status, "invalid");
        if (result.status === "invalid") assert.equal(result.problem, "length");
      },
    ),
  );
});
