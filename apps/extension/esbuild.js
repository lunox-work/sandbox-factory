// Bundles the extension for the VS Code host.
//
// `external: ["vscode"]` is mandatory — the host provides that module at
// runtime and bundling it breaks activation. Everything else, including the
// workspace packages, is bundled in, which is why `vsce package` runs with
// --no-dependencies.
//
// format: cjs because the extension host does not load ESM. This is the one
// place in the repo that is not ESM; see tooling/tsconfig/extension.json.

const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node20",
    outfile: "dist/extension.js",
    external: ["vscode"],
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
