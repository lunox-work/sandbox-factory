import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
  StoredAnalysisRun,
  StoredVersionWithSource,
} from "@sandbox-factory/db";
import {
  canonicalJson,
  descriptorPublic,
  resolveScope,
  transformConfigOf,
} from "sandbox-factory";
import type {
  AliasRule,
  EvaluationCommand,
  EvaluationExecResult,
  EvaluationProvider,
  SandboxBuildManifest,
  VersionFixtures,
} from "sandbox-factory";
import type {
  AgentModel,
  AgentSettings,
  AgentTurn,
} from "../src/agent/loop.js";
import { AnalysisError } from "../src/errors.js";
import { HIDDEN_TEST_RUNS_MAX } from "../src/tools/hidden-tests.js";
import {
  BUILD_TRANSFORM_PATH,
  buildArtifactKind,
  createSandboxBuildAdapter,
  nearestCompilerOptions,
  packageVocabulary,
  privateTestOutcome,
} from "../src/tools/sandbox-build.js";
import { stubModules } from "../src/tools/slice-run.js";
import { sha256 } from "../src/tools/slice/hash.js";
import type { ToolInputs, ToolRunInput } from "../src/tools/adapter.js";
import { fixture, slice, sliceRun, stamp } from "./fixture-slice.js";

/**
 * What the test runner reports for a hidden test that failed as one should:
 * a test that ran and failed, which is not a file that never ran.
 */
const TAP_FAILED = {
  exitCode: 1,
  stdout:
    "TAP version 13\nnot ok 1 - fails\n  failureType: 'testCodeFailure'\n1..1\n# tests 1\n# pass 0\n# fail 1\n",
};

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
  const stored: StoredVersionWithSource = {
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
      origin: "slice",
      sourceSnapshotId: "rsn_1",
      sourceCommitSha: "a".repeat(40),
      sliceRunId: sliceRun.id,
      starterRunId: null,
      starterSha256: null,
      manifestSha256: overrides.stale === true ? "0".repeat(64) : manifestSha,
      contractSha256: contractSha,
      // Computed below from the content, as the API stores them.
      transformConfigSha256: "",
      approvedTaskSha256: "",
      proposalVersion: 1,
      contextVersions: { jira: null, github: null },
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
  const { source } = stored;
  return {
    ...stored,
    source: {
      ...source,
      transformConfigSha256: sha256(
        canonicalJson(
          transformConfigOf({
            aliasRules: source.aliasRules,
            dependencyChoices: source.dependencyChoices,
            acceptanceTests: source.acceptanceTests,
            fixtures: source.fixtures,
            starterSha256: source.starterSha256,
          }),
        ),
      ),
      approvedTaskSha256: sha256(canonicalJson(source.approvedTask)),
    },
  };
}

