/**
 * The vocabulary check a build and a starter block on: the workspace's
 * names found in public files, by carveout's scan and by the platform's
 * before it, merged term by term.
 *
 * carveout's `vocabularyLeaks` joins a term's words across a space, `_`,
 * `-` or `.`, no longer across a `/` (two folders that hold a name's words
 * are two names to it). For the first release on carveout's renaming the
 * check blocks on both scans (`publicVocabularyLeaks` in core, which the
 * upload route runs too), so no name the platform blocked before can reach
 * a public file now.
 */

import { publicVocabularyLeaks } from "sandbox-factory";

export const publicLeaks = publicVocabularyLeaks;
