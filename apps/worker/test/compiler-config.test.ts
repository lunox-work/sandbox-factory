import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import ts from "typescript-compiler";
import {
  loadConfig,
  nearestCompilerOptions,
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
