/**
 * Hidden tests for a sliced version that has none: an agent reads the
 * project the build generated, as the developer will get it, and writes the
 * acceptance tests a submission is judged by from the bounty's approved
 * spec. Each candidate set is built into the project and run through a full
 * baseline in a fresh job, as a starter's is, and a set is accepted only
 * when that baseline passes: the project still builds and runs, and each
 * test does what the agent said it would, at least one failing until the
 * bounty is done. A set that never passes is not kept, so the next build
 * asks again rather than settling tests that cannot judge anything.
 *
 * The agent reads only the public project, written to a scratch directory
 * of its own; the repository the slice was cut from is not in reach.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  AcceptanceTest,
  AgentUsage,
  BaselineReport,
  EvaluationEnvironment,
  GeneratedFile,
  ProjectBlocker,
  SpecDraft,
} from "sandbox-factory";
import { acceptanceTestsSchema } from "@sandbox-factory/shared";
import { z } from "zod";
import type {
  AgentModel,
  AgentSettings,
  AgentTool,
  AgentToolResult,
} from "../agent/loop.js";
import { inputCount, runAgent } from "../agent/loop.js";
import {
  HIDDEN_TESTS_SYSTEM_PROMPT,
  hiddenTestsSection,
} from "../agent/prompts.js";
import {
  indexRepository,
  invalidInput,
  repositoryOverview,
  repositoryTools,
} from "../agent/repo-tools.js";
import type { RunTiming } from "../timing.js";

/** Candidate sets one build may run, the submission's run among them. */
export const HIDDEN_TEST_RUNS_MAX = 5;

/** The project a set of hidden tests is built into. */
export interface GeneratedCandidate {
  readonly files: GeneratedFile[];
  readonly blockers: ProjectBlocker[];
}

/** A candidate's baseline, and what the agent is told of it. */
export interface CandidateBaseline {
  readonly baseline: BaselineReport;
  readonly evaluator: EvaluationEnvironment;
  readonly report: string;
}

/** A set of hidden tests whose baseline passed, and that baseline. */
export interface WrittenHiddenTests {
  readonly tests: readonly AcceptanceTest[];
  readonly summary: string;
  readonly files: GeneratedFile[];
  readonly blockers: ProjectBlocker[];
  readonly baseline: BaselineReport;
  readonly evaluator: EvaluationEnvironment;
  readonly usage: AgentUsage;
}

const testsProperty = {
  type: "array",
  description:
    "Hidden tests under tests/private/, each with its outcome on the project as it is now.",
  items: {
    type: "object",
    properties: {
      path: { type: "string", description: "tests/private/<name>.test.ts" },
      text: { type: "string" },
      expectedBaseline: { type: "string", enum: ["pass", "fail"] },
    },
    required: ["path", "text", "expectedBaseline"],
    additionalProperties: false,
  },
};
const candidateSchema = z.object({ tests: acceptanceTestsSchema });
const submissionSchema = candidateSchema.extend({
  summary: z.string().trim().min(1).max(2_000),
});

/** A set's tests, as a step says them: "3 hidden tests". */
function testCount(input: unknown): string {
  const count = inputCount(input, "tests");
  return `${count} hidden ${count === 1 ? "test" : "tests"}`;
}

/** A run of a set, as a step: whether its baseline passed. */
function ranTests(
  verb: string,
  input: unknown,
  result: AgentToolResult,
): string | null {
  if (result.content.startsWith("No runs are left")) return null;
  if (result.content.startsWith("The baseline passes."))
    return `${verb} ${testCount(input)}: the baseline passes`;
  if (result.content.startsWith("The baseline does not pass."))
    return `${verb} ${testCount(input)}: the baseline does not pass yet`;
  return null;
}

