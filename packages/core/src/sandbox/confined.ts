/**
 * Whether fixture code stays inside its rules: no imports, network, files,
 * processes, timers, clock or randomness, read without a parser since core
 * has no dependencies.
 *
 * A fixture runs in the public mock runtime on every machine that runs the
 * sandbox, and a walkthrough runs with `npm run dev`; both are written by
 * an agent that reads untrusted repository text. So the text is tokenized
 * (strings, templates, comments and regular expressions included) and
 * refused on names, never matched by substrings: any use of a forbidden
 * global or escape hatch, wherever it stands, even as a property name.
 * Names are only half of it, since `Math["ran" + "dom"]` names nothing: a
 * computed member or key must be one plain string or number literal, and
 * the reflection that reads a property without naming it is refused. A
 * name spelled with an escape (`process`) is refused, as is anything
 * the tokenizer cannot follow. A quoted key (`{ "constructor": F }`) is held
 * to the computed key's rule, since it reads or defines what it names. The worker checks the same rules on the
 * TypeScript AST; this check is the one every build and API write applies.
 */

/** Globals and escape hatches a fixture or walkthrough never names. */
export const CONFINED_FORBIDDEN_NAMES: readonly string[] = [
  // Modules and code from strings.
  "require",
  "import",
  "eval",
  "Function",
  "module",
  "exports",
  // The process, the host and its globals.
  "process",
  "globalThis",
  "global",
  "window",
  "self",
  "document",
  "navigator",
  "Deno",
  "Bun",
  "Buffer",
  "child_process",
  "Worker",
  "WebAssembly",
  // Network.
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  // Timers and the clock.
  "setTimeout",
  "setInterval",
  "setImmediate",
  "queueMicrotask",
  "MessageChannel",
  "Atomics",
  "SharedArrayBuffer",
  "performance",
  "Intl",
  "Temporal",
  // Randomness.
  "random",
  "crypto",
  // Reaching what a name was kept from.
  "constructor",
  "prototype",
  "__proto__",
  "Reflect",
  "Proxy",
  "with",
  "getOwnPropertyDescriptor",
  "getOwnPropertyDescriptors",
  "getPrototypeOf",
  "setPrototypeOf",
  "defineProperty",
  "defineProperties",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  "prepareStackTrace",
  "captureStackTrace",
];
const FORBIDDEN = new Set(CONFINED_FORBIDDEN_NAMES);

interface Token {
  readonly kind: "word" | "punct" | "string" | "number" | "template" | "regex";
  /** A string's content as written, escapes and all. */
  readonly text: string;
}

