import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import ts from "typescript-compiler";
import {
  loadConfig,
  nearestCompilerOptions,
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
