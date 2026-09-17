import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

import { resolveBuildInfo } from "../../scripts/build-info.mjs";

/**
 * Resolved once at config load: resolving per module would stamp chunks of one
 * build with different timestamps.
 */
const buildInfo = resolveBuildInfo();

/**
 * Serves the build record as a virtual module.
 *
 * Do not switch this to `define`: it substitutes only during bundling, and the
 * dev server does not bundle, so `__BUILD_INFO__` stayed an undeclared global
 * and the footer read 0.0.0 under `npm run dev`. A module resolves the same
 * way in both modes. Pinned by `test/build-injection.test.ts`.
 */
function buildInfoPlugin(): Plugin {
  const id = "virtual:build-info";
  // Vite's convention: a \0 prefix stops other plugins and the dev server
  // trying to read the id from disk.
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
    // Same-origin like production (see nginx.conf), so cookie and CORS
    // behaviour does not differ.
    proxy: {
      "/api": {
        target: process.env["VITE_API_URL"] ?? "http://localhost:4000",
        changeOrigin: true,
      },
    },
  },
});
