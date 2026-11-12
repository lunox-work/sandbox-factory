/**
 * Pseudonyms drafted by rule: the name table a sliced version needs to keep
 * the workspace's vocabulary out of its public files, written without a
 * model wherever the vocabulary is where rules can find it.
 *
 * carveout's draft (`carveout/pseudonyms`, `draft.ts`) since carveout
 * 0.3.0, under the names core always exported: an import of the workspace's
 * own package becomes the relative path the generator gives it, and every
 * other occurrence of a term a placeholder no input uses. carveout tries
 * made-up placeholders first, gives a term of several words a tail word per
 * extra word, restyles each to the spelling it replaces, and can keep an
 * earlier cut's placeholders (NOTICE.md). The draft is a candidate the
 * build checks as it applies it.
 */

export {
  PSEUDONYM_PLACEHOLDERS,
  draftPseudonyms,
  type PseudonymImport,
} from "carveout/pseudonyms";
