import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import {
  lockedSpec,
  npmPackageTypes,
  PUBLIC_REGISTRY,
  typesPackageOf,
} from "../src/tools/slice/package-types.js";

test("the lockfile's root install is what npm installs again, an alias as one", async () => {
  const root = await mkdtemp(join(tmpdir(), "locked-spec-"));
  try {
    assert.equal(lockedSpec(root, "zod"), null);
    await writeFile(
      join(root, "package-lock.json"),
      JSON.stringify({
        packages: {
          "node_modules/zod": { version: "4.6.5" },
          "node_modules/ts-alias": { name: "typescript", version: "5.9.3" },
          "node_modules/linked": { version: "file:../x" },
          "apps/a/node_modules/nested": { version: "1.0.0" },
        },
      }),
    );
    assert.equal(lockedSpec(root, "zod"), "4.6.5");
    assert.equal(lockedSpec(root, "ts-alias"), "npm:typescript@5.9.3");
    assert.equal(lockedSpec(root, "linked"), null);
    assert.equal(lockedSpec(root, "nested"), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a package's types package is its @types name", () => {
  assert.equal(typesPackageOf("pg"), "@types/pg");
  assert.equal(typesPackageOf("@scope/lib"), "@types/scope__lib");
});

test("npm fetches each set of packages once, scripts off and from the public registry, and a failure is reported, not thrown", async () => {
  const root = await mkdtemp(join(tmpdir(), "package-types-"));
  const bin = await mkdtemp(join(tmpdir(), "fake-npm-"));
  const path = process.env["PATH"];
  try {
    // An npm that records its arguments and installs each dependency, or
    // fails for a package named `broken`.
    await writeFile(
      join(bin, "npm"),
      `#!/bin/sh\nexec node -e '
const fs = require("node:fs");
const deps = JSON.parse(fs.readFileSync("package.json", "utf8")).dependencies;
fs.appendFileSync(${JSON.stringify(join(bin, "calls"))}, JSON.stringify({ args: process.argv.slice(1), home: process.env.HOME, deps }) + "\\n");
if ("broken" in deps) { console.error("E404 broken"); process.exit(1); }
for (const name of Object.keys(deps)) {
  fs.mkdirSync("node_modules/" + name, { recursive: true });
  fs.writeFileSync("node_modules/" + name + "/package.json", JSON.stringify({ name, version: "9.9.9" }));
}' -- "$@"\n`,
    );
    await chmod(join(bin, "npm"), 0o755);
    process.env["PATH"] = `${bin}${delimiter}${path ?? ""}`;
    const fetch = npmPackageTypes({ root });
    const signal = new AbortController().signal;
    const requests = [
      { name: "zod", spec: "4.6.5" },
      { name: "@types/pg", spec: "^8.0.0" },
    ];
    const first = await fetch(requests, signal);
    assert.ok(!("failed" in first));
    assert.deepEqual(first.packages, [
      { name: "@types/pg", version: "9.9.9" },
      { name: "zod", version: "9.9.9" },
    ]);
    assert.ok(existsSync(join(first.directory, "node_modules/zod")));
    // The same set again, in another order, is the same directory, unfetched.
    const again = await fetch([...requests].reverse(), signal);
    assert.ok(!("failed" in again));
    assert.equal(again.directory, first.directory);
    const calls = (await readFile(join(bin, "calls"), "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            args: string[];
            home: string;
            deps: Record<string, string>;
          },
      );
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.deepEqual(call?.deps, { "@types/pg": "^8.0.0", zod: "4.6.5" });
    assert.equal(call?.home, root);
    for (const flag of [
      "install",
      "--ignore-scripts",
      `--registry=${PUBLIC_REGISTRY}`,
    ])
      assert.ok(call?.args.includes(flag), flag);
    // A failed fetch says why and leaves nothing half-installed behind.
    const failed = await fetch([{ name: "broken", spec: "1.0.0" }], signal);
    assert.ok("failed" in failed);
    assert.deepEqual(
      (await readdir(root)).filter((name) => !name.startsWith(".")),
      [first.directory.slice(root.length + 1)],
    );
    // An aborted slice stops rather than going on untyped.
    const aborted = new AbortController();
    aborted.abort(new Error("stopped"));
    await assert.rejects(
      fetch([{ name: "other", spec: "1.0.0" }], aborted.signal),
    );
  } finally {
    process.env["PATH"] = path;
    await rm(root, { recursive: true, force: true });
    await rm(bin, { recursive: true, force: true });
  }
});