/** Where a `/` begins a regular expression rather than divides. */
const BEFORE_REGEX = new Set("(,=:[!&|?{;+-*%<>~^");
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
const NUMBER =
  /^(?:0[xX][\da-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?)n?/;
const CONTROL_KEYWORDS = new Set(["if", "while", "for", "with"]);
/** Words after which `[` opens an array, not a member access. */
const KEYWORDS_BEFORE_ARRAY = new Set([
  ...KEYWORDS_BEFORE_EXPRESSION,
  "const",
  "let",
  "var",
]);

/**
 * The text's tokens, or null for anything the walk cannot follow: an
 * unterminated literal, a `/` it cannot place, a backslash outside a
 * literal, a template substitution that does not close.
 */
function tokenize(text: string): Token[] | null {
  const tokens: Token[] = [];
  const end = scan(text, 0, tokens, false);
  return end === text.length ? tokens : null;
}

/**
 * Scans from `at`, pushing tokens, to the end of the text or, with `inner`,
 * to the `}` that closes a template substitution, returning the index past
 * it; -1 when it cannot follow the text.
 */
function scan(text: string, at: number, tokens: Token[], inner: boolean) {
  let depth = 0;
  const controls: boolean[] = [];
  let closedControl = false;
  let i = at;
  const last = () => tokens[tokens.length - 1];
  while (i < text.length) {
    const c = text[i] ?? "";
    const next = text[i + 1] ?? "";
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    if (c === "/" && next === "/") {
      const lineEnd = text.indexOf("\n", i);
      i = lineEnd < 0 ? text.length : lineEnd + 1;
      continue;
    }
    if (c === "/" && next === "*") {
      const close = text.indexOf("*/", i + 2);
      if (close < 0) return -1;
      i = close + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c && text[j] !== "\n")
        j += text[j] === "\\" ? 2 : 1;
      if (text[j] !== c) return -1;
      tokens.push({ kind: "string", text: text.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    if (c === "`") {
      let j = i + 1;
      for (;;) {
        if (j >= text.length) return -1;
        const t = text[j];
        if (t === "\\") j += 2;
        else if (t === "`") break;
        else if (t === "$" && text[j + 1] === "{") {
          j = scan(text, j + 2, tokens, true);
          if (j < 0) return -1;
        } else j += 1;
      }
      tokens.push({ kind: "template", text: text.slice(i, j + 1) });
      i = j + 1;
      continue;
    }
    if (c === "\\") return -1;
    const previous = last();
    if (c === "/") {
      // A word after `.` is a property, whatever it spells.
      const before = tokens[tokens.length - 2];
      const property =
        before?.kind === "punct" &&
        (before.text === "." || before.text === "?.");
      const regex =
        previous === undefined ||
        (previous.kind === "punct" &&
          (BEFORE_REGEX.has(previous.text) || previous.text === "=>")) ||
        (previous.kind === "word" &&
          !property &&
          KEYWORDS_BEFORE_EXPRESSION.has(previous.text));
      // Where misplacing the `/` either way could hide code in a literal.
      const ambiguous =
        previous !== undefined &&
        ((previous.kind === "punct" &&
          (previous.text === "}" ||
            previous.text === "++" ||
            previous.text === "--" ||
            (previous.text === ")" && closedControl) ||
            nonNullAssertion(tokens))) ||
          (previous.kind === "word" && !property && previous.text === "of"));
      if (ambiguous) return -1;
      if (regex) {
        let j = i + 1;
        let inClass = false;
        for (;;) {
          const t = text[j];
          if (t === undefined || t === "\n") return -1;
          if (t === "\\") j += 1;
          else if (inClass) inClass = t !== "]";
          else if (t === "[") inClass = true;
          else if (t === "/") break;
          j += 1;
        }
        j += 1;
        while (/[a-z]/.test(text[j] ?? "")) j += 1;
        tokens.push({ kind: "regex", text: text.slice(i, j) });
        i = j;
        continue;
      }
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(next))) {
      const match = NUMBER.exec(text.slice(i));
      const found = match?.[0] ?? c;
      // A number runs into no name: `1..x` is `1.` then `.x`.
      if (/[\w$]/.test(text[i + found.length] ?? "")) return -1;
      tokens.push({ kind: "number", text: found });
      i += found.length;
      continue;
    }
    if (/[\w$]/.test(c) || c.charCodeAt(0) >= 0x80) {
      const match = /^[\w$\u0080-￿]+/.exec(text.slice(i));
      const found = match?.[0] ?? c;
      tokens.push({ kind: "word", text: found });
      i += found.length;
      continue;
    }
    // Punctuation: the few multi-character forms the rules read.
    const two = text.slice(i, i + 2);
    const punct =
      two === "?." && !/[0-9]/.test(text[i + 2] ?? "")
        ? "?."
        : two === "++" || two === "--" || two === "=>"
          ? two
          : c;
    if (punct === "(") {
      controls.push(
        previous?.kind === "word" && CONTROL_KEYWORDS.has(previous.text),
      );
      depth += 1;
    } else if (punct === "[" || punct === "{") depth += 1;
    else if (punct === ")" || punct === "]" || punct === "}") {
      if (depth === 0) {
        if (inner && punct === "}") return i + 1;
        return -1;
      }
      depth -= 1;
      if (punct === ")") closedControl = controls.pop() ?? false;
    }
    tokens.push({ kind: "punct", text: punct });
    i += punct.length;
  }
  return inner ? -1 : i;
}

/**
 * Whether the tokens end in a run of `!` that could be TypeScript's
 * postfix non-null assertion (`x! / 2`), after which `/` divides.
 */
function nonNullAssertion(tokens: readonly Token[]): boolean {
  let at = tokens.length - 1;
  if (tokens[at]?.kind !== "punct" || tokens[at]?.text !== "!") return false;
  while (tokens[at]?.kind === "punct" && tokens[at]?.text === "!") at -= 1;
  const operand = tokens[at];
  if (operand === undefined) return false;
  if (operand.kind === "punct")
    return operand.text === ")" || operand.text === "]";
  if (operand.kind !== "word") return true;
  const before = tokens[at - 1];
  const property =
    before?.kind === "punct" && (before.text === "." || before.text === "?.");
  return property || !KEYWORDS_BEFORE_EXPRESSION.has(operand.text);
}

/** Words before a quoted key in an object, pattern or class body. */
const KEY_MODIFIERS = new Set(["get", "set", "async", "static", "readonly"]);

/**
 * Whether the string or template at `index` is a key: directly inside `{`,
 * after `{`, `,`, `;`, `}`, `*` or a modifier, and before `:` or `(`.
 */
function quotedKey(
  tokens: readonly Token[],
  index: number,
  enclosing: string | undefined,
): boolean {
  if (enclosing !== "{") return false;
  const previous = tokens[index - 1];
  const following = tokens[index + 1];
  const opensKey =
    (previous?.kind === "punct" &&
      ["{", ",", ";", "}", "*"].includes(previous.text)) ||
    (previous?.kind === "word" && KEY_MODIFIERS.has(previous.text));
  return (
    opensKey &&
    following?.kind === "punct" &&
    (following.text === ":" || following.text === "(")
  );
}

/** Whether a `[` after this token reads a member rather than opening an array. */
function readsMember(previous: Token | undefined): boolean {
  if (previous === undefined) return false;
  if (previous.kind === "word")
    return !KEYWORDS_BEFORE_ARRAY.has(previous.text);
  if (previous.kind === "punct")
    return [")", "]", "}", "?."].includes(previous.text);
  return true;
}

export interface ConfinedOptions {
  /**
   * A walkthrough's static imports, of relative specifiers only:
   * `import { x } from "../src/x.js"`. Never `import()` or `import.meta`.
   */
  readonly staticImports?: boolean;
}

/** Why code breaks the fixture rules; empty when it keeps them. */
export function confinedCodeProblems(
  text: string,
  options: ConfinedOptions = {},
): string[] {
  const tokens = tokenize(text);
  if (tokens === null)
    return [
      "The code could not be read for the fixture rules: an escape outside a string, an unterminated literal or an ambiguous `/`.",
    ];
  const problems = new Set<string>();
  // Which brackets are open, to tell a computed key from an array element.
  const open: string[] = [];
  for (const [index, token] of tokens.entries()) {
    const previous = tokens[index - 1];
    const following = tokens[index + 1];
    if (token.kind === "word") {
      if (
        token.text === "import" &&
        options.staticImports === true &&
        following !== undefined &&
        !(following.kind === "punct" && ["(", "."].includes(following.text))
      )
        continue;
      if (FORBIDDEN.has(token.text))
        problems.add(`\`${token.text}\` is not allowed.`);
      if (token.text === "Date") {
        const constructed =
          previous?.kind === "word" &&
          previous.text === "new" &&
          following?.kind === "punct" &&
          following.text === "(" &&
          // A value, never none: not `()` and not a spread that may be empty.
          !(
            tokens[index + 2]?.kind === "punct" &&
            (tokens[index + 2]?.text === ")" || tokens[index + 2]?.text === ".")
          );
        if (!constructed)
          problems.add(
            "`Date` is allowed only as `new Date(value)`, never the current time.",
          );
      }
      continue;
    }
    if (
      token.kind === "string" &&
      options.staticImports === true &&
      previous?.kind === "word" &&
      (previous.text === "from" || previous.text === "import") &&
      !token.text.startsWith("./") &&
      !token.text.startsWith("../")
    )
      problems.add(
        `${token.text} is not a relative import; the walkthrough imports only the project's own files.`,
      );
    if (
      (token.kind === "string" ||
        (token.kind === "template" && !token.text.includes("${"))) &&
      quotedKey(tokens, index, open[open.length - 1]) &&
      !plainName(token.kind === "string" ? token.text : token.text.slice(1, -1))
    )
      problems.add(
        `A quoted key must name nothing forbidden and hold no escape; ${token.kind === "string" ? JSON.stringify(token.text) : token.text} does not.`,
      );
    if (token.kind !== "punct") continue;
    if (token.text === "[") {
      const enclosing = open[open.length - 1];
      const computed =
        readsMember(previous) ||
        (enclosing === "{" &&
          previous?.kind === "punct" &&
          (previous.text === "{" || previous.text === ","));
      if (computed && !literalKey(tokens[index + 1], tokens[index + 2]))
        problems.add(
          'A computed member or key must be one string or number literal, such as `rows[0]` or `item["id"]`.',
        );
    }
    if (token.text === "(" || token.text === "[" || token.text === "{")
      open.push(token.text);
    else if (token.text === ")" || token.text === "]" || token.text === "}")
      open.pop();
  }
  return [...problems];
}

/** Whether `[key]` is one plain literal that names nothing forbidden. */
function literalKey(key: Token | undefined, close: Token | undefined): boolean {
  if (close?.kind !== "punct" || close.text !== "]" || key === undefined)
    return false;
  if (key.kind === "number") return true;
  return key.kind === "string" && plainName(key.text);
}

/** Whether a quoted name, as written, has no escape and is not forbidden. */
const plainName = (text: string) =>
  !text.includes("\\") && !FORBIDDEN.has(text);
