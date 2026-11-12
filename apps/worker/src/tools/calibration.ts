/**
 * Calibration of a set of hidden tests by a reference implementation, on
 * duediligence's rule (`duediligence/api`, pinned in package.json): a test
 * that should fail before the bounty is done is kept only if it fails on
 * the sandbox as built and a reference implementation of the bounty passes
 * it. A test no implementation that follows the spec can pass would
 * otherwise judge every submission as failing.
 *
 * The hidden-tests agent's accepted set already fails or passes on the
 * sandbox as it said (its baseline), so what this adds is the reference:
 * a second agent, told duediligence's own brief (`prompts/repo/reference`),
 * implements the bounty in the developer's project with the hidden tests in
 * view and leaves failing any test that contradicts the spec. The worker
 * runs the hidden tests on it in a fresh job, as a baseline. A test that
 * should fail is put through `calibrate`; one that guards behaviour the
 * sandbox already has ("pass") is kept when the reference passes it too,
 * since a finished bounty must keep that behaviour. When the kept set is
 * smaller, its baseline is run again so the build is the baseline of the
 * set it keeps. No test that should fail kept means no set: the build then
 * has no hidden tests, as when the hidden-tests agent keeps none.
 *
 * The reference itself is evidence, never shipped: it is not part of the
 * version, and only its file paths and summary are recorded.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { calibrate, renderPrompt } from "duediligence/api";
import type { SuiteResult } from "duediligence/api";
import type {
  AcceptanceTest,
  AgentUsage,
  BaselineReport,
  GeneratedFile,
  ProjectBlocker,
  SpecDraft,
} from "sandbox-factory";
import {
  PRIVATE_TESTS_DIR,
  PUBLIC_TESTS_DIR,
  renderGherkin,
} from "sandbox-factory";
import { z } from "zod";
import type {
  AgentModel,
  AgentSettings,
  AgentTool,
  AgentToolResult,
} from "../agent/loop.js";
import { runAgent } from "../agent/loop.js";
import { referenceSection, referenceSystemPrompt } from "../agent/prompts.js";
import {
  indexRepository,
  invalidInput,
  repositoryOverview,
  repositoryTools,
} from "../agent/repo-tools.js";
import type { RunTiming } from "../timing.js";
import type {
  CandidateBaseline,
  GeneratedCandidate,
  WrittenHiddenTests,
} from "./hidden-tests.js";

/** The engine the rule and the brief come from, as a build records it. */
export const CALIBRATION_ENGINE = `duediligence@${
  (
    createRequire(import.meta.url)("duediligence/package.json") as {
      version: string;
    }
  ).version
}`;
/** Reference runs one calibration may spend, the submission's among them. */
export const REFERENCE_RUNS_MAX = 4;
/** What the reference agent runs its project with: its one tool. */
const RUN_TOOL = "run_reference";
/** A hidden test's name in a suite result: the worker judges whole files. */
const FILE_TEST = "(file)";

/** What a calibration kept and dropped, for the build's transform. */
export interface HiddenTestsCalibration {
  readonly engine: string;
  readonly status: "ok" | "dropped";
  readonly reason: string | null;
  /** The hidden test files kept. */
  readonly kept: readonly string[];
  readonly dropped: readonly {
    readonly path: string;
    readonly reason: string;
  }[];
  /** The reference's files and summary; null when it submitted none. */
  readonly reference: {
    readonly files: readonly string[];
    readonly summary: string;
  } | null;
  readonly usage: AgentUsage;
}

/** A file the reference writes: an edit to the slice's source, or a new one beside it. */
interface ReferenceFile {
  readonly path: string;
  readonly text: string;
}
const referenceFilesSchema = z
  .array(
    z.object({
      path: z.string().trim().min(1).max(500),
      text: z.string().max(400_000),
    }),
  )
  .min(1)
  .max(60);
const runSchema = z.object({ files: referenceFilesSchema });
const submissionSchema = z.object({
  files: referenceFilesSchema.nullable(),
  summary: z.string().trim().min(1).max(4_000),
});

