/**
 * Where the scope agent looks first, found without a model: the
 * repository's modules ranked by the words they share with the spec, in
 * their paths and in their exports' names, each word weighed by how few
 * modules have it, since a word every module has says nothing. Path words
 * count double: a file is named for what it does, and exports also name
 * what it uses.
 *
 * The ranking is a starting point for the agent's reading, quoted in its
 * first prompt so it does not spend turns searching for what a word match
 * finds; it is never an answer. `check_scope` still decides what a request
 * produces.
 */

import type { SpecDraft } from "sandbox-factory";
import { termWords } from "sandbox-factory";

/** Modules the first prompt names, most likely first. */
export const SCOPE_CANDIDATES_MAX = 12;
/** A candidate's exports the prompt names. */
const EXPORTS_SHOWN = 8;
/**
 * A surface this wide re-exports or aggregates others, and its names match
 * any spec: its exports are not read for words, its path still is.
 */
const EXPORTS_READ_MAX = 40;
/** A barrel (`index.ts`) only gathers what other modules do. */
const BARREL = /(?:^|\/)index\.[cm]?[jt]sx?$/;
const WORD_MIN = 3;
/** Gherkin's own words and everyday English, which name no code. */
const STOP_WORDS: ReadonlySet<string> = new Set([
  "and",
  "any",
  "are",
  "but",
  "can",
  "does",
  "each",
  "for",
  "from",
  "given",
  "has",
  "have",
  "into",
  "its",
  "not",
  "one",
  "only",
  "should",
  "that",
  "the",
  "then",
  "their",
  "there",
  "this",
  "was",
  "when",
  "where",
  "which",
  "with",
  "without",
]);

/** A word's singular, roughly: `sandboxes` and `sandbox` are one word. */
function stem(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && /(?:s|x|ch|sh)es$/.test(word))
    return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss"))
    return word.slice(0, -1);
  return word;
}

function wordsOf(text: string): Set<string> {
  return new Set(
    termWords(text)
      .filter(
        (word) =>
          word.length >= WORD_MIN &&
          !STOP_WORDS.has(word) &&
          /\p{L}/u.test(word),
      )
      .map(stem),
  );
}

/** A module as the ranking reads it. */
export interface CandidateModule {
  readonly path: string;
  readonly exports: readonly { readonly name: string }[];
  /** Repository files importing it; ties go to the more imported. */
  readonly importers: number;
}

export interface ScopeCandidate {
  readonly path: string;
  /** The spec's words it shares, best first. */
  readonly matched: readonly string[];
  readonly exports: readonly string[];
  readonly importers: number;
}

export function scopeCandidates(input: {
  readonly spec: SpecDraft;
  readonly modules: readonly CandidateModule[];
}): ScopeCandidate[] {
  const { spec } = input;
  const specWords = wordsOf(
    [
      spec.feature,
      ...spec.background,
      ...spec.scenarios.flatMap((scenario) => [
        scenario.title,
        ...scenario.steps.map((step) => step.text),
      ]),
    ].join("\n"),
  );
  if (specWords.size === 0) return [];
  const read = input.modules
    .filter((module) => !BARREL.test(module.path))
    .map((module) => ({
      module,
      path: wordsOf(module.path.replace(/\.[^./]+$/, "")),
      exports:
        module.exports.length > EXPORTS_READ_MAX
          ? new Set<string>()
          : wordsOf(module.exports.map((entry) => entry.name).join(" ")),
    }));
  const holders = new Map<string, number>();
  for (const { path, exports } of read)
    for (const word of new Set([...path, ...exports]))
      holders.set(word, (holders.get(word) ?? 0) + 1);
  const weight = (word: string) =>
    Math.log((read.length + 1) / ((holders.get(word) ?? 0) + 1));
  return read
    .map(({ module, path, exports }) => {
      const matched = [...specWords]
        .map((word) => ({
          word,
          score:
            (path.has(word) ? 2 * weight(word) : 0) +
            (exports.has(word) ? weight(word) : 0),
        }))
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score || compare(a.word, b.word));
      return {
        module,
        matched,
        score: matched.reduce((sum, { score }) => sum + score, 0),
      };
    })
    .filter(({ score }) => score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.module.importers - a.module.importers ||
        compare(a.module.path, b.module.path),
    )
    .slice(0, SCOPE_CANDIDATES_MAX)
    .map(({ module, matched }) => ({
      path: module.path,
      matched: matched.map(({ word }) => word),
      exports: module.exports.map((entry) => entry.name),
      importers: module.importers,
    }));
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The ranking as the scope agent's first prompt carries it. */
export function scopeCandidatesSection(
  candidates: readonly ScopeCandidate[],
): string | null {
  if (candidates.length === 0) return null;
  return [
    "The modules that share the most words with the spec, in their paths and export names, found by matching words and not yet read. Start your reading here, and search only for what these do not explain:",
    ...candidates.map(
      (candidate) =>
        `- ${candidate.path} (imported by ${candidate.importers}): shares ${candidate.matched.join(", ")}${
          candidate.exports.length === 0
            ? ""
            : `; exports ${candidate.exports.slice(0, EXPORTS_SHOWN).join(", ")}${candidate.exports.length > EXPORTS_SHOWN ? `, and ${candidate.exports.length - EXPORTS_SHOWN} more` : ""}`
        }`,
    ),
  ].join("\n");
}
