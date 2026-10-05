import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SPEC_TEST_PATH,
  STARTER_LIMITS,
  STARTER_TOOL_VERSION,
  aliasStarter,
  descriptorPublic,
  generateStarterProject,
  isSandboxBuildParams,
  isStarterParams,
  offNodeStack,
  readsSource,
  starterProblems,
  starterScope,
  starterStackProblem,
  starterTaskReadiness,
  toolOfParams,
  toolVersionOf,
  transformConfigOf,
} from "../src/index.js";
import type {
  ApprovedTaskPricing,
  SpecDraft,
  StarterSubmission,
} from "../src/index.js";

const starter: StarterSubmission = {
  files: [
    {
      path: "src/cart.ts",
      text: "export function total(prices: number[]): number {\n  return 0;\n}\n",
    },
    { path: "src/prices.json", text: "[1, 2]\n" },
  ],
  publicTests: [
    {
      path: "tests/public/cart.test.ts",
      text: 'import { test } from "node:test";\ntest("loads", () => {});\n',
    },
  ],
  hiddenTests: [
    {
      path: "tests/private/total.test.ts",
      text: 'import { test } from "node:test";\ntest("sums", () => {});\n',
      expectedBaseline: "fail",
    },
  ],
  packages: [
    { name: "zod", version: "3.25.76" },
    { name: "@scope/pkg", version: "1.0.0-beta.1" },
  ],
  scenario:
    'import { total } from "../src/cart.js";\nconsole.log(total([1]));\n',
  summary: "A cart module whose total is not written yet.",
  aliases: [{ before: "total", after: "sum", kind: "identifier", paths: [] }],
};

const version = {
  sandboxId: "sbx_1",
  versionId: "sbv_1",
  version: 2,
  title: "Sum a cart",
  specSummary: "The cart adds up its prices.",
  complexity: "S",
  tags: ["cart"],
};

const spec: SpecDraft = {
  feature: "Cart",
  background: ["A cart holds prices"],
  scenarios: [
    {
      id: "s1",
      kind: "happy-path" as never,
      title: "sums",
      steps: [{ keyword: "Given", text: "two prices" }],
      origin: "draft",
    },
  ],
  openQuestions: [],
  assumptions: [],
};

test("the starter tool runs without source and is told apart from a build", () => {
  const params = {
    deadlineMinutes: 30,
    agent: "starter" as const,
    sandboxVersionId: "sbv_1",
    approvedTaskSha256: "a".repeat(64),
    stack: ["TypeScript"],
  };
  assert.equal(isStarterParams(params), true);
  assert.equal(isSandboxBuildParams(params), false);
  assert.equal(toolOfParams(params), "sandbox_starter");
  assert.equal(toolVersionOf("sandbox_starter"), STARTER_TOOL_VERSION);
  assert.equal(readsSource("sandbox_starter"), false);
  assert.equal(readsSource("sandbox_build"), true);
});

test("a sliced version's transform reads as it did before starters", () => {
  const base = {
    aliasRules: [],
    dependencyChoices: {},
    acceptanceTests: [],
  };
  assert.deepEqual(Object.keys(transformConfigOf(base)).sort(), [
    "acceptanceTests",
    "aliasRules",
    "dependencyChoices",
    "fixtures",
    "schemaVersion",
  ]);
  assert.equal(
    transformConfigOf({ ...base, starterSha256: null }).fixtures,
    null,
  );
  assert.equal(
    transformConfigOf({ ...base, starterSha256: "s".repeat(64) }).starterSha256,
    "s".repeat(64),
  );
});

test("a well-formed starter has no problems, and its scope is its source", () => {
  assert.deepEqual(starterProblems(starter), []);
  assert.deepEqual(starterScope(starter), {
    editablePaths: ["src/cart.ts", "src/prices.json"],
    generatedPaths: [],
    permittedOperations: ["edit", "add"],
    dependencies: [
      {
        name: "@scope/pkg",
        kind: "package",
        version: "1.0.0-beta.1",
        resolution: "approved-package",
        detail: "Chosen for the starter.",
      },
      {
        name: "zod",
        kind: "package",
        version: "3.25.76",
        resolution: "approved-package",
        detail: "Chosen for the starter.",
      },
    ],
    blockers: [],
  });
});