/**
 * Where the reference may write: the slice's source files, and new
 * TypeScript files in a directory that already holds one. Never a test, a
 * declaration, a stub, the harness, a config or anything else the build
 * generated. A problem per file that breaks the rule.
 */
export function referenceProblems(
  project: readonly GeneratedFile[],
  files: readonly ReferenceFile[],
): string[] {
  const byPath = new Map(project.map((file) => [file.path, file]));
  const sourceDirs = new Set(
    project
      .filter((file) => file.class === "source" && file.public)
      .map((file) => dirname(file.path)),
  );
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const { path } of files) {
    if (seen.has(path)) problems.push(`${path}: given twice.`);
    seen.add(path);
    const existing = byPath.get(path);
    if (existing !== undefined) {
      if (existing.class !== "source" || !existing.public)
        problems.push(
          `${path}: not the slice's source; change only source files.`,
        );
      continue;
    }
    if (
      path
        .split("/")
        .some((part) => part === "" || part === "." || part === "..") ||
      !/\.(?:c|m)?tsx?$/.test(path) ||
      path.endsWith(".d.ts") ||
      /\.test\.[cm]?tsx?$/.test(path) ||
      !sourceDirs.has(dirname(path))
    )
      problems.push(
        `${path}: a new file must be TypeScript, not a test or declaration, in a directory that already holds source.`,
      );
  }
  return problems;
}

/** The project with the reference's files in place of the slice's. */
export function withReference(
  project: readonly GeneratedFile[],
  files: readonly ReferenceFile[],
): GeneratedFile[] {
  const given = new Map(files.map((file) => [file.path, file.text]));
  const out = project.map((file) => {
    const text = given.get(file.path);
    return text === undefined ? file : { ...file, text };
  });
  const present = new Set(project.map((file) => file.path));
  for (const file of files)
    if (!present.has(file.path))
      out.push({
        path: file.path,
        text: file.text,
        class: "source",
        public: true,
      });
  return out;
}

/**
 * A baseline's hidden tests as the suite result duediligence's rule reads,
 * a test per file: a file that could not run, or disagreed with itself, is
 * one that crashed. A file the baseline never ran is absent.
 */
export function suiteOf(
  baseline: BaselineReport,
  paths: readonly string[],
): SuiteResult {
  const outcomes = new Map(
    baseline.privateTests.map((outcome) => [outcome.path, outcome.observed]),
  );
  return {
    compiled: true,
    files: paths.flatMap((path) => {
      const observed = outcomes.get(path);
      if (observed === undefined) return [];
      const crashed = observed === "error" || observed === "flaky";
      return [
        {
          file: path,
          crashed,
          timedOut: false,
          tests: crashed
            ? []
            : [
                {
                  name: FILE_TEST,
                  ok: observed === "pass",
                  skipped: false,
                  error:
                    observed === "pass" ? null : { message: "The test fails." },
                },
              ],
        },
      ];
    }),
  };
}

/**
 * Which tests stand, from the sandbox's baseline and the reference's:
 * `calibrate` for those that should fail, the reference's pass for those
 * that guard. `reference` null is a reference that never ran.
 */
