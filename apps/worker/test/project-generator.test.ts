import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { generateProject as carveoutGenerateProject } from "carveout/api";
import {
  PLATFORM_LAYOUT,
  SANDBOX_RUN_ARGV,
  generateProject,
  gradingTree,
} from "sandbox-factory";
import type { GeneratedFile, ProjectInput } from "sandbox-factory";
import {
  CARVEOUT_GUIDE_PATHS,
  CARVEOUT_RUN,
  PLATFORM_RUN,
  carveoutInputOf,
  carveoutLayout,
  carveoutProject,
  generateOnEngine,
  platformLayers,
  platformPackageJson,
  projectRunOf,
  withFixtureDefaults,
  withPublicNames,
  withSourceMaps,
} from "../src/tools/project-generator.js";

/**
 * The input the round trip's build gave the generator for its final
 * project (`scripts/roundtrip.mjs`): the fee module renamed, its ledger
 * stubbed, three hidden tests and one carried test.
 */
const roundTripInput = JSON.parse(
  readFileSync(
    new URL("../../test/golden/project/roundtrip-input.json", import.meta.url),
    "utf8",
  ),
) as ProjectInput;

const digest = (files: readonly GeneratedFile[]) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        files.map((file) => [
          file.path,
          file.class,
          file.public,
          createHash("sha256").update(file.text).digest("hex"),
        ]),
      ),
    )
    .digest("hex");

const byPath = (files: readonly GeneratedFile[]) =>
  new Map(files.map((file) => [file.path, file]));

test("the platform engine is core's generator, byte for byte as before", () => {
  const project = generateOnEngine("platform", roundTripInput);
  assert.equal(project.layout, undefined);
  assert.deepEqual(project.files, generateProject(roundTripInput).files);
  // The round trip's project before the carveout engine existed.
  assert.equal(
    digest(project.files),
    "0494d9a965979fe6a8e309f8899a365d635be02db708bded3dc9ab300f7744f4",
  );
  assert.deepEqual(projectRunOf("platform"), PLATFORM_RUN);
  assert.deepEqual(PLATFORM_RUN.dev, SANDBOX_RUN_ARGV.dev);
  assert.deepEqual(PLATFORM_RUN.publicTests, SANDBOX_RUN_ARGV.test);
  assert.deepEqual(PLATFORM_RUN.oneTest("tests/private/a.test.ts"), {
    argv: [
      "node",
      "--env-file=sandbox.env",
      "--test",
      "--test-reporter=tap",
      "tests/private/a.test.js",
    ],
    hidden: { entry: "tests/private/a.test.js", load: "memory" },
  });
});

