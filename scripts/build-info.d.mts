/**
 * Types for `build-info.mjs`, which is plain JavaScript because it runs (Vite
 * config, esbuild config, `node` in CI) before anything is compiled.
 *
 * The `.d.mts` extension is load-bearing: under Bundler and NodeNext
 * resolution a `.d.ts` is silently ignored and the import resolves to `any`.
 *
 * `BuildInfo` restates `BuildInfoDto` from packages/shared rather than
 * importing it, because this file is read before that package is built.
 * `packages/shared/test/build-info.test.ts` pins the shared shape.
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