export function calibrationOf(input: {
  readonly tests: readonly AcceptanceTest[];
  readonly skeleton: BaselineReport;
  readonly reference: BaselineReport | null;
}): Pick<HiddenTestsCalibration, "status" | "reason" | "kept" | "dropped"> {
  const failing = input.tests
    .filter((test) => test.expectedBaseline === "fail")
    .map((test) => test.path);
  const guards = input.tests
    .filter((test) => test.expectedBaseline === "pass")
    .map((test) => test.path);
  const ruled = calibrate({
    skeleton: suiteOf(input.skeleton, failing),
    reference:
      input.reference === null ? null : suiteOf(input.reference, failing),
  });
  const fileOf = (id: string) => id.slice(0, id.lastIndexOf(" :: "));
  const keptFailing = new Set(ruled.kept.map(fileOf));
  const dropped = new Map<string, string>();
  for (const { id, reason } of ruled.dropped) {
    const path = fileOf(id);
    if (!keptFailing.has(path) && !dropped.has(path)) dropped.set(path, reason);
  }
  // A failing test the rule saw no result for never ran on the skeleton.
  for (const path of failing)
    if (!keptFailing.has(path) && !dropped.has(path))
      dropped.set(path, "It did not run on the sandbox.");
  const referenceOutcomes = new Map(
    (input.reference?.privateTests ?? []).map((outcome) => [
      outcome.path,
      outcome.observed,
    ]),
  );
  const keptGuards = new Set<string>();
  for (const path of guards) {
    const observed = referenceOutcomes.get(path);
    if (observed === "pass") keptGuards.add(path);
    else
      dropped.set(
        path,
        observed === undefined
          ? "The reference never ran it."
          : `It guards what the sandbox does, and the reference ${observed === "fail" ? "fails" : observed === "flaky" ? "disagrees with itself on" : "could not run"} it.`,
      );
  }
  const kept = input.tests
    .map((test) => test.path)
    .filter((path) => keptFailing.has(path) || keptGuards.has(path));
  return {
    status: keptFailing.size > 0 ? "ok" : "dropped",
    reason:
      keptFailing.size > 0
        ? null
        : (ruled.reason ??
          "No hidden test that should fail survived calibration."),
    kept,
    dropped: [...dropped].map(([path, reason]) => ({ path, reason })),
  };
}

/** A reference run, as the agent is told it: each hidden test passes or not. */
function referenceReport(result: CandidateBaseline): string {
  const failing = result.baseline.privateTests.filter(
    (outcome) => outcome.observed !== "pass",
  ).length;
  const [, ...rest] = result.report.split("\n");
  return [
    result.baseline.privateTests.length === 0
      ? "No hidden test ran."
      : failing === 0
        ? "Every hidden test passes."
        : `${failing} hidden ${failing === 1 ? "test does" : "tests do"} not pass.`,
    // The baseline's rule wants a test that fails before the fix, which a
    // reference has none of: that reason is not the reference's to fix.
    ...rest.filter(
      (line) => !/^Reason: No hidden test (judges|is expected)/.test(line),
    ),
  ].join("\n");
}

/** A run of the reference, as a step: how many hidden tests it passes. */
function ranReference(verb: string, result: AgentToolResult): string | null {
  const head = result.content.split("\n", 1)[0] ?? "";
  if (head === "Every hidden test passes.")
    return `${verb} a reference: every hidden test passes`;
  if (/^\d+ hidden tests? do(es)? not pass\.$/.test(head))
    return `${verb} a reference: ${head.slice(0, -1).toLowerCase()}`;
  return null;
}

