import assert from "node:assert/strict";
import { test } from "node:test";
import { isFunctionExpressionText } from "../src/index.js";

test("one function expression is accepted, however it is written", () => {
  for (const text of [
    "() => 1",
    "x => x * 2",
    "async (a, b) => { return a + b; }",
    "(rows) => ({ rows, count: rows.length })",
    "function () { return 1; }",
    "async function named(a) { await a; }",
    "function* gen() { yield 1; }",
    "(s) => s.replace(/[)(;,]/g, '')",
    "(a) => a / 2 / 3",
    "() => `${[1, 2].join(',')}; done`",
    "() => '); evil(); ('",
    "() => {\n  // a note; with, punctuation\n  return 1;\n}",
    "  (a) => a  ",
    "() => /* , ; */ 1",
    "(a, b) => (a + b) / 2",
    "(xs) => xs[0] / 2",
    "(s) => { if (/^a/.test(s)) return 1; return 0; }",
  ])
    assert.equal(isFunctionExpressionText(text), true, text);
});

test("statements, calls and anything unfollowable are refused", () => {
  for (const text of [
    // The splice it is put into, broken out of.
    "() => 1); globalThis.x = doThing(); (() => 0",
    "() => 1, evil()",
    "() => 1; evil()",
    // A call runs at load.
    "(() => evil())()",
    "function () {}()",
    "function () {} evil()",
    "x => x)(1",
    // Not a function.
    "1 + 1",
    "evil()",
    "",
    // A trailing line comment would swallow the splice's `);`.
    "() => 1 // done",
    "() => 'unterminated",
    "() => `${",
    "() => {",
    "() => (1]",
    // A `/` the walk cannot place as division or regular expression.
    "() => a + {} / 1); globalThis.pwned = 1; (0 / 1",
    "function () { if (a) /'/; }); globalThis.pwned = 3; (function () { /'/ }",
    "(a) => a.in / 1); globalThis.pwned = 1; (0 / 1",
    "(of) => of / 1); globalThis.pwned = 1; (0 / 1",
    "(a) => a++ / 1); globalThis.pwned = 1; (0 / 1",
  ])
    assert.equal(isFunctionExpressionText(text), false, text);
});
