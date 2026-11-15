/**
 * The no-change round trip, one of the two gates a version is published on
 * (`freezeReadiness`): the project a contributor receives, left unchanged,
 * carried back to the repository's names, is the slice's source at the
 * pinned commit byte for byte.
 *
 * Merge-back carries a change the way `reverseSubmission` does: each copied
 * file is matched to its repository file by path (the build's moves, else
 * the table's path rules), lined up line for line, and a line a contributor
 * wrote is renamed by the table's inverse, scoped by the repository path.
 * So the unchanged project carries back exactly when, for every copied
 * file, the repository has the file, the two line up, and each line read
 * back through the inverse table is the repository's line. The generator's
 * own per-line edits are the one allowed difference: a module specifier it
 * rewrote (a string literal) and an environment variable it renamed (an
 * identifier on a line that reads `process.env`), which merge-back puts
 * back from the repository's line, never from the table.
 *
 * Pure: the worker reads the source and the project, and records the
 * result in the build manifest (`PublicationGates.roundTrip`).
 */

import { invertAliasRules, renameFile, type AliasRule } from "./aliases.js";
import { linesOf, tokensOf } from "./carry.js";

export interface RoundTripSource {
  /** Where the file is in the project. */
  readonly projectPath: string;
  /** Where it is in the repository. */
  readonly repositoryPath: string;
  /** The project's text; null when the project lacks it. */
  readonly publicText: string | null;
  /** The repository's text at the pinned commit; null for none. */
  readonly repositoryText: string | null;
}

export interface RoundTripProblem {
  /** The project path. */
  readonly path: string;
  readonly reason: string;
}

export interface RoundTripResult {
  readonly ok: boolean;
  /** Copied files checked. */
  readonly files: number;
  /** At most `ROUND_TRIP_PROBLEMS_MAX`, first by path. */
  readonly problems: readonly RoundTripProblem[];
}

export const ROUND_TRIP_PROBLEMS_MAX = 20;

const isLiteral = (token: string) => /^["'`]/.test(token);
const isIdentifier = (token: string) => /^[A-Za-z_$][\w$]*$/.test(token);

/** Whether two lines differ only where the generator edits a line. */
function generatorEdit(reversed: string, repository: string): boolean {
  const a = tokensOf(reversed);
  const b = tokensOf(repository);
  if (a.length !== b.length) return false;
  const readsEnvironment = /\bprocess\.env\b/.test(repository);
  return a.every((token, index) => {
    const other = b[index] ?? "";
    if (token === other) return true;
    if (isLiteral(token) && isLiteral(other)) return true;
    return readsEnvironment && isIdentifier(token) && isIdentifier(other);
  });
}

export function noChangeRoundTrip(input: {
  readonly sources: readonly RoundTripSource[];
  /** The version's name table. */
  readonly rules: readonly AliasRule[];
}): RoundTripResult {
  const inverse = invertAliasRules(input.rules);
  const problems: RoundTripProblem[] = [];
  const sources = [...input.sources].sort((a, b) =>
    a.projectPath < b.projectPath ? -1 : a.projectPath > b.projectPath ? 1 : 0,
  );
  for (const source of sources) {
    const problem = (reason: string) =>
      problems.push({ path: source.projectPath, reason });
    if (source.publicText === null) {
      problem("The project does not have this copied file.");
      continue;
    }
    if (source.repositoryText === null) {
      problem(
        `The repository has no ${source.repositoryPath} at the pinned commit.`,
      );
      continue;
    }
    const reversed = renameFile(
      { path: source.repositoryPath, text: source.publicText },
      inverse,
    ).text;
    if (reversed === source.repositoryText) continue;
    const back = linesOf(reversed);
    const original = linesOf(source.repositoryText);
    if (back.length !== original.length) {
      problem(
        `It has ${back.length} lines and the repository's ${original.length}, so a change to it cannot be carried back.`,
      );
      continue;
    }
    const at = back.findIndex(
      (line, index) =>
        line !== original[index] && !generatorEdit(line, original[index] ?? ""),
    );
    if (at >= 0)
      problem(
        `Line ${at + 1}, read back through the name table, is not the repository's line.`,
      );
  }
  return {
    ok: problems.length === 0,
    files: sources.length,
    problems: problems.slice(0, ROUND_TRIP_PROBLEMS_MAX),
  };
}
