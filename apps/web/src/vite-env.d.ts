/// <reference types="vite/client" />

/**
 * The build record, supplied by the `sandbox-factory:build-info` plugin in
 * `vite.config.ts` and resolved identically by the dev server and a build.
 *
 * Typed as `BuildInfoDto` so the UI that reads it is checked against the same
 * contract the API serves from `GET /version` — the two are compared field for
 * field, and a shape that drifted on one side would otherwise only fail in the
 * browser.
 */
declare module "virtual:build-info" {
  const buildInfo: import("@sandbox-factory/shared").BuildInfoDto;
  export default buildInfo;
}
