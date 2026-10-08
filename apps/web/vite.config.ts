import tailwind from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type Plugin } from "vite";

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

/** Keeps the OAuth state and session cookies on one origin in dev only. */
function canonicalOriginPlugin(value: string | undefined): Plugin {
  if (!value) return { name: "sandbox-factory:dev-origin", apply: "serve" };
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("VITE_DEV_CANONICAL_ORIGIN must be an HTTP(S) origin.");
  }
  return {
    name: "sandbox-factory:dev-origin",
    apply: "serve",
    transformIndexHtml() {
      return [
        {
          tag: "script",
          injectTo: "head-prepend",
          children: `if (window.location.origin !== ${JSON.stringify(url.origin)}) {
          window.location.replace(${JSON.stringify(url.origin)} + window.location.pathname + window.location.search + window.location.hash);
        }`,
        },
      ];
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(
    mode,
    fileURLToPath(new URL(".", import.meta.url)),
    "VITE_",
  );
  const allowedHosts = (env["VITE_DEV_ALLOWED_HOSTS"] ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);

  return {
    // Tailwind v4 is configured in CSS, not in a config file: the theme lives in
    // `@theme` in index.css, which is why there is no tailwind.config.js here.
    plugins: [
      tailwind(),
      react(),
      buildInfoPlugin(),
      canonicalOriginPlugin(env["VITE_DEV_CANONICAL_ORIGIN"]),
    ],
    resolve: {
      alias: {
        // The import prefix shadcn's generated components use. Mirrored in
        // tsconfig `paths` and in vitest.config.ts — three places, because the
        // type-checker, the bundler and the test runner each resolve modules
        // themselves.
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
    optimizeDeps: {
      // Imported only by the Graphviz worker, which the dependency scan does
      // not read. Found on first use instead, it was bundled then and the dev
      // server reloaded the page, closing whatever dialog had asked for it.
      include: ["@viz-js/viz"],
    },
    server: {
      host: "0.0.0.0",
      port: 5173,
      allowedHosts,
      // Same-origin like production (see nginx.conf), so cookie and CORS
      // behaviour does not differ.
      proxy: {
        "/api": {
          target: env["VITE_API_URL"] ?? "http://localhost:4000",
          changeOrigin: true,
        },
      },
    },
  };
});
