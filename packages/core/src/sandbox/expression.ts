/**
 * Whether a text is exactly one JavaScript function expression, read
 * without a parser: core has no dependencies.
 *
 * A fixture's implementation is spliced into the public mock runtime as an
 * argument, `fixture(path, <implementation>);`. A prefix that looks like a
 * function proves nothing about the rest: `() => 1); evil(); (() => 0`
 * starts like one and adds statements, and `(() => evil())()` runs at load.
 * So the text is walked as code, strings, templates, comments and regular
 * expressions included, and it must be a `function` whose body closes at
 * the end, or an arrow whose body runs to the end with no statement or
 * argument boundary in it. Anything the walk cannot follow is refused: a
 * false refusal costs a rewrite, a false acceptance runs code.
 */
export function isFunctionExpressionText(text: string): boolean {
  let at = skipSpace(text, 0);
  const asyncWord = /^async\b/.exec(text.slice(at));
  if (asyncWord !== null) at = skipSpace(text, at + asyncWord[0].length);
  const functionWord = /^function\b/.exec(text.slice(at));
  if (functionWord !== null) {
    at = skipSpace(text, at + functionWord[0].length);
    if (text[at] === "*") at = skipSpace(text, at + 1);
    const name = /^[A-Za-z_$][\w$]*/.exec(text.slice(at));
    if (name !== null) at = skipSpace(text, at + name[0].length);
    if (text[at] !== "(") return false;
    at = skipSpace(text, walk(text, at + 1, ")"));
    if (at < 0 || text[at] !== "{") return false;
    const end = walk(text, at + 1, "}");
    return end >= 0 && skipSpace(text, end) === text.length;
  }
  // An arrow: one parameter name, or a parenthesized list.
  const param = /^[A-Za-z_$][\w$]*/.exec(text.slice(at));
  if (param !== null) at += param[0].length;
  else if (text[at] === "(") {
    at = walk(text, at + 1, ")");
    if (at < 0) return false;
  } else return false;
  at = skipSpace(text, at);
  if (text.slice(at, at + 2) !== "=>") return false;
  at = skipSpace(text, at + 2);
  if (at >= text.length) return false;
  if (text[at] === "{") {
    const end = walk(text, at + 1, "}");
    return end >= 0 && skipSpace(text, end) === text.length;
  }
  return walk(text, at, null) === text.length;
}

const CLOSING: Readonly<Record<string, string>> = {
  "(": ")",
  "[": "]",
  "{": "}",
};
/** Where a `/` begins a regular expression rather than divides. */
const BEFORE_REGEX = new Set("(,=:[!&|?{;+-*%<>~^");
/**
 * A `/` the walk cannot place, since misreading it either way skips real
 * code as a string or a regular expression: after `}` (`{} / 2`, or a block
 * then `/re/`), after the `)` of `if`, `while`, `for` or `with`, after `++`
 * or `--`, and after a name that is a keyword only sometimes (`of`, `.in`).
 */
const CONTROL_KEYWORDS = new Set(["if", "while", "for", "with"]);
const KEYWORDS_BEFORE_EXPRESSION = new Set([
  "return",
  "typeof",
  "case",
  "do",
  "else",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "instanceof",
  "yield",
  "await",
]);

function skipSpace(text: string, at: number): number {
  if (at < 0) return at;
  while (at < text.length && /\s/.test(text[at] ?? "")) at += 1;
  return at;
}

/**
 * Walks code from `at` to the `close` that ends it at depth zero, returning
 * the index past it; with `close` null, to the end of the text, where a `;`
 * or `,` at depth zero is refused, as the boundary of a second statement or
 * argument. -1 for anything it cannot follow.
 */
function walk(text: string, at: number, close: string | null): number {
  const stack: string[] = [];
  // Per open `(`, whether it follows a control keyword.
  const controls: boolean[] = [];
  let closedControl = false;
  // What came before, to tell a regular expression from a division.
  let previous = "";
  let doubled = false;
  let word = "";
  let wordAfterDot = false;
  let i = at;
  while (i < text.length) {
    const c = text[i] ?? "";
    const next = text[i + 1] ?? "";
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    if (c === "/" && next === "/") {
      // To the end of its line, which must come: the splice continues
      // after the text, and a comment would swallow it.
      const end = text.indexOf("\n", i);
      if (end < 0) return -1;
      i = end + 1;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) return -1;
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      i = skipString(text, i, c);
      if (i < 0) return -1;
      previous = "value";
      doubled = false;
      word = "";
      continue;
    }
    if (c === "`") {
      i = skipTemplate(text, i);
      if (i < 0) return -1;
      previous = "value";
      doubled = false;
      word = "";
      continue;
    }
    if (
      c === "/" &&
      (previous === "}" ||
        (previous === ")" && closedControl) ||
        doubled ||
        (previous === "word" && (word === "of" || wordAfterDot)))
    )
      return -1;
    if (
      c === "/" &&
      (previous === "" ||
        BEFORE_REGEX.has(previous) ||
        KEYWORDS_BEFORE_EXPRESSION.has(word))
    ) {
      i = skipRegex(text, i);
      if (i < 0) return -1;
      previous = "value";
      doubled = false;
      word = "";
      continue;
    }
    if (/[\w$]/.test(c)) {
      const match = /^[\w$]+/.exec(text.slice(i));
      const found = match?.[0] ?? c;
      word = found;
      wordAfterDot = previous === ".";
      previous = "word";
      doubled = false;
      i += found.length;
      continue;
    }
    const opening = CLOSING[c];
    if (opening !== undefined) {
      stack.push(opening);
      if (c === "(")
        controls.push(previous === "word" && CONTROL_KEYWORDS.has(word));
    } else if (c === ")" || c === "]" || c === "}") {
      if (stack.length === 0) return c === close ? i + 1 : -1;
      if (stack.pop() !== c) return -1;
      if (c === ")") closedControl = controls.pop() ?? false;
    } else if (stack.length === 0 && close === null && (c === ";" || c === ","))
      return -1;
    word = "";
    doubled = (c === "+" || c === "-") && previous === c && !doubled;
    previous = c;
    i += 1;
  }
  return close === null && stack.length === 0 ? i : -1;
}

function skipString(text: string, at: number, quote: string): number {
  for (let i = at + 1; i < text.length; i += 1) {
    const c = text[i];
    if (c === "\\") i += 1;
    else if (c === quote) return i + 1;
    else if (c === "\n") return -1;
  }
  return -1;
}

function skipTemplate(text: string, at: number): number {
  for (let i = at + 1; i < text.length; i += 1) {
    const c = text[i];
    if (c === "\\") i += 1;
    else if (c === "`") return i + 1;
    else if (c === "$" && text[i + 1] === "{") {
      const end = walk(text, i + 2, "}");
      if (end < 0) return -1;
      i = end - 1;
    }
  }
  return -1;
}

function skipRegex(text: string, at: number): number {
  let inClass = false;
  for (let i = at + 1; i < text.length; i += 1) {
    const c = text[i];
    if (c === "\\") i += 1;
    else if (c === "\n") return -1;
    else if (inClass) {
      if (c === "]") inClass = false;
    } else if (c === "[") inClass = true;
    else if (c === "/") {
      let end = i + 1;
      while (/[a-z]/.test(text[end] ?? "")) end += 1;
      return end;
    }
  }
  return -1;
}
