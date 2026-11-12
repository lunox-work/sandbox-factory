/**
 * The part of `duediligence/api` the API calls (the package ships plain
 * JavaScript), typed from `bin/hash.mjs`. Pinned exactly in package.json.
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
}
