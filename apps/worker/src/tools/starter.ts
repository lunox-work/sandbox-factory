/**
 * The starter adapter: for a generated version, an agent writes the project
 * a contributor starts from out of the bounty's own title, description and
 * stack, and the worker builds it and checks its baseline, as a build does
 * for a sliced version.
 *
 * There is no repository: the run reads no source and the agent has no
 * repository tools. The agent writes in the bounty's own vocabulary and
 * submits the name table that renames it; the project is built from the
 * renamed starter, and the table becomes the version's, as a sliced
 * version's is. It type-checks candidates in memory (`check_starter`)
 * and runs them for real in a fresh evaluation job (`run_starter`), whose
 * output it is shown, since everything in a starter is its own writing.
 * An answer is accepted when its baseline passes; once the runs are spent,
 * the last answer is kept as a build that is not ready, so a person can
 * see what went wrong. The set and the build land on the version only
 * after the run commits, and only while the draft still points at it.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  STARTER_SET_SCHEMA_VERSION,
  STARTER_TOOL_VERSION,
  aliasStarter,
  canonicalJson,
  nameTableProblems,
  isStarterParams,
  starterScope,
  transformConfigOf,
} from "sandbox-factory";
import type {
  AcceptanceTest,
  BaselineReport,
  EvaluationEnvironment,
  EvaluationProvider,
  GeneratedFile,
  ProjectBlocker,
  ProjectVersion,
  SandboxBuildManifest,
  SpecDraft,
  StarterSet,
  StarterSubmission,
} from "sandbox-factory";
import {
  starterSetSchema,
  starterSubmissionSchema,
} from "@sandbox-factory/shared";
import { AnalysisError } from "../errors.js";
import type {
  AgentSettings,
  AgentTool,
  AgentToolResult,
} from "../agent/loop.js";
import { runAgent } from "../agent/loop.js";
import {
  STARTER_SYSTEM_PROMPT,
  starterBountySection,
} from "../agent/prompts.js";
import { invalidInput } from "../agent/repo-tools.js";
import type { ArtifactFile, ToolAdapter, ToolRunInput } from "./adapter.js";
import { baselineOf, writeBuildOutputs } from "./sandbox-build.js";
import { sha256 } from "./slice/hash.js";
import { checkStarter } from "./starter-check.js";

/** Candidates one run may type-check, and run for real, before it must submit. */
export const STARTER_CHECKS_MAX = 16;
export const STARTER_RUNS_MAX = 5;
/** How much of a failed step's output the agent is shown. */
export const STEP_OUTPUT_CHARS = 4_000;
export const STARTER_SET_PATH = "starter-set.json";

const candidateSchema = starterSubmissionSchema.omit({
  summary: true,
  aliases: true,
});
const submissionSchema = starterSubmissionSchema.omit({ aliases: true });

const fileItems = (description: string) => ({
  type: "array",
  description,
  items: {
    type: "object",
    properties: {
      path: { type: "string" },
      text: { type: "string" },
    },
    required: ["path", "text"],
    additionalProperties: false,
  },
});
const candidateProperties = {
  files: fileItems("The source, under src/."),
  publicTests: fileItems("Tests under tests/public/ that pass on the starter."),
  hiddenTests: {
    type: "array",
    description:
      "Acceptance tests under tests/private/, each with its outcome on the starter.",
    items: {
      type: "object",
      properties: {
        path: { type: "string" },
        text: { type: "string" },
        expectedBaseline: { type: "string", enum: ["pass", "fail"] },
      },
      required: ["path", "text", "expectedBaseline"],
      additionalProperties: false,
    },
  },
  packages: {
    type: "array",
    items: {
      type: "object",
      properties: {
        name: { type: "string" },
        version: { type: "string", description: "An exact version." },
      },
      required: ["name", "version"],
      additionalProperties: false,
    },
  },
  scenario: { type: "string", description: "TypeScript for sandbox/run.ts." },
};
const candidateRequired = [
  "files",
  "publicTests",
  "hiddenTests",
  "packages",
  "scenario",
];
/**
 * The pseudonyms, set apart from the starter: with them, the three
 * starter tools' strict schemas compile past the grammar's size limit, so
 * this one is loose and checked when it runs.
 */
