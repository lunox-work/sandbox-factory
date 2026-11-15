import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ALIASES_V1,
  CURRENT_ALIASES,
  renameFile,
  renameFileV1,
} from "carveout/pseudonyms";
import { NEW_FILE_ON_REPOSITORY_PATH_REASON } from "sandbox-factory";
import type {
  AliasRule,
  EvaluationCommand,
  EvaluationProvider,
  SubmissionResult,
} from "sandbox-factory";
import { CARVEOUT_VERSION } from "../src/tools/engines.js";
import type { ToolInputs, ToolRunInput } from "../src/tools/adapter.js";
import {
  MERGE_PATCH_PATH,
  SUBMISSION_RESULT_PATH,
  createSubmissionGradeAdapter,
  repositoryTree,
  resultOf,
  sourceText,
} from "../src/tools/submission-grade.js";

const TAP_PASSED =
  "TAP version 13\n# Subtest: passes\nok 1 - passes\n  ---\n  duration_ms: 0.27\n  type: 'test'\n  ...\n1..1\n# tests 1\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 40.13\n";
const TAP_FAILED =
  "TAP version 13\nnot ok 1 - fails\n  failureType: 'testCodeFailure'\n1..1\n# tests 1\n# pass 0\n# fail 1\n";

/** The engines a build records: none before carveout 0.3.0, the release's after. */
type Engines = { readonly carveout: string } | undefined;

/** The built version: its public project and two hidden tests. */
function builtFor(
  engines: Engines,
  overrides: {
    readonly rules?: readonly AliasRule[];
    readonly project?: Record<string, string>;
  } = {},
): Record<string, string> {
  return {
    "project/src/feature.ts": "export const feature = () => 0;\n",
    "project/package.json": '{"name":"sandbox"}\n',
    "project/sandbox-task.json": JSON.stringify({
      editablePaths: ["src/feature.ts"],
    }),
    ...overrides.project,
    "private/s1-returns-a-value.test.ts": "hidden one\n",
    "private/s2-handles-the-edge.test.ts": "hidden two\n",
    "private/pseudonym.lunox": JSON.stringify({
      schemaVersion: 1,
      rules: overrides.rules ?? [],
    }),
    "build-manifest.json": JSON.stringify({
      renames: [],
      files: [
        { path: "src/feature.ts", class: "source", public: true },
        { path: "sandbox/mocks/ledger.ts", class: "mock", public: true },
        { path: "tests/public/helpers.ts", class: "test-public", public: true },
      ],
      ...(engines === undefined ? {} : { engines }),
    }),
  };
}
const ENGINES: readonly {
  readonly label: string;
  readonly engines: Engines;
}[] = [
  { label: "built before carveout 0.3.0", engines: undefined },
  {
    label: `built on carveout ${CARVEOUT_VERSION}`,
    engines: { carveout: CARVEOUT_VERSION },
  },
];
const built = builtFor(undefined);

function provider(
  outcome: (
    argv: readonly string[],
    label: string,
  ) => { exitCode?: number; stdout?: string },
) {
  const commands: string[][] = [];
  /** Each job's staged files, by its label. */
  const staged = new Map<string, Map<string, string>>();
  let jobs = 0;
  const value: EvaluationProvider = {
    name: "fake",
    async create({ label }) {
      jobs += 1;
      return {
        id: `job_${jobs}`,
        environment: {
          provider: "fake",
          environmentId: "env",
          templateDigest: "sha256:t",
        },
        async stage(files: readonly { path: string; text: string }[]) {
          staged.set(label, new Map(files.map((f) => [f.path, f.text])));
        },
        async exec(command: EvaluationCommand) {
          commands.push([...command.argv]);
          return {
            exitCode: 0,
            timedOut: false,
            outputTruncated: false,
            stdout: "",
            stderr: "",
            durationMs: 1,
            ...outcome(command.argv, label),
          };
        },
        async read(path: string) {
          return path === "package-lock.json" ? '{"lockfileVersion":3}' : null;
        },
        async seal() {},
        async destroy() {},
      };
    },
  };
  return { value, commands, staged, jobs: () => jobs };
}

