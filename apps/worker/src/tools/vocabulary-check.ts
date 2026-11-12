/**
 * The vocabulary check a build and a starter block on: the workspace's
 * names found in public files, by carveout's scan and by the platform's
 * before it, merged term by term.
 *
 * carveout's `vocabularyLeaks` joins a term's words across a space, `_`,
 * `-` or `.`, no longer across a `/` (two folders that hold a name's words
 * are two names to it). For the first release on carveout's renaming the
 * check blocks on both scans (`unionVocabularyLeaks`), so no name the
 * platform blocked before can reach a public file now.
 */

import {
  unionVocabularyLeaks,
  vocabularyLeaksV1,
  type VocabularyLeak,
} from "carveout/pseudonyms";
import { vocabularyLeaks } from "sandbox-factory";

export function publicLeaks(
  files: readonly { readonly path: string; readonly text: string }[],
  vocabulary: readonly string[],
): VocabularyLeak[] {
  return unionVocabularyLeaks(
    vocabularyLeaks(files, vocabulary),
    vocabularyLeaksV1(files, vocabulary),
  );
}
