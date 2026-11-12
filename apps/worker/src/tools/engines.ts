/**
 * The carveout release this worker runs, as package.json pins it, and the
 * renaming a sandbox build was made with.
 *
 * Every build records the release in its manifest (`engines.carveout`). A
 * build without it was made before carveout 0.3.0 renamed the platform's
 * versions, by the platform's own renaming, and its names carry back and
 * forward only under that renaming, frozen as `ALIASES_V1`; one with it,
 * under carveout's (`CURRENT_ALIASES`).
 */

import { createRequire } from "node:module";
import {
  ALIASES_V1,
  CURRENT_ALIASES,
  type AliasImplementation,
} from "carveout/pseudonyms";
import type { SandboxBuildManifest } from "sandbox-factory";

export const CARVEOUT_VERSION = (
  createRequire(import.meta.url)("carveout/package.json") as {
    version: string;
  }
).version;

/** What a build records of the engines it ran on. */
export const BUILD_ENGINES: NonNullable<SandboxBuildManifest["engines"]> = {
  carveout: CARVEOUT_VERSION,
};

/** The renaming a build was made with, from its manifest. */
export function aliasesOf(
  manifest: Pick<SandboxBuildManifest, "engines">,
): AliasImplementation {
  return manifest.engines?.carveout === undefined
    ? ALIASES_V1
    : CURRENT_ALIASES;
}