const pseudonymsProperties = {
  aliases: {
    type: "array",
    description:
      "The pseudonyms, applied in order: each name the starter takes from the bounty's own vocabulary, and the neutral one the developer reads instead.",
    items: {
      type: "object",
      properties: {
        before: {
          type: "string",
          description: "The name as the starter writes it.",
        },
        after: {
          type: "string",
          description: "The neutral name the developer reads.",
        },
        kind: {
          type: "string",
          enum: ["identifier", "text"],
          description:
            "identifier: a TypeScript name, matched whole. text: a word or phrase in strings and comments, matched anywhere.",
        },
      },
      required: ["before", "after", "kind"],
      additionalProperties: false,
    },
  },
};
const pseudonymsSchema = starterSubmissionSchema.pick({ aliases: true });

/** The tail of a step's output: where a failure usually says what it is. */
function tail(text: string): string {
  return text.length <= STEP_OUTPUT_CHARS
    ? text
    : `…${text.slice(-STEP_OUTPUT_CHARS)}`;
}

/** One baseline, built and run for a candidate. */
interface StarterBuild {
  readonly files: GeneratedFile[];
  readonly blockers: ProjectBlocker[];
  readonly baseline: BaselineReport;
  readonly evaluator: EvaluationEnvironment;
  /** The hidden tests in public names, as the version keeps them. */
  readonly hiddenTests: readonly AcceptanceTest[];
  /** What the agent is told: each step, and the output of those that failed. */
  readonly report: string;
}

