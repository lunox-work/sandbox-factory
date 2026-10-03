const { readdirSync } = require("node:fs");
const { join } = require("node:path");

const production = "^(apps|packages)/[^/]+/src/";
const neutral = "^packages/(core|shared|client|jira)/src/";
const packageDependencies = {
  core: [],
  shared: ["core"],
  client: ["core", "shared"],
  db: ["core"],
  jira: ["shared"],
  github: ["shared"],
};
const workspaces = (directory) =>
  readdirSync(join(__dirname, directory), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "core-has-no-external-dependencies",
      comment: "Domain code may import other core source files only.",
      severity: "error",
      from: { path: "^packages/core/src/" },
      to: { pathNot: "^packages/core/src/" },
    },
    {
      name: "packages-do-not-import-apps",
      severity: "error",
      from: { path: "^packages/[^/]+/src/" },
      to: { path: "^apps/" },
    },
    ...workspaces("apps").map((app) => ({
      name: `${app}-does-not-import-other-apps`,
      severity: "error",
      from: { path: `^apps/${escape(app)}/src/` },
      to: { path: "^apps/", pathNot: `^apps/${escape(app)}/` },
    })),
    ...workspaces("packages").map((name) => ({
      name: `${name}-dependency-direction`,
      comment: "Keep the package allowlist aligned with docs/architecture.md.",
      severity: "error",
      from: { path: `^packages/${escape(name)}/src/` },
      to: {
        path: "^packages/",
        pathNot: `^packages/(${[name, ...(packageDependencies[name] ?? [])].map(escape).join("|")})/`,
      },
    })),
    {
      name: "platform-neutral-packages-do-not-import-node",
      severity: "error",
      from: { path: neutral },
      to: { dependencyTypes: ["core"] },
    },
    {
      name: "platform-neutral-packages-do-not-import-node-types",
      severity: "error",
      from: { path: neutral },
      to: { path: "(^|/)node_modules/@types/node/|^@types/node($|/)" },
    },
    {
      name: "only-extension-imports-vscode",
      severity: "error",
      from: { path: production, pathNot: "^apps/extension/src/" },
      to: { path: "^vscode($|/)|(^|/)node_modules/(@types/)?vscode/" },
    },
    {
      name: "source-does-not-import-generated-output",
      severity: "error",
      from: { path: production },
      to: { path: "^(apps|packages)/[^/]+/dist(-test)?/" },
    },
    {
      name: "no-unresolved-imports",
      comment: "Vite injects build info; VS Code supplies its host module.",
      severity: "error",
      from: { path: production },
      to: { couldNotResolve: true, pathNot: "^(virtual:build-info|vscode)$" },
    },
    {
      name: "no-circular-imports",
      comment:
        "Runtime cycles only: a cycle that passes through a type-only import is erased at compile time.",
      severity: "error",
      from: { path: production },
      to: { circular: true, viaOnly: { dependencyTypesNot: ["type-only"] } },
    },
  ],
  options: {
    // Keep external edges for validation without crawling dependencies, tests,
    // fixtures or generated output. The command starts at production src roots.
    doNotFollow: { path: "node_modules|^(apps|packages)/[^/]+/(?!src/)" },
    // The product uses TypeScript 7, whose native API is not supported by
    // dependency-cruiser. SWC parses TS/TSX, including type-only imports.
    parser: "swc",
    tsPreCompilationDeps: true,
    webpackConfig: { fileName: "scripts/dependency-resolver.cjs" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["types", "import", "node", "default"],
      mainFields: ["types", "typings", "module", "main"],
    },
  },
};
