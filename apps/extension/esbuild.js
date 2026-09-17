// Bundles the extension for the VS Code host.
//
// `external: ["vscode"]` is mandatory: the host provides that module, and
// bundling it breaks activation. Everything else is bundled in, which is why
// `vsce package` runs with --no-dependencies.
//
// `format: "cjs"` because the extension host does not load ESM — the one place
// in the repo that is not ESM; see tooling/tsconfig/extension.json.

const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

async function main() {
  // Dynamic import: this file is CommonJS and the resolver, shared with the
  // Vite config, is ESM.
  const { resolveBuildInfo } = await import("../../scripts/build-info.mjs");

  const ctx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node20",
    outfile: "dist/extension.js",
    external: ["vscode"],
    // Baked in: the extension host has no build environment to read. Declared
    // for TypeScript in src/build.ts.
    define: {
      __BUILD_INFO__: JSON.stringify(resolveBuildInfo()),
    },
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    logLevel: "info",
  });

  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
