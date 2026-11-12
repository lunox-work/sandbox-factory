/**
 * Carrying a change between a version's public names and the repository's:
 * the reverse path merge-back needs (a submission, made in public names,
 * as a patch on the repository at the pinned commit), and the forward path
 * the CI judge needs (a pull request's files, in the repository's names,
 * as a submission on the version).
 *
 * carveout's (`carveout/pseudonyms`, `carry.ts`), moved there verbatim from
 * here but for one addition: `aliases`, the renaming the version was built
 * with, on `ReverseInput`, `ForwardInput` and `projectPathOf`. It defaults
 * to carveout's current renaming (`CURRENT_ALIASES`); a version built before
 * carveout 0.3.0 (no `engines.carveout` in its build manifest) carries
 * under the frozen one, `ALIASES_V1`. Pure and platform-neutral: the worker
 * reads the files, the API writes the pull request.
 */

export {
  carryChange,
  forwardChange,
  keptLines,
  learnedRenames,
  linesOf,
  projectPathOf,
  resolveRelative,
  reverseSubmission,
  tokensOf,
  type CarriedChange,
  type CarriedFile,
  type CarryRefusal,
  type ForwardInput,
  type Renaming,
  type ReverseInput,
} from "carveout/pseudonyms";
