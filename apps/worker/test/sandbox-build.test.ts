import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
  StoredAnalysisRun,
  StoredArtifact,
  StoredVersionWithSource,
} from "@sandbox-factory/db";
import {
  PSEUDONYM_PLACEHOLDERS,
  canonicalJson,
  descriptorPublic,
  resolveScope,
  transformConfigOf,
  workspaceVocabulary,
} from "sandbox-factory";
import type {
  AliasRule,
  EvaluationCommand,
  GeneratedFile,
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
import { HIDDEN_TESTS_SYSTEM_PROMPT } from "../src/agent/prompts.js";
import {
  HIDDEN_TEST_RUNS_MAX,
  PROMPT_PROJECT_CHARS,
  hiddenTestScaffold,
  quotedProject,
} from "../src/tools/hidden-tests.js";
import { unresolvedImportRules } from "../src/tools/pseudonyms.js";
import {
  BUILD_TRANSFORM_PATH,
  buildArtifactKind,
  createSandboxBuildAdapter,
  nearestCompilerOptions,
  packageVocabulary,
  privateTestOutcome,
  tapPoints,
} from "../src/tools/sandbox-build.js";
import { stubModules } from "../src/tools/slice-run.js";
import { sha256 } from "../src/tools/slice/hash.js";
import type { ToolInputs, ToolRunInput } from "../src/tools/adapter.js";
import type { contextRun } from "./context-fixtures.js";
import { fixture, sha, slice, sliceRun, stamp } from "./fixture-slice.js";
import type { SliceOutput } from "./fixture-slice.js";
import { timingRecorder } from "../src/timing.js";

/**
 * What the test runner reports for a hidden test that failed as one should:
 * a test that ran and failed, which is not a file that never ran.
 */
const TAP_FAILED = {
  exitCode: 1,
  stdout:
    "TAP version 13\nnot ok 1 - fails\n  failureType: 'testCodeFailure'\n1..1\n# tests 1\n# pass 0\n# fail 1\n",
};

/** What Node 22's runner reports for a file whose one test passed. */
const TAP_PASSED = {
  exitCode: 0,
  stdout:
    "TAP version 13\n# Subtest: passes\nok 1 - passes\n  ---\n  duration_ms: 0.27\n  type: 'test'\n  ...\n1..1\n# tests 1\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 40.13\n",
};

/** A hidden test's run: the public tests run without a TAP reporter. */
const runsHiddenTest = (argv: readonly string[]) =>
  argv.includes("--test-reporter=tap");
/** The walkthrough, as the baseline runs it once the project is built. */
const DEV = "node --env-file=sandbox.env sandbox/run.js";
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
    slice: SliceOutput;
  }> = {},
): Promise<StoredVersionWithSource> {
  const { artifacts, manifest, contract } = overrides.slice ?? (await slice());
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
    /** Context builders' runs the build can read, beside the slice. */
    served: readonly ReturnType<typeof contextRun>[];
    /** The slice run's outputs, when not the fixture's own. */
    slice: SliceOutput;
  }> = {},
) {
  const { artifacts, objects } = options.slice ?? (await slice());
  const served = options.served ?? [];
  const version =
    options.version === undefined ? await versionFor() : options.version;
  const outDir =
    options.outDir ?? (await mkdtemp(join(tmpdir(), "build-out-")));
  const messages: string[] = [];
  const timing = timingRecorder();
  /** Each preview the build showed: its paths, and what was logged before. */
  const previews: { paths: string[]; logged: string[]; text: string }[] = [];
  const inputs: ToolInputs = {
    getRun: async (id) =>
      id === sliceRun.id
        ? { ...sliceRun, status: options.sliceStatus ?? "succeeded" }
        : (served.find((entry) => entry.run.id === id)?.run ?? null),
    listArtifacts: async (id) =>
      id === sliceRun.id
        ? artifacts
        : served.flatMap((entry) =>
            entry.run.id === id ? [entry.artifact] : [],
          ),
    readArtifact: async (key) =>
      options.corrupt === true && key.endsWith("boundary-contract.json")
        ? Buffer.from("tampered")
        : (served.find((entry) => entry.artifact.objectKey === key)?.bytes ??
          objects.get(key)),
    getVersion: async (id) => (id === "sbv_1" ? version : null),
    getTask: async () => null,
    recordBuildOutput: async () => false,
    recordStarterOutput: async () => false,
  };
  const input: ToolRunInput = {
    runId: "arn_build",
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
    preview: (shown) => {
      const app = shown.find(({ path }) => path === "project/src/app.ts");
      previews.push({
        paths: shown.map(({ path }) => path),
        logged: [...messages],
        text: app === undefined ? "" : readFileSync(app.absolutePath, "utf8"),
      });
    },
    timing,
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
  return {
    files,
    manifest,
    read,
    messages,
    outDir,
    adapter,
    version,
    previews,
    timing: timing.value(),
  };
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
/** A model whose every turn waits until the run stops it. */
function waiting(): AgentModel {
  return {
    model: "test-model",
    turn: (_request, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
  };
}
/**
 * One model for agents that run at once, each played its own turns by its
 * system prompt; the prompts each was first sent, by the same key.
 */
function routed(turns: Record<string, AgentTurn[]>): AgentModel & {
  prompts: Record<string, string[]>;
} {
  const prompts: Record<string, string[]> = {};
  return {
    model: "test-model",
    prompts,
    async turn(request) {
      if (request.messages.length === 1)
        (prompts[request.system] ??= []).push(
          JSON.stringify(request.messages[0]?.content ?? ""),
        );
      return turns[request.system]?.shift() ?? turn([], "refusal");
    },
  };
}
/** How many evaluation jobs a provider's calls ran: one prepare each. */
const jobsOf = (calls: readonly string[][]) =>
  calls.filter((argv) => argv.includes("--package-lock-only")).length;
/** A table the slice already has, so no pseudonyms agent runs. */
const named: AliasRule[] = [
  { before: "retries", after: "attempts", kind: "identifier", paths: [] },
];
/** Fixtures the draft already has, so no fixtures agent runs. */
const given: VersionFixtures = {
  fixtureRunId: null,
  fixtures: [],
  scenario: null,
};
const hiddenTest = {
  path: "tests/private/acceptance.test.ts",
  text: 'import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("describes", () => { assert.equal(1, 2); });\n',
  expectedBaseline: "fail" as const,
};

test("a build produces a standalone project, hidden tests apart, a verified baseline and a bound manifest", async () => {
  const fake = fakeProvider((argv) => (runsHiddenTest(argv) ? TAP_FAILED : {}));
  const { files, manifest, read, timing, previews } = await runBuild(
    fake.provider,
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
  // The generated project was shown before its baseline ran, at the paths
  // the build keeps it at.
  assert.equal(previews.length, 1);
  assert.ok(previews[0]?.paths.includes("project/src/app.ts"));
  assert.ok(previews[0]?.paths.includes("private/fix.test.ts"));
  assert.match(previews[0]?.text ?? "", /makeService/);
  // Shown while the baseline ran, not after the build settled.
  assert.equal(
    previews[0]?.logged.some((line) =>
      /^Sandbox build (ready|completed)/.test(line),
    ),
    false,
  );
  // The baseline's steps, each as long as the evaluator said it ran.
  assert.equal(timing.baselines?.length, 1);
  assert.deepEqual(
    timing.baselines?.[0]?.map((step) => step.name),
    manifest.baseline?.steps.map((step) => step.name),
  );
  assert.ok(timing.baselines?.[0]?.every((step) => step.durationMs === 1));
  assert.ok(manifest.baseline?.steps.every((step) => step.durationMs === 1));
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
      // Built once: the walkthrough and the public tests run what their
      // scripts run after building.
      "node --env-file=sandbox.env sandbox/run.js",
      "node --env-file=sandbox.env --test",
      // The hidden test, twice: once each round.
      "node --env-file=sandbox.env --test",
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
    fakeProvider((argv) => (runsHiddenTest(argv) ? TAP_FAILED : {})).provider,
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
  const fake = fakeProvider((argv) => (runsHiddenTest(argv) ? TAP_FAILED : {}));
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
  assert.ok(fake.calls.some((argv) => argv.join(" ") === DEV));
  // A walkthrough that fails on the baseline fails the build.
  const failing = fakeProvider((argv) =>
    argv.join(" ") === DEV
      ? { exitCode: 1 }
      : runsHiddenTest(argv)
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

test("a sliced draft with no fixtures is built without them, and no agent is asked for any", async () => {
  const rule: AliasRule = {
    before: "createService",
    after: "makeService",
    kind: "identifier",
    paths: [],
  };
  const fake = fakeProvider((argv) => (runsHiddenTest(argv) ? TAP_FAILED : {}));
  // No turns: an agent asked for anything would keep nothing.
  const model = scripted([]);
  const built = await runBuild(fake.provider, {
    version: await versionFor({ aliasRules: [rule] }),
    agent: { model, limits },
  });
  assert.deepEqual(built.manifest.blockers, []);
  assert.equal(built.manifest.ready, true);
  assert.deepEqual(model.prompts, []);
  assert.ok(
    built.messages.includes(
      "No fixtures: the mocks answer with recording mocks and the walkthrough lists the entry points.",
    ),
  );
  // Every mock still answers, and the default walkthrough runs.
  assert.doesNotMatch(
    await built.read("project/README.md"),
    /mocked calls? ha(s|ve) default behaviour/,
  );
  assert.match(
    await built.read("project/sandbox/run.ts"),
    /Object\.keys\(await import\(/,
  );
  assert.ok(fake.calls.some((argv) => argv.join(" ") === DEV));
  // Nothing was written for the draft, so nothing settles on it.
  assert.equal(
    built.files.some((file) => file.path === BUILD_TRANSFORM_PATH),
    false,
  );
});

test("a rule named like a key renames text, never the keys of the spec, contract or fixtures", async () => {
  // A quote is a word boundary, so aliasing them serialized renamed
  // `"name":` and `"kind":` too, and the project came out with mocks of
  // `undefined`.
  const fake = fakeProvider((argv) => (runsHiddenTest(argv) ? TAP_FAILED : {}));
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
    runsHiddenTest(argv) ? { exitCode: 2 } : {},
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
    runsHiddenTest(argv) ? { exitCode: null, timedOut: true } : {},
  );
  assert.equal(
    (await runBuild(timed.provider)).manifest.baseline?.privateTests[0]
      ?.observed,
    "error",
  );
  const unexpected = fakeProvider((argv) =>
    runsHiddenTest(argv) ? TAP_PASSED : {},
  );
  assert.deepEqual(
    (await runBuild(unexpected.provider)).manifest.baseline?.privateTests[0],
    {
      path: "tests/private/fix.test.ts",
      expected: "fail",
      observed: "pass",
      ok: false,
    },
  );
  // An exit 0 with no report says nothing passed.
  assert.equal(
    (await runBuild(fakeProvider().provider)).manifest.baseline?.privateTests[0]
      ?.observed,
    "error",
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
  // A table that does not rename it.
  const leaked = await runBuild(fake.provider, {
    version: await versionFor({ aliasRules: named }),
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

/** The fixture's slice, its manifest requiring `packages` besides its own. */
async function sliceRequiring(
  packages: SliceOutput["manifest"]["requiredBuildInputs"]["packages"],
): Promise<SliceOutput> {
  const sliced = await slice();
  const manifest = {
    ...sliced.manifest,
    requiredBuildInputs: {
      ...sliced.manifest.requiredBuildInputs,
      packages: [...sliced.manifest.requiredBuildInputs.packages, ...packages],
    },
  };
  const bytes = Buffer.from(JSON.stringify(manifest));
  const objects = new Map(sliced.objects);
  const artifacts = sliced.artifacts.map((artifact) => {
    if (artifact.kind !== "slice_manifest") return artifact;
    objects.set(artifact.objectKey, bytes);
    return { ...artifact, sha256: sha(bytes), sizeBytes: bytes.byteLength };
  });
  return { ...sliced, artifacts, objects, manifest };
}

test("a private package's scope or name blocks the build until the table renames it", async () => {
  const pkg = (name: string) => ({
    name,
    version: "1.0.0",
    declaredIn: "package.json",
  });
  const privateRegistry = { source: "private" as const, evidence: ".npmrc" };
  const sliced = await sliceRequiring([
    { ...pkg("@acmeinc/ledger"), workspace: true },
    { ...pkg("payflow-sdk"), registry: privateRegistry },
    // Mocked by default, a public package's name names no one.
    pkg("left-pad"),
  ]);
  const leaked = await runBuild(fakeProvider().provider, {
    slice: sliced,
    version: await versionFor({ slice: sliced, aliasRules: named }),
  });
  assert.equal(leaked.manifest.baseline, null);
  assert.deepEqual(
    leaked.manifest.blockers.map((blocker) => blocker.code),
    ["vocabulary_leaked", "vocabulary_leaked"],
  );
  assert.match(
    leaked.manifest.blockers[0]?.detail ?? "",
    /^"acmeinc" names the workspace .*package\.json/,
  );
  assert.match(
    leaked.manifest.blockers[1]?.detail ?? "",
    /^"payflow-sdk" names the workspace /,
  );
  // Renamed, the scope is gone from every public file, the mock included.
  const scoped = await sliceRequiring([
    { ...pkg("@acmeinc/ledger"), workspace: true },
  ]);
  const renamed = await runBuild(fakeProvider().provider, {
    slice: scoped,
    version: await versionFor({
      slice: scoped,
      aliasRules: [
        {
          before: "acmeinc",
          after: "northwind",
          kind: "identifier",
          paths: [],
        },
      ],
    }),
  });
  assert.deepEqual(
    renamed.manifest.blockers.map((blocker) => blocker.code),
    ["baseline_failed"],
  );
  const pkgJson = JSON.parse(await renamed.read("project/package.json")) as {
    dependencies: Record<string, string>;
  };
  assert.equal(
    pkgJson.dependencies["@northwind/ledger"],
    "file:mocks/@northwind/ledger",
  );
});

test("a credential in a public file blocks the build before any job runs, naming its line, not its value", async () => {
  const key = ["AKIA", "Z3K7Q2M9W4X8C6V1"].join("");
  const fake = fakeProvider();
  const leaked = await runBuild(fake.provider, {
    version: await versionFor({
      fixtures: {
        fixtureRunId: "arn_fixtures",
        fixtures: [],
        scenario: `import { run } from "../src/app.js";\nconst region = "${key}";\nconsole.log(run({ name: region, retries: 1, nested: { enabled: true } }));\n`,
      },
    }),
  });
  assert.equal(leaked.manifest.ready, false);
  assert.equal(leaked.manifest.baseline, null);
  assert.equal(fake.calls.length, 0);
  assert.deepEqual(leaked.manifest.blockers, [
    {
      code: "secret_found",
      file: "sandbox/run.ts",
      detail:
        "A credential appears at sandbox/run.ts:2 (aws-access-key-id). Remove it or replace it with a fixture value.",
    },
  ]);
  assert.equal(JSON.stringify(leaked.manifest).includes(key), false);
});

test("a mocked package and an environment variable go by the names the table gives them", async () => {
  // Unrenamed, the variable's name reaches sandbox.env and the source.
  const leaked = await runBuild(fakeProvider().provider, {
    version: await versionFor({ aliasRules: named }),
    params: { vocabulary: ["database_url"] },
  });
  assert.deepEqual(
    leaked.manifest.blockers.map((blocker) => blocker.code),
    ["vocabulary_leaked"],
  );
  assert.match(
    leaked.manifest.blockers[0]?.detail ?? "",
    /public files: README\.md, sandbox\.env, src\/app\.ts\./,
  );
  // The table renames them everywhere a developer reads, mocks included.
  const renamed = await runBuild(fakeProvider().provider, {
    version: await versionFor({
      aliasRules: [
        { before: "pg", after: "store", kind: "identifier", paths: [] },
        {
          before: "DATABASE_URL",
          after: "STORE_URL",
          kind: "identifier",
          paths: [],
        },
      ],
    }),
    params: { vocabulary: ["database_url"] },
  });
  // The fake job passes every test, which a hidden one was not to.
  assert.deepEqual(
    renamed.manifest.blockers.map((blocker) => blocker.code),
    ["baseline_failed"],
  );
  const app = await renamed.read("project/src/app.ts");
  assert.match(app, /import store from "store";/);
  assert.match(app, /process\.env\.STORE_URL/);
  const pkg = JSON.parse(await renamed.read("project/package.json")) as {
    dependencies: Record<string, string>;
  };
  assert.deepEqual(pkg.dependencies, { store: "file:mocks/store" });
  assert.match(
    await renamed.read("project/mocks/store/package.json"),
    /"name": "store"/,
  );
  assert.match(
    await renamed.read("project/sandbox.env"),
    /^STORE_URL=sandbox-fixture-store-url$/m,
  );
  const paths = renamed.files.map((file) => file.path);
  assert.equal(
    paths.some((path) => path.startsWith("project/mocks/pg/")),
    false,
  );
  // A rename that is no longer a name of its kind is refused.
  const broken = await runBuild(fakeProvider().provider, {
    version: await versionFor({
      aliasRules: [
        { before: "pg", after: "Store", kind: "identifier", paths: [] },
        {
          before: "DATABASE_URL",
          after: "store url",
          kind: "text",
          paths: [],
        },
      ],
    }),
  });
  assert.deepEqual(
    broken.manifest.blockers.map((blocker) => blocker.detail),
    [
      "The alias table renames the package pg to Store, which is not a valid package name.",
      "The alias table renames the environment variable DATABASE_URL to store url, which is not a valid environment variable name.",
    ],
  );
  // So is a name Node keeps for itself: its own module, which it loads in
  // place of the mock, or a variable sandbox.env would set for it.
  const reserved = await runBuild(fakeProvider().provider, {
    version: await versionFor({
      aliasRules: [
        { before: "pg", after: "events", kind: "identifier", paths: [] },
        {
          before: "DATABASE_URL",
          after: "NODE_OPTIONS",
          kind: "identifier",
          paths: [],
        },
      ],
    }),
  });
  assert.deepEqual(
    reserved.manifest.blockers.map((blocker) => [blocker.code, blocker.detail]),
    [
      [
        "alias_failed",
        "The alias table renames the package pg to events, which is a module Node provides, which it loads in place of the mock.",
      ],
      [
        "alias_failed",
        "The alias table renames the environment variable DATABASE_URL to NODE_OPTIONS, which is a variable Node or npm reads, which sandbox.env would set for them.",
      ],
    ],
  );
  const long = `store${"x".repeat(210)}`;
  const tooLong = await runBuild(fakeProvider().provider, {
    version: await versionFor({
      aliasRules: [
        { before: "pg", after: long, kind: "identifier", paths: [] },
        {
          before: "DATABASE_URL",
          after: "npm_config_registry",
          kind: "identifier",
          paths: [],
        },
      ],
    }),
  });
  assert.deepEqual(
    tooLong.manifest.blockers.map((blocker) => blocker.detail),
    [
      `The alias table renames the package pg to ${long}, which is longer than the 214 characters a package name may have.`,
      "The alias table renames the environment variable DATABASE_URL to npm_config_registry, which is a variable Node or npm reads, which sandbox.env would set for them.",
    ],
  );
});

test("a repository's package.json names its scope or package, its author and their address", async () => {
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
        author: "Jo Doe <jo@payflow.dev> (https://acme.dev)",
      }),
      [
        { name: "acme", kind: "name" },
        { name: "Jo Doe", kind: "name" },
        { name: "jo", kind: "name" },
        // An address at the organization's own domain names it.
        { name: "payflow.dev", kind: "organization" },
      ],
    );
    assert.deepEqual(
      await names({
        name: "storefront",
        author: { name: "Acme Corp", email: "acme.builds@gmail.com" },
      }),
      [
        { name: "storefront", kind: "name" },
        { name: "Acme Corp", kind: "name" },
        // A public provider's domain says nothing of whose code it is.
        { name: "acme.builds", kind: "name" },
      ],
    );
    assert.deepEqual(
      workspaceVocabulary(await names({ author: "Jo <jo@payflowhq.io>" })),
      ["payflowhq-io", "payflowhq"],
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
    fakeProvider((argv) => (runsHiddenTest(argv) ? TAP_FAILED : {})).provider,
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
    "error",
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

/** A report as Node's runner writes it: points, the plan, then the counts. */
function tap(
  points: readonly string[],
  counts: Partial<Record<string, number>>,
): string {
  const all = {
    tests: 0,
    suites: 0,
    pass: 0,
    fail: 0,
    cancelled: 0,
    skipped: 0,
    todo: 0,
    ...counts,
  };
  return [
    "TAP version 13",
    ...points,
    `1..${points.filter((line) => /^(?:not )?ok /.test(line)).length}`,
    ...Object.entries(all).map(([name, value]) => `# ${name} ${value}`),
    "# duration_ms 38.6",
    "",
  ].join("\n");
}

test("an exit 0 is a pass only when the report says every test ran and passed", () => {
  const exited0 = { exitCode: 0, timedOut: false };
  const exited1 = { exitCode: 1, timedOut: false };
  const point = (line: string) => [
    `# Subtest: ${line.replace(/^(?:not )?ok \d+ - /, "")}`,
    line,
    "  ---",
    "  duration_ms: 0.3",
    "  type: 'test'",
    "  ...",
  ];
  // One test, or nested ones, that ran and passed.
  assert.equal(privateTestOutcome(exited0, TAP_PASSED.stdout), "pass");
  assert.equal(
    privateTestOutcome(exited0, tap(point("ok 1 - a"), { tests: 3, pass: 3 })),
    "pass",
  );
  // The file ended the process early: `process.exit(0)` at load or inside a
  // test, or code under test calling it. The runner reports the file as one
  // passing point named after it.
  const early = tap(point("ok 1 - tests/private/fix.test.js"), {
    tests: 1,
    pass: 1,
  });
  assert.equal(privateTestOutcome(exited0, early), "error");
  // So does a file that declares no test at all.
  assert.equal(
    privateTestOutcome(
      exited0,
      tap(point("ok 1 - /tmp/job/tests/private/empty.test.js"), {
        tests: 1,
        pass: 1,
      }),
    ),
    "error",
  );
  // Only todo or skipped tests, or some of them beside a pass.
  assert.equal(
    privateTestOutcome(
      exited0,
      tap([...point("not ok 1 - a # TODO"), ...point("ok 2 - b # SKIP")], {
        tests: 2,
        skipped: 1,
        todo: 1,
      }),
    ),
    "error",
  );
  assert.equal(
    privateTestOutcome(
      exited0,
      tap([...point("ok 1 - a"), ...point("ok 2 - c # SKIP")], {
        tests: 2,
        pass: 1,
        skipped: 1,
      }),
    ),
    "error",
  );
  // Counts the file printed itself come before the runner's, escaped or
  // not; only the trailing block is read.
  const forged = [
    "TAP version 13",
    "# pass 5",
    "# \\# fail 0",
    ...point("not ok 1 - a"),
    "1..1",
    "# tests 1",
    "# pass 0",
    "# fail 1",
    "",
  ].join("\n");
  assert.equal(privateTestOutcome(exited1, forged), "fail");
  assert.equal(privateTestOutcome(exited0, forged), "error");
  // A report whose counts are followed by anything else, or that has none.
  assert.equal(
    privateTestOutcome(exited0, `${TAP_PASSED.stdout}ok 2 - more\n`),
    "error",
  );
  assert.equal(
    privateTestOutcome(exited0, "TAP version 13\n1..1\n# pass 1\n"),
    "error",
  );
  // A cancelled test (a timeout) is not a failed one.
  assert.equal(
    privateTestOutcome(
      exited1,
      tap([...point("ok 1 - a"), ...point("not ok 2 - b")], {
        tests: 2,
        pass: 1,
        cancelled: 1,
      }),
    ),
    "error",
  );
  // Work left running after a test failed the file as a whole.
  assert.equal(
    privateTestOutcome(
      exited1,
      tap(
        [
          ...point("ok 1 - a"),
          "# Subtest: tests/private/fix.test.js",
          "not ok 2 - tests/private/fix.test.js",
          "  exitCode: 1",
          "  code: 'ERR_TEST_FAILURE'",
        ],
        { tests: 2, pass: 1, fail: 1 },
      ),
    ),
    "error",
  );
  // A path with a space in it is still the file's point; a test named
  // with a space and no directory is a test.
  assert.equal(
    privateTestOutcome(
      exited0,
      tap(point("ok 1 - /tmp/my job/tests/private/fix it.test.js"), {
        tests: 1,
        pass: 1,
      }),
    ),
    "error",
  );
  assert.equal(
    privateTestOutcome(
      exited0,
      tap(point("ok 1 - reads fix.test.js"), { tests: 1, pass: 1 }),
    ),
    "pass",
  );
  assert.deepEqual(tapPoints(early), ["ok 1 - tests/private/fix.test.js"]);
});

test("a hidden test that disagrees with itself across two runs is flaky, and the baseline fails", async () => {
  let runs = 0;
  const flaky = fakeProvider((argv) => {
    if (!runsHiddenTest(argv)) return {};
    runs += 1;
    return runs === 1 ? TAP_FAILED : TAP_PASSED;
  });
  const { manifest } = await runBuild(flaky.provider);
  assert.equal(runs, 2);
  assert.deepEqual(manifest.baseline?.privateTests, [
    {
      path: "tests/private/fix.test.ts",
      expected: "fail",
      observed: "flaky",
      ok: false,
    },
  ]);
  assert.match(
    manifest.baseline?.reasons.join(" ") ?? "",
    /fix\.test\.ts gave different results on two runs/,
  );
  assert.deepEqual(
    manifest.baseline?.steps
      .filter((step) => step.name === "private-test")
      .map((step) => step.ok),
    [false, false],
  );
  assert.equal(manifest.ready, false);
  // Same outcome, different tests failing: still flaky.
  let second = 0;
  const shifting = fakeProvider((argv) => {
    if (!runsHiddenTest(argv)) return {};
    second += 1;
    return {
      exitCode: 1,
      stdout: tap(
        second === 1
          ? ["not ok 1 - a", "ok 2 - b"]
          : ["ok 1 - a", "not ok 2 - b"],
        { tests: 2, pass: 1, fail: 1 },
      ),
    };
  });
  assert.equal(
    (await runBuild(shifting.provider)).manifest.baseline?.privateTests[0]
      ?.observed,
    "flaky",
  );
});

test("a draft with no pseudonyms has a table drafted by rule, checked as the build applies it, and it settles with the build", async () => {
  const fake = fakeProvider((argv) => (runsHiddenTest(argv) ? TAP_FAILED : {}));
  // No turns: an agent asked for anything would keep nothing.
  const model = scripted([]);
  const version = await versionFor({ fixtures: given });
  const built = await runBuild(fake.provider, {
    version,
    params: { vocabulary: ["Widget"] },
    agent: { model, limits },
  });
  assert.deepEqual(built.manifest.blockers, []);
  assert.equal(built.manifest.ready, true);
  assert.deepEqual(model.prompts, []);
  const rules = (
    JSON.parse(await built.read("private/pseudonym.lunox")) as {
      rules: AliasRule[];
    }
  ).rules;
  assert.ok(rules.length > 0);
  assert.ok(
    built.messages.includes(
      `The pseudonyms drafted by rule hold: ${rules.length} rule(s).`,
    ),
  );
  // The project is renamed by the table, which the private side keeps.
  assert.doesNotMatch(await built.read("project/README.md"), /widget/i);
  const transform = JSON.parse(await built.read(BUILD_TRANSFORM_PATH)) as {
    aliasRules: AliasRule[];
    pseudonyms: { usage: { turns: number } };
  };
  assert.deepEqual(transform.aliasRules, rules);
  // Drafted by rule, the table cost no turn.
  assert.equal(transform.pseudonyms.usage.turns, 0);
  const transformConfigSha256 = sha256(
    canonicalJson(
      transformConfigOf({
        aliasRules: rules,
        dependencyChoices: {},
        acceptanceTests: version.source.acceptanceTests,
        fixtures: given,
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
  // A slice that names nothing of the workspace needs no table at all.
  const unnamed = await runBuild(fakeProvider().provider, {
    version: await versionFor({ fixtures: given }),
    agent: { model: scripted([]), limits },
  });
  assert.ok(
    unnamed.messages.includes(
      "No public file names the workspace; no pseudonyms are needed.",
    ),
  );
  assert.equal(
    unnamed.files.some((file) => file.path === BUILD_TRANSFORM_PATH),
    false,
  );
});

test("a table drafted by rule that does not hold goes to the agent, which starts from it, and one nobody settles leaves the build blocked", async () => {
  // The walkthrough uses every placeholder but one: the term met first
  // takes it, the other gets none, and the draft leaves that one to leak.
  const version = await versionFor({
    fixtures: {
      ...given,
      scenario: `console.log("demo");\n// The widget and the WIDGET walkthrough, for ${PSEUDONYM_PLACEHOLDERS.slice(0, -1).join(", ")}.\n`,
    },
  });
  const vocabulary = ["Widget", "Thing"];
  const rules: AliasRule[] = [
    { before: "Widget", after: "Gadget", kind: "identifier", paths: [] },
    { before: "widget", after: "gadget", kind: "text", paths: [] },
    { before: "WIDGET", after: "GADGET", kind: "path", paths: [] },
    { before: "Thing", after: "Item", kind: "identifier", paths: [] },
    { before: "thing", after: "item", kind: "text", paths: [] },
  ];
  const model = scripted([
    turn([
      call("submit_pseudonyms", {
        aliases: rules,
        summary: "Renames the product.",
      }),
    ]),
  ]);
  const built = await runBuild(
    fakeProvider((argv) => (runsHiddenTest(argv) ? TAP_FAILED : {})).provider,
    { version, params: { vocabulary }, agent: { model, limits } },
  );
  assert.deepEqual(built.manifest.blockers, []);
  assert.ok(
    built.messages.some((line) =>
      /^The pseudonyms drafted by rule do not hold \(\d+ problem\(s\)\); an agent amends the table\.$/.test(
        line,
      ),
    ),
    built.messages.join("\n"),
  );
  // The agent was told what the workspace is called and what was drafted.
  assert.match(model.prompts[0] ?? "", /no public file may carry: widget/);
  assert.match(model.prompts[0] ?? "", /A table was drafted by rule/);
  assert.match(
    model.prompts[0] ?? "",
    new RegExp(`identifier Thing -> ${PSEUDONYM_PLACEHOLDERS.at(-1)}`, "i"),
  );
  assert.match(model.prompts[0] ?? "", /\\"widget\\" names the workspace/);
  assert.match(
    await built.read("project/sandbox/run.ts"),
    /The gadget and the GADGET walkthrough/,
  );
  const transform = JSON.parse(await built.read(BUILD_TRANSFORM_PATH)) as {
    aliasRules: AliasRule[];
    pseudonyms: { usage: { turns: number } };
  };
  assert.deepEqual(transform.aliasRules, rules);
  assert.equal(transform.pseudonyms.usage.turns, 1);

  // An agent that keeps nothing, or none at all, leaves the leak to block.
  const gaveUp = await runBuild(fakeProvider().provider, {
    version,
    params: { vocabulary },
    agent: { model: scripted([]), limits },
  });
  // Both names leak: the one the draft had no placeholder for, and the
  // one its rules would have renamed.
  assert.deepEqual(
    [...new Set(gaveUp.manifest.blockers.map((blocker) => blocker.code))],
    ["vocabulary_leaked"],
  );
  assert.equal(gaveUp.manifest.blockers.length, 2);
  assert.equal(
    gaveUp.files.some((file) => file.path === BUILD_TRANSFORM_PATH),
    false,
  );
  assert.ok(
    gaveUp.messages.some((line) => /with no table kept/.test(line)),
    gaveUp.messages.join("\n"),
  );
  const unconfigured = await runBuild(fakeProvider().provider, {
    version,
    params: { vocabulary },
    agent: { model: null, limits },
  });
  assert.ok(
    unconfigured.messages.includes(
      "No agent model is configured; no pseudonyms are written.",
    ),
  );
});

test("a draft with no hidden tests has an agent write them, and the build is the baseline they passed", async () => {
  const fake = fakeProvider((argv) => (runsHiddenTest(argv) ? TAP_FAILED : {}));
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
  const version = await versionFor({
    acceptance: false,
    aliasRules: named,
    fixtures: given,
  });
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
  // It starts with the project quoted: how it builds, the mocks' interface,
  // the code and its stubs, never the mock runtimes or the lockfile.
  for (const path of [
    "package.json",
    "tsconfig.json",
    "sandbox/mock.d.ts",
    "src/app.ts",
    "lib/service.d.ts",
  ])
    assert.match(model.prompts[0] ?? "", new RegExp(`--- ${path}\\\\n`));
  assert.doesNotMatch(model.prompts[0] ?? "", /--- sandbox\/mock\.js/);
  assert.doesNotMatch(model.prompts[0] ?? "", /--- lib\/service\.js/);
  // And a file per scenario, drafted by rule, importing the entry points
  // and the mock runtime from where it lives.
  assert.match(
    model.prompts[0] ?? "",
    /--- tests\/private\/s1-createservice-describes-a-thing\.test\.ts\\n/,
  );
  assert.match(
    model.prompts[0] ?? "",
    /import \* as app from \\"\.\.\/\.\.\/src\/app\.js\\";/,
  );
  assert.match(
    model.prompts[0] ?? "",
    /import \* as local from \\"\.\.\/\.\.\/src\/local\.js\\";/,
  );
  assert.match(
    model.prompts[0] ?? "",
    /from \\"\.\.\/\.\.\/sandbox\/mock\.js\\";/,
  );
  assert.match(model.prompts[0] ?? "", /\/\/ When createService runs/);
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
        fixtures: given,
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

test("a submission naming the last passing run keeps that run's set and baseline, with no further run", async () => {
  const fake = fakeProvider((argv) => (runsHiddenTest(argv) ? TAP_FAILED : {}));
  const efforts: string[] = [];
  const model = scripted([
    // Nothing has passed yet: the tests themselves are asked for.
    turn([call("submit_hidden_tests", { tests: null, summary: "Early." })]),
    turn([call("run_hidden_tests", { tests: [hiddenTest] })]),
    turn([
      call("submit_hidden_tests", {
        tests: null,
        summary: "Checks the described thing.",
      }),
    ]),
  ]);
  const asked = model.turn.bind(model);
  model.turn = async (request, signal) => {
    efforts.push(request.effort);
    return asked(request, signal);
  };
  const built = await runBuild(fake.provider, {
    version: await versionFor({
      acceptance: false,
      aliasRules: named,
      fixtures: given,
    }),
    agent: { model, limits },
  });
  assert.equal(built.manifest.ready, true);
  assert.match(
    model.results[0]?.[0]?.content ?? "",
    /submit the tests themselves/,
  );
  // The first baseline and the one run: the submission ran nothing.
  assert.equal(jobsOf(fake.calls), 2);
  assert.deepEqual(
    built.manifest.baseline?.privateTests.map((outcome) => outcome.path),
    [hiddenTest.path],
  );
  const transform = JSON.parse(await built.read(BUILD_TRANSFORM_PATH)) as {
    acceptanceTests: unknown[];
    hiddenTests: { summary: string };
  };
  assert.deepEqual(transform.acceptanceTests, [hiddenTest]);
  assert.equal(transform.hiddenTests.summary, "Checks the described thing.");
  assert.ok(
    built.messages.includes("Hidden-tests agent wrote 1 hidden test(s)."),
  );
  // Its baseline decides, so the agent thinks at medium effort.
  assert.deepEqual([...new Set(efforts)], ["medium"]);
});

test("a term inside a workspace import is renamed by rule all the way through the generated project", async () => {
  // `@lib/alias` is the fixture's path alias to a cut module: the draft
  // turns the import into the relative path of the stub, at the renamed
  // path the segment gets, and the generator finds nothing left to rewrite.
  const model = scripted([]);
  const built = await runBuild(
    fakeProvider((argv) => (runsHiddenTest(argv) ? TAP_FAILED : {})).provider,
    {
      version: await versionFor({ fixtures: given }),
      params: { vocabulary: ["alias"] },
      agent: { model, limits },
    },
  );
  assert.deepEqual(built.manifest.blockers, [], model.prompts[0] ?? "");
  assert.ok(
    built.messages.some((line) =>
      /^The pseudonyms drafted by rule hold: \d+ rule\(s\)\.$/.test(line),
    ),
    built.messages.join("\n"),
  );
  const app = await built.read("project/src/app.ts");
  const imported = /from "\.\.\/lib\/([a-z]+)\.js"/.exec(app)?.[1];
  assert.ok(imported !== undefined && imported !== "alias", app);
  const paths = built.files.map((file) => file.path);
  assert.ok(paths.includes(`project/lib/${imported}.d.ts`), paths.join("\n"));
  assert.ok(paths.includes(`project/lib/${imported}.js`));
  assert.doesNotMatch(app, /@lib\/alias|fromAlias/);
  assert.deepEqual(
    built.manifest.importRewrites.filter((rewrite) =>
      /alias/i.test(rewrite.from),
    ),
    [],
  );
});

test("an import rule that reaches no generated file is a problem of the table", () => {
  const rule = (after: string, paths: string[] = ["src/app.ts"]) => ({
    before: '"@acme/lib"',
    after,
    kind: "text" as const,
    paths,
  });
  const files = [
    { path: "src/app.ts" },
    { path: "lib/service.ts" },
    { path: "lib/types.d.ts" },
    { path: "lib/types.js" },
    { path: "sandbox/mock.js" },
  ];
  const problems = unresolvedImportRules(
    [
      rule('"../lib/service.js"'),
      rule('"../lib/types.js"'),
      rule("'../sandbox/mock.js'"),
      rule('"../lib/gone.js"'),
      // An unscoped rule, a package name and a directory scope are not
      // import rules.
      rule('"../lib/gone.js"', []),
      rule('"@shop/lib"'),
      rule('"../lib/gone.js"', ["src"]),
      // A renamed importer resolves from its new path.
      rule('"./service.js"', ["old/app.ts"]),
    ],
    [{ from: "old/app.ts", to: "lib/app.ts" }],
    files,
  );
  assert.deepEqual(
    problems.map((problem) => [problem.code, problem.file]),
    [["import_unrewritable", "src/app.ts"]],
  );
  assert.match(problems[0]?.detail ?? "", /resolves to lib\/gone\.js/);
});

test("the hidden-tests scaffold names a file per scenario with imports that resolve from it", () => {
  const spec = {
    feature: "Retries",
    background: ["a gateway"],
    scenarios: [
      {
        id: "s1",
        kind: "happy" as const,
        title: 'Invoices are "retried" / twice!',
        steps: [
          { keyword: "When" as const, text: "the gateway fails" },
          { keyword: "Then" as const, text: "the invoice is retried" },
        ],
        origin: "draft" as const,
      },
      {
        id: "s2",
        kind: "happy" as const,
        title: "---",
        steps: [],
        origin: "draft" as const,
      },
    ],
    openQuestions: [],
    assumptions: [],
  };
  const [first, second] = hiddenTestScaffold({
    spec,
    entryPoints: ["src/billing/retry.ts", "src/retry.ts", "src/3d.ts"],
  });
  assert.equal(
    first?.path,
    "tests/private/s1-invoices-are-retried-twice.test.ts",
  );
  assert.equal(second?.path, "tests/private/s2-scenario.test.ts");
  const lines = (first?.text ?? "").split("\n");
  assert.deepEqual(lines.slice(0, 6), [
    'import { beforeEach, test } from "node:test";',
    'import assert from "node:assert/strict";',
    'import { mockImplementation, recordedCalls, resetMocks } from "../../sandbox/mock.js";',
    'import * as m3d from "../../src/3d.js";',
    'import * as retry from "../../src/billing/retry.js";',
    'import * as retry2 from "../../src/retry.js";',
  ]);
  assert.ok(
    lines.includes('test("Invoices are \\"retried\\" / twice!", async () => {'),
  );
  assert.ok(lines.includes("  // Given a gateway"));
  assert.ok(lines.includes("  // Then the invoice is retried"));
  assert.deepEqual(hiddenTestScaffold({ spec: null, entryPoints: [] }), []);
});

test("the hidden-tests prompt quotes the project most needed first, within its room, and names what it leaves out", () => {
  const file = (path: string, cls: GeneratedFile["class"], chars = 10) => ({
    path,
    text: "x".repeat(chars),
    class: cls,
    public: true,
  });
  const { quoted, unquoted } = quotedProject([
    file("src/big.ts", "source", PROMPT_PROJECT_CHARS),
    file("lib/a.d.ts", "stub"),
    file("lib/a.js", "mock"),
    file("tests/public/a.test.ts", "test-public"),
    file("sandbox/mock.d.ts", "harness"),
    file("sandbox/mock.js", "harness"),
    file("package-lock.json", "config"),
    file("package.json", "config"),
    { ...file("tests/private/a.test.ts", "test-private"), public: false },
  ]);
  assert.deepEqual(
    quoted.map((item) => item.path),
    [
      "package.json",
      "sandbox/mock.d.ts",
      "tests/public/a.test.ts",
      "lib/a.d.ts",
    ],
  );
  assert.deepEqual(unquoted, ["src/big.ts"]);
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
    version: await versionFor({
      acceptance: false,
      aliasRules: named,
      fixtures: given,
    }),
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

test("the early hidden-tests agent's failure fails only a build whose baseline needs its tests", async () => {
  let failed!: () => void;
  const hasFailed = new Promise<void>((resolve) => (failed = resolve));
  const failing = (): AgentModel => ({
    model: "test-model",
    turn: async () => {
      failed();
      throw new Error("model overloaded");
    },
  });
  const draft = () =>
    versionFor({ acceptance: false, aliasRules: named, fixtures: given });
  // The baseline's steps wait until the agent has failed beside them.
  const base = fakeProvider((argv) =>
    argv.includes("build") ? { exitCode: 2 } : {},
  ).provider;
  const slow: EvaluationProvider = {
    ...base,
    async create(options) {
      const job = await base.create(options);
      return {
        ...job,
        async exec(command) {
          // Past the agent's own cleanup, as a real baseline's minutes are.
          await hasFailed;
          await new Promise((resolve) => setTimeout(resolve, 100));
          return job.exec(command);
        },
      };
    },
  };
  // A project that does not build needs no hidden tests: the build ends
  // with the baseline's verdict, as it did before the agent ran beside it.
  const broken = await runBuild(slow, {
    version: await draft(),
    agent: { model: failing(), limits },
  });
  assert.equal(broken.manifest.ready, false);
  assert.ok(!broken.messages.some((line) => /wrote \d+ hidden/.test(line)));
  // One whose baseline lacks them fails with the agent's error.
  await assert.rejects(
    runBuild(fakeProvider().provider, {
      version: await draft(),
      agent: { model: failing(), limits },
    }),
    /model overloaded/,
  );
});

test("hidden tests are written only for a draft with none whose baseline fails for that alone", async () => {
  // A draft with hidden tests is built as it is.
  const untouched = scripted([]);
  const withTests = await runBuild(
    fakeProvider((argv) => (runsHiddenTest(argv) ? TAP_FAILED : {})).provider,
    {
      version: await versionFor({ aliasRules: named, fixtures: given }),
      agent: { model: untouched, limits },
    },
  );
  assert.equal(withTests.manifest.ready, true);
  assert.deepEqual(untouched.prompts, []);
  // A project that does not build is not the tests' to fix: the agent,
  // started beside the baseline, is stopped once it fails for that.
  const broken = waiting();
  const failing = await runBuild(
    fakeProvider((argv) => (argv.includes("build") ? { exitCode: 2 } : {}))
      .provider,
    {
      version: await versionFor({
        acceptance: false,
        aliasRules: named,
        fixtures: given,
      }),
      agent: { model: broken, limits },
    },
  );
  assert.equal(failing.manifest.ready, false);
  assert.ok(
    failing.messages.includes(
      "Hidden-tests agent stopped: the baseline needs none.",
    ),
  );
  assert.ok(!failing.messages.some((line) => /wrote \d+ hidden/.test(line)));
  // Without a model, the build says why it wrote none.
  const unconfigured = await runBuild(fakeProvider().provider, {
    version: await versionFor({
      acceptance: false,
      aliasRules: named,
      fixtures: given,
    }),
    agent: { model: null, limits },
  });
  assert.equal(unconfigured.manifest.ready, false);
  assert.ok(
    unconfigured.messages.includes(
      "No agent model is configured; no hidden tests are written.",
    ),
  );
});

/** A sandbox's preparation of the slice, served as a fixtures run's two artifacts. */
function preparationRun(
  rules: readonly AliasRule[],
  fixtures: VersionFixtures,
) {
  const run: StoredAnalysisRun = {
    ...sliceRun,
    id: "arn_prep",
    tool: "fixtures",
    toolVersion: "fixtures@2",
    params: {
      deadlineMinutes: 90,
      agent: "fixtures",
      proposalId: "bpr_1",
      specRevision: 1,
      specHash: "s".repeat(64),
      sliceRunId: sliceRun.id,
      pseudonyms: { vocabulary: ["Widget"], title: "t", summary: "s" },
    },
  };
  const served = (
    kind: StoredArtifact["kind"],
    path: string,
    document: unknown,
  ) => {
    const bytes = Buffer.from(JSON.stringify(document));
    return {
      run,
      artifact: {
        id: `art_${path}`,
        runId: run.id,
        kind,
        path,
        objectKey: `runs/${run.id}/${path}`,
        contentType: "application/json",
        sizeBytes: bytes.byteLength,
        sha256: sha256(bytes),
        meta: null,
        createdAt: stamp,
      } satisfies StoredArtifact,
      bytes,
    };
  };
  const usage = {
    model: "test-model",
    turns: 1,
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  return [
    served("fixture_set", "fixture-set.json", {
      schemaVersion: 1,
      toolVersion: "fixtures@2",
      sliceRunId: sliceRun.id,
      sourceSnapshotId: "rsn_1",
      sourceCommitSha: "a".repeat(40),
      proposalId: "bpr_1",
      specRevision: 1,
      fixtures: fixtures.fixtures,
      scenario: fixtures.scenario,
      summary: "Shows a widget.",
      usage,
    }),
    served("pseudonyms", "pseudonym-table.json", {
      schemaVersion: 1,
      toolVersion: "fixtures@2",
      sliceRunId: sliceRun.id,
      rules,
      summary: "Renames the product.",
      usage,
    }),
  ];
}

test("a draft with a preparation takes its fixtures, and its table when the build's check holds it", async () => {
  const fixtures: VersionFixtures = {
    fixtureRunId: "arn_prep",
    fixtures: [],
    scenario: 'console.log("a widget walkthrough");\n',
  };
  const rules: AliasRule[] = [
    { before: "Widget", after: "Gadget", kind: "identifier", paths: [] },
    { before: "widget", after: "gadget", kind: "text", paths: [] },
  ];
  const fake = fakeProvider((argv) => (runsHiddenTest(argv) ? TAP_FAILED : {}));
  // No turns: an agent asked for anything would keep nothing.
  const model = scripted([]);
  const built = await runBuild(fake.provider, {
    params: { vocabulary: ["Widget"], preparedRunId: "arn_prep" },
    agent: { model, limits },
    served: preparationRun(rules, fixtures),
  });
  assert.deepEqual(built.manifest.blockers, []);
  assert.equal(built.manifest.ready, true);
  assert.equal(model.prompts.length, 0);
  assert.ok(
    built.messages.includes("Fixtures taken from the sandbox's preparation."),
  );
  assert.ok(
    built.messages.includes("Pseudonyms taken from the sandbox's preparation."),
  );
  assert.match(
    await built.read("project/sandbox/run.ts"),
    /a gadget walkthrough/,
  );
  const transform = JSON.parse(await built.read(BUILD_TRANSFORM_PATH)) as {
    aliasRules: AliasRule[];
    fixtures: VersionFixtures;
    preparedRunId: string;
  };
  assert.deepEqual(transform.aliasRules, rules);
  assert.deepEqual(transform.fixtures, fixtures);
  assert.equal(transform.preparedRunId, "arn_prep");

  // A table that does not hold against the project is passed over for an
  // agent's; the fixtures are still taken.
  const short = await runBuild(fakeProvider().provider, {
    params: { vocabulary: ["Widget"], preparedRunId: "arn_prep" },
    agent: { model: scripted([]), limits },
    served: preparationRun([rules[0] as AliasRule], fixtures),
  });
  assert.ok(
    short.messages.some((line) =>
      /The prepared pseudonyms do not hold here/.test(line),
    ),
    short.messages.join("\n"),
  );
  assert.ok(short.messages.some((line) => /with no table kept/.test(line)));
  assert.deepEqual(
    short.manifest.blockers.map((blocker) => blocker.code),
    ["vocabulary_leaked"],
  );

  // A preparation of another slice, or none at all, gives nothing.
  const other = preparationRun(rules, fixtures).map((entry) => ({
    ...entry,
    run: {
      ...entry.run,
      params: { ...entry.run.params, sliceRunId: "arn_other" },
    } as StoredAnalysisRun,
  }));
  const elsewhere = await runBuild(fakeProvider().provider, {
    version: await versionFor({ fixtures: given }),
    params: { vocabulary: ["Widget"], preparedRunId: "arn_prep" },
    agent: { model: scripted([]), limits },
    served: other,
  });
  assert.ok(
    !elsewhere.messages.some((line) => /sandbox's preparation/.test(line)),
  );
});

test("the hidden-tests agent reads the project while the first baseline runs, and its tests are kept when that baseline lacks them", async () => {
  let release = () => {};
  const firstBaseline = new Promise<void>((resolve) => {
    release = resolve;
  });
  const events: string[] = [];
  let jobs = 0;
  const provider: EvaluationProvider = {
    ...fakeProvider().provider,
    async create(options) {
      jobs += 1;
      const job = await fakeProvider((argv) =>
        runsHiddenTest(argv) ? TAP_FAILED : {},
      ).provider.create(options);
      const first = jobs === 1;
      return {
        ...job,
        async exec(command) {
          // The first baseline is held until the agent has had a turn.
          if (first && command.argv.includes("--package-lock-only")) {
            events.push("baseline started");
            await firstBaseline;
          }
          return job.exec(command);
        },
      };
    },
  };
  const model = routed({
    [HIDDEN_TESTS_SYSTEM_PROMPT]: [
      turn([
        call("submit_hidden_tests", {
          tests: [hiddenTest],
          summary: "Checks the description.",
        }),
      ]),
    ],
  });
  const asked = model.turn.bind(model);
  model.turn = async (request, signal) => {
    events.push("agent turn");
    release();
    return asked(request, signal);
  };
  const built = await runBuild(provider, {
    version: await versionFor({
      acceptance: false,
      aliasRules: named,
      fixtures: given,
    }),
    agent: { model, limits },
  });
  assert.equal(built.manifest.ready, true);
  // The agent's first turn came while the first baseline was still running.
  assert.deepEqual(events.slice(0, 2), ["baseline started", "agent turn"]);
  assert.ok(
    built.messages.includes("Hidden-tests agent wrote 1 hidden test(s)."),
  );
});