async function runBuild(
  provider: EvaluationProvider | null,
  options: Partial<{
    version: StoredVersionWithSource | null;
    sliceStatus: StoredAnalysisRun["status"];
    corrupt: boolean;
    params: Partial<Record<string, unknown>>;
    sourceDir: string;
    outDir: string;
    snapshotId: string;
    agent: AgentSettings;
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
    recordStarterOutput: async () => false,
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
  const adapter = createSandboxBuildAdapter({
    provider,
    ...(options.agent === undefined ? {} : { agent: options.agent }),
    now: () => new Date(stamp),
  });
  const files = await adapter.run(input);
  const read = async (path: string) => readFile(join(outDir, path), "utf8");
  const manifest = JSON.parse(
    await read("build-manifest.json"),
  ) as SandboxBuildManifest;
  return { files, manifest, read, messages, outDir, adapter, version };
}

let toolCalls = 0;
const call = (name: string, input: unknown) => ({
  type: "tool_use",
  id: `${name}-${(toolCalls += 1)}`,
  name,
  input,
});
const turn = (content: unknown[], stopReason = "tool_use"): AgentTurn => ({
  content: content as AgentTurn["content"],
  stopReason,
  usage: {
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  },
});
/** A model that takes the given turns, and what each turn was told. */
function scripted(turns: AgentTurn[]): AgentModel & {
  results: { content: string; is_error?: boolean }[][];
  prompts: string[];
} {
  const results: { content: string; is_error?: boolean }[][] = [];
  const prompts: string[] = [];
  return {
    model: "test-model",
    results,
    prompts,
    async turn(request) {
      const last = request.messages.at(-1);
      if (request.messages.length === 1)
        prompts.push(JSON.stringify(last?.content ?? ""));
      else if (Array.isArray(last?.content))
        results.push(
          last.content as unknown as { content: string; is_error?: boolean }[],
        );
      return turns.shift() ?? turn([], "refusal");
    },
  };
}
const limits = { maxTurns: 20, maxTokens: 1_000_000 };
/** How many evaluation jobs a provider's calls ran: one prepare each. */
const jobsOf = (calls: readonly string[][]) =>
  calls.filter((argv) => argv.includes("--package-lock-only")).length;
/** A table the slice already has, so no pseudonyms agent runs. */
const named: AliasRule[] = [
  { before: "retries", after: "attempts", kind: "identifier", paths: [] },
];
const hiddenTest = {
  path: "tests/private/acceptance.test.ts",
  text: 'import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("describes", () => { assert.equal(1, 2); });\n',
  expectedBaseline: "fail" as const,
};

test("a build produces a standalone project, hidden tests apart, a verified baseline and a bound manifest", async () => {
  const fake = fakeProvider((argv) =>
    argv.includes("--test") && !argv.includes("test") ? TAP_FAILED : {},
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
  // Packages are declared as the slice's check declared them: a package
  // the sources read is a module exporting what they read, as a value and
  // a type, not an untyped shorthand, and the build allows implicit `any`.
  const ambient = await read("project/sandbox/ambient.d.ts");
  assert.match(ambient, /declare module "pg" \{\n {2}const __default: any;/);
  assert.doesNotMatch(ambient, /declare module "pg";/);
  assert.match(ambient, /declare module "pg\/\*";/);
  const tsconfig = JSON.parse(await read("project/tsconfig.json")) as {
    compilerOptions: Record<string, unknown>;
  };
  assert.equal(tsconfig.compilerOptions["noImplicitAny"], false);
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
      argv.includes("--test") && !argv.includes("test") ? TAP_FAILED : {},
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
    argv.includes("--test") && !argv.includes("test") ? TAP_FAILED : {},
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
        ? TAP_FAILED
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

test("a rule named like a key renames text, never the keys of the spec, contract or fixtures", async () => {
  // A quote is a word boundary, so aliasing them serialized renamed
  // `"name":` and `"kind":` too, and the project came out with mocks of
  // `undefined`.
  const fake = fakeProvider((argv) =>
    argv.includes("--test") && !argv.includes("test") ? TAP_FAILED : {},
  );
  const { manifest, files } = await runBuild(fake.provider, {
    version: await versionFor({
      aliasRules: [
        { before: "name", after: "aliasedName", kind: "identifier", paths: [] },
        { before: "kind", after: "aliasedKind", kind: "identifier", paths: [] },
      ],
    }),
  });
  assert.deepEqual(manifest.blockers, []);
  assert.equal(manifest.ready, true);
  const mocks = files.filter((file) => file.path.startsWith("project/mocks/"));
  assert.ok(mocks.length > 0);
  for (const file of mocks)
    assert.doesNotMatch(await readFile(file.absolutePath, "utf8"), /undefined/);
});

test("build outputs are classified by path", () => {
  assert.equal(buildArtifactKind("build-manifest.json"), "build_manifest");
  assert.equal(buildArtifactKind("baseline.json"), "baseline_report");
  assert.equal(buildArtifactKind("project/src/app.ts"), "project_file");
  assert.equal(buildArtifactKind("private/fix.test.ts"), "private_test");
  assert.equal(buildArtifactKind("private/pseudonym.lunox"), "pseudonyms");
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
  // The hashes match, but the content under them moved: a hidden test or
  // the approved task changed without the hash that names it.
  const hashed = await versionFor();
  for (const tampered of [
    {
      ...hashed.source,
      acceptanceTests: [
        ...hashed.source.acceptanceTests,
        {
          path: "tests/private/extra.test.ts",
          text: "",
          expectedBaseline: "pass" as const,
        },
      ],
    },
    {
      ...hashed.source,
      approvedTask: { ...hashed.source.approvedTask, title: "Changed" },
    },
  ])
    assert.equal(
      await code(
        runBuild(fake.provider, { version: { ...hashed, source: tampered } }),
      ),
      "tool_failed",
    );
  assert.equal(fake.calls.length, 0);
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
        recordStarterOutput: async () => false,
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
  const prepared = (await runBuild(prepareFails.provider)).manifest.baseline;
  assert.deepEqual(
    prepared?.steps.map((s) => s.name),
    ["prepare"],
  );
  // The hidden tests did not run, but the version has them.
  assert.deepEqual(prepared?.reasons, ["prepare exited with 1."]);
  const ciFails = fakeProvider((argv) =>
    argv[1] === "ci" ? { exitCode: 1 } : {},
  );
  assert.deepEqual(
    (await runBuild(ciFails.provider)).manifest.baseline?.steps.map(
      (s) => s.name,
    ),
    ["prepare", "install"],
  );
  // A sandbox no hidden test judges could never accept a submission, so
  // it is not ready, however green its harness.
  const noTests = await runBuild(fakeProvider().provider, {
    version: await versionFor({ acceptance: false }),
  });
  assert.equal(noTests.manifest.ready, false);
  assert.deepEqual(noTests.manifest.baseline?.privateTests, []);
  assert.deepEqual(noTests.manifest.baseline?.reasons, [
    "No hidden test judges a submission.",
  ]);
});

test("a public file naming the workspace blocks the build before any job runs", async () => {
  const fake = fakeProvider();
  const leaked = await runBuild(fake.provider, {
    params: { vocabulary: ["Widget", "Nowhere Inc"] },
  });
  assert.equal(leaked.manifest.ready, false);
  assert.equal(leaked.manifest.baseline, null);
  assert.deepEqual(
    leaked.manifest.blockers.map((blocker) => blocker.code),
    ["vocabulary_leaked"],
  );
  assert.match(
    leaked.manifest.blockers[0]?.detail ?? "",
    /^"widget" names the workspace and appears \d+ times? in \d+ public files?: /,
  );
  assert.equal(fake.calls.length, 0);
  assert.ok(
    leaked.messages.includes("Public files still name the workspace: widget."),
  );
  // A build queued before the check carries no names, and the fixture's
  // own package name is nowhere public.
  const clean = await runBuild(fakeProvider().provider);
  assert.equal(
    clean.manifest.blockers.some((b) => b.code === "vocabulary_leaked"),
    false,
  );
  assert.ok(
    clean.messages.includes(
      "No public file names the workspace (1 name(s) checked).",
    ),
  );
});

test("a repository's package.json names its scope or package, and its author", async () => {
  const dir = await mkdtemp(join(tmpdir(), "package-vocabulary-"));
  const names = async (manifest: unknown) => {
    await writeFile(
      join(dir, "package.json"),
      typeof manifest === "string" ? manifest : JSON.stringify(manifest),
    );
    return packageVocabulary(dir);
  };
  try {
    assert.deepEqual(await packageVocabulary(dir), []);
    assert.deepEqual(
      await names({
        name: "@acme/monorepo",
        author: "Jo Doe <jo@acme.dev> (https://acme.dev)",
      }),
      ["acme", "Jo Doe"],
    );
    assert.deepEqual(
      await names({ name: "storefront", author: { name: "Acme Corp" } }),
      ["storefront", "Acme Corp"],
    );
    assert.deepEqual(await names({ name: "@", author: { email: "x" } }), []);
    assert.deepEqual(await names({ author: 7 }), []);
    assert.deepEqual(await names("null"), []);
    assert.deepEqual(await names("{ not json"), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
    recordStarterOutput: async () => false,
  };
  const ready = await runBuild(
    fakeProvider((argv) =>
      argv.includes("--test") && !argv.includes("test") ? TAP_FAILED : {},
    ).provider,
  );
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

test("a hidden test that never ran is an error, not the failure it was expected to show", () => {
  // As Node's runner reports each: a failed assertion, a file that threw
  // while loading, and one that imported something missing.
  const failed = TAP_FAILED.stdout;
  const fileFailed = [
    "TAP version 13",
    "# Error: boom at load",
    "# Subtest: load.test.js",
    "not ok 1 - load.test.js",
    "  failureType: 'testCodeFailure'",
    "  exitCode: 1",
    "  signal: ~",
    "  error: 'test failed'",
    "  code: 'ERR_TEST_FAILURE'",
    "1..1",
    "# tests 1",
    "# pass 0",
    "# fail 1",
  ].join("\n");
  const exited = { exitCode: 1, timedOut: false };
  assert.equal(privateTestOutcome(exited, failed), "fail");
  // Tests that ran and failed: one asserting on an `exitCode`, one throwing
  // something other than an assertion, which the runner also codes.
  const testsFailed = [
    "TAP version 13",
    "not ok 1 - exits cleanly",
    "  failureType: 'testCodeFailure'",
    "  error: 'Expected values to be strictly deep-equal'",
    "  code: 'ERR_ASSERTION'",
    "  expected:",
    "    exitCode: 0",
    "  actual:",
    "    exitCode: 1",
    "not ok 2 - builds",
    "  failureType: 'testCodeFailure'",
    "  error: 'x is not a function'",
    "  code: 'ERR_TEST_FAILURE'",
    "1..2",
    "# tests 2",
    "# pass 0",
    "# fail 2",
  ].join("\n");
  assert.equal(privateTestOutcome(exited, testsFailed), "fail");
  assert.equal(privateTestOutcome(exited, fileFailed), "error");
  // A report cut short, or none at all, says nothing ran and failed.
  assert.equal(privateTestOutcome(exited, ""), "error");
  assert.equal(
    privateTestOutcome({ exitCode: 0, timedOut: false }, ""),
    "pass",
  );
  assert.equal(
    privateTestOutcome({ exitCode: 2, timedOut: false }, failed),
    "error",
  );
  assert.equal(
    privateTestOutcome({ exitCode: null, timedOut: true }, failed),
    "error",
  );
});

test("a draft with no pseudonyms has an agent write them, checked as the build applies them, and they settle with the build", async () => {
  const fake = fakeProvider((argv) =>
    argv.includes("--test") && !argv.includes("test") ? TAP_FAILED : {},
  );
  const rules: AliasRule[] = [
    { before: "Widget", after: "Gadget", kind: "identifier", paths: [] },
    { before: "widget", after: "gadget", kind: "text", paths: [] },
  ];
  const model = scripted([
    // Two names of one kind that differ only by case do not hold.
    turn([
      call("check_pseudonyms", {
        aliases: [
          { before: "Widget", after: "Gadget", kind: "text" },
          { before: "widget", after: "gadget", kind: "text" },
        ],
      }),
    ]),
    // The title still names the workspace.
    turn([
      call("check_pseudonyms", {
        aliases: [{ before: "Widget", after: "Gadget", kind: "identifier" }],
      }),
    ]),
    // A rule that renames nothing is not kept.
    turn([
      call("check_pseudonyms", {
        aliases: [
          ...rules,
          { before: "absentName", after: "otherName", kind: "identifier" },
        ],
      }),
    ]),
    turn([call("check_pseudonyms", { aliases: [] })]),
    turn([
      call("submit_pseudonyms", {
        aliases: [rules[0]],
        summary: "Renames the product.",
      }),
    ]),
    turn([
      call("submit_pseudonyms", {
        aliases: rules,
        summary: "Renames the product.",
      }),
    ]),
  ]);
  const version = await versionFor();
  const built = await runBuild(fake.provider, {
    version,
    params: { vocabulary: ["Widget"] },
    agent: { model, limits },
  });
  assert.deepEqual(built.manifest.blockers, []);
  assert.equal(built.manifest.ready, true);
  // The agent was told what the workspace is called, and where it leaks.
  assert.match(model.prompts[0] ?? "", /no public file may carry: widget/);
  assert.match(model.prompts[0] ?? "", /With no pseudonyms, the check says/);
  const told = model.results.map((result) => result[0]);
  assert.equal(told[0]?.is_error, true);
  assert.match(told[0]?.content ?? "", /casing_variant/);
  assert.match(told[1]?.content ?? "", /"widget" names the workspace/);
  assert.match(told[2]?.content ?? "", /Rule 3 \(absentName\) renames nothing/);
  assert.match(told[3]?.content ?? "", /Invalid input/);
  assert.match(told[4]?.content ?? "", /does not hold/);
  assert.equal(told[4]?.is_error, true);
  // The project is renamed by the table, which the private side keeps.
  assert.deepEqual(
    JSON.parse(await built.read("private/pseudonym.lunox")).rules,
    rules,
  );
  assert.match(await built.read("project/README.md"), /Fix the gadget/);
  const transformConfigSha256 = sha256(
    canonicalJson(
      transformConfigOf({
        aliasRules: rules,
        dependencyChoices: {},
        acceptanceTests: version.source.acceptanceTests,
        fixtures: null,
        starterSha256: null,
      }),
    ),
  );
  assert.equal(built.manifest.transformConfigSha256, transformConfigSha256);
  const recorded: unknown[] = [];
  await built.adapter.committed?.({
    runId: "arn_build",
    files: built.files,
    inputs: {
      getRun: async () => null,
      listArtifacts: async () => [],
      readArtifact: async () => undefined,
      getVersion: async () => null,
      getTask: async () => null,
      recordBuildOutput: async (versionId, runId, output) => {
        recorded.push({ versionId, runId, output });
        return true;
      },
      recordStarterOutput: async () => false,
    },
  });
  assert.deepEqual(recorded, [
    {
      versionId: "sbv_1",
      runId: "arn_build",
      output: {
        harnessSha256: built.manifest.harnessSha256,
        toolchainDigest: built.manifest.toolchainDigest,
        transform: {
          aliasRules: rules,
          fromTransformConfigSha256: version.source.transformConfigSha256,
          transformConfigSha256,
        },
      },
    },
  ]);
});

test("a draft whose agent keeps no table, or that has no model, is built without one and blocks on the names it leaks", async () => {
  const fake = fakeProvider();
  const gaveUp = await runBuild(fake.provider, {
    params: { vocabulary: ["Widget"] },
    agent: { model: scripted([]), limits },
  });
  assert.deepEqual(
    gaveUp.manifest.blockers.map((blocker) => blocker.code),
    ["vocabulary_leaked"],
  );
  assert.equal(fake.calls.length, 0);
  assert.equal(
    gaveUp.files.some((file) => file.path === BUILD_TRANSFORM_PATH),
    false,
  );
  assert.ok(
    gaveUp.messages.some((line) => /with no table kept/.test(line)),
    gaveUp.messages.join("\n"),
  );
  const unconfigured = await runBuild(fakeProvider().provider, {
    agent: { model: null, limits },
  });
  assert.ok(
    unconfigured.messages.includes(
      "No agent model is configured; no pseudonyms are written.",
    ),
  );
});

test("a draft with no hidden tests has an agent write them, and the build is the baseline they passed", async () => {
  const fake = fakeProvider((argv) =>
    argv.includes("--test") && !argv.includes("test") ? TAP_FAILED : {},
  );
  const model = scripted([
    turn([
      call("read_file", {
        path: "src/app.ts",
        startLine: null,
        endLine: null,
      }),
    ]),
    turn([call("run_hidden_tests", { tests: [hiddenTest] })]),
    turn([
      call("submit_hidden_tests", {
        tests: [hiddenTest],
        summary: "Checks the described thing.",
      }),
    ]),
  ]);
  const version = await versionFor({ acceptance: false, aliasRules: named });
  const built = await runBuild(fake.provider, {
    version,
    agent: { model, limits },
  });
  assert.equal(
    built.manifest.ready,
    true,
    JSON.stringify(built.manifest.baseline?.reasons),
  );
  assert.deepEqual(built.manifest.blockers, []);
  assert.deepEqual(built.manifest.baseline?.privateTests, [
    {
      path: hiddenTest.path,
      expected: "fail",
      observed: "fail",
      ok: true,
    },
  ]);
  // The first baseline, the run and the submission's: a job each.
  assert.equal(jobsOf(fake.calls), 3);
  // The agent read the developer's project and was told the spec.
  assert.match(model.prompts[0] ?? "", /createService describes a thing/);
  assert.equal(model.results[0]?.[0]?.is_error, undefined);
  assert.match(model.results[0]?.[0]?.content ?? "", /createService/);
  assert.match(model.results[1]?.[0]?.content ?? "", /^The baseline passes\./);
  // The manifest binds the transform the draft has with the tests.
  const transformConfigSha256 = sha256(
    canonicalJson(
      transformConfigOf({
        aliasRules: named,
        dependencyChoices: {},
        acceptanceTests: [hiddenTest],
        fixtures: null,
        starterSha256: null,
      }),
    ),
  );
  assert.equal(built.manifest.transformConfigSha256, transformConfigSha256);
  const paths = built.files.map((file) => file.path);
  assert.ok(paths.includes("private/acceptance.test.ts"));
  assert.ok(paths.includes(BUILD_TRANSFORM_PATH));
  assert.equal(buildArtifactKind(BUILD_TRANSFORM_PATH), "other");
  // They settle on the draft with the build's evidence when it commits.
  const recorded: unknown[] = [];
  await built.adapter.committed?.({
    runId: "arn_build",
    files: built.files,
    inputs: {
      getRun: async () => null,
      listArtifacts: async () => [],
      readArtifact: async () => undefined,
      getVersion: async () => null,
      getTask: async () => null,
      recordBuildOutput: async (versionId, runId, output) => {
        recorded.push({ versionId, runId, output });
        return true;
      },
      recordStarterOutput: async () => false,
    },
  });
  assert.deepEqual(recorded, [
    {
      versionId: "sbv_1",
      runId: "arn_build",
      output: {
        harnessSha256: built.manifest.harnessSha256,
        toolchainDigest: built.manifest.toolchainDigest,
        transform: {
          acceptanceTests: [hiddenTest],
          fromTransformConfigSha256: version.source.transformConfigSha256,
          transformConfigSha256,
        },
      },
    },
  ]);
});

test("hidden tests that never pass their baseline are not kept, and the build stays diagnostic", async () => {
  // The hidden test passes on the baseline, though it is said to fail.
  const fake = fakeProvider();
  const submit = () =>
    turn([
      call("submit_hidden_tests", {
        tests: [hiddenTest],
        summary: "Checks the described thing.",
      }),
    ]);
  const model = scripted(
    Array.from({ length: HIDDEN_TEST_RUNS_MAX + 1 }, submit),
  );
  const built = await runBuild(fake.provider, {
    version: await versionFor({ acceptance: false, aliasRules: named }),
    agent: { model, limits },
  });
  assert.equal(built.manifest.ready, false);
  assert.equal(jobsOf(fake.calls), 1 + HIDDEN_TEST_RUNS_MAX);
  assert.deepEqual(built.manifest.baseline?.reasons, [
    "No hidden test judges a submission.",
  ]);
  assert.equal(
    built.files.some((file) => file.path === BUILD_TRANSFORM_PATH),
    false,
  );
  assert.ok(
    built.messages.some((line) => /with no tests kept/.test(line)),
    built.messages.join("\n"),
  );
});

test("hidden tests are written only for a draft with none whose baseline fails for that alone", async () => {
  // A draft with hidden tests is built as it is.
  const untouched = scripted([]);
  const withTests = await runBuild(
    fakeProvider((argv) =>
      argv.includes("--test") && !argv.includes("test") ? TAP_FAILED : {},
    ).provider,
    {
      version: await versionFor({ aliasRules: named }),
      agent: { model: untouched, limits },
    },
  );
  assert.equal(withTests.manifest.ready, true);
  assert.deepEqual(untouched.prompts, []);
  // A project that does not build is not the tests' to fix.
  const broken = scripted([]);
  const failing = await runBuild(
    fakeProvider((argv) => (argv.includes("build") ? { exitCode: 2 } : {}))
      .provider,
    {
      version: await versionFor({ acceptance: false, aliasRules: named }),
      agent: { model: broken, limits },
    },
  );
  assert.equal(failing.manifest.ready, false);
  assert.deepEqual(broken.prompts, []);
  // Without a model, the build says why it wrote none.
  const unconfigured = await runBuild(fakeProvider().provider, {
    version: await versionFor({ acceptance: false, aliasRules: named }),
    agent: { model: null, limits },
  });
  assert.equal(unconfigured.manifest.ready, false);
  assert.ok(
    unconfigured.messages.includes(
      "No agent model is configured; no hidden tests are written.",
    ),
  );
});
