import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
  StoredAnalysisRun,
  StoredVersionWithSource,
} from "@sandbox-factory/db";
import { descriptorPublic, resolveScope } from "sandbox-factory";
import type {
  AliasRule,
  EvaluationCommand,
  EvaluationExecResult,
  EvaluationProvider,
  SandboxBuildManifest,
  VersionFixtures,
} from "sandbox-factory";
import { AnalysisError } from "../src/errors.js";
import {
  buildArtifactKind,
  createSandboxBuildAdapter,
  nearestCompilerOptions,
} from "../src/tools/sandbox-build.js";
import { stubModules } from "../src/tools/slice-run.js";
import type { ToolInputs, ToolRunInput } from "../src/tools/adapter.js";
import { fixture, slice, sliceRun, stamp } from "./fixture-slice.js";

function fakeProvider(
  script: (
    argv: readonly string[],
  ) => Partial<EvaluationExecResult> | Error = () => ({}),
  options: { createFails?: boolean; lockfile?: string | null } = {},
) {
  const calls: string[][] = [];
  const staged: string[] = [];
  let destroyed = 0;
  const provider: EvaluationProvider = {
    name: "fake",
    async create() {
      if (options.createFails === true) throw new Error("provider down");
      return {
        id: "job_1",
        environment: {
          provider: "fake",
          environmentId: "env_1",
          templateDigest: "sha256:template",
        },
        async stage(files) {
          staged.push(...files.map((file) => file.path));
        },
        async exec(command: EvaluationCommand) {
          calls.push([...command.argv]);
          const scripted = script(command.argv);
          if (scripted instanceof Error) throw scripted;
          return {
            exitCode: 0,
            timedOut: false,
            outputTruncated: false,
            stdout: "",
            stderr: "",
            durationMs: 1,
            ...scripted,
          };
        },
        async read(path) {
          return path === "package-lock.json"
            ? options.lockfile === undefined
              ? '{"lockfileVersion":3}'
              : options.lockfile
            : null;
        },
        async destroy() {
          destroyed += 1;
        },
      };
    },
  };
  return { provider, calls, staged, destroyed: () => destroyed };
}

async function versionFor(
  overrides: Partial<{
    aliasRules: AliasRule[];
    acceptance: boolean;
    blocked: boolean;
    stale: boolean;
    fixtures: VersionFixtures | null;
  }> = {},
): Promise<StoredVersionWithSource> {
  const { artifacts, manifest, contract } = await slice();
  const manifestSha =
    artifacts.find((a) => a.kind === "slice_manifest")?.sha256 ?? "";
  const contractSha =
    artifacts.find((a) => a.kind === "boundary_contract")?.sha256 ?? "";
  const scope = resolveScope({ manifest, contract });
  const acceptanceTests =
    overrides.acceptance === false
      ? []
      : [
          {
            path: "tests/private/fix.test.ts",
            text: 'import { test } from "node:test";\ntest("fixed", () => { throw new Error("not yet"); });\n',
            expectedBaseline: "fail" as const,
          },
        ];
  return {
    version: {
      id: "sbv_1",
      sandboxId: "sbx_1",
      version: 1,
      title: "Fix the widget",
      specSummary: "Make it work.",
      complexity: "M",
      tags: ["typescript"],
      testSummary: [],
      publicBaseCommitSha: null,
      readme: null,
      languages: null,
      frozenAt: null,
      createdAt: stamp,
    },
    source: {
      sandboxVersionId: "sbv_1",
      sourceSnapshotId: "rsn_1",
      sourceCommitSha: "a".repeat(40),
      sliceRunId: sliceRun.id,
      manifestSha256: overrides.stale === true ? "0".repeat(64) : manifestSha,
      contractSha256: contractSha,
      transformConfigSha256: "1".repeat(64),
      approvedTaskSha256: "2".repeat(64),
      approvedTask: {
        schemaVersion: 1,
        title: "Fix the widget",
        summary: "Make it work.",
        spec: {
          proposalId: "bpr_1",
          specRevision: 1,
          specHash: "s".repeat(64),
          draft: {
            feature: "Widget",
            background: [],
            scenarios: [
              {
                id: "s1",
                kind: "happy",
                title: "createService describes a thing",
                steps: [{ keyword: "When", text: "createService runs" }],
                origin: "draft",
              },
            ],
            openQuestions: [],
            assumptions: [],
          },
        },
        pricing: null,
        selectedBy: "user_1",
        selectedAt: stamp,
        jiraIssueIds: [],
      },
      aliasRules: overrides.aliasRules ?? [],
      dependencyChoices: {},
      acceptanceTests,
      fixtures: overrides.fixtures ?? null,
      scope:
        overrides.blocked === true
          ? {
              ...scope,
              blockers: [
                {
                  code: "dependency_unresolved",
                  detail: "left-pad has no pinned version.",
                },
              ],
            }
          : scope,
      harnessSha256: null,
      toolchainDigest: null,
      buildRunId: null,
      roundTripRunId: null,
      disclosureRunId: null,
      approvedBy: null,
      approvedAt: null,
      createdAt: stamp,
      updatedAt: stamp,
    },
  };
}

