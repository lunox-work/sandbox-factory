/**
 * A repository outline: what the spec draft is shown of the code a bounty
 * is about.
 *
 * Drawn from a snapshot's `TreeFacts` and nothing else — module names,
 * counts and file types, never a file's contents or a path inside a module.
 * It tells the model how large and how varied the system is, so a scenario
 * that reaches across several modules can be weighed as such; the draft
 * prompt still forbids naming files, modules or functions in a scenario.
 *
 * Capped in lines, largest modules first, so a monorepo of hundreds of
 * packages costs the call no more than a small one.
 */

import {
  dominantExtensions,
  ROOT_MODULE,
  type TreeFacts,
} from "sandbox-factory";

/** The most lines an outline runs to, headers included. */
export const OUTLINE_MAX_LINES = 60;

/** The longest a name from the repository is shown. */
const NAME_MAX_CHARS = 80;
/** Paths named per list (lockfiles, migrations, infrastructure). */
const LIST_MAX = 5;
/** Languages named, by share of bytes. */
const LANGUAGES_MAX = 5;

export interface OutlineOptions {
  /** Bytes per language, as the snapshot recorded them. */
  readonly languages?: Readonly<Record<string, number>>;
  readonly maxLines?: number;
}

export function repositoryOutline(
  facts: TreeFacts,
  options: OutlineOptions = {},
): string {
  const maxLines = Math.max(4, options.maxLines ?? OUTLINE_MAX_LINES);
  const header = [
    `${count(facts.fileCount, "file")}, ${count(facts.testFiles, "test file")}${
      facts.truncated
        ? " (the listing was cut short, so these are lower bounds)"
        : ""
    }.`,
  ];
  const languages = languageLine(options.languages ?? {});
  if (languages !== null) header.push(languages);

  const footer = [
    listLine("Lockfiles", facts.lockfiles),
    listLine("Migrations", facts.migrationDirectories),
    listLine("Infrastructure", facts.infraDirectories),
  ].filter((line): line is string => line !== null);

  const modules = [...facts.modules].sort(
    (left, right) =>
      right.files - left.files ||
      (left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
  );
  // One line for the heading, and one for "N more" when some are left out.
  let room = maxLines - header.length - footer.length - 1;
  if (modules.length > room) room -= 1;
  const shown = modules.slice(0, Math.max(0, room));
  const rest = modules.slice(shown.length);

  const lines = [...header, "Modules, largest first:"];
  for (const module of shown) {
    const types = dominantExtensions(module, 3).map(clean).join(", ");
    const tests =
      module.testFiles > 0 ? `, ${count(module.testFiles, "test")}` : "";
    lines.push(
      `- ${moduleName(module.path)}: ${count(module.files, "file")}${tests}${
        types === "" ? "" : ` (${types})`
      }`,
    );
  }
  if (rest.length > 0) {
    const files = rest.reduce((sum, module) => sum + module.files, 0);
    lines.push(
      `- ${count(rest.length, "more module")}: ${count(files, "file")}`,
    );
  }
  return [...lines, ...footer].join("\n");
}

function moduleName(path: string): string {
  return path === ROOT_MODULE ? "(files at the root)" : clean(path);
}

/** One line of a name from the repository: no control characters, capped. */
function clean(name: string): string {
  const line = name.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return line.length > NAME_MAX_CHARS
    ? `${line.slice(0, NAME_MAX_CHARS - 1)}…`
    : line;
}

function count(value: number, noun: string): string {
  return `${value.toLocaleString("en-US")} ${noun}${value === 1 ? "" : "s"}`;
}

function listLine(label: string, paths: readonly string[]): string | null {
  if (paths.length === 0) return null;
  const named = paths.slice(0, LIST_MAX).map(clean).join(", ");
  const more =
    paths.length > LIST_MAX ? `, and ${paths.length - LIST_MAX} more` : "";
  return `${label}: ${named}${more}`;
}

function languageLine(
  languages: Readonly<Record<string, number>>,
): string | null {
  const entries = Object.entries(languages).filter(
    ([, bytes]) => Number.isFinite(bytes) && bytes > 0,
  );
  const total = entries.reduce((sum, [, bytes]) => sum + bytes, 0);
  if (total === 0) return null;
  const top = entries
    .sort(([a, left], [b, right]) => right - left || (a < b ? -1 : 1))
    .slice(0, LANGUAGES_MAX)
    .map(
      ([name, bytes]) =>
        `${clean(name)} ${Math.max(1, Math.round((bytes / total) * 100))}%`,
    );
  return `Languages by size: ${top.join(", ")}.`;
}
