/// <reference types="vite/client" />

/**
 * The build record, supplied by the `sandbox-factory:build-info` plugin in
 * `vite.config.ts`. Typed as `BuildInfoDto`, the same contract the API serves
 * from `GET /version`, so drift fails the type check rather than the browser.
 */
declare module "virtual:build-info" {
  const buildInfo: import("@sandbox-factory/shared").BuildInfoDto;
  export default buildInfo;
}