async function runBuild(
  provider: EvaluationProvider | null,
  options: Partial<{
    version: StoredVersionWithSource | null;
    sliceStatus: StoredAnalysisRun["status"];
    corrupt: boolean;
    params: Partial<Record<string, string>>;
    sourceDir: string;
    outDir: string;
    snapshotId: string;
  }> = {},
) {
  const { artifacts, objects } = await slice();
  const version =
    options.version === undefined ? await versionFor() : options.version;
  const outDir =
    options.outDir ?? (await mkdtemp(join(tmpdir(), "build-out-")));
  const messages: string[] = [];
  const inputs: ToolInputs = {
    getRun: async (id) =>
      id === sliceRun.id
        ? { ...sliceRun, status: options.sliceStatus ?? "succeeded" }
        : null,
    listArtifacts: async (id) => (id === sliceRun.id ? artifacts : []),
    readArtifact: async (key) =>
      options.corrupt === true && key.endsWith("boundary-contract.json")
        ? Buffer.from("tampered")
        : objects.get(key),
    getVersion: async (id) => (id === "sbv_1" ? version : null),
    getTask: async () => null,
    recordBuildOutput: async () => false,
  };
  const input: ToolRunInput = {
    sourceDir: options.sourceDir ?? fixture,
    outDir,
    params: {
      deadlineMinutes: 30,
      sliceRunId: sliceRun.id,
      sandboxVersionId: "sbv_1",
      manifestSha256: version?.source.manifestSha256 ?? "",
      contractSha256: version?.source.contractSha256 ?? "",
      transformConfigSha256: version?.source.transformConfigSha256 ?? "",
      approvedTaskSha256: version?.source.approvedTaskSha256 ?? "",
      ...options.params,
    } as never,
    run: {
      snapshotId: options.snapshotId ?? "rsn_1",
      commitSha: "a".repeat(40),
    },
    inputs,
    signal: new AbortController().signal,
    log: (line) => messages.push(line),
  };
  const files = await createSandboxBuildAdapter({
    provider,
    now: () => new Date(stamp),
  }).run(input);
  const read = async (path: string) => readFile(join(outDir, path), "utf8");
  const manifest = JSON.parse(
    await read("build-manifest.json"),
  ) as SandboxBuildManifest;
  return { files, manifest, read, messages, outDir };
}

