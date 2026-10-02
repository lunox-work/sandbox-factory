import assert from "node:assert/strict";
import { test } from "node:test";

import {
  dominantExtensions,
  extensionOf,
  isTestFile,
  moduleOf,
  modulesFor,
  NO_EXTENSION,
  normalizePath,
  PATH_LIST_MAX,
  ROOT_MODULE,
  TREE_FACTS_VERSION,
  treeFacts,
  type TreeEntry,
} from "../src/index.js";

const entries = (paths: readonly string[], size = 10): TreeEntry[] =>
  paths.map((path) => ({ path, size }));

const MONOREPO = entries([
  "package.json",
  "package-lock.json",
  "README.md",
  "apps/api/src/server.ts",
  "apps/api/src/routes.ts",
  "apps/api/test/routes.test.ts",
  "apps/web/src/App.tsx",
  "apps/web/src/App.test.tsx",
  "packages/db/src/store.ts",
  "packages/db/drizzle/0001_init.sql",
  "packages/db/migrations/0002.sql",
  "packages/core/src/index.ts",
  "infra/main.tf",
  "infra/modules/vpc/main.tf",
  ".github/workflows/ci.yml",
  "docs/architecture.md",
]);

test("module detection: grouped roots by child, others by first segment", () => {
  assert.equal(moduleOf("packages/db/src/x.ts"), "packages/db");
  assert.equal(moduleOf("apps/web/index.html"), "apps/web");
  assert.equal(moduleOf("services/billing/main.go"), "services/billing");
  assert.equal(moduleOf("src/api/handler.ts"), "src/api");
  assert.equal(moduleOf("lib/util/x.rb"), "lib/util");
  // A file directly in a root belongs to the root.
  assert.equal(moduleOf("src/main.ts"), "src");
  assert.equal(moduleOf("packages/README.md"), "packages");
  assert.equal(moduleOf("docs/guide/intro.md"), "docs");
  assert.equal(moduleOf("README.md"), ROOT_MODULE);
  assert.equal(moduleOf("./src/main.ts"), "src");
});

test("normalizePath strips leading and trailing slashes", () => {
  assert.equal(normalizePath(" ./packages/db/ "), "packages/db");
  assert.equal(normalizePath("/src"), "src");
  assert.equal(normalizePath("src//"), "src");
  assert.equal(normalizePath("///"), "");
  assert.equal(normalizePath(""), "");
  // Inner slashes are kept, and a long run of them stays linear to scan.
  const inner = `a${"/".repeat(20_000)}b`;
  assert.equal(normalizePath(inner), inner);
});

test("extensions: lower-cased, hidden files and bare names have none", () => {
  assert.equal(extensionOf("src/App.TSX"), "tsx");
  assert.equal(extensionOf(".gitignore"), NO_EXTENSION);
  assert.equal(extensionOf("Dockerfile"), NO_EXTENSION);
  assert.equal(extensionOf("config/.eslintrc.json"), "json");
  assert.equal(extensionOf("weird."), NO_EXTENSION);
});

test("test files by name or by directory", () => {
  assert.equal(isTestFile("src/a.test.ts"), true);
  assert.equal(isTestFile("src/a.spec.js"), true);
  assert.equal(isTestFile("src/__tests__/a.ts"), true);
  assert.equal(isTestFile("apps/api/test/helpers.ts"), true);
  assert.equal(isTestFile("tests/conftest.py"), true);
  assert.equal(isTestFile("src/testing.ts"), false);
  assert.equal(isTestFile("test.ts"), false);
});

test("a monorepo: modules, tests, lockfiles, migrations and infra", () => {
  const facts = treeFacts(MONOREPO);
  assert.equal(facts.version, TREE_FACTS_VERSION);
  assert.equal(facts.fileCount, MONOREPO.length);
  assert.equal(facts.totalBytes, MONOREPO.length * 10);
  assert.equal(facts.truncated, false);
  assert.equal(facts.testFiles, 2);
  assert.deepEqual(
    facts.modules.map(({ path, files }) => [path, files]),
    [
      [".", 3],
      [".github", 1],
      ["apps/api", 3],
      ["apps/web", 2],
      ["docs", 1],
      ["infra", 2],
      ["packages/core", 1],
      ["packages/db", 3],
    ],
  );
  const api = facts.modules.find(({ path }) => path === "apps/api");
  assert.deepEqual(api, {
    path: "apps/api",
    files: 3,
    bytes: 30,
    testFiles: 1,
    extensions: { ts: 3 },
  });
  assert.deepEqual(facts.lockfiles, ["package-lock.json"]);
  assert.deepEqual(facts.migrationDirectories, ["packages/db/migrations"]);
  // `infra/modules/vpc` holds Terraform but sits inside `infra`.
  assert.deepEqual(facts.infraDirectories, [".github/workflows", "infra"]);
  assert.deepEqual(Object.keys(facts.extensions), [
    "json",
    "md",
    "sql",
    "tf",
    "ts",
    "tsx",
    "yml",
  ]);
});

