/**
 * Workspace vocabulary: the names that say whose code a sandbox was cut
 * from (the organization, its repository, its package scope, its author)
 * and the check that none of them reaches a public file.
 *
 * carveout's (`carveout/pseudonyms`, `vocabulary.ts`) since carveout 0.3.0,
 * under the names core always exported. `workspaceVocabulary` and the names
 * it reads are the platform's as they were; `vocabularyLeaks` joins a
 * term's words across a space, `_`, `-` or `.` but no longer across a `/`.
 * For this release a build blocks on the leaks either scan finds
 * (`unionVocabularyLeaks` of `vocabularyLeaks` and `vocabularyLeaksV1`, in
 * the worker), so no name the platform blocked before can leak.
 */

import {
  unionVocabularyLeaks,
  vocabularyLeaks as leaksNow,
  vocabularyLeaksV1,
  type VocabularyLeak as Leak,
} from "carveout/pseudonyms";

export {
  VOCABULARY_TERM_MIN,
  emailNames,
  organizationNames,
  privatePackageNames,
  termMatches,
  termWords,
  vocabularyBlockers,
  vocabularyLeaks,
  workspaceVocabulary,
  type TermMatch,
  type VocabularyLeak,
  type VocabularyName,
} from "carveout/pseudonyms";

/**
 * The check a build, a starter and an upload block on: the workspace's
 * names found in public files by carveout's scan and by the platform's
 * before it, merged term by term (`unionVocabularyLeaks`).
 */
export function publicVocabularyLeaks(
  files: readonly { readonly path: string; readonly text: string }[],
  vocabulary: readonly string[],
): Leak[] {
  return unionVocabularyLeaks(
    leaksNow(files, vocabulary),
    vocabularyLeaksV1(files, vocabulary),
  );
}
