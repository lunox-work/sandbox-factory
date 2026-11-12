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
