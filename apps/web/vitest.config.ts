/**
 * Test config for the web app. Separate from `vite.config.ts`, whose dev
 * server settings are irrelevant to tests and whose `server.port` would make
 * two test runs collide.
 */

import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vitest/config";

/**
 * A fixed build record instead of the real resolver, so assertions on the
 * rendered version do not depend on the checkout's sha or a dirty tree.
 *
 * `test/build.ts` restates these values; the first test in
 * `build-footer.test.tsx` fails if the two drift.
 */
const TEST_BUILD = {
  version: "1.4.2",
  gitSha: "7f3a9c1e5b2d8a4f6c0e9b3a1d7f5c2e8a4b6d09",
  gitShortSha: "7f3a9c1",
  buildTime: "2026-09-17T09:14:00.000Z",
  gitRef: "main",
  dirty: false,
};

/**
 * Stands in for `buildInfoPlugin` in `vite.config.ts`. Without it nothing
 * resolves the `virtual:build-info` import in `src/build.ts` under Vitest.
 */
function buildInfoPlugin(): Plugin {
  const id = "virtual:build-info";
  const resolvedId = `\0${id}`;

  return {
    name: "sandbox-factory:build-info-test",
    resolveId(source) {
      return source === id ? resolvedId : undefined;
    },
    load(loadedId) {
      return loadedId === resolvedId
        ? `export default ${JSON.stringify(TEST_BUILD)};`
        : undefined;
    },
  };
}

export default defineConfig({
  plugins: [react(), buildInfoPlugin()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.tsx", "test/**/*.test.ts"],
  },
});
