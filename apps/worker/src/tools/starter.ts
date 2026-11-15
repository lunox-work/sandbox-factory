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
 *
 * One agent writes the starter and its hidden tests, so nothing it does
 * shows a correct implementation can pass them. An accepted answer is
 * calibrated as a sliced build's hidden tests are (`calibration.ts`, on
 * duediligence's `calibrate`), by a reference agent of its own with the
 * hidden tests withheld: it reads the renamed project, the spec and the
 * confirmed decisions, never a hidden test. A test the reference fails is
 * dropped, the set and the build keep the rest, and the baseline is run
 * again over them. When no test that should fail survives, the build is
 * held (not ready, the baseline's reasons saying why) and the agent's set
 * is kept as written, as diagnostic output. The calibration is recorded in
 * `build-transform.json` as a sliced build records it.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  PRIVATE_TESTS_DIR,
  STARTER_SET_SCHEMA_VERSION,
  STARTER_TOOL_VERSION,
  aliasStarter,
  baselineVerdict,
  canonicalJson,
  DISCLOSURE_FINDINGS_EVALUATED,
  disclosureGate,
  disclosureRecords,
  nameTableProblems,
  scanDisclosure,
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
  GeneratedProject,
  ProjectBlocker,
  ProjectVersion,
  PublicationGates,
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
import { inputCount, runAgent } from "../agent/loop.js";
import {
  STARTER_SYSTEM_PROMPT,
  starterBountySection,
} from "../agent/prompts.js";
import { invalidInput } from "../agent/repo-tools.js";
import type { ArtifactFile, ToolAdapter, ToolRunInput } from "./adapter.js";
import {
  BUILD_TRANSFORM_PATH,
  buildArtifactKind,
  descriptorTestSummary,
  previewProject,
  reportedBaselineOf,
  writeBuildOutputs,
} from "./sandbox-build.js";
import { calibrateHiddenTests } from "./calibration.js";
import type { HiddenTestsCalibration } from "./calibration.js";
import { sha256 } from "carveout/extract";
import { checkStarter } from "./starter-check.js";
import { confirmedDecisions } from "./decisions.js";
import type { StarterCheckStage } from "./starter-check.js";

/** Candidates one run may type-check, and run for real, before it must submit. */
export const STARTER_CHECKS_MAX = 16;
export const STARTER_RUNS_MAX = 5;
export { STEP_OUTPUT_CHARS } from "./sandbox-build.js";
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

/** A candidate's files, as a step says them: "12 files". */
function starterFiles(input: unknown): string {
  const files =
    inputCount(input, "files") +
    inputCount(input, "publicTests") +
    inputCount(input, "hiddenTests");
  return `${files} ${files === 1 ? "file" : "files"}`;
}

/** What a step says of a candidate its check refused, by where it stopped. */
const REFUSED_STEP: Record<StarterCheckStage, string> = {
  rules: "its files break the starter's rules",
  names: "its names need fixing",
  project: "its project does not generate yet",
  types: "it does not compile yet",
};

/** Problems the run log shows of one refused check, at most. */
const LOGGED_PROBLEMS_MAX = 10;
const LOGGED_PROBLEM_CHARS = 300;

/**
 * A refused check, as the run log keeps it: where it stopped and its
 * problems, so a run that loops on checks says why. A problem in a hidden
 * test is only counted: like a hidden test's output, it reads the test.
 */
export function refusedCheckLog(
  tool: string,
  stage: StarterCheckStage,
  problems: readonly string[],
): string {
  const hidden = problems.filter((problem) =>
    problem.startsWith(`${PRIVATE_TESTS_DIR}/`),
  ).length;
  const shown = problems
    .filter((problem) => !problem.startsWith(`${PRIVATE_TESTS_DIR}/`))
    .map((problem) =>
      problem.length <= LOGGED_PROBLEM_CHARS
        ? problem
        : `${problem.slice(0, LOGGED_PROBLEM_CHARS)}…`,
    );
  const kept = shown.slice(0, LOGGED_PROBLEMS_MAX);
  const lines = [
    `${tool} refused (${stage}): ${problems.length} problem${problems.length === 1 ? "" : "s"}.`,
    ...kept.map((problem) => `  ${problem}`),
    ...(shown.length > kept.length
      ? [`  and ${shown.length - kept.length} more`]
      : []),
    ...(hidden > 0 ? [`  and ${hidden} in hidden tests, not shown`] : []),
  ];
  return lines.join("\n");
}

/** A run of a candidate, as a step: whether it built, and its baseline. */
function ranStarter(
  verb: string,
  input: unknown,
  result: AgentToolResult,
  refused: StarterCheckStage | undefined,
): string | null {
  if (result.content.startsWith("No runs are left")) return null;
  if (result.content.startsWith("The baseline passes."))
    return `${verb} the starter's ${starterFiles(input)}: the baseline passes`;
  if (result.content.startsWith("The baseline does not pass."))
    return `${verb} the starter's ${starterFiles(input)}: the baseline does not pass yet`;
  if (refused !== undefined)
    return `${verb} the starter: ${REFUSED_STEP[refused]}`;
  return result.isError === true
    ? `${verb} the starter: it does not build yet`
    : null;
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
  /** The listing, spec and confirmed decisions in public names. */
  readonly listing: { readonly title: string; readonly specSummary: string };
  readonly spec: SpecDraft | null;
  readonly decisions: readonly string[];
  /** The same project with other hidden tests (`checkStarter`). */
  readonly regenerate: (tests: readonly AcceptanceTest[]) => GeneratedProject;
}

/**
 * A held starter's baseline: the run's own steps, judged again over the
 * hidden tests calibration kept, none of which should fail, with why.
 */
function heldBaseline(
  baseline: BaselineReport,
  calibration: HiddenTestsCalibration,
): BaselineReport {
  const kept = new Set(calibration.kept);
  const privateTests = baseline.privateTests.filter((outcome) =>
    kept.has(outcome.path),
  );
  const verdict = baselineVerdict({
    steps: baseline.steps,
    privateTests,
    declared: privateTests.map((outcome) => outcome.expected),
  });
  return {
    ...baseline,
    privateTests,
    ok: false,
    reasons: [
      ...verdict.reasons,
      `Calibration (${calibration.engine}) kept no hidden test that should fail: ${calibration.reason ?? "none survived"}`,
    ],
  };
}

/**
 * A starter's disclosure gate: its public files as built, scanned again.
 * The check refused any candidate with a finding, so this records none
 * unless a later step added one, and such a finding waits for an owner's
 * acknowledgement at publication (`pending_acknowledgement`) rather than
 * holding the build: the build read no acknowledgement, so its files are
 * the same whatever the draft's list says.
 */
export function starterDisclosureGate(input: {
  readonly files: readonly GeneratedFile[];
  readonly blockers: readonly ProjectBlocker[];
  readonly names: number;
  readonly ticketKeys: readonly string[];
  readonly aliases: StarterSubmission["aliases"];
}): PublicationGates["disclosure"] {
  const scanned = scanDisclosure(
    input.files.filter((file) => file.public),
    {
      ticketKeys: input.ticketKeys,
      publicNames: input.aliases.map((rule) => rule.after),
    },
  );
  return disclosureGate(input.blockers, input.names, "build", {
    findings: disclosureRecords(scanned, [], DISCLOSURE_FINDINGS_EVALUATED),
    total: scanned.length,
    unacknowledged: scanned.length,
    acknowledgedAt: "publish",
  });
}

export function createStarterAdapter(options: {
  readonly agent: AgentSettings;
  /** `null` when the worker has none: generation fails before the agent starts. */
  readonly provider: EvaluationProvider | null;
  readonly now?: () => Date;
  /**
   * How the accepted hidden tests are calibrated: `reference` (the
   * default) by a reference agent with them withheld, on duediligence's
   * rule; `off` keeps the set as the starter agent wrote it (tests that
   * are not about calibration).
   */
  readonly calibration?: "reference" | "off";
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
      // No disclosure acknowledgement is read: the agent renames every
      // finding at its check, so what it writes never depends on the
      // draft's list, which publication checks instead (`gatesOf`).
      const spec: SpecDraft | null = task.spec?.draft ?? null;
      // The decisions a person confirmed, as the run names them by hash.
      const decisions = confirmedDecisions(spec, params.decisionsSha256);
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
          decisions,
          vocabulary: params.vocabulary ?? [],
          ticketKeys: params.ticketKeys ?? [],
        });
      let checks = 0;
      let runs = 0;
      // Where each refused candidate stopped, for its step to say.
      const refusedAt = new WeakMap<AgentToolResult, StarterCheckStage>();
      const refuse = (
        tool: string,
        checked: {
          readonly stage: StarterCheckStage;
          readonly problems: readonly string[];
        },
      ): AgentToolResult => {
        input.log(refusedCheckLog(tool, checked.stage, checked.problems));
        const result = { content: checked.problems.join("\n"), isError: true };
        refusedAt.set(result, checked.stage);
        return result;
      };
      const build = async (
        starter: StarterSubmission,
      ): Promise<
        | StarterBuild
        | {
            readonly stage: StarterCheckStage;
            readonly problems: readonly string[];
          }
      > => {
        const checked = check(starter);
        if (!checked.ok)
          return { stage: checked.stage, problems: checked.problems };
        runs += 1;
        const files = [...checked.project.files];
        const blockers = [...checked.project.blockers];
        // Shown as the version's files while this candidate's baseline runs.
        await previewProject(input, files, runs);
        // The hidden tests run against the renamed project, renamed with it.
        const hiddenTests = checked.starter.hiddenTests;
        const { baseline, evaluator, report } = await reportedBaselineOf(
          provider,
          {
            label: version.id,
            files,
            acceptanceTests: hiddenTests,
            blockers,
            signal: input.signal,
            log: input.log,
            now,
            timing: input.timing,
          },
        );
        return {
          files,
          blockers,
          baseline,
          evaluator,
          hiddenTests,
          report,
          listing: {
            title: checked.project.descriptor.title,
            specSummary: checked.project.descriptor.specSummary,
          },
          spec: checked.spec,
          decisions: checked.decisions,
          regenerate: checked.regenerate,
        };
      };
      // The table the starter tools rename by, until it is set again.
      let pseudonyms: StarterSubmission["aliases"] = [];
      const pseudonymsTool: AgentTool = {
        name: "set_pseudonyms",
        describe: (_input, result) =>
          result.isError === true
            ? null
            : "Set the names the starter is renamed by",
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
        describe: (input, result) => {
          const refused = refusedAt.get(result);
          if (refused !== undefined)
            return `Checked the starter: ${REFUSED_STEP[refused]}`;
          // Out of checks, or a candidate that did not parse.
          if (result.isError === true)
            return result.content.startsWith("No checks are left")
              ? null
              : "Checked the starter: it was refused";
          return `Checked the starter: ${starterFiles(input)} compile`;
        },
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
            : refuse("check_starter", result);
        },
      };
      const runTool: AgentTool = {
        name: "run_starter",
        describe: (input, result) =>
          ranStarter("Ran", input, result, refusedAt.get(result)),
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
          if ("problems" in result) return refuse("run_starter", result);
          return { content: result.report, isError: !result.baseline.ok };
        },
      };
      let accepted: {
        readonly starter: StarterSubmission;
        readonly build: StarterBuild;
      } | null = null;
      const submitTool: AgentTool = {
        name: "submit_starter",
        describe: (input, result) =>
          result.accepted === true
            ? `Submitted the starter: ${starterFiles(input)}`
            : ranStarter("Submitted", input, result, refusedAt.get(result)),
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
          if ("problems" in result) return refuse("submit_starter", result);
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
        step: input.step,
        onTurn: input.timing?.turn,
        system: STARTER_SYSTEM_PROMPT,
        prompt: starterBountySection({
          title: task.title,
          description: task.summary,
          stack: params.stack,
          spec,
          context: "context" in task ? task.context : undefined,
          vocabulary: params.vocabulary ?? [],
          decisions,
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
      // The accepted set, calibrated by a reference that never reads it. A
      // diagnostic answer, whose baseline did not pass, is not.
      let built: StarterBuild = answer.build;
      let hiddenTests = answer.starter.hiddenTests;
      let calibration: HiddenTestsCalibration | null = null;
      if (
        (options.calibration ?? "reference") === "reference" &&
        built.baseline.ok
      ) {
        const accepted = built;
        const calibrated = await calibrateHiddenTests({
          model,
          limits: options.agent.limits,
          task: {
            title: accepted.listing.title,
            summary: accepted.listing.specSummary,
            spec: accepted.spec,
            decisions: accepted.decisions,
          },
          // The starter's source is its interface: the developer edits it.
          entryPoints: answer.starter.files.map((file) => file.path),
          hiddenTests: "withheld",
          written: {
            tests: accepted.hiddenTests,
            summary: answer.starter.summary,
            files: accepted.files,
            blockers: accepted.blockers,
            baseline: accepted.baseline,
            evaluator: accepted.evaluator,
            usage: outcome.usage,
          },
          generate: (tests) => {
            const project = accepted.regenerate(tests);
            return {
              files: [...project.files],
              blockers: [...project.blockers],
            };
          },
          baseline: (candidateFiles, candidateBlockers, tests) =>
            reportedBaselineOf(provider, {
              label: version.id,
              files: candidateFiles,
              acceptanceTests: tests,
              blockers: candidateBlockers,
              signal: input.signal,
              log: input.log,
              now,
              timing: input.timing,
            }),
          signal: input.signal,
          log: input.log,
          step: input.step,
          timing: input.timing,
        });
        calibration = calibrated.calibration;
        const kept = calibrated.written;
        if (kept === null) {
          // Held: no test that should fail stands. The set stays as the
          // agent wrote it, and the build says why it is not ready.
          const baseline = heldBaseline(accepted.baseline, calibration);
          built = {
            ...accepted,
            baseline,
            blockers: [
              ...accepted.blockers,
              {
                code: "baseline_failed",
                file: null,
                detail: baseline.reasons.join(" "),
              },
            ],
          };
        } else if (kept.tests.length < hiddenTests.length) {
          const paths = new Set(kept.tests.map((test) => test.path));
          hiddenTests = hiddenTests.filter((test) => paths.has(test.path));
          built = {
            ...accepted,
            files: kept.files,
            blockers: kept.blockers,
            baseline: kept.baseline,
            evaluator: kept.evaluator,
            hiddenTests: kept.tests,
          };
        }
      }
      const set: StarterSet = {
        schemaVersion: STARTER_SET_SCHEMA_VERSION,
        toolVersion: STARTER_TOOL_VERSION,
        sandboxVersionId: version.id,
        approvedTaskSha256: params.approvedTaskSha256,
        stack: params.stack,
        ...answer.starter,
        hiddenTests,
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
        // No repository to carry back to; the check scanned every public
        // file, and the scan is recorded as a sliced build records it.
        gates: {
          roundTrip: { status: "not_applicable", files: 0, problems: [] },
          disclosure: starterDisclosureGate({
            files: built.files,
            blockers: built.blockers,
            names: (params.vocabulary ?? []).length,
            ticketKeys: params.ticketKeys ?? [],
            aliases: set.aliases,
          }),
        },
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
                acceptanceTests: built.hiddenTests,
                starterSha256,
              }),
            ),
          ),
          approvedTaskSha256: params.approvedTaskSha256,
        },
        files: built.files,
        importRewrites: [],
        renames: [],
        dependencies: starterScope(set).dependencies,
        baseline: built.baseline,
        evaluator: built.evaluator,
        blockers: built.blockers,
      });
      // The hidden tests and their calibration, as a sliced build records
      // them: what readers of a build's transform find in the same place.
      const transformPath = join(input.outDir, BUILD_TRANSFORM_PATH);
      await writeFile(
        transformPath,
        canonicalJson({
          fromTransformConfigSha256: stored.source.transformConfigSha256,
          transformConfigSha256: manifest.transformConfigSha256,
          acceptanceTests: built.hiddenTests,
          aliasRules: set.aliases,
          hiddenTests: {
            summary: set.summary,
            usage: outcome.usage,
            ...(calibration === null ? {} : { calibration }),
          },
        }),
        "utf8",
      );
      input.log(
        manifest.ready
          ? `Starter recorded and built: ${set.files.length} source files, ${set.hiddenTests.length} hidden tests.`
          : `Starter recorded as diagnostic output (${manifest.blockers.length} blocker(s)).`,
      );
      const files: ArtifactFile[] = [
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
            calibration:
              calibration === null
                ? null
                : {
                    status: calibration.status,
                    kept: calibration.kept.length,
                    dropped: calibration.dropped.length,
                    usage: calibration.usage,
                  },
          },
        },
        {
          path: BUILD_TRANSFORM_PATH,
          absolutePath: transformPath,
          kind: buildArtifactKind(BUILD_TRANSFORM_PATH),
          contentType: "application/json",
          meta: {
            hiddenTests: built.hiddenTests.length,
            pseudonyms: set.aliases.length,
            fixtures: 0,
          },
        },
        ...written,
      ];
      return files.sort((a, b) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
      );
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
      // A rule only the spec uses renames nothing here, and was checked
      // against the spec when the starter was accepted.
      const renamed = aliasStarter(set, null, { requireUse: false });
      if (!renamed.ok) throw new AnalysisError("tool_failed");
      const testSummary = await descriptorTestSummary(files);
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
        ...(testSummary === undefined ? {} : { testSummary }),
      });
    },
  };
}
