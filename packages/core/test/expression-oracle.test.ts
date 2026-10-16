/**
 * `isFunctionExpressionText` against a real parser.
 *
 * The walker decides, without a parser, whether a fixture implementation
 * may be spliced into the public mock runtime as
 * `fixture(<path>, <implementation>);`. Its own comment states the stake:
 * a false refusal costs a rewrite, a false acceptance runs code. So the
 * property checked here is soundness only: every text the walker accepts
 * must, once spliced, parse as exactly that one call with a function
 * expression as its second argument, or fail to parse at all (a build that
 * fails loudly runs nothing). What the walker refuses is its business.
 *
 * Checked two ways: every token sequence up to a bound, which is a
 * complete check within it, and random longer sequences over a wider
 * alphabet. Acorn is the oracle; it is a test dependency only.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { parse } from "acorn";
import * as fc from "fast-check";

import { isFunctionExpressionText } from "../src/index.js";

type Verdict = "function" | "unparsable" | "other";

/** What the splice site in `sandbox/project.ts` writes. */
const spliced = (text: string) => `fixture("src/a.ts", ${text.trim()});`;

function oracle(text: string): Verdict {
  let program;
  try {
    program = parse(spliced(text), {
      ecmaVersion: "latest",
      sourceType: "module",
    });
  } catch {
    return "unparsable";
  }
  if (program.body.length !== 1) return "other";
  const statement = program.body[0];
  if (statement?.type !== "ExpressionStatement") return "other";
  const call = statement.expression;
  if (
    call.type !== "CallExpression" ||
    call.callee.type !== "Identifier" ||
    call.callee.name !== "fixture" ||
    call.arguments.length !== 2
  )
    return "other";
  const implementation = call.arguments[1];
  return implementation?.type === "FunctionExpression" ||
    implementation?.type === "ArrowFunctionExpression"
    ? "function"
    : "other";
}

/** Sound: accepted means one function argument, or no program at all. */
function assertSound(text: string): Verdict | null {
  if (!isFunctionExpressionText(text)) return null;
  const verdict = oracle(text);
  assert.notEqual(
    verdict,
    "other",
    `accepted but not one function argument: ${JSON.stringify(text)}`,
  );
  return verdict;
}

/**
 * The pieces the walker has rules for: the function and arrow heads,
 * every bracket, the statement and argument boundaries it must refuse at
 * depth zero, strings, templates and the slash that is a comment, a
 * regular expression or a division depending on what came before.
 */
const CORE_TOKENS = [
  "a",
  "(",
  ")",
  "{",
  "}",
  "=>",
  ";",
  ",",
  "/",
  "'",
  "`",
  "${",
  "+",
  " ",
  "\n",
  "function",
] as const;

const WIDE_TOKENS = [
  ...CORE_TOKENS,
  "b",
  "[",
  "]",
  "++",
  "--",
  ".",
  "of",
  "in",
  "if",
  "return",
  "async",
  "*",
  "//x\n",
  "/*x*/",
  "\\",
  '"',
  "x",
  "=",
  ">",
  "<",
  "!",
  "?",
  ":",
] as const;

test("every token sequence up to five long: accepted text is one function argument or no program", (t) => {
  const counts = { checked: 0, accepted: 0, functions: 0, unparsable: 0 };
  const tokens = CORE_TOKENS;
  const depth = 5;
  const sequence: string[] = [];
  const visit = (remaining: number) => {
    const text = sequence.join("");
    counts.checked += 1;
    const verdict = assertSound(text);
    if (verdict !== null) {
      counts.accepted += 1;
      if (verdict === "function") counts.functions += 1;
      else counts.unparsable += 1;
    }
    if (remaining === 0) return;
    for (const token of tokens) {
      sequence.push(token);
      visit(remaining - 1);
      sequence.pop();
    }
  };
  visit(depth);
  t.diagnostic(
    `${counts.checked} sequences, ${counts.accepted} accepted: ${counts.functions} parse as a function argument, ${counts.unparsable} as no program`,
  );
  // The bound reaches real acceptances, or it proves nothing.
  assert.ok(counts.functions > 50);
});

test("random longer sequences over the wide alphabet are sound too", () => {
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom(...WIDE_TOKENS), {
        minLength: 1,
        maxLength: 14,
      }),
      (parts) => {
        assertSound(parts.join(""));
      },
    ),
    { numRuns: 20_000 },
  );
});

test("a function followed by anything that makes a second statement or argument is refused", () => {
  const heads = [
    "() => 1",
    "a => a",
    "(a, b) => { return a + b; }",
    "function () { return 1; }",
    "async function* g() { yield 1; }",
    "async (x) => await x",
  ];
  const tails = [
    "; evil()",
    ", evil()",
    ") ; evil(); (() => 0",
    "); evil(); (",
    "\n; evil()",
    ", /re/",
  ];
  for (const head of heads) {
    assert.equal(isFunctionExpressionText(head), true, head);
    assert.equal(oracle(head), "function", head);
    for (const tail of tails) {
      const text = `${head}${tail}`;
      assert.equal(isFunctionExpressionText(text), false, text);
    }
  }
  // A function that is immediately called runs at load, so it is refused.
  for (const text of ["(() => evil())()", "(function () { evil(); })()"]) {
    assert.equal(isFunctionExpressionText(text), false, text);
    assert.equal(oracle(text), "other", text);
  }
});
