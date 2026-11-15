import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CARRIED_TEST_LIMITS,
  CARRIED_TESTS_DIR,
  PLATFORM_LAYOUT,
  PUBLIC_TESTS_DIR,
  SANDBOX_RUN_ARGV,
  buildSummary,
  carriedTestCandidates,
  carriedTestFile,
  carriedTestPaths,
  generateProject,
  gradingTree,
  reversedCarriedTest,
} from "../src/index.js";
import type {
  BoundaryContract,
  CarriedTestCandidate,
  GeneratedFile,
  SandboxBuildManifest,
  SliceManifest,
} from "../src/index.js";

type Manifest = Pick<SliceManifest, "cuts" | "included">;

const edge = (from: string, to: string, specifier: string) => ({
  from,
  to,
  relation: "imports",
  specifier,
  location: "L1",
  targetSymbol: null,
});

/** A slice of `src/fees/fee.ts`, its ledger cut to a stub, and the tests the walk saw import it. */
const manifest = {
  included: [{ path: "src/fees/fee.ts" }, { path: "src/fees/fee.test.ts" }],
  cuts: {
    outbound: [edge("src/fees/fee.ts", "src/ledger.ts", "../ledger.js")],
    inbound: [
      edge("test/fee.test.ts", "src/fees/fee.ts", "../src/fees/fee.js"),
      edge("test/alias.test.ts", "src/fees/fee.ts", "@fees/fee"),
      edge("test/vitest.test.ts", "src/fees/fee.ts", "../src/fees/fee.js"),
      edge("test/jest.test.ts", "src/fees/fee.ts", "../src/fees/fee.js"),
      edge("test/plain.test.js", "src/fees/fee.ts", "../src/fees/fee.js"),
      edge("test/fee.spec.ts", "src/fees/fee.ts", "../src/fees/fee.js"),
      edge("test/helper.test.ts", "src/fees/fee.ts", "../src/fees/fee.js"),
      edge("test/package.test.ts", "src/fees/fee.ts", "../src/fees/fee.js"),
      edge("test/gone.test.ts", "src/fees/fee.ts", "../src/fees/fee.js"),
      // Not a test: a consumer of the slice.
      edge("src/cli.ts", "src/fees/fee.ts", "./fees/fee.js"),
      // A test the slice itself holds.
      edge("src/fees/fee.test.ts", "src/fees/fee.ts", "./fee.js"),
      // Twice from one test: listed once.
      edge("test/fee.test.ts", "src/fees/fee.ts", "../src/fees/fee.js"),
    ],
  },
} as unknown as Manifest;
const contract = {
  outbound: [
    { module: "src/ledger.ts", symbols: [], importedBy: [], stubPath: "x" },
    { module: "src/unstubbed.ts", symbols: [], importedBy: [], stubPath: null },
  ],
} as unknown as Pick<BoundaryContract, "outbound">;

const NODE = 'import { test } from "node:test";\n';
const texts = new Map([
  [
    "test/fee.test.ts",
    `${NODE}import assert from "node:assert/strict";\nimport { fee } from "../src/fees/fee.js";\nimport type { Entry } from "../src/ledger.js";\nimport { z } from "zod";\n// import { gone } from "../src/elsewhere.js";\ntest("fee", () => assert.equal(fee(), 1));\n`,
  ],
  [
    "test/alias.test.ts",
    `${NODE}import { fee } from "@fees/fee";\ntest("fee", () => fee());\n`,
  ],
  [
    "test/vitest.test.ts",
    'import { it } from "vitest";\nimport { fee } from "../src/fees/fee.js";\nit("fee", () => fee());\n',
  ],
  [
    "test/jest.test.ts",
    'import { fee } from "../src/fees/fee.js";\ndescribe("fee", () => it("is", () => expect(fee()).toBe(1)));\n',
  ],
  ["test/plain.test.js", `${NODE}import { fee } from "../src/fees/fee.js";\n`],
  ["test/fee.spec.ts", `${NODE}import { fee } from "../src/fees/fee.js";\n`],
  [
    "test/helper.test.ts",
    `${NODE}import { fee } from "../src/fees/fee.js";\nimport { make } from "./helpers.js";\nimport { half } from "../src/unstubbed.js";\n`,
  ],
  [
    "test/package.test.ts",
    `${NODE}import { fee } from "../src/fees/fee.js";\nimport request from "supertest";\n`,
  ],
]);
const installs = (specifier: string) => specifier === "zod";