test("a build produces a standalone project, hidden tests apart, a verified baseline and a bound manifest", async () => {
  const fake = fakeProvider((argv) =>
    argv.includes("--test") && !argv.includes("test") ? { exitCode: 1 } : {},
  );
  const { files, manifest, read } = await runBuild(fake.provider, {
    version: await versionFor({
      aliasRules: [
        {
          before: "createService",
          after: "makeService",
          kind: "identifier",
          paths: [],
        },
      ],
    }),
  });
  assert.equal(
    manifest.ready,
    true,
    JSON.stringify(
      manifest.blockers.concat(manifest.baseline?.reasons as never),
    ),
  );
  assert.deepEqual(manifest.blockers, []);
  assert.equal(manifest.sandboxVersionId, "sbv_1");
  assert.equal(manifest.sourceCommitSha, "a".repeat(40));
  assert.equal(manifest.evaluator?.provider, "fake");
  assert.equal(manifest.evaluator?.templateDigest, "sha256:template");
  assert.match(manifest.toolchainDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(manifest.importRewrites, [
    { file: "src/app.ts", from: "@lib/alias", to: "../lib/alias.js" },
  ]);
  const paths = files.map((file) => file.path);
  assert.ok(paths.includes("project/src/app.ts"));
  assert.ok(paths.includes("project/lib/service.d.ts"));
  assert.ok(paths.includes("project/lib/service.js"));
  assert.ok(paths.includes("project/mocks/pg/index.js"));
  assert.ok(paths.includes("project/package-lock.json"));
  assert.ok(paths.includes("project/sandbox-task.json"));
  assert.ok(paths.includes("private/fix.test.ts"));
  assert.equal(
    paths.some((path) => path.startsWith("project/tests/private")),
    false,
  );
  assert.equal(
    files.find((file) => file.path === "private/fix.test.ts")?.kind,
    "private_test",
  );
  assert.equal(
    files.find((file) => file.path === "project/src/app.ts")?.kind,
    "project_file",
  );
  assert.equal(
    files.find((file) => file.path === "build-manifest.json")?.kind,
    "build_manifest",
  );
  assert.equal(
    files.find((file) => file.path === "baseline.json")?.kind,
    "baseline_report",
  );
  const meta = files.find((file) => file.path === "build-manifest.json")
    ?.meta as { ready: boolean; privateTests: number };
  assert.equal(meta.ready, true);
  assert.equal(meta.privateTests, 1);
  // Aliased consistently across source, stub, runtime and spec.
  const app = await read("project/src/app.ts");
  assert.match(app, /makeService/);
  assert.doesNotMatch(app, /createService/);
  assert.match(app, /from "\.\.\/lib\/alias\.js"/);
  assert.match(
    await read("project/lib/service.d.ts"),
    /export declare function makeService/,
  );
  assert.match(
    await read("project/lib/service.js"),
    /export const makeService = mock\["makeService"\]/,
  );
  assert.match(
    await read("project/tests/public/spec.test.ts"),
    /makeService describes a thing/,
  );
  assert.match(
    await read("project/tests/public/interface.test.ts"),
    /module\["run"\]/,
  );
  assert.deepEqual(
    descriptorPublic(JSON.parse(await read("project/sandbox-task.json"))),
    { ok: true, offending: [] },
  );
  // The baseline ran every step in a job that was destroyed.
  assert.deepEqual(
    fake.calls.map((argv) => argv.slice(0, 3).join(" ")),
    [
      "npm install --package-lock-only",
      "npm ci --ignore-scripts",
      "npm run build",
      "npm run dev",
      "npm test",
      "node --env-file=sandbox.env --test",
    ],
  );
  assert.ok(fake.staged.includes("tests/private/fix.test.ts"));
  assert.equal(fake.destroyed(), 1);
  assert.deepEqual(manifest.baseline?.privateTests, [
    {
      path: "tests/private/fix.test.ts",
      expected: "fail",
      observed: "fail",
      ok: true,
    },
  ]);
  assert.equal(manifest.baseline?.executions[0]?.teardown, "destroyed");
  assert.equal(manifest.baseline?.executions[0]?.state, "succeeded");
  // Hashes cover what they say.
  const publicRecords = manifest.files.filter((file) => file.public);
  assert.equal(
    publicRecords.some((file) => file.path === "package-lock.json"),
    true,
  );
  assert.equal(
    manifest.files.some(
      (file) => file.class === "test-private" && !file.public,
    ),
    true,
  );
  assert.notEqual(manifest.harnessSha256, manifest.publicProjectSha256);
  // Deterministic for the same inputs and clock.
  const again = await runBuild(
    fakeProvider((argv) =>
      argv.includes("--test") && !argv.includes("test") ? { exitCode: 1 } : {},
    ).provider,
    {
      version: await versionFor({
        aliasRules: [
          {
            before: "createService",
            after: "makeService",
            kind: "identifier",
            paths: [],
          },
        ],
      }),
    },
  );
  assert.deepEqual(again.manifest, manifest);
});

test("fixtures and the walkthrough are aliased with the version, generated, and the walkthrough runs on the baseline", async () => {
  const fixtures: VersionFixtures = {
    fixtureRunId: "arn_fixtures",
    fixtures: [
      {
        module: "lib/service.ts",
        symbol: "createService",
        member: null,
        call: "call",
        implementation:
          "(options) => ({ describe: (label) => ({ id: `${label}:${options.name}` }) })",
        reason: "a service that describes",
      },
    ],
    scenario:
      'import { run } from "../src/app.js";\n// createService is mocked with a fixture.\nconsole.log(run({ name: "demo", retries: 1, nested: { enabled: true } }));\n',
  };
  const rule: AliasRule = {
    before: "createService",
    after: "makeService",
    kind: "identifier",
    paths: [],
  };
  const fake = fakeProvider((argv) =>
    argv.includes("--test") && !argv.includes("test") ? { exitCode: 1 } : {},
  );
  const { manifest, read } = await runBuild(fake.provider, {
    version: await versionFor({ aliasRules: [rule], fixtures }),
  });
  assert.deepEqual(manifest.blockers, []);
  assert.equal(manifest.ready, true);
  const runtime = await read("project/lib/service.js");
  assert.match(runtime, /import \{ createMock, fixture \} from/);
  assert.match(
    runtime,
    /fixture\("module:lib\/service\.ts\.makeService", \(options\) =>/,
  );
  const walkthrough = await read("project/sandbox/run.ts");
  assert.match(walkthrough, /makeService is mocked with a fixture/);
  assert.match(walkthrough, /from "\.\.\/src\/app\.js"/);
  assert.match(
    await read("project/README.md"),
    /1 mocked call has default behaviour/,
  );
  assert.ok(fake.calls.some((argv) => argv.join(" ") === "npm run dev"));
  // A walkthrough that fails on the baseline fails the build.
  const failing = fakeProvider((argv) =>
    argv.join(" ") === "npm run dev"
      ? { exitCode: 1 }
      : argv.includes("--test") && !argv.includes("test")
        ? { exitCode: 1 }
        : {},
  );
  const broken = await runBuild(failing.provider, {
    version: await versionFor({ aliasRules: [rule], fixtures }),
  });
  assert.equal(broken.manifest.ready, false);
  assert.deepEqual(broken.manifest.baseline?.reasons, ["dev exited with 1."]);
  // Fixtures for a module the slice does not mock stop the build first.
  const invalid = await runBuild(fakeProvider().provider, {
    version: await versionFor({
      fixtures: {
        ...fixtures,
        fixtures: [{ ...fixtures.fixtures[0]!, module: "lib/nowhere.ts" }],
      },
    }),
  });
  assert.deepEqual(
    invalid.manifest.blockers.map((blocker) => blocker.code),
    ["fixture_invalid"],
  );
});

test("build outputs are classified by path", () => {
  assert.equal(buildArtifactKind("build-manifest.json"), "build_manifest");
  assert.equal(buildArtifactKind("baseline.json"), "baseline_report");
  assert.equal(buildArtifactKind("project/src/app.ts"), "project_file");
  assert.equal(buildArtifactKind("private/fix.test.ts"), "private_test");
  assert.equal(buildArtifactKind("other.txt"), "other");
});

test("a build refuses stale parameters, missing versions, an unfinished slice, tampered artifacts and changed source", async () => {
  const fake = fakeProvider();
  const code = async (promise: Promise<unknown>) => {
    try {
      await promise;
      return "ok";
    } catch (error) {
      return error instanceof AnalysisError ? error.code : String(error);
    }
  };
  assert.equal(
    await code(
      runBuild(fake.provider, {
        params: { transformConfigSha256: "9".repeat(64) },
      }),
    ),
    "tool_failed",
  );
  assert.equal(
    await code(runBuild(fake.provider, { version: null })),
    "tool_failed",
  );
  assert.equal(
    await code(runBuild(fake.provider, { snapshotId: "rsn_other" })),
    "tool_failed",
  );
  assert.equal(
    await code(runBuild(fake.provider, { sliceStatus: "queued" })),
    "slice_unavailable",
  );
  assert.equal(
    await code(
      runBuild(fake.provider, { version: await versionFor({ stale: true }) }),
    ),
    "slice_unavailable",
  );
  assert.equal(
    await code(runBuild(fake.provider, { corrupt: true })),
    "slice_unavailable",
  );
  const copy = await mkdtemp(join(tmpdir(), "build-src-"));
  try {
    await cp(fixture, copy, { recursive: true });
    await writeFile(join(copy, "src/app.ts"), "// changed\n");
    assert.equal(
      await code(runBuild(fake.provider, { sourceDir: copy })),
      "source_unavailable",
    );
  } finally {
    await rm(copy, { recursive: true, force: true });
  }
  await assert.rejects(
    createSandboxBuildAdapter({ provider: fake.provider }).run({
      sourceDir: fixture,
      outDir: await mkdtemp(join(tmpdir(), "build-out-")),
      params: { deadlineMinutes: 30 },
      run: { snapshotId: "rsn_1", commitSha: "a".repeat(40) },
      inputs: {
        getRun: async () => null,
        listArtifacts: async () => [],
        readArtifact: async () => undefined,
        getVersion: async () => null,
        getTask: async () => null,
        recordBuildOutput: async () => false,
      },
      signal: new AbortController().signal,
      log: () => {},
    }),
    (error: unknown) =>
      error instanceof AnalysisError && error.code === "tool_failed",
  );
  assert.equal(fake.calls.length, 0);
});

test("alias collisions and scope blockers stop before any job runs; a failing baseline is recorded", async () => {
  const fake = fakeProvider();
  const collided = await runBuild(fake.provider, {
    version: await versionFor({
      aliasRules: [
        { before: "run", after: "client", kind: "identifier", paths: [] },
      ],
    }),
  });
  assert.equal(collided.manifest.ready, false);
  assert.equal(collided.manifest.baseline, null);
  assert.equal(collided.manifest.files.length, 0);
  assert.equal(collided.manifest.blockers[0]?.code, "alias_failed");
  assert.match(collided.manifest.blockers[0]?.detail ?? "", /target_collision/);
  assert.equal(
    collided.files.some((file) => file.path.startsWith("project/")),
    false,
  );
  const blocked = await runBuild(fake.provider, {
    version: await versionFor({ blocked: true }),
  });
  assert.equal(blocked.manifest.blockers[0]?.code, "scope_blocked");
  assert.equal(blocked.manifest.baseline, null);
  assert.equal(fake.calls.length, 0);
  const failing = fakeProvider(
    (argv) => (argv[1] === "run" ? { exitCode: 2 } : {}),
    { lockfile: null },
  );
  const broken = await runBuild(failing.provider);
  assert.equal(broken.manifest.ready, false);
  assert.deepEqual(
    broken.manifest.blockers.map((b) => b.code),
    ["baseline_failed"],
  );
  assert.deepEqual(
    broken.manifest.baseline?.steps.map((step) => [step.name, step.ok]),
    [
      ["prepare", true],
      ["install", true],
      ["build", false],
    ],
  );
  assert.equal(
    broken.manifest.files.some((file) => file.path === "package-lock.json"),
    false,
  );
  assert.equal(failing.destroyed(), 1);
  // A hidden test that cannot run is an error, not a pass or a fail.
  const erroring = fakeProvider((argv) =>
    argv[0] === "node" ? { exitCode: 2 } : {},
  );
  const errored = await runBuild(erroring.provider);
  assert.deepEqual(errored.manifest.baseline?.privateTests[0], {
    path: "tests/private/fix.test.ts",
    expected: "fail",
    observed: "error",
    ok: false,
  });
  assert.equal(errored.manifest.ready, false);
  const timed = fakeProvider((argv) =>
    argv[0] === "node" ? { exitCode: null, timedOut: true } : {},
  );
  assert.equal(
    (await runBuild(timed.provider)).manifest.baseline?.privateTests[0]
      ?.observed,
    "error",
  );
  const unexpected = fakeProvider();
  assert.deepEqual(
    (await runBuild(unexpected.provider)).manifest.baseline?.privateTests[0],
    {
      path: "tests/private/fix.test.ts",
      expected: "fail",
      observed: "pass",
      ok: false,
    },
  );
  const prepareFails = fakeProvider((argv) =>
    argv[1] === "install" ? { exitCode: 1 } : {},
  );
  assert.deepEqual(
    (await runBuild(prepareFails.provider)).manifest.baseline?.steps.map(
      (s) => s.name,
    ),
    ["prepare"],
  );
  const ciFails = fakeProvider((argv) =>
    argv[1] === "ci" ? { exitCode: 1 } : {},
  );
  assert.deepEqual(
    (await runBuild(ciFails.provider)).manifest.baseline?.steps.map(
      (s) => s.name,
    ),
    ["prepare", "install"],
  );
  const noTests = await runBuild(fakeProvider().provider, {
    version: await versionFor({ acceptance: false }),
  });
  assert.equal(noTests.manifest.ready, true);
  assert.deepEqual(noTests.manifest.baseline?.privateTests, []);
});

test("after commit, a ready build records its harness and toolchain on the draft; a diagnostic one does not", async () => {
  const adapter = createSandboxBuildAdapter({
    provider: fakeProvider().provider,
  });
  const recorded: unknown[] = [];
  const inputs = {
    getRun: async () => null,
    listArtifacts: async () => [],
    readArtifact: async () => undefined,
    getVersion: async () => null,
    getTask: async () => null,
    recordBuildOutput: async (
      versionId: string,
      runId: string,
      output: unknown,
    ) => {
      recorded.push({ versionId, runId, output });
      return true;
    },
  };
  const ready = await runBuild(fakeProvider().provider, {
    version: await versionFor({ acceptance: false }),
  });
  assert.equal(ready.manifest.ready, true);
  await adapter.committed?.({ runId: "arn_build", files: ready.files, inputs });
  assert.deepEqual(recorded, [
    {
      versionId: "sbv_1",
      runId: "arn_build",
      output: {
        harnessSha256: ready.manifest.harnessSha256,
        toolchainDigest: ready.manifest.toolchainDigest,
      },
    },
  ]);
  const diagnostic = await runBuild(fakeProvider().provider, {
    version: await versionFor({
      aliasRules: [
        { before: "run", after: "client", kind: "identifier", paths: [] },
      ],
    }),
  });
  assert.equal(diagnostic.manifest.ready, false);
  await adapter.committed?.({
    runId: "arn_build",
    files: diagnostic.files,
    inputs,
  });
  await adapter.committed?.({ runId: "arn_build", files: [], inputs });
  assert.equal(recorded.length, 1);
});

test("a stub maps to the module the contract names, whatever its extension", () => {
  const moduleOf = stubModules({
    outbound: [
      {
        module: "lib/view.tsx",
        symbols: [],
        importedBy: [],
        stubPath: "stubs/lib/view.d.ts",
      },
      {
        module: "lib/esm.mts",
        symbols: [],
        importedBy: [],
        stubPath: "stubs/lib/esm.d.mts",
      },
      {
        module: "lib/plain.js",
        symbols: [],
        importedBy: [],
        stubPath: "stubs/lib/plain.d.ts",
      },
    ],
  });
  assert.equal(moduleOf("stubs/lib/view.d.ts"), "lib/view.tsx");
  assert.equal(moduleOf("stubs/lib/esm.d.mts"), "lib/esm.mts");
  assert.equal(moduleOf("stubs/lib/plain.d.ts"), "lib/plain.js");
  assert.equal(moduleOf("stubs/lib/other.d.ts"), "lib/other.ts");
  assert.equal(moduleOf("stubs/lib/other.d.cts"), "lib/other.ts");
});

test("provider failures are evaluation failures and the job is still torn down", async () => {
  const down = fakeProvider(() => ({}), { createFails: true });
  await assert.rejects(
    runBuild(down.provider),
    (error: unknown) =>
      error instanceof AnalysisError && error.code === "evaluation_failed",
  );
  const crashing = fakeProvider(() => new Error("exec exploded"));
  await assert.rejects(
    runBuild(crashing.provider),
    (error: unknown) =>
      error instanceof AnalysisError && error.code === "evaluation_failed",
  );
  assert.equal(crashing.destroyed(), 1);
  // A worker with no provider refuses before generating anything.
  await assert.rejects(
    runBuild(null),
    (error: unknown) =>
      error instanceof AnalysisError && error.code === "evaluation_failed",
  );
});

test("the nearest tsconfig's raw compiler options are carried, and none when there is no tsconfig", async () => {
  const options = nearestCompilerOptions(fixture, "src/app.ts");
  assert.equal(options?.["module"], "NodeNext");
  assert.equal(options?.["strict"], true);
  const bare = await mkdtemp(join(tmpdir(), "no-tsconfig-"));
  try {
    await writeFile(join(bare, "a.ts"), "");
    assert.equal(nearestCompilerOptions(bare, "a.ts"), undefined);
    assert.equal(nearestCompilerOptions(bare, "../outside.ts"), undefined);
    await writeFile(join(bare, "tsconfig.json"), "{}");
    assert.equal(nearestCompilerOptions(bare, "a.ts"), undefined);
    // `extends` is followed base-first, relative and inside the root only.
    await mkdir(join(bare, "tooling"));
    await writeFile(
      join(bare, "tooling", "base.json"),
      JSON.stringify({
        extends: "./root",
        compilerOptions: { experimentalDecorators: true, target: "ES2020" },
      }),
    );
    await writeFile(
      join(bare, "tooling", "root.json"),
      JSON.stringify({ compilerOptions: { jsx: "react-jsx", strict: false } }),
    );
    await writeFile(
      join(bare, "tsconfig.json"),
      JSON.stringify({
        extends: [
          "./tooling/base.json",
          "@tsconfig/node22",
          "../../outside.json",
        ],
        compilerOptions: { target: "ES2022" },
      }),
    );
    assert.deepEqual(nearestCompilerOptions(bare, "a.ts"), {
      jsx: "react-jsx",
      strict: false,
      experimentalDecorators: true,
      target: "ES2022",
    });
    // A cycle ends instead of recursing.
    await writeFile(
      join(bare, "tooling", "root.json"),
      JSON.stringify({ extends: "./base.json", compilerOptions: {} }),
    );
    assert.equal(nearestCompilerOptions(bare, "a.ts")?.["target"], "ES2022");
  } finally {
    await rm(bare, { recursive: true, force: true });
  }
});
