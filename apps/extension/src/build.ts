/**
 * What this extension build was built from.
 *
 * Deliberately thin: this workspace has no test runner yet (see AGENTS.md), so
 * anything with a decision in it stays in @sandbox-factory/shared, where it is
 * covered.
 *
 * The `version` in package.json is the vsce marketplace version and moves
 * independently of the API and web app; the sha is what ties this build to a
 * commit.
 */

import type { BuildInfoDto } from "@sandbox-factory/shared";

/** Substituted at bundle time by esbuild; see `esbuild.js`. */
declare const __BUILD_INFO__: BuildInfoDto;

export const extensionBuild: BuildInfoDto = __BUILD_INFO__;