test("a starter is refused for misplaced files, loose versions and tests that cannot tell done from not", () => {
  const long = "x".repeat(STARTER_LIMITS.fileChars + 1);
  const problems = starterProblems({
    files: [
      { path: "lib/app.ts", text: "" },
      { path: "src/../escape.ts", text: "" },
      { path: "src/app.js", text: "" },
      { path: "src/types.d.ts", text: "" },
      { path: "src/big.ts", text: long },
      { path: "src/big.ts", text: "" },
    ],
    publicTests: [
      { path: "tests/public/app.spec.ts", text: "" },
      { path: SPEC_TEST_PATH, text: "" },
    ],
    hiddenTests: [
      {
        path: "tests/private/app.test.tsx",
        text: "",
        expectedBaseline: "pass",
      },
    ],
    packages: [
      { name: "Not A Name", version: "1.0.0" },
      { name: "typescript", version: "5.0.0" },
      { name: "zod", version: "^3.0.0" },
      { name: "zod", version: "3.0.0" },
    ],
    scenario: " ",
    summary: "",
    aliases: [
      { before: "src/a.ts", after: "src/b.ts", kind: "path", paths: [] },
      { before: "", after: "x", kind: "identifier", paths: [] },
    ],
  });
  for (const expected of [
    /lib\/app\.ts: source files live under src\//,
    /src\/\.\.\/escape\.ts: source files live under src\//,
    /src\/app\.js: a source file is TypeScript/,
    /src\/types\.d\.ts: a source file is TypeScript/,
    /src\/big\.ts is longer than/,
    /src\/big\.ts is given twice/,
    /app\.spec\.ts: public tests live under/,
    /spec\.test\.ts is generated from the spec/,
    /app\.test\.tsx: hidden tests live under/,
    /At least one hidden test must fail/,
    /Not A Name is not an npm package name/,
    /typescript comes with the toolchain/,
    /zod@\^3\.0\.0: give an exact version/,
    /zod is listed twice/,
    /The walkthrough is empty/,
    /The summary is empty/,
    /Name 1 \(src\/a\.ts\): a starter renames identifier and text names, not paths/,
    /Name 2: Both sides of a rule must be non-empty/,
  ])
    assert.ok(
      problems.some((problem) => expected.test(problem)),
      `expected a problem matching ${expected}`,
    );
});

test("a starter is refused when it is too much", () => {
  const many = <T>(count: number, make: (index: number) => T) =>
    Array.from({ length: count }, (_, index) => make(index));
  const problems = starterProblems({
    files: many(STARTER_LIMITS.files + 1, (index) => ({
      path: `src/f${index}.ts`,
      text: "x".repeat(10_000),
    })),
    publicTests: many(STARTER_LIMITS.publicTests + 1, (index) => ({
      path: `tests/public/t${index}.test.ts`,
      text: "",
    })),
    hiddenTests: many(STARTER_LIMITS.hiddenTests + 1, (index) => ({
      path: `tests/private/t${index}.test.ts`,
      text: "",
      expectedBaseline: "fail" as const,
    })),
    packages: many(STARTER_LIMITS.packages + 1, (index) => ({
      name: `p${index}`,
      version: "1.0.0",
    })),
    scenario: "x".repeat(STARTER_LIMITS.scenarioChars + 1),
    summary: "x".repeat(STARTER_LIMITS.summaryChars + 1),
    aliases: many(STARTER_LIMITS.aliases + 1, (index) => ({
      before: `a${index}`,
      after: `b${index}`,
      kind: "identifier" as const,
      paths: [],
    })),
  });
  for (const expected of [
    /At most 60 source files/,
    /At most 20 public tests/,
    /At most 20 hidden tests/,
    /At most 25 packages/,
    /walkthrough is longer/,
    /summary is longer/,
    /in all/,
    /At most 50 names in the table/,
  ])
    assert.ok(
      problems.some((problem) => expected.test(problem)),
      `${expected}`,
    );
  assert.deepEqual(starterProblems({ ...starter, files: [] }), [
    "A starter needs at least one source file under src/.",
  ]);
  assert.match(
    starterProblems({ ...starter, aliases: [] }).join("\n"),
    /^A starter needs a name table/,
  );
});

