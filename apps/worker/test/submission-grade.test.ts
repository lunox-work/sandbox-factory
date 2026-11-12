import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
  EvaluationCommand,
  EvaluationProvider,
  SubmissionResult,
} from "sandbox-factory";
import type { ToolInputs, ToolRunInput } from "../src/tools/adapter.js";
import {
  SUBMISSION_RESULT_PATH,
  createSubmissionGradeAdapter,
  resultOf,
} from "../src/tools/submission-grade.js";

const TAP_PASSED =
  "TAP version 13\n# Subtest: passes\nok 1 - passes\n  ---\n  duration_ms: 0.27\n  type: 'test'\n  ...\n1..1\n# tests 1\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 40.13\n";
const TAP_FAILED =
  "TAP version 13\nnot ok 1 - fails\n  failureType: 'testCodeFailure'\n1..1\n# tests 1\n# pass 0\n# fail 1\n";

/** The built version: its public project and two hidden tests. */
const built: Record<string, string> = {
  "project/src/feature.ts": "export const feature = () => 0;\n",
  "project/package.json": '{"name":"sandbox"}\n',
  "project/sandbox-task.json": JSON.stringify({
    editablePaths: ["src/feature.ts"],
  }),
  "private/s1-returns-a-value.test.ts": "hidden one\n",
  "private/s2-handles-the-edge.test.ts": "hidden two\n",
  "private/pseudonym.lunox": "not a test\n",
};

function provider(
  outcome: (argv: readonly string[]) => { exitCode?: number; stdout?: string },
) {
  const commands: string[][] = [];
  let jobs = 0;
  const value: EvaluationProvider = {
    name: "fake",
    async create() {
      jobs += 1;
      return {
        id: `job_${jobs}`,
        environment: {
          provider: "fake",
          environmentId: "env",
          templateDigest: "sha256:t",
        },
        async stage() {},
        async exec(command: EvaluationCommand) {
          commands.push([...command.argv]);
          return {
            exitCode: 0,
            timedOut: false,
            outputTruncated: false,
            stdout: "",
            stderr: "",
            durationMs: 1,
            ...outcome(command.argv),
          };
        },
        async read(path: string) {
          return path === "package-lock.json" ? '{"lockfileVersion":3}' : null;
        },
        async destroy() {},
      };
    },
  };
  return { value, commands, jobs: () => jobs };
}

async function grade(
  files: { path: string; text: string }[],
  outcome: (argv: readonly string[]) => { exitCode?: number; stdout?: string },
) {
  const outDir = await mkdtemp(join(tmpdir(), "grade-"));
  const finished: { id: string; runId: string; outcome: unknown }[] = [];
  const fake = provider(outcome);
  const inputs = {
    getRun: async () => null,
    listArtifacts: async (runId: string) =>
      runId === "arn_build"
        ? Object.keys(built).map((path) => ({
            id: `art_${path}`,
            runId,
            path,
            objectKey: `runs/arn_build/${path}`,
            kind: "other",
            contentType: "text/plain",
            sizeBytes: (built[path] ?? "").length,
            sha256: "0".repeat(64),
            meta: {},
            createdAt: "2026-11-12T00:00:00.000Z",
          }))
        : [],
    readArtifact: async (key: string) => {
      const path = key.replace("runs/arn_build/", "");
      const text = built[path];
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
    finishSubmission: async (id: string, runId: string, result: unknown) => {
      finished.push({ id, runId, outcome: result });
      return true;
    },
  } as unknown as ToolInputs;
  const logged: string[] = [];
  const input: ToolRunInput = {
    runId: "arn_grade",
    sourceDir: outDir,
    outDir,
    params: {
      deadlineMinutes: 60,
      grader: "submission",
      submissionId: "sbm_1",
      sandboxVersionId: "sbv_1",
      patchSha256: "a".repeat(64),
    } as never,
    run: { snapshotId: "", commitSha: "" },
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
    return { written, result, finished, fake, logged };
  } finally {
    await rm(outDir, { recursive: true, force: true });
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
  assert.deepEqual(finished, [
    { id: "sbm_1", runId: "arn_grade", outcome: result },
  ]);
  assert.equal(written[0]?.path, SUBMISSION_RESULT_PATH);
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
