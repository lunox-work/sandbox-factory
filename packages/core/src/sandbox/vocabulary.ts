/**
 * Workspace vocabulary: the names that say whose code a sandbox was cut
 * from (the organization, its repository, its package scope, its author)
 * and the check that none of them reaches a public file.
 *
 * Pseudonyms are what hide those names, but a table can be empty or miss
 * one, and a sliced version is the workspace's own code. So a build scans
 * what contributors would read, paths and text, for every name the
 * workspace goes by, and a name still there blocks the build until the
 * table renames it.
 *
 * A name is matched by its words, whatever joins them: `sandbox-factory`
 * is found as `sandboxFactory`, `SANDBOX_FACTORY` and `sandbox factory`.
 * A match must start and end on a word boundary, where a case change in an
 * identifier counts as one: `acme` is found in `acmeOrders` and `MyAcme`,
 * not in `acmes`. A name too short or too generic to say whose code it is
 * (`api`, `web`, `monorepo`) is not scanned for.
 */

import type { ProjectBlocker } from "./project.js";

/** Shorter names, separators aside, match too much to block on. */
export const VOCABULARY_TERM_MIN = 4;
/** Files a leak's detail names before it counts the rest. */
const LEAK_FILES_SHOWN = 5;
/** Words any workspace might name itself with, which say nothing about whose. */
const GENERIC_WORDS: ReadonlySet<string> = new Set([
  "admin",
  "android",
  "api",
  "app",
  "apps",
  "backend",
  "client",
  "code",
  "common",
  "company",
  "core",
  "corp",
  "dashboard",
  "demo",
  "docs",
  "example",
  "frontend",
  "ios",
  "lib",
  "libs",
  "main",
  "mobile",
  "mono",
  "monorepo",
  "personal",
  "platform",
  "project",
  "repo",
  "root",
  "server",
  "service",
  "services",
  "shared",
  "site",
  "src",
  "team",
  "test",
  "tests",
  "utils",
  "web",
  "website",
  "workspace",
  "www",
]);

/**
 * A name's words, lowercased: split at anything not a letter or digit, and
 * at each case change an identifier marks (`acmeOrders`, `XMLParser`).
 */
export function termWords(name: string): string[] {
  return name
    .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());
}

/**
 * The names worth scanning for, each as its words joined by `-`, in the
 * order first given. Repeats, names under `VOCABULARY_TERM_MIN` and names
 * made only of generic words are dropped.
 */
export function workspaceVocabulary(names: readonly string[]): string[] {
  const terms: string[] = [];
  for (const name of names) {
    const words = termWords(name);
    if (words.join("").length < VOCABULARY_TERM_MIN) continue;
    if (words.every((word) => GENERIC_WORDS.has(word))) continue;
    const term = words.join("-");
    if (!terms.includes(term)) terms.push(term);
  }
  return terms;
}

export interface VocabularyLeak {
  readonly term: string;
  readonly occurrences: number;
  /** The files it was found in, path or text, in the order given. */
  readonly files: readonly string[];
}

const LETTER = /\p{L}/u;
const UPPER = /\p{Lu}/u;
const LOWER = /\p{Ll}/u;
const is = (pattern: RegExp, char: string | undefined) =>
  char !== undefined && pattern.test(char);

/** Every match of `term` in `text` that starts and ends on a word boundary. */
function countTerm(text: string, term: string): number {
  const pattern = new RegExp(term.split("-").join("[\\s_\\-./]*"), "giu");
  let count = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    const end = start + match[0].length;
    const before = text[start - 1];
    const after = text[end];
    const opens =
      !is(LETTER, before) || (is(LOWER, before) && is(UPPER, text[start]));
    const closes =
      !is(LETTER, after) || (is(UPPER, after) && is(LOWER, text[end - 1]));
    if (opens && closes) count += 1;
  }
  return count;
}

/** Each term found in the files' paths or text, in the vocabulary's order. */
export function vocabularyLeaks(
  files: readonly { readonly path: string; readonly text: string }[],
  vocabulary: readonly string[],
): VocabularyLeak[] {
  const leaks: VocabularyLeak[] = [];
  for (const term of vocabulary) {
    let occurrences = 0;
    const found: string[] = [];
    for (const file of files) {
      const count = countTerm(file.path, term) + countTerm(file.text, term);
      if (count === 0) continue;
      occurrences += count;
      found.push(file.path);
    }
    if (occurrences > 0) leaks.push({ term, occurrences, files: found });
  }
  return leaks;
}

/** A blocker for each leak, naming where it was found and what clears it. */
export function vocabularyBlockers(
  leaks: readonly VocabularyLeak[],
): ProjectBlocker[] {
  return leaks.map((leak) => {
    const shown = leak.files.slice(0, LEAK_FILES_SHOWN).join(", ");
    const rest = leak.files.length - LEAK_FILES_SHOWN;
    return {
      code: "vocabulary_leaked",
      file: leak.files[0] ?? null,
      detail: `"${leak.term}" names the workspace and appears ${leak.occurrences} time${leak.occurrences === 1 ? "" : "s"} in ${leak.files.length} public file${leak.files.length === 1 ? "" : "s"}: ${shown}${rest > 0 ? `, and ${rest} more` : ""}. Give it a pseudonym.`,
    };
  });
}
