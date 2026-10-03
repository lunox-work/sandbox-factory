const { existsSync, readdirSync, readFileSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const alias = { "@": join(root, "apps/web/src") };

// Resolve workspace public entry points from source even in a fresh checkout.
// Package subpaths are intentionally not invented: their package exports still
// decide whether they exist. Relative imports are resolved normally.
for (const entry of readdirSync(join(root, "packages"), {
  withFileTypes: true,
})) {
  const directory = join(root, "packages", entry.name);
  if (entry.isDirectory() && existsSync(join(directory, "src/index.ts"))) {
    const manifest = JSON.parse(
      readFileSync(join(directory, "package.json"), "utf8"),
    );
    alias[`${manifest.name}$`] = join(directory, "src/index.ts");
  }
}

// This is only dependency-cruiser's resolver; it does not affect product builds.
module.exports = {
  resolve: {
    alias,
    extensionAlias: {
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
      ".cjs": [".cts", ".cjs"],
    },
  },
};