test("a flat repository is one module per top-level directory", () => {
  const facts = treeFacts(
    entries([
      "main.py",
      "setup.py",
      "poetry.lock",
      "app/models.py",
      "app/views.py",
      "app/migrations/0001_initial.py",
      "deploy/terraform/main.tf",
    ]),
  );
  assert.deepEqual(
    facts.modules.map(({ path }) => path),
    [".", "app", "deploy"],
  );
  assert.deepEqual(facts.lockfiles, ["poetry.lock"]);
  assert.deepEqual(facts.migrationDirectories, ["app/migrations"]);
  assert.deepEqual(facts.infraDirectories, ["deploy"]);
});

test("a repository with only top-level files has one module", () => {
  const facts = treeFacts(entries(["README.md", "index.js", "LICENSE"]));
  assert.deepEqual(
    facts.modules.map(({ path, files }) => [path, files]),
    [[".", 3]],
  );
  assert.deepEqual(facts.extensions, { [NO_EXTENSION]: 1, js: 1, md: 1 });
  assert.deepEqual(facts.lockfiles, []);
});

test("truncated input is flagged and still described", () => {
  const facts = treeFacts(entries(["a/x.ts"]), { truncated: true });
  assert.equal(facts.truncated, true);
  assert.equal(facts.fileCount, 1);
});

test("facts are the same whatever order the entries arrive in", () => {
  const reversed = [...MONOREPO].reverse();
  const shuffled = [...MONOREPO].sort((a, b) =>
    a.path.length === b.path.length
      ? b.path.localeCompare(a.path)
      : a.path.length - b.path.length,
  );
  const expected = JSON.stringify(treeFacts(MONOREPO));
  assert.equal(JSON.stringify(treeFacts(reversed)), expected);
  assert.equal(JSON.stringify(treeFacts(shuffled)), expected);
});

test("odd sizes count as zero and empty paths are skipped", () => {
  const facts = treeFacts([
    { path: "", size: 5 },
    { path: "a/b.ts", size: Number.NaN },
    { path: "a/c.ts", size: -3 },
    { path: "a/d.ts", size: 7 },
  ]);
  assert.equal(facts.fileCount, 3);
  assert.equal(facts.totalBytes, 7);
});

test("path lists are capped", () => {
  const many = Array.from(
    { length: PATH_LIST_MAX + 5 },
    (_, index) => `pkg${String(index).padStart(3, "0")}/yarn.lock`,
  );
  assert.equal(treeFacts(entries(many)).lockfiles.length, PATH_LIST_MAX);
});

test("modulesFor maps files and directories to the modules they touch", () => {
  const facts = treeFacts(MONOREPO);
  assert.deepEqual(
    modulesFor(facts, [
      "apps/api/src/server.ts",
      "./packages/db/",
      "packages/db/src/store.ts",
      "nowhere/at/all.ts",
      "",
    ]),
    ["apps/api", "packages/db"],
  );
  // A directory holding modules touches each of them.
  assert.deepEqual(modulesFor(facts, ["packages"]), [
    "packages/core",
    "packages/db",
  ]);
  // A root file touches the root module; a directory does not.
  assert.deepEqual(modulesFor(facts, ["README.md"]), [ROOT_MODULE]);
  assert.deepEqual(modulesFor(facts, ["docs"]), ["docs"]);
});

test("dominantExtensions: most files first, ties by name", () => {
  assert.deepEqual(
    dominantExtensions({ extensions: { ts: 3, md: 1, css: 3, json: 2 } }, 3),
    ["css", "ts", "json"],
  );
  assert.deepEqual(dominantExtensions({ extensions: { ts: 1 } }, 0), []);
});

test("modulesFor assigns a file to its most specific module", () => {
  const facts = treeFacts(entries(["src/main.ts", "src/api/handler.ts"]));
  assert.deepEqual(modulesFor(facts, ["src/api/handler.ts"]), ["src/api"]);
  assert.deepEqual(modulesFor(facts, ["src/main.ts"]), ["src"]);
  assert.deepEqual(modulesFor(facts, ["src"]), ["src", "src/api"]);
  assert.deepEqual(modulesFor(facts, ["src/api"]), ["src/api"]);
});
