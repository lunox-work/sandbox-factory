/**
 * Carry refusals that are the carry's limit, not the contributor's doing.
 * A passing submission that meets one keeps its verdict and is marked
 * `carryBack: "failed"` (merge-back withheld), as a pass whose reversed
 * check fails is; any other carry refusal refuses the submission.
 *
 * Keyed on reason text, since carveout's `CarryRefusal` carries no code.
 */

import type { CarryRefusal } from "carveout/pseudonyms";

/**
 * carveout's refusal of a file whose two sides have different line counts.
 * For a file the version does not have (a new file), that means the
 * repository already holds a file at its path, outside the slice.
 */
export const CARRY_LINE_UP_REASON =
  "The version's copy of this file does not line up with the repository's, so the change cannot be carried.";

/**
 * The platform's name for that case: a new file at a path the repository
 * already holds outside the slice (`carryLimitOf` relabels carveout's).
 */
export const NEW_FILE_ON_REPOSITORY_PATH_REASON =
  "The contribution adds a file at a path the repository already holds outside the slice, so it cannot be carried back.";

/**
 * carveout's `STRANDED_NAME_REASON`, from carveout ≥ next release (after
 * 0.3.1): an added line holds a public name the table renames back only in
 * other files. Matched as text until the pin moves, when it can be
 * imported instead.
 */
export const CARVEOUT_STRANDED_NAME_REASON =
  "An added line uses a public name the table renames back only in other files, so it cannot be named back in this one.";

const LIMITS: ReadonlySet<string> = new Set([
  NEW_FILE_ON_REPOSITORY_PATH_REASON,
  CARVEOUT_STRANDED_NAME_REASON,
]);

/**
 * A reverse carry's refusals, carveout's line-up refusal of a new file
 * relabelled (`NEW_FILE_ON_REPOSITORY_PATH_REASON`), split into the carry's
 * limits and the contributor's doing. `isNew` says whether the version
 * lacks the submitted file at that project path.
 */
export function carryLimitOf(
  refused: readonly CarryRefusal[],
  isNew: (path: string) => boolean,
): { readonly limits: CarryRefusal[]; readonly contributor: CarryRefusal[] } {
  const limits: CarryRefusal[] = [];
  const contributor: CarryRefusal[] = [];
  for (const refusal of refused) {
    const reason =
      refusal.reason === CARRY_LINE_UP_REASON && isNew(refusal.path)
        ? NEW_FILE_ON_REPOSITORY_PATH_REASON
        : refusal.reason;
    (LIMITS.has(reason) ? limits : contributor).push({ ...refusal, reason });
  }
  return { limits, contributor };
}
