/**
 * Does the build record actually reach the app?
 *
 * The other suites stub the value, so they prove the *UI* renders whatever it
 * is given and say nothing about whether the real plumbing delivers it. That
 * gap shipped a bug: `define` substitutes during bundling, the dev server does
 * not bundle, and so `npm run dev` showed "0.0.0" with no sha while every test
 * and the production build were green.
 *
 * These tests drive Vite itself — the real `vite.config.ts` — in both modes,
 * because "works in one mode" was precisely the failure.
 *
 * @vitest-environment node
 *
 * The environment override is required, not cosmetic: the suite-wide jsdom
 * environment replaces globals that esbuild — which Vite runs underneath —
 * asserts on, and it refuses to start under it.
 */

import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "vitest";
import { build, createServer } from "vite";

/** Long enough for a cold Vite start and a production build. */
const TIMEOUT = 120_000;

const ROOT = join(import.meta.dirname, "..");

/**
 * What the real resolver reports for this checkout.
 *
 * Read through the config rather than restated, so the assertions are about
 * delivery — did the value arrive — and not about any particular sha.
 */
async function expectedSha(): Promise<string> {
  const { resolveBuildInfo } = await import("../../../scripts/build-info.mjs");
  return resolveBuildInfo().gitSha;
}

/**
 * The regression, asserted on the exact path that broke.
 *
 * `transformRequest` is what the dev server runs to produce the JavaScript a
 * browser receives for a module — not `ssrLoadModule`, which bundles and
 * therefore applied `define` and passed even while the browser was broken.
 * Asserting on the served text is what makes this test able to fail.
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

      // The assertion that would have caught the bug. Before the fix this text
      // still contained the bare `__BUILD_INFO__` identifier — undeclared in
      // the browser, so `undefined` at runtime and 0.0.0 in the footer.
      expect(code).not.toContain("__BUILD_INFO__");

      // And it must get the record from somewhere, rather than having quietly
      // fallen back to a literal. The plugin serves it as a module, so the
      // served text imports it; following that import is left to the build
      // test below, which checks the value itself end to end.
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

      // The value itself, not merely the wiring: this is the end-to-end check
      // that the record reaches the artifact a user loads.
      const bundle = await readFile(join(outDir, "assets", asset!), "utf8");
      expect(bundle).toContain(await expectedSha());
      expect(bundle).not.toContain("__BUILD_INFO__");
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  },
);