test("a starter's name table renames its source, tests, walkthrough and spec, or says why not", () => {
  const withNames: StarterSubmission = {
    ...starter,
    hiddenTests: [
      {
        path: "tests/private/total.test.ts",
        text: 'import { total } from "../../src/cart.js";\ntotal([]);\n',
        expectedBaseline: "fail",
      },
    ],
    aliases: [
      { before: "total", after: "sum", kind: "identifier", paths: [] },
      { before: "Acme", after: "the shop", kind: "text", paths: [] },
    ],
  };
  const named: SpecDraft = {
    feature: "Acme carts add up",
    background: [],
    scenarios: [],
    openQuestions: [],
    assumptions: [],
  };
  const renamed = aliasStarter(withNames, named);
  assert.equal(renamed.ok, true);
  if (!renamed.ok) return;
  assert.equal(
    renamed.starter.files[0]?.text,
    "export function sum(prices: number[]): number {\n  return 0;\n}\n",
  );
  assert.equal(
    renamed.starter.hiddenTests[0]?.text,
    'import { sum } from "../../src/cart.js";\nsum([]);\n',
  );
  assert.equal(renamed.starter.hiddenTests[0]?.expectedBaseline, "fail");
  assert.match(renamed.starter.scenario, /console\.log\(sum\(\[1\]\)\)/);
  assert.equal(renamed.spec?.feature, "the shop carts add up");
  // The table is the one given, and paths do not move.
  assert.deepEqual(renamed.starter.aliases, withNames.aliases);
  assert.deepEqual(
    renamed.starter.files.map((file) => file.path),
    withNames.files.map((file) => file.path),
  );

  // A name that occurs nowhere hides nothing.
  assert.deepEqual(
    aliasStarter(
      {
        ...starter,
        aliases: [
          { before: "Globex", after: "Vendor", kind: "identifier", paths: [] },
        ],
      },
      null,
    ),
    {
      ok: false,
      problems: [
        "Name 1: Globex does not occur in the starter, so it renames nothing.",
      ],
    },
  );
  // A public name already in a file could not be mapped back.
  const colliding = aliasStarter(
    {
      ...starter,
      aliases: [
        { before: "total", after: "prices", kind: "identifier", paths: [] },
      ],
    },
    null,
  );
  assert.equal(colliding.ok, false);
  assert.match(
    colliding.ok ? "" : (colliding.problems[0] ?? ""),
    /^Name 1 in src\/cart\.ts: prices already occurs/,
  );
});

test("a generated version needs a title, a description and an approved proposal", () => {
  const pricing: ApprovedTaskPricing = {
    proposalId: "prp_1",
    proposalRevision: 2,
    complexity: "S",
    amountMinor: 5_800,
    currency: "USD",
    status: "approved",
    decidedAt: "2026-10-06T00:00:00.000Z",
  };
  assert.deepEqual(
    starterTaskReadiness({ title: "T", summary: "S", pricing }),
    { ready: true, reasons: [] },
  );
  assert.deepEqual(
    starterTaskReadiness({ title: " ", summary: "", pricing: null }).reasons,
    [
      "The bounty has no proposal; size and approve it first.",
      "The bounty has no title.",
      "The bounty has no description to follow.",
    ],
  );
  // A proposal still proposed is a draft, which blocks generation.
  assert.deepEqual(
    starterTaskReadiness({
      title: "T",
      summary: "S",
      pricing: { ...pricing, status: "proposed", decidedAt: null },
    }).reasons,
    ["The bounty's proposal is a draft; approve it first."],
  );
});

test("a stack only another runtime runs rules out a starter", () => {
  assert.deepEqual(offNodeStack(["Python", "Django", "PostgreSQL", "React"]), [
    "Python",
    "Django",
  ]);
  assert.deepEqual(offNodeStack(["Tailwind CSS", "Unknown Thing"]), []);
  assert.equal(starterStackProblem([]), null);
  assert.equal(starterStackProblem(["PostgreSQL", "Redis"]), null);
  assert.equal(starterStackProblem(["TypeScript", "Python"]), null);
  assert.equal(starterStackProblem(["Node.js", "Go"]), null);
  assert.equal(
    starterStackProblem(["Python", "PostgreSQL"]),
    "A starter runs on Node.js and TypeScript; this bounty's stack names Python.",
  );
});

