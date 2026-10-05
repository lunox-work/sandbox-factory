/**
 * What the sidebar's views find in a version's files: its documents, its
 * tests and the cases in them, and the lines a search matches. Pure.
 */

/** A file of tests: a `.test`, `.spec` or `.steps` script, or a feature. */
export function isTestFile(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  return (
    /\.(test|spec|steps)\.[cm]?[jt]sx?$/.test(name) || name.endsWith(".feature")
  );
}

export function isMarkdown(path: string): boolean {
  return /\.(md|mdx|markdown)$/i.test(path);
}

export function isFeature(path: string): boolean {
  return /\.feature$/i.test(path);
}

/** A file's folder, `""` at the top. */
export function folderOf(path: string): string {
  return path.slice(0, Math.max(0, path.lastIndexOf("/")));
}

/** Items grouped by folder: the top first, the rest by name. */
export function byFolder<T>(
  items: readonly T[],
  pathOf: (item: T) => string,
): [string, T[]][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const folder = folderOf(pathOf(item));
    groups.set(folder, [...(groups.get(folder) ?? []), item]);
  }
  return [...groups].sort(([a], [b]) =>
    a === "" ? -1 : b === "" ? 1 : a.localeCompare(b),
  );
}

export interface TestCase {
  name: string;
  /** 1-based. */
  line: number;
  /** `describe` blocks are groups, not cases. */
  group: boolean;
}

const TEST_CALL =
  /\b(describe|suite|test|it)(?:\.(?:only|skip|todo|concurrent|each\([^)]*\)))?\s*\(\s*(["'`])((?:\\.|(?!\2).)*)\2/;

/** The named tests in a script, in order: `test("…")`, `it('…')`, `describe`. */
export function testCases(text: string): TestCase[] {
  const cases: TestCase[] = [];
  text.split("\n").forEach((line, index) => {
    const match = TEST_CALL.exec(line);
    if (match === null) return;
    const kind = match[1] ?? "";
    cases.push({
      name: match[3] ?? "",
      line: index + 1,
      group: kind === "describe" || kind === "suite",
    });
  });
  return cases;
}

export interface SearchMatch {
  /** 1-based. */
  line: number;
  /** The line, its leading whitespace trimmed. */
  text: string;
  /** Where the first match on the line starts and ends, in `text`. */
  start: number;
  end: number;
}

/** Each line of the text the query is found on, first match per line. */
export function searchLines(
  text: string,
  query: string,
  matchCase: boolean,
): SearchMatch[] {
  if (query === "") return [];
  const needle = matchCase ? query : query.toLowerCase();
  const matches: SearchMatch[] = [];
  text.split("\n").forEach((raw, index) => {
    const line = raw.replace(/\r$/, "");
    const at = (matchCase ? line : line.toLowerCase()).indexOf(needle);
    if (at === -1) return;
    const indent = line.length - line.trimStart().length;
    matches.push({
      line: index + 1,
      text: line.trimStart(),
      // A match in the indentation is marked from where the text starts.
      start: Math.max(0, at - indent),
      end: Math.max(0, at - indent + query.length),
    });
  });
  return matches;
}
