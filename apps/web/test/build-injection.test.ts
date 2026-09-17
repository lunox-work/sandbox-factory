/**
 * Does the build record actually reach the app?
 *
 * The other suites stub the value, so they say nothing about the real
 * plumbing. That gap shipped a bug: `define` left `npm run dev` showing
 * "0.0.0" while every test and the production build were green. These tests
 * drive the real `vite.config.ts` in both modes.
 *
 * @vitest-environment node
 *
 * The override is required: esbuild, which Vite runs underneath, refuses to
 * start under jsdom's replaced globals.
 */

import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "vitest";
import { build, createServer } from "vite";

/** Long enough for a cold Vite start and a production build. */
const TIMEOUT = 120_000;

const ROOT = join(import.meta.dirname, "..");

/**
 * What the real resolver reports for this checkout, so the assertions are
 * about delivery and not about any particular sha.
 */
async function expectedSha(): Promise<string> {
  const { resolveBuildInfo } = await import("../../../scripts/build-info.mjs");
  return resolveBuildInfo().gitSha;
}

/**
 * The regression, asserted on the path that broke. `transformRequest` produces
 * what a browser receives. Do not use `ssrLoadModule`: it applies `define` and
 * passed while the browser was broken.
 */
test(
  "the dev server serves a module carrying the real commit",
  { timeout: TIMEOUT },
  async () => {
    const server = await createServer({
      root: ROOT,
      server: { middlewareMode: true },
      logLevel: "silent",
    });

    try {
      const result = await server.transformRequest("/src/build.ts");
      const code = result?.code ?? "";

      // The bug: the served text kept the bare identifier, which is undeclared
      // in the browser.
      expect(code).not.toContain("__BUILD_INFO__");

      // It must import the record rather than fall back to a literal. The
      // build test below checks the value itself.
      expect(code).toContain("virtual:build-info");
    } finally {
      await server.close();
    }
  },
);

test(
  "a production build bakes the commit into the bundle",
  { timeout: TIMEOUT },
  async () => {
    const outDir = join(ROOT, "dist-build-injection-test");
    await rm(outDir, { recursive: true, force: true });

    try {
      await build({
        root: ROOT,
        logLevel: "silent",
        build: { outDir, emptyOutDir: true },
      });

      const html = await readFile(join(outDir, "index.html"), "utf8");
      const asset = /\/assets\/(index-[^"]+\.js)/.exec(html)?.[1];
      expect(asset).toBeDefined();

      // End to end: the value reaches the artifact a user loads.
      const bundle = await readFile(join(outDir, "assets", asset!), "utf8");
      expect(bundle).toContain(await expectedSha());
      expect(bundle).not.toContain("__BUILD_INFO__");
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  },
);
