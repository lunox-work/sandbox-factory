/**
 * What this extension build was built from.
 *
 * Deliberately thin. This workspace has no test runner yet (see AGENTS.md), so
 * everything with a decision in it — formatting, comparison, the commit link —
 * stays in @sandbox-factory/shared where it is covered, and this file only
 * holds the injected literal and the `vscode` calls that display it.
 *
 * Note that the extension's own `version` in package.json is the vsce
 * marketplace version and moves independently of the API and web app. The sha
 * below is what actually ties this build to a commit, which is the whole reason
 * the sha rather than the version is the identifier everywhere in this repo.
 */

import type { BuildInfoDto } from "@sandbox-factory/shared";

/** Substituted at bundle time by esbuild; see `esbuild.js`. */
declare const __BUILD_INFO__: BuildInfoDto;

export const extensionBuild: BuildInfoDto = __BUILD_INFO__;