test("the tests to carry are the walk's test files importing the slice, not in it", () => {
  assert.deepEqual(carriedTestPaths(manifest), [
    "test/alias.test.ts",
    "test/fee.spec.ts",
    "test/fee.test.ts",
    "test/gone.test.ts",
    "test/helper.test.ts",
    "test/jest.test.ts",
    "test/package.test.ts",
    "test/plain.test.js",
    "test/vitest.test.ts",
  ]);
});

test("only a node:test TypeScript test whose imports the project holds is a candidate; the rest say why", () => {
  const { candidates, dropped } = carriedTestCandidates({
    manifest,
    contract,
    texts,
    installs,
    limits: CARRIED_TEST_LIMITS,
  });
  assert.deepEqual(
    candidates.map((candidate) => [candidate.from, candidate.imports]),
    [
      [
        "test/alias.test.ts",
        [
          { specifier: "node:test", target: null },
          { specifier: "@fees/fee", target: "src/fees/fee.ts" },
        ],
      ],
      [
        "test/fee.test.ts",
        [
          { specifier: "node:test", target: null },
          { specifier: "node:assert/strict", target: null },
          { specifier: "../src/fees/fee.js", target: "src/fees/fee.ts" },
          // A cut module's stub, resolved from the specifier alone.
          { specifier: "../src/ledger.js", target: "src/ledger.ts" },
          { specifier: "zod", target: null },
        ],
      ],
    ],
  );
  assert.deepEqual(
    dropped.map(({ from, reason }) => [from, reason]),
    [
      ["test/fee.spec.ts", "language"],
      ["test/gone.test.ts", "unreadable"],
      ["test/helper.test.ts", "outside_slice"],
      ["test/jest.test.ts", "runner"],
      ["test/package.test.ts", "package_missing"],
      ["test/plain.test.js", "language"],
      ["test/vitest.test.ts", "runner"],
    ],
  );
  const why = new Map(dropped.map(({ from, detail }) => [from, detail]));
  assert.match(why.get("test/vitest.test.ts") ?? "", /Vitest/);
  assert.match(why.get("test/jest.test.ts") ?? "", /Jest/);
  assert.match(why.get("test/helper.test.ts") ?? "", /\.\/helpers\.js/);
  assert.match(why.get("test/package.test.ts") ?? "", /supertest/);
});

test("the slice's limits take candidates in path order, by count and by bytes", () => {
  const byCount = carriedTestCandidates({
    manifest,
    contract,
    texts,
    installs,
    limits: { maxFiles: 1, maxBytes: 1_000_000 },
  });
  assert.deepEqual(
    byCount.candidates.map((candidate) => candidate.from),
    ["test/alias.test.ts"],
  );
  assert.deepEqual(
    byCount.dropped
      .filter(({ reason }) => reason === "limit")
      .map(({ from }) => from),
    ["test/fee.test.ts"],
  );
  const bytes = new TextEncoder().encode(
    texts.get("test/alias.test.ts") ?? "",
  ).length;
  const byBytes = carriedTestCandidates({
    manifest,
    contract,
    texts,
    installs,
    limits: { maxFiles: 10, maxBytes: bytes },
  });
  assert.deepEqual(
    byBytes.candidates.map((candidate) => candidate.from),
    ["test/alias.test.ts"],
  );
  assert.match(
    byBytes.dropped.find(({ reason }) => reason === "limit")?.detail ?? "",
    /limit of 10 carried test\(s\)/,
  );
});

const candidate: CarriedTestCandidate = {
  from: "test/acme/fee.test.ts",
  text: "",
  imports: [
    { specifier: "node:test", target: null },
    { specifier: "../../src/acme/fee.js", target: "src/acme/fee.ts" },
    { specifier: "../../src/ledger.js", target: "src/ledger.ts" },
    { specifier: "acme-sdk/client", target: null },
  ],
};
const renamedText = [
  'import { test } from "node:test";',
  'import { fee } from "../../src/acme/fee.js";',
  'import type { Entry } from "../../src/ledger.js";',
  'import { client } from "acme-sdk/client";',
  '// a comment\'s import "../nowhere.js" is not one',
  'test("fee", () => fee(process.env.ACME_KEY));',
  "",
].join("\n");

