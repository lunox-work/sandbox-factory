/**
 * The alias table's promise, on generated rule sets and files: whatever
 * `applyAliases` returns as ok maps back to the input through the inverse
 * table, byte for byte, and a set the validator passes is applied in full
 * unless a target already occurs in the text, which is the one problem
 * only the text can show.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import * as fc from "fast-check";

import {
  applyAliases,
  invertAliasRules,
  renameFile,
  validateAliasRules,
  type AliasedFile,
  type AliasRule,
} from "../src/index.js";

const IDENTIFIERS = [
  "alpha",
  "beta",
  "gamma",
  "delta",
  "Alpha",
  "alphaBeta",
  "alpha_1",
  "x",
] as const;

const identifierRules = fc.array(
  fc.record({
    before: fc.constantFrom(...IDENTIFIERS),
    after: fc.constantFrom(...IDENTIFIERS),
  }),
  { maxLength: 3 },
);

const identifierText = fc
  .array(
    fc.constantFrom(
      ...IDENTIFIERS,
      " ",
      ".",
      "(",
      ")",
      "_",
      "$",
      "'",
      "\n",
      "1",
    ),
    { maxLength: 16 },
  )
  .map((parts) => parts.join(""));

// Plain objects: a generated record has a null prototype, which deep
// equality tells apart from the plain object `applyAliases` returns.
const files = (text: fc.Arbitrary<string>): fc.Arbitrary<AliasedFile[]> =>
  fc
    .array(fc.record({ path: fc.constantFrom("src/a.ts", "src/b.ts"), text }), {
      minLength: 1,
      maxLength: 2,
    })
    .map((list) => list.map(({ path, text: body }) => ({ path, text: body })));

function asRules(
  pairs: readonly { before: string; after: string }[],
  kind: AliasRule["kind"],
): AliasRule[] {
  return pairs.map(({ before, after }) => ({ before, after, kind, paths: [] }));
}

/** Both laws, for one kind of rule over its own alphabet. */
function check(
  kind: AliasRule["kind"],
  pairs: fc.Arbitrary<{ before: string; after: string }[]>,
  text: fc.Arbitrary<string>,
  validationSuffices: boolean,
) {
  fc.assert(
    fc.property(pairs, files(text), (chosen, input) => {
      const rules = asRules(chosen, kind);
      const result = applyAliases(input, rules);
      const validation = validateAliasRules(rules);
      if (!validation.ok) {
        assert.equal(result.ok, false);
        assert.deepEqual(result.problems, validation.problems);
        return;
      }
      if (result.ok) {
        // The law that must hold: the inverse table gives the input back.
        const inverse = invertAliasRules(rules);
        input.forEach((file: AliasedFile, index) => {
          const stored = result.files[index];
          assert.ok(stored !== undefined);
          assert.deepEqual(renameFile(stored, inverse), file);
        });
        assert.equal(result.applied.length, rules.length);
      } else {
        assert.deepEqual(result.files, []);
        const codes = new Set(result.problems.map((problem) => problem.code));
        // Nothing the validator should have caught slipped through to here.
        assert.ok(codes.has("target_collision") || codes.has("irreversible"));
        if (validationSuffices) assert.ok(codes.has("target_collision"));
      }
    }),
    { numRuns: 3_000 },
  );
}

test("identifier rules: an ok result inverts exactly, and a valid set fails only on a target already in the text", () => {
  check("identifier", identifierRules, identifierText, true);
});

const TEXTS = ["a", "b", "ab", "bc", "abc", "x", "xy"] as const;
const textRules = fc.array(
  fc.record({
    before: fc.constantFrom(...TEXTS),
    after: fc.constantFrom(...TEXTS),
  }),
  { maxLength: 3 },
);
const freeText = fc
  .array(fc.constantFrom(...TEXTS, " ", "-"), { maxLength: 12 })
  .map((parts) => parts.join(""));

test("text rules: an ok result inverts exactly; overlapping texts the validator cannot see are refused as irreversible", () => {
  check("text", textRules, freeText, false);
});

test("the inverse table is the rules reversed and swapped, and inverting twice is the identity", () => {
  fc.assert(
    fc.property(identifierRules, (chosen) => {
      const rules = asRules(chosen, "identifier");
      const inverse = invertAliasRules(rules);
      assert.equal(inverse.length, rules.length);
      inverse.forEach((rule, i) => {
        const source = rules[rules.length - 1 - i];
        assert.ok(source !== undefined);
        assert.equal(rule.before, source.after);
        assert.equal(rule.after, source.before);
        assert.equal(rule.kind, source.kind);
      });
      assert.deepEqual(invertAliasRules(inverse), rules);
    }),
  );
});
