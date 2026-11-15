/**
 * The part of `duediligence/api` the API calls (the package ships plain
 * JavaScript), typed from `bin/hash.mjs` and `bin/decisions.mjs`. Pinned
 * exactly in package.json.
 */
declare module "duediligence/api" {
  /**
   * The commitment hash over a hidden suite given as a file map keyed
   * `tests/private/<file>`, with the kept test ids.
   */
  export function hiddenSha256(
    files: Readonly<Record<string, string | Uint8Array>>,
    kept: readonly string[],
  ): string;
  /**
   * A spec's Gherkin scenarios, keyed `kind-n` by their first tag
   * (`untagged` without one) and position among that kind's, in spec
   * order; `body` is the lines after the `Scenario:` line, trimmed.
   */
  export function scenarios(
    specText: string,
  ): { key: string; title: string; body: string }[];
  /** The items under a spec's last `Decided:` heading, with their fields. */
  export function decisionItems(specText: string): {
    text: string;
    ticket?: string;
    instead?: string;
    scenarios?: string;
  }[];
}