test("a carried test sits under tests/public/carried, its imports pointed at the project's files", () => {
  const made = carriedTestFile({
    candidate,
    renamed: { path: "test/northwind/fee.test.ts", text: renamedText },
    projectPathOf: (path) =>
      ({
        "src/acme/fee.ts": "src/northwind/fee.ts",
        "src/ledger.ts": "src/ledger.ts",
      })[path] ?? null,
    packageName: (specifier) => specifier.replace("acme-sdk", "pay-sdk"),
    environment: new Map([["ACME_KEY", "PAY_KEY"]]),
  });
  assert.ok(!("reason" in made));
  assert.equal(made.path, "tests/public/carried/test/northwind/fee.test.ts");
  assert.equal(
    made.text,
    [
      'import { test } from "node:test";',
      'import { fee } from "../../../../../src/northwind/fee.js";',
      'import type { Entry } from "../../../../../src/ledger.js";',
      'import { client } from "pay-sdk/client";',
      '// a comment\'s import "../nowhere.js" is not one',
      'test("fee", () => fee(process.env.PAY_KEY));',
      "",
    ].join("\n"),
  );
});

test("a carried test the table broke, or whose target the project lacks, is dropped", () => {
  const base = {
    candidate,
    projectPathOf: (path: string) => path,
    packageName: (specifier: string) => specifier,
    environment: new Map<string, string>(),
  };
  const fewer = carriedTestFile({
    ...base,
    renamed: {
      path: "test/acme/fee.test.ts",
      text: 'import { test } from "node:test";\n',
    },
  });
  assert.ok("reason" in fewer && fewer.reason === "alias_failed");
  const renamedAway = carriedTestFile({
    ...base,
    renamed: { path: "test/acme/fee.check.ts", text: renamedText },
  });
  assert.ok("reason" in renamedAway && renamedAway.reason === "alias_failed");
  const missing = carriedTestFile({
    ...base,
    renamed: { path: "test/acme/fee.test.ts", text: renamedText },
    projectPathOf: (path) => (path === "src/ledger.ts" ? null : path),
  });
  assert.ok("reason" in missing && missing.reason === "outside_slice");
  assert.match(missing.detail, /src\/ledger\.ts/);
});

test("in the repository's names, a carried test's imports follow their targets back", () => {
  const publicText = [
    'import { test } from "node:test";',
    'import { fee } from "../../../../../src/northwind/fee.js";',
    'import { entry } from "../../../../../src/ledger.js";',
    'import { gone } from "../../../../../src/gone.js";',
    'test("fee", () => fee(entry));',
    "",
  ].join("\n");
  // The table's inverse renamed words; the paths moved apart from it.
  const reversedText = publicText.replaceAll("northwind", "acme");
  const reversedPaths = new Map([
    ["src/northwind/fee.ts", "src/acme/billing/fee.ts"],
    ["src/ledger.js", "src/ledger.js"],
  ]);
  const text = reversedCarriedTest({
    publicPath: "tests/public/carried/test/northwind/fee.test.ts",
    publicText,
    reversedPath: "tests/public/carried/test/acme/fee.test.ts",
    reversedText,
    holds: (path) => reversedPaths.has(path),
    reversedOf: (path) => reversedPaths.get(path) ?? null,
  });
  assert.equal(
    text,
    [
      'import { test } from "node:test";',
      'import { fee } from "../../../../../src/acme/billing/fee.js";',
      'import { entry } from "../../../../../src/ledger.js";',
      // A target the version does not hold keeps the inverse's text.
      'import { gone } from "../../../../../src/gone.js";',
      'test("fee", () => fee(entry));',
      "",
    ].join("\n"),
  );
  // Imports that no longer line up leave the inverse's text alone.
  assert.equal(
    reversedCarriedTest({
      publicPath: "tests/public/carried/a.test.ts",
      publicText,
      reversedPath: "tests/public/carried/a.test.ts",
      reversedText: "test();\n",
      holds: () => true,
      reversedOf: () => null,
    }),
    "test();\n",
  );
});

