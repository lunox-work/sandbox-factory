/**
 * The build record the test config serves as `virtual:build-info`.
 *
 * Must match `TEST_BUILD` in `vitest.config.ts`. A config cannot import from a
 * test file, so the first assertion in `build-footer.test.tsx` fails if the
 * two drift.
 */

import type { BuildInfoDto } from "@sandbox-factory/shared";

export const TEST_BUILD: BuildInfoDto = {
  version: "1.4.2",
  gitSha: "7f3a9c1e5b2d8a4f6c0e9b3a1d7f5c2e8a4b6d09",
  gitShortSha: "7f3a9c1",
  buildTime: "2026-09-17T09:14:00.000Z",
  gitRef: "main",
  dirty: false,
};

/** A different commit, for the mismatch cases. */
export const OTHER_BUILD: BuildInfoDto = {
  ...TEST_BUILD,
  gitSha: "b2e881d3c7a9f4e6d8b0a2c5e7f9d1b3a5c7e9f0",
  gitShortSha: "b2e881d",
};
