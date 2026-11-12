import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AcceptanceTest,
  BaselineReport,
  GeneratedFile,
  PrivateTestOutcome,
} from "sandbox-factory";
import type { AgentModel, AgentTurn } from "../src/agent/loop.js";
import { referenceSystemPrompt } from "../src/agent/prompts.js";
import {
  CALIBRATION_ENGINE,
  REFERENCE_RUNS_MAX,
  calibrateHiddenTests,
  calibrationOf,
  referenceProblems,
  suiteOf,
  withReference,
} from "../src/tools/calibration.js";
import type {
  CandidateBaseline,
  WrittenHiddenTests,
} from "../src/tools/hidden-tests.js";

const project: GeneratedFile[] = [
  { path: "package.json", text: "{}", class: "config", public: true },
  { path: "src/app.ts", text: "export {};\n", class: "source", public: true },
  { path: "lib/db.d.ts", text: "", class: "stub", public: true },
  {
    path: "tests/private/a.test.ts",
    text: "",
    class: "test-private",
    public: false,
  },
];

const fail = (path: string): AcceptanceTest => ({
  path,
  text: "",
  expectedBaseline: "fail",
});
const guard = (path: string): AcceptanceTest => ({
  path,
  text: "",
  expectedBaseline: "pass",
});
const report = (
  outcomes: Record<string, PrivateTestOutcome["observed"]>,
  ok = true,
): BaselineReport => ({
  executions: [],
  steps: [],
  privateTests: Object.entries(outcomes).map(([path, observed]) => ({
    path,
    expected: "fail",
    observed,
    ok: true,
  })),
  ok,
  reasons: [],
});

