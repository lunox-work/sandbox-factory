import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GRADING_COMMANDS,
  PLATFORM_LAYOUT,
  SANDBOX_IMPORT_TOOL_VERSION,
  gradingTree,
  hiddenArtifactPath,
  hiddenTestPath,
  isSandboxBuildParams,
  isSandboxImportParams,
  layoutOf,
  layoutTestArgv,
  pathProblem,
  privateTestArgv,
  publicVocabularyLeaks,
  readsSource,
  slotOf,
  snapshotFits,
  taskCodeProblems,
  testRunnerOf,
  toolOfParams,
  toolVersionOf,
  uploadObjectKey,
} from "../src/index.js";
import type { GeneratedFile, GradingLayout } from "../src/index.js";

/** A carveout folder's layout, as `folderLayout` writes it. */
const CARVEOUT: GradingLayout = {
  harnessDir: "carveout",
  mocksDir: "carveout/packages",
  mockRuntimePath: "carveout/mock.js",
  envFile: "carveout.env",
  harnessRoots: ["carveout", "node_modules"],
  configFiles: {
    "package.json": "package.json is the folder's.",
    "carveout.json": "carveout.json is the folder's record of the cut.",
    "sandbox-task.json": "sandbox-task.json is the version's.",
  },
  commands: [
    { name: "install", argv: ["npm", "ci", "--ignore-scripts"] },
    {
      name: "build",
      argv: ["node", "node_modules/typescript/bin/tsc", "-p", "tsconfig.json"],
    },
    { name: "public-tests", argv: ["node", "carveout/test.js"] },
  ],
  tests: {
    publicDir: null,
    privateDir: null,
    files: ["apps/shop/src/cart.test.ts"],
    run: {
      "node:test": {
        argv: [
          "node",
          "--env-file=carveout.env",
          "--import=./carveout/assets.js",
          "--test",
          "--test-reporter=tap",
        ],
        emitted: true,
      },
      vitest: {
        argv: ["node_modules/.bin/vitest", "run", "--reporter=tap"],
        emitted: false,
      },
    },
  },
};

const file = (
  path: string,
  text: string,
  cls: GeneratedFile["class"] = "source",
): GeneratedFile => ({
  path,
  text,
  class: cls,
  public: cls !== "test-private",
});

test("the platform's layout is what grading always ran: its commands and its hidden-test command", () => {
  assert.equal(GRADING_COMMANDS, PLATFORM_LAYOUT.commands);
  assert.deepEqual(
    layoutTestArgv(PLATFORM_LAYOUT, "tests/private/fix.test.ts"),
    privateTestArgv("tests/private/fix.test.ts"),
  );
  assert.equal(
    layoutTestArgv(PLATFORM_LAYOUT, "tests/private/fix.test.ts", "vitest"),
    null,
  );
  assert.equal(layoutOf({}), PLATFORM_LAYOUT);
  assert.equal(layoutOf({ layout: CARVEOUT }), CARVEOUT);
  assert.equal(
    hiddenTestPath(PLATFORM_LAYOUT, "s1-a.test.ts"),
    "tests/private/s1-a.test.ts",
  );
  assert.equal(
    hiddenArtifactPath(PLATFORM_LAYOUT, "tests/private/s1-a.test.ts"),
    "private/s1-a.test.ts",
  );
});

test("a carveout layout stages hidden tests at their own paths and runs each by the runner it imports", () => {
  assert.equal(
    hiddenTestPath(CARVEOUT, "apps/shop/src/cart.accept.test.ts"),
    "apps/shop/src/cart.accept.test.ts",
  );
  assert.equal(
    hiddenArtifactPath(CARVEOUT, "apps/shop/src/cart.accept.test.ts"),
    "private/apps/shop/src/cart.accept.test.ts",
  );
  assert.deepEqual(
    layoutTestArgv(CARVEOUT, "apps/shop/src/cart.accept.test.ts"),
    [
      "node",
      "--env-file=carveout.env",
      "--import=./carveout/assets.js",
      "--test",
      "--test-reporter=tap",
      "apps/shop/src/cart.accept.test.js",
    ],
  );
  assert.deepEqual(
    layoutTestArgv(CARVEOUT, "apps/x.test.ts", "vitest")?.at(-1),
    "apps/x.test.ts",
  );
  assert.equal(testRunnerOf('import { test } from "vitest";'), "vitest");
  assert.equal(testRunnerOf('import { test } from "node:test";'), "node:test");
});

