import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

import { resolveBuildInfo } from "../../scripts/build-info.mjs";

/**
 * Resolved once, at config load, rather than per module: every chunk of a
 * single build must report the same record, and calling the resolver more than
 * once would stamp them with different timestamps.
 */
const buildInfo = resolveBuildInfo();

/**
 * Serves the build record as a module.
 *
 * A virtual module rather than `define`, which is what this originally used and
 * what the Vite docs point you at first. `define` performs a textual
 * substitution during *bundling*, and the dev server does not bundle — it
 * transforms each module on request and leaves the identifier alone, so
 * `__BUILD_INFO__` stayed a bare undeclared global and the footer read 0.0.0
 * with no sha for the whole of `npm run dev`.
 *
 * A module is resolved the same way in both modes, so dev and production cannot
 * disagree about it. The value is still fixed at config load, so the build-time
 * freezing that makes a stale bundle report itself honestly is unchanged.
 */
function buildInfoPlugin(): Plugin {
  const id = "virtual:build-info";
  // Vite's convention: the resolved id is prefixed with \0 so that other
  // plugins and the dev server leave it alone rather than trying to read it
  // from disk.
  const resolvedId = `\0${id}`;

  return {
    name: "sandbox-factory:build-info",
    resolveId(source) {
      return source === id ? resolvedId : undefined;
    },
    load(loadedId) {
      return loadedId === resolvedId
        ? `export default ${JSON.stringify(buildInfo)};`
        : undefined;
    },
  };
}

export default defineConfig({
  plugins: [react(), buildInfoPlugin()],
  server: {
    port: 5173,
    // Keeps the dev origin identical to production's same-origin setup, so
    // cookie and CORS behaviour does not differ between the two.
    proxy: {
      "/api": {
        target: process.env["VITE_API_URL"] ?? "http://localhost:4000",
        changeOrigin: true,
      },
    },
  },
});