test("a starter becomes a standalone project with its tests and config", () => {
  const project = generateStarterProject({
    version,
    starter,
    acceptanceTests: starter.hiddenTests,
    spec,
  });
  assert.deepEqual(project.blockers, []);
  assert.deepEqual(
    project.files.map((file) => [file.path, file.class, file.public]),
    [
      [".gitignore", "config", true],
      [".npmrc", "config", true],
      [".nvmrc", "config", true],
      ["README.md", "config", true],
      ["package.json", "config", true],
      ["sandbox-task.json", "descriptor", true],
      ["sandbox.env", "config", true],
      ["sandbox/ambient.d.ts", "harness", true],
      ["sandbox/run.ts", "harness", true],
      ["src/cart.ts", "source", true],
      ["src/prices.json", "source", true],
      ["tests/private/total.test.ts", "test-private", false],
      ["tests/public/cart.test.ts", "test-public", true],
      ["tests/public/spec.test.ts", "test-public", true],
      ["tsconfig.json", "config", true],
    ],
  );
  const text = (path: string) =>
    project.files.find((file) => file.path === path)?.text ?? "";
  const pkg = JSON.parse(text("package.json")) as {
    dependencies: Record<string, string>;
    scripts: Record<string, string>;
  };
  assert.deepEqual(pkg.dependencies, {
    "@scope/pkg": "1.0.0-beta.1",
    zod: "3.25.76",
  });
  assert.match(pkg.scripts.test ?? "", /tests\/public/);
  assert.match(text("sandbox/ambient.d.ts"), /declare module "zod";/);
  assert.doesNotMatch(text("sandbox/ambient.d.ts"), /namespace JSX/);
  assert.doesNotMatch(text("tsconfig.json"), /"jsx"/);
  assert.match(text("tests/public/spec.test.ts"), /s1: sums/);
  assert.match(text(".gitignore"), /src\/cart\.js/);
  assert.match(text("README.md"), /# Sum a cart/);
  assert.match(text("README.md"), /zod@3\.25\.76/);
  assert.deepEqual(project.descriptor.editablePaths, [
    "src/cart.ts",
    "src/prices.json",
  ]);
  assert.deepEqual(project.publicTests, [
    "tests/public/cart.test.ts",
    "tests/public/spec.test.ts",
  ]);
  assert.deepEqual(project.descriptor.testSummary, [
    { label: "public", count: 2 },
    { label: "scenarios", count: 1 },
  ]);
  assert.equal(descriptorPublic(project.descriptor).ok, true);
  // Deterministic.
  assert.deepEqual(
    generateStarterProject({
      version,
      starter,
      acceptanceTests: starter.hiddenTests,
      spec,
    }),
    project,
  );
});

test("a starter without a spec, with JSX, packages and a stray import", () => {
  const project = generateStarterProject({
    version,
    starter: {
      ...starter,
      files: [
        {
          path: "src/view.tsx",
          text: "export const View = () => <p>hi</p>;\n",
        },
      ],
      packages: [],
      scenario: 'import "../src/missing.js";\nimport "./mock.js";\n',
    },
    acceptanceTests: starter.hiddenTests,
    spec: null,
  });
  const text = (path: string) =>
    project.files.find((file) => file.path === path)?.text ?? "";
  assert.match(text("sandbox/ambient.d.ts"), /namespace JSX/);
  assert.match(text("tsconfig.json"), /"jsx": "react-jsx"/);
  assert.equal(
    project.files.some((file) => file.path === SPEC_TEST_PATH),
    false,
  );
  assert.deepEqual(project.descriptor.testSummary, [
    { label: "public", count: 1 },
    { label: "scenarios", count: 0 },
  ]);
  assert.deepEqual(
    project.blockers.map((blocker) => [blocker.code, blocker.detail]),
    [
      [
        "import_unrewritable",
        "../src/missing.js does not resolve to a file in the project.",
      ],
      [
        "import_unrewritable",
        "./mock.js does not resolve to a file in the project.",
      ],
    ],
  );
  assert.match(text("README.md"), /## Packages\n\nNone\./);
});

test("a starter that breaks the rules still generates, with blockers", () => {
  const project = generateStarterProject({
    version,
    starter: {
      ...starter,
      files: [...starter.files, { path: "src/cart.ts", text: "duplicate" }],
    },
    acceptanceTests: starter.hiddenTests.map((hidden) => ({
      ...hidden,
      expectedBaseline: "pass" as const,
    })),
    spec: null,
  });
  const codes = project.blockers.map((blocker) => blocker.code);
  assert.ok(codes.includes("starter_invalid"));
  assert.ok(codes.includes("path_conflict"));
});