test("the carveout engine writes carveout's harness with the platform's tests, guide and layout over it", () => {
  const project = generateOnEngine("carveout", roundTripInput);
  assert.deepEqual(project.blockers, []);
  const files = byPath(project.files);
  // carveout's harness and configuration, none of the platform's.
  for (const path of [
    "carveout/mock.js",
    "carveout/assets.js",
    "carveout/test.js",
    "carveout/run.ts",
    "carveout/tests/interface.test.ts",
    "carveout.env",
  ])
    assert.ok(files.has(path), path);
  for (const path of ["sandbox/mock.js", "sandbox.env", "mocks"])
    assert.ok(![...files.keys()].some((p) => p.startsWith(path)), path);
  // The platform's tests, guide and descriptor.
  assert.equal(files.get("tests/public/spec.test.ts")?.class, "test-public");
  assert.equal(
    files.get("tests/public/carried/test/credit.test.ts")?.class,
    "test-public",
  );
  const hidden = project.files.filter((file) => file.class === "test-private");
  assert.deepEqual(
    hidden.map((file) => [file.path, file.public]),
    roundTripInput.acceptanceTests.map((test) => [test.path, false]),
  );
  for (const path of [
    "TASK.md",
    "AGENTS.md",
    "CLAUDE.md",
    ".vscode/launch.json",
  ])
    assert.ok(files.has(path), path);
  const agents = files.get("AGENTS.md")?.text ?? "";
  assert.match(agents, /carveout\.env/);
  assert.doesNotMatch(agents, /sandbox\.env|tests\/private/);
  const descriptor = JSON.parse(files.get("sandbox-task.json")?.text ?? "{}");
  assert.deepEqual(descriptor.editablePaths, ["src/northwind/fees.ts"]);
  assert.deepEqual(descriptor.publicTests, [
    "carveout/tests/interface.test.ts",
    "tests/public/spec.test.ts",
    "tests/public/carried/test/credit.test.ts",
  ]);
  // The README is the platform's, in carveout's paths: nothing of a
  // hand-off folder's (`carveout patch`, `BOUNDARY.md`, `carveout.json`).
  const readme = files.get("README.md")?.text ?? "";
  assert.match(readme, /^# Charge the Northwind fee by amount\n/);
  assert.match(readme, /`carveout\/mock\.js`/);
  assert.match(readme, /--env-file=carveout\.env --test tests\/public/);
  assert.doesNotMatch(readme, /BOUNDARY\.md|carveout patch|carveout\.json/);
  // Source maps, the version's package version and npm pin; carveout's
  // scripts.
  assert.equal(
    JSON.parse(files.get("tsconfig.json")?.text ?? "{}").compilerOptions
      .sourceMap,
    true,
  );
  assert.match(files.get(".gitignore")?.text ?? "", /\n\*\.map\n$/);
  const pkg = JSON.parse(files.get("package.json")?.text ?? "{}");
  assert.equal(pkg.version, "1.0.0");
  assert.equal(pkg.packageManager, "npm@10.9.2");
  assert.equal(pkg.scripts.test, "npm run build && node carveout/test.js");
  // The layout grading reads: carveout's harness, the platform's tests.
  const layout = project.layout;
  assert.ok(layout !== undefined);
  assert.equal(layout.harnessDir, "carveout");
  assert.equal(layout.mocksDir, "carveout/packages");
  assert.equal(layout.envFile, "carveout.env");
  assert.deepEqual(layout.harnessRoots, ["carveout", "tests", "node_modules"]);
  assert.equal(layout.tests.privateDir, "tests/private");
  assert.equal(layout.tests.publicDir, "tests/public");
  assert.deepEqual(layout.tests.files, [...descriptor.publicTests].sort());
  assert.equal(layout.configFiles["carveout.json"], undefined);
  assert.equal(
    layout.configFiles["package.json"],
    PLATFORM_LAYOUT.configFiles["package.json"],
  );
  assert.equal(
    layout.configFiles["carveout.env"],
    "carveout.env is the version's fixture environment.",
  );
  assert.ok(layout.configFiles["sandbox-task.json"]);
  // Grading on that layout: a test added under tests/ is the harness's,
  // task code naming the hidden folder is refused, the editable file is taken.
  const graded = gradingTree({
    versionFiles: project.files.filter((file) => file.public),
    editablePaths: descriptor.editablePaths,
    submission: [
      { path: "src/northwind/fees.ts", text: "export const x = 1;\n" },
      { path: "tests/public/mine.test.ts", text: "export {};\n" },
      {
        path: "src/northwind/peek.ts",
        text: 'export const p = "tests/private";\n',
      },
    ],
    layout,
  });
  assert.deepEqual(graded.refused.map((refusal) => refusal.path).sort(), [
    "src/northwind/peek.ts",
    "tests/public/mine.test.ts",
  ]);
});

test("the carveout engine runs carveout's commands, one test at a time as its layout says", () => {
  assert.equal(projectRunOf("carveout"), CARVEOUT_RUN);
  assert.deepEqual(CARVEOUT_RUN.dev, [
    "node",
    "--env-file=carveout.env",
    "--import=./carveout/assets.js",
    "carveout/run.js",
  ]);
  assert.deepEqual(CARVEOUT_RUN.publicTests, ["node", "carveout/test.js"]);
  const one = CARVEOUT_RUN.oneTest("tests/private/a.test.ts");
  assert.deepEqual(one.argv, [
    "node",
    "--env-file=carveout.env",
    "--import=./carveout/assets.js",
    "--test",
    "--test-reporter=tap",
    "--test-reporter-destination=stdout",
    "tests/private/a.test.js",
  ]);
  assert.deepEqual(one.hidden, {
    entry: "tests/private/a.test.js",
    load: "memory",
  });
  // A layout that carveout's build script holds builds with it.
  const waived = carveoutLayout(["carveout/build.js", "vitest.config.mjs"], []);
  assert.deepEqual(
    waived.commands.find((command) => command.name === "build")?.argv,
    ["node", "carveout/build.js"],
  );
  assert.ok(waived.tests.run.vitest !== null);
});

test("public names are applied before carveout reads the input, and spent", () => {
  const input: ProjectInput = {
    ...roundTripInput,
    sources: [
      {
        originalPath: "src/a.ts",
        path: "src/a.ts",
        text: 'import { Client } from "@acme/billing/client";\nimport x from "./b.js";\n// import "@acme/billing";\nexport const key = process.env.ACME_KEY;\n',
      },
      { originalPath: "src/data.json", path: "src/data.json", text: "{}\n" },
    ],
    dependencies: [
      {
        name: "@acme/billing",
        kind: "package",
        version: null,
        resolution: "runtime-mock",
        detail: "",
      },
      {
        name: "zod",
        kind: "package",
        version: "4.0.0",
        resolution: "approved-package",
        detail: "",
      },
    ],
    manifest: {
      ...roundTripInput.manifest,
      externals: {
        ...roundTripInput.manifest.externals,
        environment: [{ name: "ACME_KEY", files: ["src/a.ts"] }],
      },
    },
    scenario: "console.log(process.env.ACME_KEY);\n",
    publicNames: {
      packages: { "@acme/billing": "@north/billing", zod: "zod" },
      environment: { ACME_KEY: "NORTH_KEY" },
    },
  };
  const named = withPublicNames(input);
  assert.equal(named.publicNames, undefined);
  assert.equal(
    named.sources[0]?.text,
    'import { Client } from "@north/billing/client";\nimport x from "./b.js";\n// import "@acme/billing";\nexport const key = process.env.NORTH_KEY;\n',
  );
  assert.equal(named.sources[1]?.text, "{}\n");
  assert.deepEqual(
    named.dependencies.map((dependency) => dependency.name),
    ["@north/billing", "zod"],
  );
  assert.deepEqual(
    named.manifest.externals.environment.map((item) => item.name),
    ["NORTH_KEY"],
  );
  assert.equal(named.scenario, "console.log(process.env.NORTH_KEY);\n");
  // carveout then writes the mock package and the environment in public
  // names only.
  const project = carveoutProject(input);
  const paths = project.files.map((file) => file.path);
  assert.ok(paths.includes("carveout/packages/@north/billing/index.js"));
  assert.ok(!paths.some((path) => path.includes("acme")));
  const env = project.files.find((file) => file.path === "carveout.env");
  assert.match(env?.text ?? "", /^NORTH_KEY=/m);
  assert.doesNotMatch(env?.text ?? "", /ACME/);
  assert.match(
    project.files.find((file) => file.path === "README.md")?.text ?? "",
    /`@north\/billing`[\s\S]*`zod@4\.0\.0`[\s\S]*`NORTH_KEY`/,
  );
  // With nothing to rename, the input is the same, less the table.
  const plain = withPublicNames({ ...roundTripInput, publicNames: {} });
  assert.equal(plain.sources, roundTripInput.sources);
  assert.equal(plain.publicNames, undefined);
  const unnamed = withPublicNames({
    ...input,
    scenario: null,
    publicNames: { environment: { ACME_KEY: "NORTH_KEY" } },
  });
  assert.equal(unnamed.scenario, null);
  assert.equal(unnamed.dependencies[0]?.name, "@acme/billing");
});

test("fixture defaults and a walkthrough go into carveout's runtimes and harness, checked as the platform checks them", () => {
  const module = roundTripInput.contract.outbound[0];
  assert.ok(module !== undefined);
  const symbol = "ledgerBalance";
  const input: ProjectInput = {
    ...roundTripInput,
    contract: {
      ...roundTripInput.contract,
      outbound: [
        {
          ...module,
          symbols: [
            {
              name: symbol,
              kind: "function",
              declaration: `export declare function ${symbol}(): number;`,
            } as never,
          ],
        },
      ],
    },
    fixtures: [
      {
        module: module.module,
        symbol,
        member: null,
        call: "call",
        implementation: " () => 42 ",
        reason: "a balance",
      },
    ],
    scenario:
      'import { entryFee } from "../src/northwind/fees.js";\nimport { recordedCalls } from "./mock.js";\nimport "./missing.js";\nconsole.log(entryFee, recordedCalls);\n',
  };
  const project = carveoutProject(input);
  const runtime = project.files.find(
    (file) => file.path === "src/northwind/ledger.js",
  );
  assert.match(runtime?.text ?? "", /import \{ createMock, fixture \} from/);
  assert.match(
    runtime?.text ?? "",
    /const mock = createMock\("module:src\/northwind\/ledger\.ts"\);\nfixture\("module:src\/orvanta\/ledger\.ts\.ledgerBalance", \(\) => 42\);\n/,
  );
  assert.match(
    project.files.find((file) => file.path === "carveout/run.ts")?.text ?? "",
    /recordedCalls/,
  );
  // Only the import that lands nowhere is a blocker; `./mock.js` is
  // carveout's runtime.
  assert.deepEqual(
    project.blockers.map((blocker) => [blocker.code, blocker.detail]),
    [
      [
        "import_unrewritable",
        "./missing.js does not resolve to a file in the project.",
      ],
    ],
  );
  assert.match(
    project.files.find((file) => file.path === "README.md")?.text ?? "",
    /1 mocked call has default behaviour[\s\S]*runs `carveout\/run\.ts`, a walkthrough/,
  );
  // A fixture for a module the slice does not mock, an empty walkthrough.
  const invalid = carveoutProject({
    ...input,
    fixtures: [{ ...input.fixtures![0]!, module: "src/nowhere.ts" }],
    scenario: " ",
  });
  assert.deepEqual(invalid.blockers.map((blocker) => blocker.code).sort(), [
    "fixture_invalid",
    "fixture_invalid",
  ]);
});

test("tests at paths the platform does not keep them are blockers, as are carveout's own", () => {
  const project = carveoutProject({
    ...roundTripInput,
    carriedTests: [
      { path: "tests/public/carried/../escape.test.ts", text: "export {};\n" },
      { path: "tests/public/other.test.ts", text: "export {};\n" },
    ],
    acceptanceTests: [
      { path: "tests/hidden/a.test.ts", text: "", expectedBaseline: "fail" },
      {
        path: "tests/private/a.spec.ts",
        text: "",
        expectedBaseline: "fail",
      },
    ],
  });
  assert.deepEqual(
    project.blockers.map((blocker) => [blocker.code, blocker.file]),
    [
      ["test_path_invalid", "tests/public/carried/../escape.test.ts"],
      ["test_path_invalid", "tests/public/other.test.ts"],
      ["test_path_invalid", "tests/hidden/a.test.ts"],
      ["test_path_invalid", "tests/private/a.spec.ts"],
    ],
  );
  // carveout's blocker codes are the platform's; one it alone has is
  // recorded as a mock the project cannot run, its code kept in the detail.
  const raw = carveoutGenerateProject(carveoutInputOf(roundTripInput));
  const layered = platformLayers(
    {
      ...raw,
      files: [
        ...raw.files,
        {
          path: "tests/public/spec.test.ts",
          text: "",
          class: "test-public",
          public: true,
        },
      ],
      blockers: [
        { code: "test_runner_mocked", file: null, detail: "vitest is mocked" },
        { code: "path_conflict", file: "a.ts", detail: "twice" },
      ],
    },
    { ...roundTripInput, toolchain: undefined } as never,
  );
  assert.deepEqual(
    layered.blockers.map((blocker) => [blocker.code, blocker.detail]),
    [
      ["mock_unsupported", "test_runner_mocked: vitest is mocked"],
      ["path_conflict", "twice"],
      ["path_conflict", "tests/public/spec.test.ts is produced twice."],
    ],
  );
  // A credential in what the platform adds is found too.
  const secret = carveoutProject({
    ...roundTripInput,
    carriedTests: [
      {
        path: "tests/public/carried/k.test.ts",
        // Joined at runtime, so the source holds no key-shaped literal
        // for secret scanning to stop a push on.
        text: `const key = "${["AKIA", "ABCDEFGHIJKLMNOP"].join("")}";\n`,
      },
    ],
  });
  assert.ok(
    secret.blockers.some((blocker) => blocker.code === "secret_found"),
    JSON.stringify(secret.blockers),
  );
});

test("the configuration edits keep carveout's text but for what they change", () => {
  assert.equal(
    platformPackageJson(
      '{"name":"x","version":"0.0.0","engines":{"node":">=22"},"scripts":{}}',
      3,
      "10.9.2",
    ),
    '{\n  "name": "x",\n  "version": "3.0.0",\n  "engines": {\n    "node": ">=22"\n  },\n  "packageManager": "npm@10.9.2",\n  "scripts": {}\n}\n',
  );
  assert.match(
    platformPackageJson('{"name":"x"}', 1, "10.9.2"),
    /"packageManager": "npm@10\.9\.2"\n\}\n$/,
  );
  assert.equal(
    withSourceMaps('{"compilerOptions":{"strict":true},"include":["."]}'),
    '{\n  "compilerOptions": {\n    "strict": true,\n    "sourceMap": true\n  },\n  "include": [\n    "."\n  ]\n}\n',
  );
  assert.match(withSourceMaps("{}"), /"sourceMap": true/);
  const runtime =
    'import { createMock } from "../mock.js";\nconst mock = createMock("module:a.ts");\nexport {};\n';
  assert.equal(withFixtureDefaults(runtime, []), runtime);
  assert.equal(
    withFixtureDefaults("export {};\n", [{ path: "p", implementation: "f" }]),
    "export {};\n",
  );
  assert.equal(
    withFixtureDefaults(runtime, [
      { path: "module:a.ts.b", implementation: "() => 2" },
      { path: "module:a.ts.a", implementation: " () => 1 " },
    ]),
    'import { createMock, fixture } from "../mock.js";\nconst mock = createMock("module:a.ts");\nfixture("module:a.ts.a", () => 1);\nfixture("module:a.ts.b", () => 2);\nexport {};\n',
  );
  assert.equal(CARVEOUT_GUIDE_PATHS.runPath, "carveout/run.ts");
});

test("carveout's input carries the platform's options when it has them", () => {
  const input = carveoutInputOf({
    ...roundTripInput,
    compilerOptions: { strict: true },
    packageModules: { specifiers: ["x"], text: "" },
    toolchain: {
      node: "22",
      nodeRange: ">=22.12.0",
      npm: "10.9.2",
      typescript: "5.9.3",
      testRunner: "node:test",
      supportedPlatforms: ["linux"],
    },
  });
  assert.deepEqual(input.origin, {
    repository: null,
    name: "sandbox-task-sbv-roundtrip",
  });
  assert.deepEqual(input.compilerOptions, { strict: true });
  assert.deepEqual(input.packageModules, { specifiers: ["x"], text: "" });
  assert.equal(input.toolchain?.typescript, "5.9.3");
  const bare = carveoutInputOf({
    ...roundTripInput,
    compilerOptions: undefined,
    packageModules: undefined,
  } as never);
  assert.equal("compilerOptions" in bare, false);
  assert.equal("packageModules" in bare, false);
  assert.equal("toolchain" in bare, false);
});