export function createStarterAdapter(options: {
  readonly agent: AgentSettings;
  /** `null` when the worker has none: generation fails before the agent starts. */
  readonly provider: EvaluationProvider | null;
  readonly now?: () => Date;
}): ToolAdapter {
  const now = options.now ?? (() => new Date());
  return {
    name: "sandbox_starter",
    version: STARTER_TOOL_VERSION,
    async run(input: ToolRunInput): Promise<ArtifactFile[]> {
      const params = input.params;
      if (!isStarterParams(params)) throw new AnalysisError("tool_failed");
      const model = options.agent.model;
      if (model === null) {
        input.log("No agent model is configured on this worker.");
        throw new AnalysisError("agent_unavailable");
      }
      const provider = options.provider;
      if (provider === null) {
        input.log("No evaluation provider is configured on this worker.");
        throw new AnalysisError("evaluation_failed");
      }
      // The version this run was queued for, still a draft of the same task.
      const stored = await input.inputs.getVersion(params.sandboxVersionId);
      if (
        stored === null ||
        stored.source.origin !== "starter" ||
        stored.version.frozenAt !== null ||
        stored.source.approvedTaskSha256 !== params.approvedTaskSha256
      )
        throw new AnalysisError("tool_failed");
      const { version } = stored;
      const task = stored.source.approvedTask;
      const spec: SpecDraft | null = task.spec?.draft ?? null;
      const projectVersion: ProjectVersion = {
        sandboxId: version.sandboxId,
        versionId: version.id,
        version: version.version,
        title: version.title,
        specSummary: version.specSummary,
        complexity: version.complexity,
        tags: version.tags,
      };
      input.log("Starter agent started.");
      const check = (starter: StarterSubmission) =>
        checkStarter({
          root: input.sourceDir,
          version: projectVersion,
          starter,
          spec,
        });
      let checks = 0;
      let runs = 0;
      const build = async (
        starter: StarterSubmission,
      ): Promise<StarterBuild | { problems: readonly string[] }> => {
        const checked = check(starter);
        if (!checked.ok) return { problems: checked.problems };
        runs += 1;
        const files = [...checked.project.files];
        const blockers = [...checked.project.blockers];
        const failed: string[] = [];
        const expected = new Map(
          starter.hiddenTests.map((test) => [test.path, test.expectedBaseline]),
        );
        // The hidden tests run against the renamed project, renamed with it.
        const hiddenTests = checked.starter.hiddenTests;
        const { baseline, evaluator } = await baselineOf(provider, {
          label: version.id,
          files,
          acceptanceTests: hiddenTests,
          blockers,
          signal: input.signal,
          log: input.log,
          now,
          onStep: (step, output) => {
            // A hidden test is judged by what it was expected to do.
            const surprising =
              step.name === "private-test"
                ? (step.timedOut || step.exitCode === null
                    ? "error"
                    : step.exitCode === 0
                      ? "pass"
                      : step.exitCode === 1
                        ? "fail"
                        : "error") !== expected.get(step.path ?? "")
                : !step.ok;
            if (!surprising) return;
            failed.push(
              `--- ${step.path ?? step.name} (exit ${step.exitCode ?? "none"}${step.timedOut ? ", timed out" : ""})\n${tail(`${output.stdout}\n${output.stderr}`.trim())}`,
            );
          },
        });
        const lines = [
          baseline.ok ? "The baseline passes." : "The baseline does not pass.",
          ...baseline.steps
            .filter((step) => step.name !== "private-test")
            .map((step) => `${step.name}: ${step.ok ? "ok" : "failed"}`),
          ...baseline.privateTests.map(
            (outcome) =>
              `${outcome.path}: expected to ${outcome.expected}, ${outcome.observed === "error" ? "could not run" : `${outcome.observed}ed`}`,
          ),
          ...baseline.reasons.map((reason) => `Reason: ${reason}`),
          ...failed,
        ];
        return {
          files,
          blockers,
          baseline,
          evaluator,
          hiddenTests,
          report: lines.join("\n"),
        };
      };
      // The table the starter tools rename by, until it is set again.
      let pseudonyms: StarterSubmission["aliases"] = [];
      const pseudonymsTool: AgentTool = {
        name: "set_pseudonyms",
        description:
          "Set the pseudonyms check_starter, run_starter and submit_starter rename the starter by, replacing any set before. Set them before the first check.",
        inputSchema: {
          properties: pseudonymsProperties,
          required: ["aliases"],
          additionalProperties: false,
        },
        strict: false,
        async run(raw) {
          const parsed = pseudonymsSchema.safeParse(raw);
          if (!parsed.success) return invalidInput(parsed.error.issues);
          const problems = nameTableProblems(parsed.data.aliases);
          if (problems.length > 0)
            return { content: problems.join("\n"), isError: true };
          pseudonyms = parsed.data.aliases;
          return {
            content: `${pseudonyms.length} pseudonym${pseudonyms.length === 1 ? "" : "s"} set; the starter tools rename by them.`,
          };
        },
      };
      const checkTool: AgentTool = {
        name: "check_starter",
        description: `Type-check the starter as \`npm run build\` would, and check where each file lives. At most ${STARTER_CHECKS_MAX} checks per run.`,
        inputSchema: {
          properties: candidateProperties,
          required: candidateRequired,
          additionalProperties: false,
        },
        async run(raw) {
          const parsed = candidateSchema.safeParse(raw);
          if (!parsed.success) return invalidInput(parsed.error.issues);
          if (checks >= STARTER_CHECKS_MAX)
            return {
              content: "No checks are left. Run or submit the starter now.",
              isError: true,
            };
          checks += 1;
          const result = check({
            ...parsed.data,
            summary: "-",
            aliases: pseudonyms,
          });
          return result.ok
            ? { content: "The starter compiles." }
            : { content: result.problems.join("\n"), isError: true };
        },
      };
      const runTool: AgentTool = {
        name: "run_starter",
        description: `Build and run the starter in a fresh job: install, build, the walkthrough, the public tests and each hidden test. Shows each step, and the output of those that failed. Runs are shared with submit_starter: ${STARTER_RUNS_MAX} per run in all.`,
        inputSchema: {
          properties: candidateProperties,
          required: candidateRequired,
          additionalProperties: false,
        },
        async run(raw): Promise<AgentToolResult> {
          const parsed = candidateSchema.safeParse(raw);
          if (!parsed.success) return invalidInput(parsed.error.issues);
          // One run is kept for the submission.
          if (runs >= STARTER_RUNS_MAX - 1)
            return {
              content: "No runs are left but the submission's. Submit now.",
              isError: true,
            };
          const result = await build({
            ...parsed.data,
            summary: "-",
            aliases: pseudonyms,
          });
          if ("problems" in result)
            return { content: result.problems.join("\n"), isError: true };
          return { content: result.report, isError: !result.baseline.ok };
        },
      };
      let accepted: {
        readonly starter: StarterSubmission;
        readonly build: StarterBuild;
      } | null = null;
      const submitTool: AgentTool = {
        name: "submit_starter",
        description:
          "Submit the starter. It is checked and run once more, and accepted when the baseline passes.",
        inputSchema: {
          properties: {
            ...candidateProperties,
            summary: {
              type: "string",
              description:
                "What the starter holds and what is left for the developer, in a few sentences.",
            },
          },
          required: [...candidateRequired, "summary"],
          additionalProperties: false,
        },
        async run(raw): Promise<AgentToolResult> {
          const parsed = submissionSchema.safeParse(raw);
          if (!parsed.success) return invalidInput(parsed.error.issues);
          const starter = { ...parsed.data, aliases: pseudonyms };
          const result = await build(starter);
          if ("problems" in result)
            return { content: result.problems.join("\n"), isError: true };
          // A failing baseline is sent back while runs remain; after that,
          // the answer is kept as it is, as a build that is not ready.
          if (!result.baseline.ok && runs < STARTER_RUNS_MAX)
            return { content: result.report, isError: true };
          accepted = { starter, build: result };
          return { content: "Recorded.", accepted: true };
        },
      };
      const outcome = await runAgent({
        model,
        system: STARTER_SYSTEM_PROMPT,
        prompt: starterBountySection({
          title: task.title,
          description: task.summary,
          stack: params.stack,
          spec,
        }),
        tools: [pseudonymsTool, checkTool, runTool, submitTool],
        submitTool: "submit_starter",
        limits: options.agent.limits,
        signal: input.signal,
        log: input.log,
      });
      const answer = accepted as {
        readonly starter: StarterSubmission;
        readonly build: StarterBuild;
      } | null;
      if (answer === null) throw new AnalysisError("agent_incomplete");
      const set: StarterSet = {
        schemaVersion: STARTER_SET_SCHEMA_VERSION,
        toolVersion: STARTER_TOOL_VERSION,
        sandboxVersionId: version.id,
        approvedTaskSha256: params.approvedTaskSha256,
        stack: params.stack,
        ...answer.starter,
        usage: outcome.usage,
      };
      const setText = canonicalJson(set);
      const starterSha256 = sha256(setText);
      await mkdir(input.outDir, { recursive: true });
      const setPath = join(input.outDir, STARTER_SET_PATH);
      await writeFile(setPath, setText, "utf8");
      const { manifest, written } = await writeBuildOutputs({
        outDir: input.outDir,
        toolVersion: STARTER_TOOL_VERSION,
        sandboxVersionId: version.id,
        aliasRules: set.aliases,
        bindings: {
          sourceSnapshotId: null,
          sourceCommitSha: null,
          sliceRunId: null,
          manifestSha256: null,
          contractSha256: null,
          starterSha256,
          // What the version's transform becomes once this run commits.
          transformConfigSha256: sha256(
            canonicalJson(
              transformConfigOf({
                aliasRules: set.aliases,
                dependencyChoices: {},
                acceptanceTests: answer.build.hiddenTests,
                starterSha256,
              }),
            ),
          ),
          approvedTaskSha256: params.approvedTaskSha256,
        },
        files: answer.build.files,
        importRewrites: [],
        renames: [],
        dependencies: starterScope(set).dependencies,
        baseline: answer.build.baseline,
        evaluator: answer.build.evaluator,
        blockers: answer.build.blockers,
      });
      input.log(
        manifest.ready
          ? `Starter recorded and built: ${set.files.length} source files, ${set.hiddenTests.length} hidden tests.`
          : `Starter recorded as diagnostic output (${manifest.blockers.length} blocker(s)).`,
      );
      return [
        {
          path: STARTER_SET_PATH,
          absolutePath: setPath,
          kind: "starter_set",
          contentType: "application/json",
          meta: {
            files: set.files.length,
            publicTests: set.publicTests.length,
            hiddenTests: set.hiddenTests.length,
            aliases: set.aliases.length,
            packages: set.packages.length,
            summary: set.summary,
            usage: set.usage,
          },
        },
        ...written,
      ];
    },
    /**
     * The starter, its hidden tests and scope, and a ready build's
     * evidence become the draft's, while it still points at this run.
     */
    async committed({ runId, files, inputs }) {
      const setFile = files.find((item) => item.path === STARTER_SET_PATH);
      const manifestFile = files.find(
        (item) => item.path === "build-manifest.json",
      );
      if (setFile === undefined || manifestFile === undefined) return;
      const setText = await readFile(setFile.absolutePath, "utf8");
      const set = starterSetSchema.parse(JSON.parse(setText));
      const manifest = JSON.parse(
        await readFile(manifestFile.absolutePath, "utf8"),
      ) as SandboxBuildManifest;
      // The hidden tests as the build ran them: renamed by the set's table,
      // which renames each file alone, so the spec is not needed for them.
      const renamed = aliasStarter(set, null);
      if (!renamed.ok) throw new AnalysisError("tool_failed");
      await inputs.recordStarterOutput(set.sandboxVersionId, runId, {
        starterSha256: sha256(setText),
        aliasRules: set.aliases,
        acceptanceTests: renamed.starter.hiddenTests,
        scope: starterScope(set),
        transformConfigSha256: manifest.transformConfigSha256,
        build: manifest.ready
          ? {
              harnessSha256: manifest.harnessSha256,
              toolchainDigest: manifest.toolchainDigest,
            }
          : null,
      });
    },
  };
}
