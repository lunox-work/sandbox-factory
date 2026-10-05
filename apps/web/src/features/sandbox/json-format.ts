/**
 * JSON laid out to be read: one member per line, indented by depth, as the
 * editor's Format Document lays it out.
 *
 * The text is reflowed rather than parsed and printed again, so every
 * string and number reads exactly as the file wrote it: `1.0` stays `1.0`,
 * and an integer too large for a double keeps its digits.
 */

const INDENT = "  ";
const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);

/** The text formatted; undefined for text that is not valid JSON. */
export function formatJson(text: string): string | undefined {
  try {
    JSON.parse(text);
  } catch {
    return undefined;
  }
  let out = "";
  let depth = 0;
  const newline = () => `\n${INDENT.repeat(depth)}`;
  const nextAfter = (from: number) => {
    let at = from;
    while (at < text.length && WHITESPACE.has(text.charAt(at))) at += 1;
    return at;
  };
  for (let at = 0; at < text.length; at += 1) {
    const char = text.charAt(at);
    if (char === '"') {
      // Copied whole, escapes and all; it was parsed, so it is closed.
      let end = at + 1;
      while (text.charAt(end) !== '"') end += text.charAt(end) === "\\" ? 2 : 1;
      out += text.slice(at, end + 1);
      at = end;
    } else if (WHITESPACE.has(char)) {
      continue;
    } else if (char === "{" || char === "[") {
      const next = nextAfter(at + 1);
      if (text.charAt(next) === (char === "{" ? "}" : "]")) {
        // An empty object or array stays on its line.
        out += char + text.charAt(next);
        at = next;
      } else {
        depth += 1;
        out += char + newline();
      }
    } else if (char === "}" || char === "]") {
      depth -= 1;
      out += newline() + char;
    } else if (char === ",") {
      out += char + newline();
    } else if (char === ":") {
      out += ": ";
    } else {
      out += char;
    }
  }
  return out;
}
