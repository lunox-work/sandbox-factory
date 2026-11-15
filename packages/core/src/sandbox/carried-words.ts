/**
 * A carried-back submission checked for words the carry renamed that the
 * name table did not: merge-back's guard against carveout's carry (0.3.1)
 * reading a contributor's own word as a client name.
 *
 * The carry renames a line a contributor added first by what the two
 * originals' differing lines show was renamed in that file, word by word
 * (`learnedRenames`), then by the table's inverse. A text rule that changes
 * several words at once (`wiki.orvanta.internal -> wiki.example.com`,
 * `Orvanta Payments -> Northwind Shop`) teaches it its words one by one
 * (`example -> orvanta`, `Shop -> Payments`), and an added
 * `export const Shop = 1` comes back as `export const Payments = 1`: code
 * the contributor did not write, in the client's words. The unchanged
 * project still carries back, and so may the corrupted pass, so neither the
 * round trip nor the reversed check sees it. `carryHazards` refuses only
 * the host and address rules among them.
 *
 * So each added line's carry is compared with the line renamed by the
 * table's inverse alone, scoped by its repository path. Where they differ,
 * each differing word must be one the build renamed beyond the table (an
 * import specifier, an environment variable): what the two originals' lines
 * still differ by once the table has renamed the version's line. Any other
 * difference is a word renamed by a pair learned from part of a table rule,
 * and the carry is not offered for merge-back. A carry that renames only by
 * whole rules, as carveout's after 0.4.1 does, leaves nothing here.
 *
 * Pure: the worker hands the files the grade carried back.
 */

import { CURRENT_ALIASES, type AliasImplementation } from "carveout/pseudonyms";
import type { AliasRule } from "./aliases.js";
import { keptLines, linesOf, tokensOf } from "./carry.js";

export interface CarriedWordsInput {
  /** The submission's files, at their paths in the version's project. */
  readonly submitted: readonly {
    readonly path: string;
    readonly text: string;
  }[];
  /** What the carry made of them (`reverseSubmission`'s files). */
  readonly carried: readonly { readonly path: string; readonly text: string }[];
  /** The version's public file at a project path; null for none. */
  readonly publicText: (path: string) => string | null;
  /** The repository's file at the pinned commit; null for none. */
  readonly repositoryText: (path: string) => string | null;
  /** The version's name table. */
  readonly rules: readonly AliasRule[];
  /** Repository path to project path, for each file the build moved. */
  readonly renames: readonly { readonly from: string; readonly to: string }[];
  /** The renaming the version was built with; carveout's by default. */
  readonly aliases?: AliasImplementation;
}

export interface CarriedWord {
  /** The project path of the submitted file. */
  readonly path: string;
  /** The added line's number, from 1. */
  readonly line: number;
}

/** The reason merge-back is withheld for, the same for every submission. */
export const CARRIED_WORDS_REASON =
  "A line the contributor added carries back with a word the name table does not rename (one learned from part of a text rule), so merge-back is withheld.";

/**
 * The added lines whose carry renames a word by a pair learned from part of
 * a table rule; empty when every renamed word is the table's or the build's.
 */
export function carriedWordHazards(input: CarriedWordsInput): CarriedWord[] {
  const { renameFile, invertAliasRules } = input.aliases ?? CURRENT_ALIASES;
  const inverse = invertAliasRules(input.rules);
  const repositoryPathOf = new Map(
    input.renames.map(({ from, to }) => [to, from]),
  );
  const carried = new Map(input.carried.map((file) => [file.path, file.text]));
  const hazards: CarriedWord[] = [];
  for (const file of input.submitted) {
    const toPath =
      repositoryPathOf.get(file.path) ??
      renameFile({ path: file.path, text: "" }, inverse).path;
    const output = carried.get(toPath);
    if (output === undefined) continue;
    const table = (text: string) =>
      renameFile({ path: toPath, text }, inverse).text;
    const from = linesOf(input.publicText(file.path) ?? "");
    const to = linesOf(input.repositoryText(toPath) ?? "");
    // What the build renamed beyond the table, by the table's output.
    const beyond = new Map<string, Set<string>>();
    from.forEach((line, index) => {
      const other = to[index];
      if (other === undefined || other === line) return;
      const a = tokensOf(table(line));
      const b = tokensOf(other);
      if (a.length !== b.length) return;
      a.forEach((token, at) => {
        const target = b[at] as string;
        if (token === target) return;
        const known = beyond.get(token) ?? new Set<string>();
        known.add(target);
        beyond.set(token, known);
      });
    });
    const edited = linesOf(file.text);
    const out = linesOf(output);
    const kept = keptLines(from, edited);
    edited.forEach((line, index) => {
      if ((kept[index] as number) >= 0) return;
      const expected = table(line);
      const actual = out[index];
      if (actual === expected) return;
      const a = tokensOf(expected);
      const b = tokensOf(actual ?? "");
      const explained =
        actual !== undefined &&
        out.length === edited.length &&
        a.length === b.length &&
        a.every(
          (token, at) =>
            token === b[at] || beyond.get(token)?.has(b[at] as string) === true,
        );
      if (!explained) hazards.push({ path: file.path, line: index + 1 });
    });
  }
  return hazards;
}