async function grade(
  files: { path: string; text: string }[],
  outcome: (
    argv: readonly string[],
    label: string,
  ) => { exitCode?: number; stdout?: string },
  /** The version's repository at its commit, for a sliced version. */
  source?: Record<string, string>,
  /** `repository`: the files are a pull request's (the CI judge). */
  names?: "repository",
  /** The build's artifacts; `built` by default. */
  build: Record<string, string> = built,
) {
  const root = await mkdtemp(join(tmpdir(), "grade-"));
  // As `executeRun` hands it: a folder that does not exist yet, which the
  // adapter makes whatever the verdict.
  const outDir = join(root, "out");
  for (const [path, text] of Object.entries(source ?? {})) {
    await mkdir(join(root, "source", path, ".."), { recursive: true });
    await writeFile(join(root, "source", path), text);
  }
  const finished: { id: string; outcome: unknown }[] = [];
  const fake = provider(outcome);
  const inputs = {
    getRun: async () => null,
    listArtifacts: async (runId: string) =>
      runId === "arn_build"
        ? Object.keys(build).map((path) => ({
            id: `art_${path}`,
            runId,
            path,
            objectKey: `runs/arn_build/${path}`,
            kind: "other",
            contentType: "text/plain",
            sizeBytes: (build[path] ?? "").length,
            sha256: "0".repeat(64),
            meta: {},
            createdAt: "2026-11-12T00:00:00.000Z",
          }))
        : [],
    readArtifact: async (key: string) => {
      const path = key.replace("runs/arn_build/", "");
      const text = build[path];
      return text === undefined ? undefined : Buffer.from(text);
    },
    getVersion: async () =>
      ({
        version: { id: "sbv_1" },
        source: { buildRunId: "arn_build" },
      }) as never,
    getTask: async () => null,
    recordBuildOutput: async () => false,
    recordStarterOutput: async () => false,
    readSubmission: async (id: string) =>
      id === "sbm_1"
        ? {
            submission: { id, sandboxVersionId: "sbv_1", status: "queued" },
            files,
          }
        : null,
    settleSubmission: (id: string, result: unknown) => {
      finished.push({ id, outcome: result });
    },
  } as unknown as ToolInputs;
  const logged: string[] = [];
  const input: ToolRunInput = {
    runId: "arn_grade",
    sourceDir: join(root, "source"),
    outDir,
    params: {
      deadlineMinutes: 60,
      grader: "submission",
      submissionId: "sbm_1",
      sandboxVersionId: "sbv_1",
      patchSha256: "a".repeat(64),
      ...(names === undefined ? {} : { names }),
    } as never,
    run:
      source === undefined
        ? null
        : { snapshotId: "snp_1", commitSha: "c0ffee" },
    inputs,
    signal: new AbortController().signal,
    log: (line) => logged.push(line),
  };
  try {
    const written = await createSubmissionGradeAdapter({
      provider: fake.value,
    }).run(input);
    const result = JSON.parse(
      await readFile(join(outDir, SUBMISSION_RESULT_PATH), "utf8"),
    ) as SubmissionResult;
    const patch = written.some((file) => file.path === MERGE_PATCH_PATH)
      ? (JSON.parse(
          await readFile(join(outDir, MERGE_PATCH_PATH), "utf8"),
        ) as unknown)
      : null;
    return { written, result, finished, fake, logged, patch };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const runsHidden = (argv: readonly string[]) =>
  argv.includes("--test-reporter=tap");
const change = [
  { path: "src/feature.ts", text: "export const feature = () => 1;\n" },
];

test("a submission that passes both suites passes, and only counts and the verdict leave the run", async () => {
  const { written, result, finished, fake } = await grade(change, (argv) =>
    runsHidden(argv) ? { stdout: TAP_PASSED } : {},
  );
  assert.deepEqual(result, {
    public: { passed: 1, total: 1 },
    hidden: { passed: 2, total: 2 },
    verdict: "passed",
    failedScenarios: [],
  });
  assert.deepEqual(finished, [{ id: "sbm_1", outcome: result }]);
  assert.deepEqual(
    written.map((file) => file.path),
    [SUBMISSION_RESULT_PATH],
  );
  // Each hidden test ran twice, as on a baseline, in one evaluation job.
  assert.equal(fake.commands.filter(runsHidden).length, 4);
  // No hidden test's name reaches the result.
  assert.equal(JSON.stringify(result).includes("returns-a-value"), false);
});

test("passing the public suite and failing a hidden test is overfit, told only the scenario key", async () => {
  const { result } = await grade(change, (argv) =>
    runsHidden(argv)
      ? {
          stdout: argv.some((arg) => arg.includes("s2-"))
            ? TAP_FAILED
            : TAP_PASSED,
          exitCode: argv.some((arg) => arg.includes("s2-")) ? 1 : 0,
        }
      : {},
  );
  assert.equal(result.verdict, "overfit");
  assert.deepEqual(result.hidden, { passed: 1, total: 2 });
  assert.deepEqual(result.failedScenarios, ["s2"]);
});

test("a failing public suite is incomplete", async () => {
  const { result } = await grade(change, (argv) =>
    argv.includes("--test") && !runsHidden(argv)
      ? { exitCode: 1 }
      : runsHidden(argv)
        ? { stdout: TAP_PASSED }
        : {},
  );
  assert.equal(result.verdict, "incomplete");
  assert.deepEqual(result.public, { passed: 0, total: 1 });
});

test("a submission that changes the version's own files is refused, and nothing runs", async () => {
  const { result, fake } = await grade(
    [{ path: "package.json", text: '{"name":"mine"}\n' }],
    () => ({}),
  );
  assert.equal(result.verdict, "refused");
  assert.equal(result.refused?.[0]?.path, "package.json");
  assert.equal(fake.jobs(), 0);
});

test("the verdict rule on outcomes: never run is incomplete, flaky is a failure", () => {
  assert.equal(
    resultOf({
      hiddenPaths: ["tests/private/s1-a.test.ts"],
      baseline: null,
      refused: [],
    }).verdict,
    "incomplete",
  );
  const flaky = resultOf({
    hiddenPaths: ["tests/private/s1-a.test.ts", "tests/private/other.test.ts"],
    baseline: {
      executions: [],
      steps: [
        {
          name: "build",
          argv: [],
          exitCode: 0,
          timedOut: false,
          ok: true,
          path: null,
        },
        {
          name: "public-tests",
          argv: [],
          exitCode: 0,
          timedOut: false,
          ok: true,
          path: null,
        },
      ],
      privateTests: [
        {
          path: "tests/private/s1-a.test.ts",
          expected: "pass",
          observed: "flaky",
          ok: false,
        },
      ],
      ok: false,
      reasons: [],
    },
    refused: [],
  });
  assert.equal(flaky.verdict, "overfit");
  assert.deepEqual(flaky.hidden, { passed: 0, total: 2 });
  assert.deepEqual(flaky.failedScenarios, ["s1"]);
});

test("a submission that tells a test run from a real one is refused by carveout's policy, and nothing runs", async () => {
  const { result, fake } = await grade(
    [
      {
        path: "src/feature.ts",
        text: 'export const feature = () => (process.env.NODE_ENV === "test" ? 1 : 0);\n',
      },
    ],
    () => ({}),
  );
  assert.equal(result.verdict, "refused");
  assert.equal(result.refused?.[0]?.path, "src/feature.ts");
  assert.match(result.refused?.[0]?.reason ?? "", /without the code/);
  assert.equal(fake.jobs(), 0);
});

const passing = (argv: readonly string[]) =>
  runsHidden(argv) ? { stdout: TAP_PASSED } : {};
const repository = { "src/feature.ts": "export const feature = () => 0;\n" };

test("source is read inside the extracted tree only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "source-"));
  try {
    await writeFile(join(dir, "a.ts"), "a");
    assert.equal(sourceText(dir, "a.ts"), "a");
    assert.equal(sourceText(dir, "missing.ts"), null);
    assert.equal(sourceText(dir, "../a.ts"), null);
    assert.equal(sourceText(dir, ""), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The carry suites, on a version built before carveout 0.3.0 (no
// `engines.carveout`: the platform's renaming of then, `ALIASES_V1`) and on
// one built after (carveout's).
for (const { label, engines } of ENGINES) {
  const build = builtFor(engines);
  test(`a pass on a sliced version is carried back to the repository at its commit, for merge-back (${label})`, async () => {
    const { result, patch, written, fake, logged } = await grade(
      change,
      passing,
      repository,
      undefined,
      build,
    );
    assert.equal(result.verdict, "passed");
    assert.equal(result.carryBack, undefined);
    // Checked again in the repository's names, in a second job, with the
    // carried file in place and the hidden tests beside it.
    assert.equal(fake.jobs(), 2);
    const reversed = fake.staged.get("sbm_1-repository");
    assert.equal(
      reversed?.get("src/feature.ts"),
      "export const feature = () => 1;\n",
    );
    assert.ok(reversed?.has("tests/private/s1-returns-a-value.test.ts"));
    assert.ok(
      logged.some((line) =>
        line.startsWith("Reversed check in the repository's names: passed"),
      ),
    );
    assert.deepEqual(patch, {
      schemaVersion: 1,
      commitSha: "c0ffee",
      files: [
        { path: "src/feature.ts", text: "export const feature = () => 1;\n" },
      ],
    });
    assert.deepEqual(
      written.map((file) => file.path),
      [MERGE_PATCH_PATH, SUBMISSION_RESULT_PATH],
    );
  });
  test(`a pass that fails in the repository's names keeps its verdict, is marked carryBack failed, and has no merge patch (${label})`, async () => {
    const { result, finished, patch, written, fake } = await grade(
      change,
      (argv, jobLabel) =>
        jobLabel.endsWith("-repository") && argv.includes("build")
          ? { exitCode: 2 }
          : passing(argv),
      repository,
      undefined,
      build,
    );
    assert.deepEqual(result, {
      public: { passed: 1, total: 1 },
      hidden: { passed: 2, total: 2 },
      verdict: "passed",
      failedScenarios: [],
      carryBack: "failed",
    });
    assert.equal(patch, null);
    assert.deepEqual(
      written.map((file) => file.path),
      [SUBMISSION_RESULT_PATH],
    );
    assert.deepEqual(finished[0]?.outcome, result);
    assert.equal(fake.jobs(), 2);
    // A hidden test that fails only in the repository's names withholds it too.
    const hiddenFails = await grade(
      change,
      (argv, jobLabel) =>
        jobLabel.endsWith("-repository") && runsHidden(argv)
          ? { stdout: TAP_FAILED, exitCode: 1 }
          : passing(argv),
      repository,
      undefined,
      build,
    );
    assert.equal(hiddenFails.result.verdict, "passed");
    assert.equal(hiddenFails.result.carryBack, "failed");
    assert.equal(hiddenFails.patch, null);
  });
  test(`a pass that cannot be carried back is refused, and its run is a failure (${label})`, async () => {
    const { result, finished, patch } = await grade(
      [
        {
          path: "src/feature.ts",
          text: 'import { helper } from "../tests/public/helpers.js";\nexport const feature = () => 1;\n',
        },
      ],
      passing,
      repository,
      undefined,
      build,
    );
    assert.equal(result.verdict, "refused");
    assert.match(result.refused?.[0]?.reason ?? "", /harness/);
    assert.equal(patch, null);
    assert.deepEqual(finished[0]?.outcome, result);
    // A failing run on a sliced version carries nothing back, and is not
    // checked in the repository's names: one job.
    const failing = await grade(
      change,
      () => ({ exitCode: 1 }),
      repository,
      undefined,
      build,
    );
    assert.equal(failing.patch, null);
    assert.equal(failing.fake.jobs(), 1);
  });
  test(`the CI judge: a pull request's files are carried forward to the version, and only what the slice lets change is judged (${label})`, async () => {
    const { result, patch, logged, fake } = await grade(
      [
        { path: "src/feature.ts", text: "export const feature = () => 1;\n" },
        // The rest of the repository is its own CI's.
        { path: "README.md", text: "changed\n" },
      ],
      passing,
      { ...repository, "README.md": "readme\n" },
      "repository",
      build,
    );
    assert.equal(result.verdict, "passed");
    // Already in the repository's names: nothing is carried back.
    assert.equal(patch, null);
    assert.ok(logged.some((line) => /Carried 1 file.*1 outside/.test(line)));
    assert.equal(fake.jobs(), 1);
  });
  test(`the CI judge refuses a pull request with nothing in the slice, one that does not carry, or a version with no repository (${label})`, async () => {
    const nothing = await grade(
      [{ path: "README.md", text: "changed\n" }],
      passing,
      { ...repository, "README.md": "readme\n" },
      "repository",
      build,
    );
    assert.equal(nothing.result.verdict, "refused");
    assert.match(
      nothing.result.refused?.[0]?.reason ?? "",
      /no file the sandbox lets/,
    );
    assert.equal(nothing.fake.jobs(), 0);

    const generated = await grade(
      change,
      passing,
      undefined,
      "repository",
      build,
    );
    assert.equal(generated.result.verdict, "refused");
    assert.match(generated.result.refused?.[0]?.reason ?? "", /not sliced/);

    // A file that does not line up with the version's copy cannot be carried.
    const unaligned = await grade(
      [{ path: "src/feature.ts", text: "export const feature = () => 2;\n" }],
      passing,
      { "src/feature.ts": "line one\nline two\n" },
      "repository",
      build,
    );
    assert.equal(unaligned.result.verdict, "refused");
    assert.match(unaligned.result.refused?.[0]?.reason ?? "", /line up/);
  });
}

test("a version carries back under the renaming it was built with, which its build manifest names", async () => {
  // A path rule after a `/`: the platform's renaming before carveout 0.3.0
  // passed over `./lunox/a.js`; carveout's renames it.
  const rules: AliasRule[] = [
    { before: "lunox", after: "zorvex", kind: "path", paths: [] },
  ];
  const repositoryText =
    'import { a } from "./lunox/a.js";\nexport const feature = () => 0;\n';
  const source = {
    "src/feature.ts": repositoryText,
    "src/lunox/a.ts": "export const a = 1;\n",
  };
  const publicOf = (rename: typeof renameFile) =>
    rename({ path: "src/feature.ts", text: repositoryText }, rules).text;
  const before = publicOf(renameFileV1);
  const after = publicOf(renameFile);
  assert.equal(before, repositoryText);
  assert.match(after, /"\.\/zorvex\/a\.js"/);
  const submit = (publicText: string) => {
    const folder = publicText.includes("zorvex") ? "zorvex" : "lunox";
    return [
      {
        path: "src/feature.ts",
        text: `${publicText.replace("() => 0", "() => 1")}export { a as b } from "./${folder}/a.js";\n`,
      },
    ];
  };
  const expected = {
    schemaVersion: 1,
    commitSha: "c0ffee",
    files: [
      {
        path: "src/feature.ts",
        text: 'import { a } from "./lunox/a.js";\nexport const feature = () => 1;\nexport { a as b } from "./lunox/a.js";\n',
      },
    ],
  };
  for (const { engines, publicText } of [
    { engines: undefined, publicText: before },
    { engines: { carveout: CARVEOUT_VERSION }, publicText: after },
  ]) {
    const build = builtFor(engines, {
      rules,
      project: { "project/src/feature.ts": publicText },
    });
    const { result, patch } = await grade(
      submit(publicText),
      passing,
      source,
      undefined,
      build,
    );
    assert.equal(result.verdict, "passed", JSON.stringify(result));
    assert.deepEqual(patch, expected);
  }
  // A version built before, carried under carveout's renaming, would not
  // map back: the added line names the folder as the old build left it.
  const crossed = await grade(submit(before), passing, source, undefined, {
    ...builtFor(
      { carveout: CARVEOUT_VERSION },
      { rules, project: { "project/src/feature.ts": before } },
    ),
  });
  assert.equal(crossed.result.verdict, "refused");
  assert.match(crossed.result.refused?.[0]?.reason ?? "", /does not map back/);
});

test("the repository-named tree: the version renamed back, sources under their scoped rules, the rest unscoped, the carried files in place", () => {
  const rules: AliasRule[] = [
    { before: "orvanta", after: "northwind", kind: "path", paths: [] },
    {
      before: "orvantaCharge",
      after: "flatCharge",
      kind: "identifier",
      paths: ["src/orvanta/fees.ts"],
    },
    { before: "Orvanta", after: "Northwind", kind: "text", paths: [] },
  ];
  const file = (path: string, text: string, cls = "source") => ({
    path,
    text,
    class: cls as "source",
    public: cls !== "test-private",
  });
  const versionFiles = [
    file(
      "src/northwind/fees.ts",
      "export const flatCharge = 25; // Northwind\n",
    ),
    // Not a repository file: no path scopes its rules.
    file(
      "tests/private/s1-charge.test.ts",
      'import { flatCharge } from "../../src/northwind/fees.js";\n',
      "test-private",
    ),
    file("src/northwind/ledger.d.ts", "export type Northwind = 1;\n", "stub"),
  ];
  const repositoryFees = "export const orvantaCharge = 25; // Orvanta\n";
  {
    const tree = repositoryTree({
      versionFiles,
      sources: new Set(["src/northwind/fees.ts"]),
      carried: [
        {
          path: "src/orvanta/fees.ts",
          text: "export const orvantaCharge = 30; // Orvanta\n",
        },
        { path: "src/orvanta/extra.ts", text: "export const x = 1;\n" },
      ],
      repositoryText: (path) =>
        path === "src/orvanta/fees.ts" ? repositoryFees : null,
      rules,
      renames: [{ from: "src/orvanta/fees.ts", to: "src/northwind/fees.ts" }],
      aliases: CURRENT_ALIASES,
    });
    assert.deepEqual(tree.refused, []);
    assert.deepEqual(
      tree.files.map((f) => [f.path, f.text, f.class]),
      [
        ["src/orvanta/extra.ts", "export const x = 1;\n", "source"],
        [
          "src/orvanta/fees.ts",
          "export const orvantaCharge = 30; // Orvanta\n",
          "source",
        ],
        ["src/orvanta/ledger.d.ts", "export type Orvanta = 1;\n", "stub"],
        [
          "tests/private/s1-charge.test.ts",
          'import { orvantaCharge } from "../../src/orvanta/fees.js";\n',
          "test-private",
        ],
      ],
    );
  }
  // A version built before carveout 0.3.0 is renamed back under the
  // renaming it was built with, whose path rules pass over `./orvanta/`.
  const legacy = repositoryTree({
    versionFiles: [
      file(
        "src/fees.ts",
        'import { a } from "./orvanta/a.js";\nexport const flatCharge = 1;\n',
      ),
    ],
    sources: new Set(["src/fees.ts"]),
    carried: [],
    repositoryText: () => null,
    rules: rules.map((rule) => ({ ...rule, paths: [] })),
    renames: [],
    aliases: ALIASES_V1,
  });
  assert.equal(
    legacy.files[0]?.text,
    'import { a } from "./orvanta/a.js";\nexport const orvantaCharge = 1;\n',
  );
  // Out of its scope a scoped rule does not apply to a repository file:
  // a source elsewhere keeps the public name, as the build left it.
  const scoped = repositoryTree({
    versionFiles: [file("src/other.ts", "export const flatCharge = 1;\n")],
    sources: new Set(["src/other.ts"]),
    carried: [],
    repositoryText: () => null,
    rules,
    renames: [],
    aliases: CURRENT_ALIASES,
  });
  assert.equal(scoped.files[0]?.text, "export const flatCharge = 1;\n");
  // Two version files on one repository path cannot both be placed.
  const clash = repositoryTree({
    versionFiles: [
      file("src/northwind/a.ts", "a\n", "mock"),
      file("src/orvanta/a.ts", "b\n", "mock"),
    ],
    sources: new Set(),
    carried: [],
    repositoryText: () => null,
    rules,
    renames: [],
    aliases: CURRENT_ALIASES,
  });
  assert.deepEqual(
    clash.refused.map((r) => r.path),
    ["src/orvanta/a.ts"],
  );
});

test("a pass whose carry meets the carry's own limit keeps its verdict and withholds merge-back", async () => {
  // A new file beside the task's, at a path the repository already holds
  // outside the slice: the carry cannot place it, which is not the
  // contributor's doing.
  const { result, patch, fake, logged } = await grade(
    [...change, { path: "src/helper.ts", text: "export const h = 1;\n" }],
    passing,
    { ...repository, "src/helper.ts": "export const other = 2;\n" },
  );
  assert.equal(result.verdict, "passed");
  assert.equal(result.carryBack, "failed");
  assert.equal(result.refused, undefined);
  assert.equal(patch, null);
  assert.equal(fake.jobs(), 1);
  assert.ok(
    logged.some((line) =>
      line.includes(`src/helper.ts: ${NEW_FILE_ON_REPOSITORY_PATH_REASON}`),
    ),
    logged.join("\n"),
  );
});

test("a reversed tree that cannot be placed withholds merge-back without a second job", async () => {
  // The version has two files that land on one path in the repository's names.
  const rules: AliasRule[] = [
    { before: "lunox", after: "zorvex", kind: "path", paths: [] },
  ];
  const build = builtFor(
    { carveout: CARVEOUT_VERSION },
    {
      rules,
      project: {
        "project/src/zorvex.ts": "export const a = 1;\n",
        "project/src/lunox.ts": "export const b = 1;\n",
      },
    },
  );
  const { result, patch, fake, logged } = await grade(
    change,
    passing,
    repository,
    undefined,
    build,
  );
  assert.equal(result.verdict, "passed");
  assert.equal(result.carryBack, "failed");
  assert.equal(patch, null);
  assert.equal(fake.jobs(), 1);
  assert.ok(logged.some((line) => /could not be placed/.test(line)));
});

test("a pass that adds a word of a multi-word text rule's public name is carried with that word", async () => {
  // A multi-word text rule: carveout 0.3.1's carry learned `Shop -> Payments`
  // from the comment and carried an added `Shop` as `Payments`, which the
  // word check withheld. carveout 0.5.0 renames by the table first, so the
  // contributor's `Shop` comes back as written (core's carried-words tests
  // keep the check covered against such a carry).
  const rules: AliasRule[] = [
    {
      before: "Orvanta Payments",
      after: "Northwind Shop",
      kind: "text",
      paths: [],
    },
  ];
  const repositoryText =
    "// Orvanta Payments settles it.\nexport const feature = () => 0;\n";
  const publicText =
    "// Northwind Shop settles it.\nexport const feature = () => 0;\n";
  const build = builtFor(
    { carveout: CARVEOUT_VERSION },
    { rules, project: { "project/src/feature.ts": publicText } },
  );
  const source = { "src/feature.ts": repositoryText };
  const { result, patch, fake, logged } = await grade(
    [
      {
        path: "src/feature.ts",
        text: `${publicText.replace("() => 0", "() => Shop")}const Shop = 1;\n`,
      },
    ],
    passing,
    source,
    undefined,
    build,
  );
  assert.equal(result.verdict, "passed");
  assert.equal(result.carryBack, undefined, logged.join("\n"));
  assert.deepEqual(patch, {
    schemaVersion: 1,
    commitSha: "c0ffee",
    files: [
      {
        path: "src/feature.ts",
        text: "// Orvanta Payments settles it.\nexport const feature = () => Shop;\nconst Shop = 1;\n",
      },
    ],
  });
  assert.equal(fake.jobs(), 2);
  assert.ok(
    !logged.some((line) => /merge-back is withheld/.test(line)),
    logged.join("\n"),
  );
  // The brand written whole is the table's: it carries, and is merged back.
  const whole = await grade(
    [
      {
        path: "src/feature.ts",
        text: `${publicText.replace("() => 0", "() => 1")}// Northwind Shop pays.\n`,
      },
    ],
    passing,
    source,
    undefined,
    build,
  );
  assert.equal(whole.result.carryBack, undefined);
  assert.deepEqual(whole.patch, {
    schemaVersion: 1,
    commitSha: "c0ffee",
    files: [
      {
        path: "src/feature.ts",
        text: "// Orvanta Payments settles it.\nexport const feature = () => 1;\n// Orvanta Payments pays.\n",
      },
    ],
  });
});

test("in the repository-named tree a carried test is back at its repository path, renamed there, its imports following their targets", () => {
  const rules: AliasRule[] = [
    { before: "orvanta", after: "northwind", kind: "path", paths: [] },
    {
      before: "orvantaFee",
      after: "entryFee",
      kind: "identifier",
      paths: ["src/billing/fees.ts", "test/orvanta/fee.test.ts"],
    },
    { before: "Orvanta", after: "Northwind", kind: "text", paths: [] },
  ];
  const file = (path: string, text: string, cls = "source") => ({
    path,
    text,
    class: cls as "source",
    public: true,
  });
  const CARRIED = "tests/public/carried/test/northwind/fee.test.ts";
  const tree = repositoryTree({
    versionFiles: [
      file("src/northwind/fees.ts", "export const entryFee = () => 0;\n"),
      file("src/northwind/ledger.js", "export const balance = 0;\n", "mock"),
      file(
        "src/northwind/ledger.d.ts",
        "export declare const balance: number;\n",
        "stub",
      ),
      file(
        CARRIED,
        [
          'import { test } from "node:test";',
          'import { entryFee } from "../../../../../src/northwind/fees.js";',
          'import { balance } from "../../../../../src/northwind/ledger.js";',
          'test("the Northwind fee", () => entryFee(balance));',
          "",
        ].join("\n"),
        "test-public",
      ),
    ],
    sources: new Set(["src/northwind/fees.ts"]),
    carried: [],
    repositoryText: () => null,
    rules,
    // The fee module came from a folder the table's words do not name.
    renames: [{ from: "src/billing/fees.ts", to: "src/northwind/fees.ts" }],
    aliases: CURRENT_ALIASES,
    carriedTests: [{ path: CARRIED, from: "test/orvanta/fee.test.ts" }],
  });
  assert.deepEqual(tree.refused, []);
  const byPath = new Map(tree.files.map((f) => [f.path, f]));
  const carried = byPath.get("tests/public/carried/test/orvanta/fee.test.ts");
  assert.equal(carried?.class, "test-public");
  assert.equal(
    carried?.text,
    [
      'import { test } from "node:test";',
      // Scoped to the test's repository path, the fee's rule applies there.
      'import { orvantaFee } from "../../../../../src/billing/fees.js";',
      'import { balance } from "../../../../../src/orvanta/ledger.js";',
      'test("the Orvanta fee", () => orvantaFee(balance));',
      "",
    ].join("\n"),
  );
  assert.ok(byPath.has("src/billing/fees.ts"));
  assert.ok(byPath.has("src/orvanta/ledger.js"));
  assert.ok(!byPath.has(CARRIED));
});
