/**
 * Alias rules: the private, bidirectional name table a sandbox version
 * applies to copied source before it can leave the organization.
 *
 * carveout's (`carveout/pseudonyms`, `aliases.ts`) since carveout 0.3.0,
 * under the names core always exported: validated as a set, applied in
 * order to identifier, path and text tokens, and refused unless the inverse
 * table gives the input back byte for byte. Where it differs from the
 * platform's before it (a path may hold any character but a NUL, a
 * backslash, a quote or a newline; a path rule matches after a `/` too; a
 * rule's target may occur where an earlier rule put it), carveout's
 * NOTICE.md says. A version built before carries back under the frozen
 * renaming, `ALIASES_V1` (see `carry.ts`).
 */

export {
  ALIAS_KINDS,
  ALIAS_PROBLEM_CODES,
  ALIAS_RULES_MAX,
  PSEUDONYMS_FILE,
  PSEUDONYMS_SCHEMA_VERSION,
  applyAliases,
  invertAliasRules,
  jsonLeaves,
  renameFile,
  validateAliasRules,
  withJsonLeaves,
  type AliasApplication,
  type AliasKind,
  type AliasProblem,
  type AliasProblemCode,
  type AliasRule,
  type AliasValidation,
  type AliasedFile,
  type PseudonymTable,
} from "carveout/pseudonyms";