test("grading on a carveout layout keeps its harness, configuration, tests and record the version's", () => {
  const versionFiles = [
    file("apps/shop/src/cart.ts", "export const a = 1;\n"),
    file("apps/shop/src/cart.test.ts", "test\n", "test-public"),
    file("apps/shop/src/cart.accept.test.ts", "hidden\n", "test-private"),
    file("carveout/mock.js", "mock\n", "harness"),
    file("carveout.json", "{}\n", "config"),
    file("package.json", "{}\n", "config"),
  ];
  const graded = (submission: { path: string; text: string }[]) =>
    gradingTree({
      versionFiles,
      editablePaths: ["apps/shop/src/cart.ts"],
      submission,
      layout: CARVEOUT,
    });
  const ok = graded([
    { path: "apps/shop/src/cart.ts", text: "export const a = 2;\n" },
    { path: "apps/shop/src/helper.ts", text: "export const h = 1;\n" },
  ]);
  assert.deepEqual(ok.refused, []);
  assert.deepEqual(ok.changed, [
    "apps/shop/src/cart.ts",
    "apps/shop/src/helper.ts",
  ]);
  const refused = graded([
    { path: "carveout.json", text: '{"x":1}\n' },
    { path: "carveout/run.ts", text: "x\n" },
    { path: "apps/shop/src/cart.accept.test.ts", text: "passes\n" },
    { path: "apps/shop/src/cart.test.ts", text: "weakened\n" },
    { path: "sandbox-task.json", text: "{}\n" },
  ]);
  assert.deepEqual(
    refused.refused.map((item) => item.path),
    [
      "apps/shop/src/cart.accept.test.ts",
      "apps/shop/src/cart.test.ts",
      "carveout.json",
      "carveout/run.ts",
      "sandbox-task.json",
    ],
  );
  assert.match(
    refused.refused.find((item) => item.path === "carveout.json")?.reason ?? "",
    /record of the cut/,
  );
  assert.match(
    refused.refused.find((item) => item.path === "carveout/run.ts")?.reason ??
      "",
    /carveout\/ is the version's harness/,
  );
  // The platform's own directories are task directories in a carveout folder.
  assert.deepEqual(
    gradingTree({
      versionFiles: [
        ...versionFiles,
        file("tests/x.ts", "export const x = 1;\n"),
      ],
      editablePaths: ["tests/x.ts"],
      submission: [{ path: "tests/x.ts", text: "export const x = 2;\n" }],
      layout: CARVEOUT,
    }).refused,
    [],
  );
});

test("task code may not reach a layout's mock runtime or harness", () => {
  assert.deepEqual(
    taskCodeProblems(
      "apps/shop/src/cart.ts",
      'import { x } from "../../../carveout/mock.js";\n',
      CARVEOUT,
    ),
    [
      "../../../carveout/mock.js reaches the mock runtime; task code imports only task code, stubs and packages.",
    ],
  );
  assert.deepEqual(
    taskCodeProblems(
      "apps/shop/src/cart.ts",
      'import { x } from "../../../carveout/packages/stripe/index.js";\n',
      CARVEOUT,
    ),
    [
      "../../../carveout/packages/stripe/index.js reaches the harness; task code imports only task code, stubs and packages.",
    ],
  );
  // The platform's harness directory is nobody's in a carveout folder.
  assert.deepEqual(
    taskCodeProblems(
      "src/a.ts",
      'import { x } from "../sandbox/mock.js";\n',
      CARVEOUT,
    ),
    [],
  );
  assert.equal(
    taskCodeProblems("src/a.ts", 'import { x } from "../sandbox/mock.js";\n')
      .length,
    1,
  );
});

test("pathProblem is the grading tree's path rule", () => {
  assert.equal(pathProblem("src/a.ts"), null);
  assert.match(pathProblem("") ?? "", /empty/);
  assert.match(pathProblem("/etc/passwd") ?? "", /absolute/);
  assert.match(pathProblem("a\\b") ?? "", /backslash/);
  assert.match(pathProblem("a/../b") ?? "", /segment/);
});

test("sandbox_import: an upload's run reads no source, calls no model and names its version and upload", () => {
  const params = {
    deadlineMinutes: 60,
    importer: "upload" as const,
    sandboxVersionId: "sbv_1",
    uploadSha256: "a".repeat(64),
    recordSha256: "b".repeat(64),
    carveoutVersion: "0.4.0",
  };
  assert.equal(isSandboxImportParams(params), true);
  assert.equal(isSandboxBuildParams(params), false);
  assert.equal(toolOfParams(params), "sandbox_import");
  assert.equal(toolVersionOf("sandbox_import"), SANDBOX_IMPORT_TOOL_VERSION);
  assert.equal(readsSource("sandbox_import"), false);
  assert.equal(snapshotFits("sandbox_import", false), true);
  assert.equal(snapshotFits("sandbox_import", true), false);
  assert.equal(slotOf("sandbox_import"), "agent");
  assert.equal(
    uploadObjectKey("org_1", "sbv_1", "c".repeat(64)),
    `uploads/org_1/sbv_1/${"c".repeat(64)}.json`,
  );
});

test("publicVocabularyLeaks blocks on either scan's leaks", () => {
  const leaks = publicVocabularyLeaks(
    [
      { path: "src/a.ts", text: "// acme widgets\n" },
      { path: "acme/b.ts", text: "x\n" },
    ],
    ["acme"],
  );
  assert.deepEqual(
    leaks.map((leak) => leak.term),
    ["acme"],
  );
  assert.deepEqual([...(leaks[0]?.files ?? [])].sort(), [
    "acme/b.ts",
    "src/a.ts",
  ]);
  assert.deepEqual(
    publicVocabularyLeaks([{ path: "src/a.ts", text: "x\n" }], ["acme"]),
    [],
  );
});