test("carried tests are public tests of the project, listed with the generated ones; another path is a blocker", () => {
  const project = generateProject({
    version: {
      sandboxId: "sbx_1",
      versionId: "sbv_1",
      version: 1,
      title: "Fix the fee",
      specSummary: "Charge it.",
      complexity: "S",
      tags: [],
    },
    manifest: {
      ...(manifest as unknown as SliceManifest),
      entryPoints: ["src/fees/fee.ts"],
      internalImports: [],
      externals: { packages: [], environment: [] },
    } as unknown as SliceManifest,
    contract: { outbound: [], inbound: [] } as unknown as BoundaryContract,
    sources: [
      {
        originalPath: "src/fees/fee.ts",
        path: "src/fees/fee.ts",
        text: "export const fee = () => 1;\n",
      },
    ],
    stubs: [],
    spec: null,
    dependencies: [],
    acceptanceTests: [],
    knownSpecifiers: ["node:test"],
    carriedTests: [
      {
        path: "tests/public/carried/test/fee.test.ts",
        text: 'import { test } from "node:test";\ntest("fee", () => {});\n',
      },
      { path: "tests/public/extra.test.ts", text: "" },
      { path: "tests/public/carried/test/fee.spec.ts", text: "" },
      { path: "tests/public/carried/../escape.test.ts", text: "" },
    ],
  });
  const carried = project.files.find(
    (file) => file.path === "tests/public/carried/test/fee.test.ts",
  );
  assert.equal(carried?.class, "test-public");
  assert.equal(carried?.public, true);
  assert.deepEqual(project.publicTests, [
    "tests/public/interface.test.ts",
    "tests/public/spec.test.ts",
    "tests/public/carried/test/fee.test.ts",
  ]);
  assert.deepEqual(project.descriptor.publicTests, project.publicTests);
  const readme = project.files.find((file) => file.path === "README.md");
  assert.match(
    readme?.text ?? "",
    /`tests\/public\/carried\/test\/fee\.test\.ts`/,
  );
  const gitignore = project.files.find((file) => file.path === ".gitignore");
  assert.match(
    gitignore?.text ?? "",
    /tests\/public\/carried\/test\/fee\.test\.js/,
  );
  assert.deepEqual(
    project.blockers
      .filter((blocker) => blocker.code === "test_path_invalid")
      .map((blocker) => blocker.file),
    [
      "tests/public/carried/../escape.test.ts",
      "tests/public/carried/test/fee.spec.ts",
      "tests/public/extra.test.ts",
    ],
  );
});

test("a submission that edits or adds a carried test is refused, like any public test", () => {
  const file = (
    path: string,
    text: string,
    cls: GeneratedFile["class"] = "source",
  ): GeneratedFile => ({ path, text, class: cls, public: true });
  const versionFiles = [
    file("src/fees/fee.ts", "export const fee = () => 1;\n"),
    file(
      "tests/public/carried/test/fee.test.ts",
      "// carried\n",
      "test-public",
    ),
  ];
  const tree = gradingTree({
    versionFiles,
    editablePaths: ["src/fees/fee.ts"],
    submission: [
      file("src/fees/fee.ts", "export const fee = () => 2;\n"),
      file("tests/public/carried/test/fee.test.ts", "// weakened\n"),
      file("tests/public/carried/test/more.test.ts", "// added\n"),
    ],
  });
  assert.deepEqual(tree.files, []);
  assert.deepEqual(tree.refused.map(({ path }) => path).sort(), [
    "tests/public/carried/test/fee.test.ts",
    "tests/public/carried/test/more.test.ts",
  ]);
  for (const { reason } of tree.refused) assert.match(reason, /tests\//);
});

test("the build's summary counts the tests carried and dropped, and says nothing when none were asked for", () => {
  const manifestOf = (
    carriedTests: SandboxBuildManifest["carriedTests"],
  ): SandboxBuildManifest =>
    ({
      ready: true,
      files: [],
      importRewrites: [],
      toolchainDigest: "d",
      harnessSha256: "h",
      evaluator: null,
      baseline: null,
      blockers: [],
      ...(carriedTests === undefined ? {} : { carriedTests }),
    }) as unknown as SandboxBuildManifest;
  assert.equal(buildSummary(manifestOf(undefined)).carriedTests, undefined);
  assert.deepEqual(
    buildSummary(
      manifestOf({
        limits: { ...CARRIED_TEST_LIMITS, timeoutMs: 1 },
        kept: [{ path: "tests/public/carried/a.test.ts", from: "a.test.ts" }],
        dropped: [
          { from: "b.test.ts", reason: "runner", detail: "Jest." },
          { from: "c.test.ts", reason: "flaky", detail: "Twice." },
        ],
      }),
    ).carriedTests,
    { kept: 1, dropped: 2 },
  );
});

test("the platform's layout runs carried tests with the public suite and keeps them out of a submission's reach", () => {
  assert.ok(CARRIED_TESTS_DIR.startsWith(`${PUBLIC_TESTS_DIR}/`));
  // `npm test` and grading's public step: every `*.test.js` under it.
  assert.ok(SANDBOX_RUN_ARGV.test.includes(`${PUBLIC_TESTS_DIR}/**/*.test.js`));
  assert.deepEqual(
    PLATFORM_LAYOUT.commands.find(({ name }) => name === "public-tests")?.argv,
    SANDBOX_RUN_ARGV.test,
  );
  assert.equal(PLATFORM_LAYOUT.tests.publicDir, PUBLIC_TESTS_DIR);
  assert.ok(
    PLATFORM_LAYOUT.harnessRoots.includes(
      CARRIED_TESTS_DIR.split("/")[0] ?? "",
    ),
  );
});