export async function calibrateHiddenTests(input: {
  readonly model: AgentModel;
  readonly limits: AgentSettings["limits"];
  readonly task: {
    readonly title: string;
    readonly summary: string;
    readonly spec: SpecDraft | null;
  };
  /** The slice's entry points at the project's paths: the interface. */
  readonly entryPoints: readonly string[];
  readonly written: WrittenHiddenTests;
  readonly generate: (tests: readonly AcceptanceTest[]) => GeneratedCandidate;
  /** As `writeHiddenTests`' baseline: a candidate's run in a fresh job. */
  readonly baseline: (
    files: GeneratedFile[],
    blockers: ProjectBlocker[],
    tests: readonly AcceptanceTest[],
  ) => Promise<CandidateBaseline>;
  readonly signal: AbortSignal;
  readonly log: (line: string) => void;
  readonly step?: ((text: string) => void) | undefined;
  readonly timing?: RunTiming | undefined;
}): Promise<{
  readonly written: WrittenHiddenTests | null;
  readonly calibration: HiddenTestsCalibration;
}> {
  const { written } = input;
  // On the reference every hidden test should pass, guards and all.
  const asPassing = written.tests.map((test) => ({
    ...test,
    expectedBaseline: "pass" as const,
  }));
  const project = input.generate(asPassing);
  const root = await mkdtemp(join(tmpdir(), "reference-"));
  try {
    // The developer's project with the hidden tests in it, and the spec
    // where duediligence's brief says it is.
    for (const file of project.files) {
      const path = join(root, file.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.text, "utf8");
    }
    await writeFile(
      join(root, "spec.md"),
      input.task.spec === null
        ? `# ${input.task.title}\n\n${input.task.summary}\n`
        : `# ${input.task.title}\n\n${input.task.summary}\n\n${renderGherkin(input.task.spec)}\n`,
      "utf8",
    );
    const index = await indexRepository(root, input.signal);
    const sourceDirs = [
      ...new Set(
        project.files
          .filter((file) => file.class === "source" && file.public)
          .map((file) => `${dirname(file.path)}/`),
      ),
    ].sort();
    const code = (items: readonly string[]) =>
      items.map((item) => `\`${item}\``).join(", ");
    const brief = renderPrompt("repo/reference", {
      seam: code([...input.entryPoints].sort()),
      publicDir: PUBLIC_TESTS_DIR,
      slug: "*",
      hiddenDir: PRIVATE_TESTS_DIR,
      allowedPaths: `the source files in ${code(sourceDirs)}`,
      testPublic: RUN_TOOL,
      testHidden: RUN_TOOL,
      test: RUN_TOOL,
    });
    let runs = 0;
    // The last run, and the files it ran with.
    let last: {
      readonly files: readonly ReferenceFile[];
      readonly result: CandidateBaseline;
    } | null = null;
    const run = async (
      files: readonly ReferenceFile[],
    ): Promise<{ problems: string[] } | CandidateBaseline> => {
      const problems = referenceProblems(project.files, files);
      if (problems.length > 0) return { problems };
      runs += 1;
      const result = await input.baseline(
        withReference(project.files, files),
        [...project.blockers],
        asPassing,
      );
      last = { files, result };
      return result;
    };
    const filesProperty = {
      type: "array",
      description:
        "The source files you change or add, each whole: path and full text.",
      items: {
        type: "object",
        properties: { path: { type: "string" }, text: { type: "string" } },
        required: ["path", "text"],
        additionalProperties: false,
      },
    };
    const runTool: AgentTool = {
      name: RUN_TOOL,
      describe: (_call, result) => ranReference("Ran", result),
      description: `Build the project with these source files in place and run it in a fresh job: install, build, the walkthrough, the public tests and each hidden test, with the output of those that fail. Runs are shared with submit_reference: ${REFERENCE_RUNS_MAX} in all.`,
      inputSchema: {
        properties: { files: filesProperty },
        required: ["files"],
        additionalProperties: false,
      },
      async run(raw): Promise<AgentToolResult> {
        const parsed = runSchema.safeParse(raw);
        if (!parsed.success) return invalidInput(parsed.error.issues);
        if (runs >= REFERENCE_RUNS_MAX - 1)
          return {
            content: "No runs are left but the submission's. Submit now.",
            isError: true,
          };
        const result = await run(parsed.data.files);
        if ("problems" in result)
          return { content: result.problems.join("\n"), isError: true };
        return { content: referenceReport(result) };
      },
    };
    let submitted: {
      readonly files: readonly ReferenceFile[];
      readonly summary: string;
      readonly result: CandidateBaseline;
    } | null = null;
    const submitTool: AgentTool = {
      name: "submit_reference",
      describe: (_call, result) =>
        result.accepted === true && submitted !== null
          ? `Submitted a reference of ${submitted.files.length} file(s)`
          : null,
      description:
        "Submit the reference. With files: null, the files your last run_reference ran with are submitted as they ran. Otherwise they are run once more. Put each test you left failing in the summary, as `file :: reason`, or say none.",
      inputSchema: {
        properties: {
          files: {
            ...filesProperty,
            type: ["array", "null"],
            description:
              "The source files, or null for those your last run_reference ran with.",
          },
          summary: {
            type: "string",
            description:
              "What the reference does, and each test left failing with why.",
          },
        },
        required: ["files", "summary"],
        additionalProperties: false,
      },
      async run(raw): Promise<AgentToolResult> {
        const parsed = submissionSchema.safeParse(raw);
        if (!parsed.success) return invalidInput(parsed.error.issues);
        const ran = last as {
          readonly files: readonly ReferenceFile[];
          readonly result: CandidateBaseline;
        } | null;
        if (parsed.data.files === null) {
          if (ran === null)
            return {
              content: "Nothing has run yet: submit the files themselves.",
              isError: true,
            };
          submitted = { ...ran, summary: parsed.data.summary };
          return { content: "Recorded.", accepted: true };
        }
        // run_reference leaves this run: never more than the budget.
        const result = await run(parsed.data.files);
        if ("problems" in result)
          return { content: result.problems.join("\n"), isError: true };
        submitted = {
          files: parsed.data.files,
          summary: parsed.data.summary,
          result,
        };
        return { content: "Recorded.", accepted: true };
      },
    };
    input.log("Reference agent started.");
    const outcome = await runAgent({
      model: input.model,
      step: input.step,
      onTurn: input.timing?.turn,
      system: referenceSystemPrompt(brief),
      prompt: referenceSection({
        title: input.task.title,
        summary: input.task.summary,
        spec: input.task.spec,
        overview: repositoryOverview(index),
        runTool: RUN_TOOL,
        runsMax: REFERENCE_RUNS_MAX,
      }),
      tools: [...repositoryTools(index), runTool, submitTool],
      submitTool: "submit_reference",
      limits: input.limits,
      effort: "medium",
      signal: input.signal,
      log: input.log,
    });
    const reference = submitted as {
      readonly files: readonly ReferenceFile[];
      readonly summary: string;
      readonly result: CandidateBaseline;
    } | null;
    const ruled = calibrationOf({
      tests: written.tests,
      skeleton: written.baseline,
      reference: reference?.result.baseline ?? null,
    });
    const calibration: HiddenTestsCalibration = {
      engine: CALIBRATION_ENGINE,
      ...ruled,
      reference:
        reference === null
          ? null
          : {
              files: reference.files.map((file) => file.path).sort(),
              summary: reference.summary,
            },
      usage: outcome.usage,
    };
    for (const { path, reason } of calibration.dropped)
      input.log(`Calibration dropped ${path}: ${reason}`);
    if (calibration.status === "dropped") {
      input.log(
        `Calibration kept no hidden test that should fail (${CALIBRATION_ENGINE}): ${calibration.reason ?? ""}`,
      );
      return { written: null, calibration };
    }
    if (calibration.kept.length === written.tests.length) {
      input.log(
        `Calibration kept all ${written.tests.length} hidden test(s) (${CALIBRATION_ENGINE}).`,
      );
      return { written, calibration };
    }
    // Fewer tests: the build is the baseline of the set it keeps.
    const keep = new Set(calibration.kept);
    const tests = written.tests.filter((test) => keep.has(test.path));
    const candidate = input.generate(tests);
    const files = [...candidate.files];
    const blockers = [...candidate.blockers];
    const rerun = await input.baseline(files, blockers, tests);
    if (!rerun.baseline.ok) {
      input.log(
        "The calibrated set's baseline does not pass; no hidden tests are kept.",
      );
      return {
        written: null,
        calibration: {
          ...calibration,
          status: "dropped",
          reason: "The calibrated set's baseline does not pass.",
        },
      };
    }
    input.log(
      `Calibration kept ${tests.length} of ${written.tests.length} hidden test(s) (${CALIBRATION_ENGINE}).`,
    );
    return {
      written: {
        ...written,
        tests,
        files,
        blockers,
        baseline: rerun.baseline,
        evaluator: rerun.evaluator,
      },
      calibration,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