export async function writeHiddenTests(input: {
  readonly model: AgentModel;
  readonly limits: AgentSettings["limits"];
  readonly task: {
    readonly title: string;
    readonly summary: string;
    readonly spec: SpecDraft | null;
  };
  /** The project built with a set of hidden tests; pure, so cheap to repeat. */
  readonly generate: (tests: readonly AcceptanceTest[]) => GeneratedCandidate;
  /**
   * Runs a candidate's baseline in a fresh job, as `reportedBaselineOf`
   * does; it adds the lockfile to `files` and a failed baseline's blocker
   * to `blockers`.
   */
  readonly baseline: (
    files: GeneratedFile[],
    blockers: ProjectBlocker[],
    tests: readonly AcceptanceTest[],
  ) => Promise<CandidateBaseline>;
  readonly signal: AbortSignal;
  readonly log: (line: string) => void;
  readonly step?: ((text: string) => void) | undefined;
  readonly timing?: RunTiming | undefined;
}): Promise<WrittenHiddenTests | null> {
  // The developer's project, for the repository tools to read.
  const root = await mkdtemp(join(tmpdir(), "hidden-tests-"));
  try {
    for (const file of input.generate([]).files) {
      if (!file.public) continue;
      const path = join(root, file.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.text, "utf8");
    }
    const index = await indexRepository(root, input.signal);
    let runs = 0;
    const run = async (
      tests: readonly AcceptanceTest[],
    ): Promise<
      | { readonly problems: readonly string[] }
      | (GeneratedCandidate & CandidateBaseline)
    > => {
      const candidate = input.generate(tests);
      // Nothing runs when the tests themselves cannot be placed.
      if (candidate.blockers.length > 0)
        return {
          problems: candidate.blockers.map(
            (blocker) => `${blocker.file ?? blocker.code}: ${blocker.detail}`,
          ),
        };
      runs += 1;
      const files = [...candidate.files];
      const blockers = [...candidate.blockers];
      const result = await input.baseline(files, blockers, tests);
      return { files, blockers, ...result };
    };
    const runTool: AgentTool = {
      name: "run_hidden_tests",
      describe: (call, result) => ranTests("Ran", call, result),
      description: `Build the project with these hidden tests and run its baseline in a fresh job: install, build, the walkthrough, the public tests and each hidden test. Shows each step, and the output of those that surprised. Runs are shared with submit_hidden_tests: ${HIDDEN_TEST_RUNS_MAX} in all.`,
      inputSchema: {
        properties: { tests: testsProperty },
        required: ["tests"],
        additionalProperties: false,
      },
      async run(raw): Promise<AgentToolResult> {
        const parsed = candidateSchema.safeParse(raw);
        if (!parsed.success) return invalidInput(parsed.error.issues);
        // One run is kept for the submission.
        if (runs >= HIDDEN_TEST_RUNS_MAX - 1)
          return {
            content: "No runs are left but the submission's. Submit now.",
            isError: true,
          };
        const result = await run(parsed.data.tests);
        if ("problems" in result)
          return { content: result.problems.join("\n"), isError: true };
        return { content: result.report, isError: !result.baseline.ok };
      },
    };
    let accepted: WrittenHiddenTests | null = null;
    const submitTool: AgentTool = {
      name: "submit_hidden_tests",
      describe: (call, result) =>
        accepted !== null && result.accepted === true
          ? `Submitted ${testCount(call)}`
          : ranTests("Submitted", call, result),
      description:
        "Submit the hidden tests. The baseline is run once more, and they are accepted when it passes.",
      inputSchema: {
        properties: {
          tests: testsProperty,
          summary: {
            type: "string",
            description: "What the hidden tests check, in a few sentences.",
          },
        },
        required: ["tests", "summary"],
        additionalProperties: false,
      },
      async run(raw): Promise<AgentToolResult> {
        const parsed = submissionSchema.safeParse(raw);
        if (!parsed.success) return invalidInput(parsed.error.issues);
        if (runs >= HIDDEN_TEST_RUNS_MAX)
          return { content: "No runs are left.", accepted: true };
        const result = await run(parsed.data.tests);
        if ("problems" in result)
          return { content: result.problems.join("\n"), isError: true };
        if (!result.baseline.ok)
          // Sent back while runs remain; after that, the loop ends with no
          // tests kept.
          return runs < HIDDEN_TEST_RUNS_MAX
            ? { content: result.report, isError: true }
            : {
                content: `${result.report}\nNo runs are left; these tests are not kept.`,
                accepted: true,
              };
        accepted = {
          tests: parsed.data.tests,
          summary: parsed.data.summary,
          files: result.files,
          blockers: result.blockers,
          baseline: result.baseline,
          evaluator: result.evaluator,
          // Filled in once the loop returns.
          usage: {
            model: input.model.model,
            turns: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        };
        return { content: "Recorded.", accepted: true };
      },
    };
    input.log("Hidden-tests agent started.");
    const outcome = await runAgent({
      model: input.model,
      step: input.step,
      onTurn: input.timing?.turn,
      system: HIDDEN_TESTS_SYSTEM_PROMPT,
      prompt: hiddenTestsSection({
        title: input.task.title,
        summary: input.task.summary,
        spec: input.task.spec,
        overview: repositoryOverview(index),
      }),
      tools: [...repositoryTools(index), runTool, submitTool],
      submitTool: "submit_hidden_tests",
      limits: input.limits,
      signal: input.signal,
      log: input.log,
    });
    const answer = accepted as WrittenHiddenTests | null;
    input.log(
      answer === null
        ? `Hidden-tests agent stopped (${outcome.stopped}) with no tests kept.`
        : `Hidden-tests agent wrote ${answer.tests.length} hidden test(s).`,
    );
    return answer === null ? null : { ...answer, usage: outcome.usage };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
