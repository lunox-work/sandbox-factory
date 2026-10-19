import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import ts from "typescript-compiler";
import {
  exportTarget,
  loadConfig,
  nearestCompilerOptions,
  pnpmWorkspacePatterns,
  workspaceModuleResolver,
  workspacePackages,
} from "../src/tools/compiler-config.js";

test("diamond inheritance applies later bases to compiler and serialized options", async () => {
  const root = await mkdtemp(join(tmpdir(), "compiler-config-"));
  try {
    for (const [name, config] of Object.entries({
      "common.json": {
        compilerOptions: { experimentalDecorators: false, target: "ES2022" },
      },
      "a.json": {
        extends: "./common",
        compilerOptions: { experimentalDecorators: true },
      },
      "b.json": { extends: "./common.json" },
      "tsconfig.json": { extends: ["./a.json", "./b.json"] },
    }))
      await writeFile(join(root, name), JSON.stringify(config));
    assert.equal(
      loadConfig(root, "app.ts").options.experimentalDecorators,
      false,
    );
    const raw = nearestCompilerOptions(root, "app.ts");
    assert.equal(raw?.["experimentalDecorators"], false);
    assert.equal(raw?.["target"], "ES2022");
    const generated = ts.convertCompilerOptionsFromJson(raw, root);
    assert.deepEqual(generated.errors, []);
    assert.equal(generated.options.target, ts.ScriptTarget.ES2022);
    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({
        extends: ["./a", "./b"],
        compilerOptions: { experimentalDecorators: true },
      }),
    );
    assert.equal(
      loadConfig(root, "app.ts").options.experimentalDecorators,
      true,
    );
    assert.equal(
      nearestCompilerOptions(root, "app.ts")?.["experimentalDecorators"],
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a base in one of the repository's workspace packages resolves without node_modules", async () => {
  const root = await mkdtemp(join(tmpdir(), "compiler-config-"));
  try {
    const files: Record<string, unknown> = {
      "package.json": { workspaces: ["tooling/*", "apps/*"] },
      "tooling/tsconfig/package.json": { name: "@acme/tsconfig" },
      "tooling/tsconfig/base.json": {
        compilerOptions: { strict: true, target: "ES2022" },
      },
      "tooling/tsconfig/react.json": {
        extends: "./base.json",
        compilerOptions: { jsx: "react-jsx" },
      },
      "apps/web/package.json": { name: "web" },
      "apps/web/tsconfig.json": {
        extends: "@acme/tsconfig/react.json",
        compilerOptions: { noEmit: true },
      },
      "apps/api/package.json": { name: "api" },
      "apps/api/tsconfig.json": { extends: "@acme/tsconfig/react" },
      // A bare package as the base: its `tsconfig` field names the file.
      "tooling/strict/package.json": {
        name: "@acme/strict",
        tsconfig: "./configs/strict.json",
      },
      "tooling/strict/configs/strict.json": {
        compilerOptions: { noUncheckedIndexedAccess: true },
      },
      "apps/jobs/package.json": { name: "jobs" },
      "apps/jobs/tsconfig.json": { extends: "@acme/strict" },
      "apps/cli/tsconfig.json": { extends: "@elsewhere/tsconfig/base.json" },
    };
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), JSON.stringify(content));
    }

    const web = loadConfig(root, "apps/web/src/App.tsx");
    assert.deepEqual(web.errors, []);
    assert.equal(web.options.jsx, ts.JsxEmit.ReactJSX);
    assert.equal(web.options.strict, true);
    assert.equal(web.options.noEmit, true);
    const raw = nearestCompilerOptions(root, "apps/web/src/App.tsx");
    assert.equal(raw?.["jsx"], "react-jsx");
    assert.equal(raw?.["target"], "ES2022");

    const api = loadConfig(root, "apps/api/src/index.ts");
    assert.deepEqual(api.errors, []);
    assert.equal(api.options.jsx, ts.JsxEmit.ReactJSX);
    assert.equal(
      nearestCompilerOptions(root, "apps/api/src/index.ts")?.["jsx"],
      "react-jsx",
    );

    const jobs = loadConfig(root, "apps/jobs/src/run.ts");
    assert.deepEqual(jobs.errors, []);
    assert.equal(jobs.options.noUncheckedIndexedAccess, true);
    assert.equal(
      nearestCompilerOptions(root, "apps/jobs/src/run.ts")?.[
        "noUncheckedIndexedAccess"
      ],
      true,
    );

    // A package the repository does not hold is still a missing input.
    const cli = loadConfig(root, "apps/cli/src/main.ts");
    assert.equal(cli.errors.length, 1);
    assert.equal(
      nearestCompilerOptions(root, "apps/cli/src/main.ts"),
      undefined,
    );

    assert.deepEqual(
      [...workspacePackages(root).entries()].map(([name, dir]) => [
        name,
        relative(root, dir),
      ]),
      [
        ["@acme/strict", "tooling/strict"],
        ["@acme/tsconfig", "tooling/tsconfig"],
        ["api", "apps/api"],
        ["jobs", "apps/jobs"],
        ["web", "apps/web"],
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace packages are found from pnpm, Lerna and nested or recursive globs", async () => {
  const root = await mkdtemp(join(tmpdir(), "compiler-config-"));
  try {
    const manifests: Record<string, string> = {
      "apps/web": "@acme/web",
      "packages/core/ledger": "@acme/ledger",
      "packages/deep/a/b": "@acme/deep",
      "packages/deep/test/fixture": "@acme/fixture",
      "services/billing": "@acme/billing",
      "libs/auth": "@acme/auth",
      "node_modules/zod": "zod",
      "packages/.hidden/x": "@acme/hidden",
      "tools/kit-a": "@acme/kit-a",
      "tools/other": "@acme/other",
    };
    for (const [dir, name] of Object.entries(manifests)) {
      await mkdir(join(root, dir), { recursive: true });
      await writeFile(
        join(root, dir, "package.json"),
        JSON.stringify({ name }),
      );
    }
    await writeFile(
      join(root, "pnpm-workspace.yaml"),
      [
        "# pnpm",
        "packages:",
        "  - 'apps/*'",
        '  - "packages/**"',
        "  - '!**/test/**'",
        "  - ./services/billing # one",
        "",
        "  - tools/kit-?",
        "onlyBuiltDependencies:",
        "  - esbuild",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(root, "lerna.json"),
      JSON.stringify({ packages: ["libs/*"] }),
    );
    await writeFile(join(root, "package.json"), "{}");
    assert.deepEqual(
      [...workspacePackages(root).entries()]
        .map(([name, dir]) => [name, relative(root, dir)])
        .sort(),
      [
        ["@acme/auth", "libs/auth"],
        ["@acme/billing", "services/billing"],
        ["@acme/deep", "packages/deep/a/b"],
        ["@acme/kit-a", "tools/kit-a"],
        ["@acme/ledger", "packages/core/ledger"],
        ["@acme/web", "apps/web"],
      ],
    );
    // Flow style, and a glob that leaves the repository.
    await writeFile(
      join(root, "pnpm-workspace.yaml"),
      "packages: ['apps/*', \"../*\"]\n",
    );
    await writeFile(join(root, "lerna.json"), "{}");
    assert.deepEqual([...workspacePackages(root).keys()], ["@acme/web"]);
    assert.deepEqual(pnpmWorkspacePatterns("catalog:\n  zod: 1\n"), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an exports map gives a subpath its target, types first, patterns too", () => {
  const exports = {
    ".": { import: "./dist/index.js", types: "./dist/index.d.ts" },
    "./sub": ["./dist/sub.js"],
    "./parts/*": { node: { default: "./dist/parts/*.js" } },
  };
  assert.equal(exportTarget(exports, ""), "./dist/index.d.ts");
  assert.equal(exportTarget(exports, "sub"), "./dist/sub.js");
  assert.equal(exportTarget(exports, "parts/a"), "./dist/parts/a.js");
  assert.equal(exportTarget(exports, "missing"), null);
  // A string or a bare map of conditions is the root's alone.
  assert.equal(exportTarget("./index.js", ""), "./index.js");
  assert.equal(exportTarget({ default: "./index.js" }, "sub"), null);
});

test("a workspace specifier resolves to the source its build output came from, and nothing else does", async () => {
  const root = await mkdtemp(join(tmpdir(), "workspace-module-"));
  try {
    const write = async (path: string, text: string) => {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), text);
    };
    await write("package.json", JSON.stringify({ workspaces: ["pkgs/*"] }));
    await write(
      "pkgs/built/package.json",
      JSON.stringify({ name: "built", main: "./out/index.js" }),
    );
    await write(
      "pkgs/built/tsconfig.json",
      JSON.stringify({ compilerOptions: { rootDir: "lib", outDir: "out" } }),
    );
    await write("pkgs/built/lib/index.ts", "export const a = 1;\n");
    await write(
      "pkgs/plain/package.json",
      JSON.stringify({ name: "plain", main: "./index.js" }),
    );
    await write("pkgs/plain/index.js", "export const b = 1;\n");
    await write("pkgs/empty/package.json", JSON.stringify({ name: "empty" }));
    const resolve = workspaceModuleResolver(root, () =>
      workspacePackages(root),
    );
    assert.equal(resolve("built"), "pkgs/built/lib/index.ts");
    assert.equal(resolve("plain"), "pkgs/plain/index.js");
    assert.equal(resolve("empty"), null);
    assert.equal(resolve("zod"), null);
    assert.equal(resolve("./built"), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