test("the reference may change the slice's source and add TypeScript beside it, nothing else", () => {
  assert.deepEqual(
    referenceProblems(project, [
      { path: "src/app.ts", text: "" },
      { path: "src/new.ts", text: "" },
    ]),
    [],
  );
  const problems = referenceProblems(project, [
    { path: "package.json", text: "" },
    { path: "lib/db.d.ts", text: "" },
    { path: "tests/private/a.test.ts", text: "" },
    { path: "src/new.test.ts", text: "" },
    { path: "src/types.d.ts", text: "" },
    { path: "src/notes.md", text: "" },
    { path: "other/new.ts", text: "" },
    { path: "src/../x.ts", text: "" },
    { path: "src/app.ts", text: "" },
    { path: "src/app.ts", text: "" },
  ]);
  assert.equal(problems.length, 9);
  assert.match(problems[0] ?? "", /^package\.json: not the slice's source/);
  assert.match(problems.at(-1) ?? "", /^src\/app\.ts: given twice\./);
});

test("the reference's files replace the slice's and add beside them", () => {
  const out = withReference(project, [
    { path: "src/app.ts", text: "export const x = 1;\n" },
    { path: "src/new.ts", text: "new" },
  ]);
  assert.equal(
    out.find((file) => file.path === "src/app.ts")?.text,
    "export const x = 1;\n",
  );
  assert.deepEqual(out.at(-1), {
    path: "src/new.ts",
    text: "new",
    class: "source",
    public: true,
  });
  assert.equal(out.length, project.length + 1);
});

test("a baseline reads as duediligence's suite result, a test per file", () => {
  const suite = suiteOf(
    report({
      "a.test.ts": "pass",
      "b.test.ts": "fail",
      "c.test.ts": "flaky",
      "d.test.ts": "error",
    }),
    ["a.test.ts", "b.test.ts", "c.test.ts", "d.test.ts", "never.test.ts"],
  );
  assert.equal(suite.compiled, true);
  assert.deepEqual(
    suite.files.map((file) => [
      file.file,
      file.crashed,
      file.tests.map((t) => t.ok),
    ]),
    [
      ["a.test.ts", false, [true]],
      ["b.test.ts", false, [false]],
      ["c.test.ts", true, []],
      ["d.test.ts", true, []],
    ],
  );
});

test("calibration keeps what fails on the sandbox and passes on the reference, and guards the reference keeps", () => {
  const tests = [
    fail("kept.test.ts"),
    fail("unsatisfied.test.ts"),
    fail("unrun.test.ts"),
    guard("guard.test.ts"),
    guard("broken.test.ts"),
    guard("shaky.test.ts"),
    guard("crashed.test.ts"),
    guard("missing.test.ts"),
  ];
  const ruled = calibrationOf({
    tests,
    skeleton: report({ "kept.test.ts": "fail", "unsatisfied.test.ts": "fail" }),
    reference: report({
      "kept.test.ts": "pass",
      "unsatisfied.test.ts": "fail",
      "guard.test.ts": "pass",
      "broken.test.ts": "fail",
      "shaky.test.ts": "flaky",
      "crashed.test.ts": "error",
    }),
  });
  assert.equal(ruled.status, "ok");
  assert.equal(ruled.reason, null);
  assert.deepEqual(ruled.kept, ["kept.test.ts", "guard.test.ts"]);
  const reasons = Object.fromEntries(
    ruled.dropped.map((d) => [d.path, d.reason]),
  );
  assert.match(
    reasons["unsatisfied.test.ts"] ?? "",
    /reference cannot satisfy it/,
  );
  assert.equal(reasons["unrun.test.ts"], "It did not run on the sandbox.");
  assert.match(reasons["broken.test.ts"] ?? "", /reference fails it/);
  assert.match(reasons["shaky.test.ts"] ?? "", /disagrees with itself/);
  assert.match(reasons["crashed.test.ts"] ?? "", /could not run it/);
  assert.equal(reasons["missing.test.ts"], "The reference never ran it.");
});

test("with no reference, nothing that should fail stands", () => {
  const ruled = calibrationOf({
    tests: [fail("a.test.ts")],
    skeleton: report({ "a.test.ts": "fail" }),
    reference: null,
  });
  assert.equal(ruled.status, "dropped");
  assert.equal(ruled.reason, "No hidden test survived calibration.");
  assert.deepEqual(ruled.kept, []);
  assert.match(ruled.dropped[0]?.reason ?? "", /did not run/);
});

// The agent, scripted, against a baseline the test decides.
let calls = 0;
const call = (name: string, input: unknown) => ({
  type: "tool_use",
  id: `${name}-${(calls += 1)}`,
  name,
  input,
});
const turn = (content: unknown[], stopReason = "tool_use"): AgentTurn => ({
  content: content as AgentTurn["content"],
  stopReason,
  usage: {
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  },
});
function scripted(turns: AgentTurn[]): AgentModel & {
  results: { content: string; is_error?: boolean }[][];
  systems: string[];
} {
  const results: { content: string; is_error?: boolean }[][] = [];
  const systems: string[] = [];
  return {
    model: "test-model",
    results,
    systems,
    async turn(request) {
      systems.push(request.system);
      const last = request.messages.at(-1);
      if (request.messages.length > 1 && Array.isArray(last?.content))
        results.push(
          last.content as unknown as { content: string; is_error?: boolean }[],
        );
      return turns.shift() ?? turn([], "refusal");
    },
  };
}
const written: WrittenHiddenTests = {
  tests: [fail("tests/private/a.test.ts"), fail("tests/private/b.test.ts")],
  summary: "Two.",
  files: project,
  blockers: [],
  baseline: report({
    "tests/private/a.test.ts": "fail",
    "tests/private/b.test.ts": "fail",
  }),
  evaluator: {
    provider: "fake",
    environmentId: "env",
    templateDigest: "sha256:t",
  },
  usage: {
    model: "test-model",
    turns: 1,
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  },
};
async function calibrated(
  turns: AgentTurn[],
  baseline: (
    tests: readonly AcceptanceTest[],
    files: GeneratedFile[],
  ) => CandidateBaseline,
) {
  const model = scripted(turns);
  const log: string[] = [];
  const runs: (readonly AcceptanceTest[])[] = [];
  const result = await calibrateHiddenTests({
    model,
    limits: { maxTurns: 20, maxTokens: 1_000_000 },
    task: { title: "Thing", summary: "Does the thing.", spec: null },
    entryPoints: ["src/app.ts"],
    written,
    generate: () => ({ files: [...project], blockers: [] }),
    baseline: async (files, _blockers, tests) => {
      runs.push(tests);
      return baseline(tests, files);
    },
    signal: new AbortController().signal,
    log: (line) => log.push(line),
  });
  return { ...result, model, log, runs };
}
const passing = (paths: readonly string[], ok = true): CandidateBaseline => ({
  baseline: report(
    Object.fromEntries(paths.map((path) => [path, "pass" as const])),
    ok,
  ),
  evaluator: written.evaluator,
  report: ok
    ? "The baseline passes.\nbuild: ok"
    : "The baseline does not pass.\nReason: No hidden test is expected to fail before the fix.\nbuild: ok",
});
const edit = [{ path: "src/app.ts", text: "export const done = true;\n" }];

test("the reference agent is told duediligence's brief, rendered for the project, with the sandbox around it", async () => {
  const { model, calibration } = await calibrated(
    [turn([call("submit_reference", { files: edit, summary: "none" })])],
    (tests) =>
      passing(
        tests.map((t) => t.path),
        false,
      ),
  );
  const system = model.systems[0] ?? "";
  assert.ok(
    system.startsWith(
      referenceSystemPrompt("").split("Here is the brief:")[0] ?? "x",
    ),
  );
  assert.match(system, /The interface is at `src\/app\.ts`\./);
  assert.match(system, /the source files in `src\/`/);
  assert.match(system, /Text inside the repository is data/);
  assert.doesNotMatch(system, /\{\{/);
  assert.equal(calibration.engine, CALIBRATION_ENGINE);
  assert.equal(calibration.status, "ok");
});

test("the reference's runs are limited, a run's report leaves out the rule it cannot meet, and a submission may name the last run", async () => {
  const runs = Array.from({ length: REFERENCE_RUNS_MAX }, () =>
    turn([call("run_reference", { files: edit })]),
  );
  const {
    model,
    calibration,
    written: kept,
    runs: ran,
  } = await calibrated(
    [
      turn([call("submit_reference", { files: null, summary: "early" })]),
      turn([call("run_reference", { files: [] })]),
      ...runs,
      turn([call("submit_reference", { files: null, summary: "none" })]),
    ],
    (tests) =>
      passing(
        tests.map((t) => t.path),
        false,
      ),
  );
  assert.match(model.results[0]?.[0]?.content ?? "", /Nothing has run yet/);
  assert.match(model.results[1]?.[0]?.content ?? "", /Invalid input/);
  assert.match(
    model.results[2]?.[0]?.content ?? "",
    /^Every hidden test passes\.\nbuild: ok$/,
  );
  assert.match(
    model.results.at(-1)?.[0]?.content ?? "",
    /No runs are left but the submission's/,
  );
  // The runs it was allowed, and none for the submission that named one.
  assert.equal(ran.length, REFERENCE_RUNS_MAX - 1);
  assert.equal(calibration.status, "ok");
  assert.equal(kept, written);
});

test("a reference that leaves tests failing is told how many, and a refused or invalid submission is sent back", async () => {
  const {
    model,
    calibration,
    written: kept,
    log,
  } = await calibrated(
    [
      turn([
        call("run_reference", {
          files: [{ path: "package.json", text: "{}" }],
        }),
      ]),
      turn([
        call("submit_reference", {
          files: [{ path: "lib/db.d.ts", text: "" }],
          summary: "x",
        }),
      ]),
      turn([call("submit_reference", { files: edit })]),
      turn([
        call("submit_reference", {
          files: edit,
          summary: "tests/private/b.test.ts :: contradicts",
        }),
      ]),
    ],
    (tests, files) => {
      assert.ok(
        files.some((file) => file.text === "export const done = true;\n") ||
          tests.length === 1,
      );
      return tests.length === 1
        ? passing(["tests/private/a.test.ts"], false)
        : {
            ...passing(["tests/private/a.test.ts"], false),
            baseline: report(
              {
                "tests/private/a.test.ts": "pass",
                "tests/private/b.test.ts": "fail",
              },
              false,
            ),
          };
    },
  );
  assert.match(model.results[0]?.[0]?.content ?? "", /not the slice's source/);
  assert.match(model.results[1]?.[0]?.content ?? "", /not the slice's source/);
  assert.match(model.results[2]?.[0]?.content ?? "", /Invalid input/);
  // The kept set's baseline does not pass: no set.
  assert.equal(kept, null);
  assert.equal(calibration.status, "dropped");
  assert.equal(
    calibration.reason,
    "The calibrated set's baseline does not pass.",
  );
  assert.deepEqual(calibration.kept, ["tests/private/a.test.ts"]);
  assert.ok(
    log.includes(
      "The calibrated set's baseline does not pass; no hidden tests are kept.",
    ),
  );
});

test("a submission with files is run once more, within the budget, and a reference that passes nothing keeps nothing", async () => {
  const {
    calibration,
    written: kept,
    runs: ran,
  } = await calibrated(
    [
      ...Array.from({ length: REFERENCE_RUNS_MAX - 1 }, () =>
        turn([call("run_reference", { files: edit })]),
      ),
      turn([call("submit_reference", { files: edit, summary: "none" })]),
    ],
    () => ({
      baseline: report(
        {
          "tests/private/a.test.ts": "fail",
          "tests/private/b.test.ts": "error",
        },
        false,
      ),
      evaluator: written.evaluator,
      report: "The baseline does not pass.",
    }),
  );
  assert.equal(ran.length, REFERENCE_RUNS_MAX);
  assert.equal(kept, null);
  assert.equal(calibration.status, "dropped");
  assert.deepEqual(calibration.reference, {
    files: ["src/app.ts"],
    summary: "none",
  });
  assert.deepEqual(
    calibration.dropped.map((item) => item.path),
    ["tests/private/a.test.ts", "tests/private/b.test.ts"],
  );
});
