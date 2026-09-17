/**
 * Types for `build-info.mjs`.
 *
 * The resolver is plain JavaScript because it runs in three places that cannot
 * consume TypeScript: a Vite config, an esbuild config, and `node` directly in
 * CI, all of them *before* the build that would compile it. This declaration
 * gives its two TypeScript consumers the types anyway.
 *
 * The `.d.mts` extension is load-bearing: under Bundler and NodeNext
 * resolution the declaration for `build-info.mjs` must be `build-info.d.mts`.
 * Named `.d.ts` it is silently ignored and the import resolves to `any`.
 *
 * `BuildInfo` is structurally the `BuildInfoDto` that packages/shared defines,
 * restated rather than imported for the same reason the runtime code is not
 * imported: this file is read before that package is built.
 * `packages/shared/test/build-info.test.ts` pins the shape both sides agree on.
 */

export interface BuildInfo {
  version: string;
  gitSha: string;
  gitShortSha: string;
  buildTime: string;
  gitRef: string;
  dirty: boolean;
}

export function resolveBuildInfo(env?: NodeJS.ProcessEnv): BuildInfo;
export function isIdentified(info: BuildInfo): boolean;
export function toEnvLines(info: BuildInfo): string;
