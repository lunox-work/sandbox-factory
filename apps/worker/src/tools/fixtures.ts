/**
 * The fixtures adapter: for a succeeded slice, an agent writes believable
 * behaviour for the mocked calls a ticket goes through, and the walkthrough
 * `npm run dev` runs.
 *
 * The agent reads the source and the slice's declaration stubs, and its
 * answer is accepted only when every fixture type-checks against the
 * declaration it stands in for and the walkthrough compiles beside the
 * included source, under the generated project's own compiler settings.
 * The set is recorded for a person to attach to a sandbox version, and a
 * sliced build whose draft has none writes one itself (`writeFixtures`);
 * the build then aliases it with the version and runs the walkthrough.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  FIXTURES_TOOL_VERSION,
  FIXTURE_SET_SCHEMA_VERSION,
  canonicalJson,
  isFixturesParams,
} from "sandbox-factory";
import type {
  AgentUsage,
  DataModel,
  FixtureSet,
  FixtureSubmission,
  SpecDraft,
} from "sandbox-factory";
import {
  fixtureSubmissionSchema,
  sandboxFixtureSchema,
} from "@sandbox-factory/shared";
import { z } from "zod";
import { AnalysisError } from "../errors.js";
import type { AgentModel, AgentSettings, AgentTool } from "../agent/loop.js";
import { inputCount, runAgent } from "../agent/loop.js";
import { FIXTURES_SYSTEM_PROMPT, bountySection } from "../agent/prompts.js";
import { dataModelTool } from "../agent/context-tools.js";
import {
  indexRepository,
  invalidInput,
  repositoryOverview,
  repositoryTools,
} from "../agent/repo-tools.js";
import { snapshotOf } from "./adapter.js";
import { loadDataModel } from "./context-runs.js";
import type { ArtifactFile, ToolAdapter, ToolRunInput } from "./adapter.js";
import { checkFixtures } from "./fixtures-check.js";
import { nearestCompilerOptions } from "./compiler-config.js";
import { loadSliceRun, readIncludedSource } from "./slice-run.js";
import type { LoadedSliceRun } from "./slice-run.js";
import type { RunTiming } from "../timing.js";

/** Candidate sets one run may check before it must submit. */
export const FIXTURE_CHECKS_MAX = 8;
/** Stub text the first prompt carries; the rest is named, not quoted. */
export const PROMPT_STUB_CHARS = 60_000;

const checkInput = z.strictObject({
  fixtures: z.array(sandboxFixtureSchema),
  scenario: z.string(),
});

const fixtureItems = {
  type: "array",
  items: {
    type: "object",
    properties: {
      module: { type: "string", description: "A cut module's path." },
      symbol: {
        type: "string",
        description: "The export; `default` for a default export.",
      },
      member: {
        type: ["string", "null"],
        description: "A dotted member path under the export, or null.",
      },
      call: { type: "string", enum: ["call", "construct"] },
      implementation: {
        type: "string",
        description: "One JavaScript function expression.",
      },
      reason: { type: "string" },
    },
    required: [
      "module",
      "symbol",
      "member",
      "call",
      "implementation",
      "reason",
    ],
    additionalProperties: false,
  },
};
const scenarioProperty = {
  type: "string",
  description: "TypeScript for sandbox/run.ts.",
};

/** A set the agent wrote and the check accepted, with what it spent. */
export interface WrittenFixtures extends FixtureSubmission {
  readonly usage: AgentUsage;
}

/**
 * Has the agent write fixtures and a walkthrough for one slice, as the
 * workspace wrote it. Null when it stopped with no set the check accepted.
 * The fixtures tool records what this returns; a sliced build with none
 * settles it on its draft.
 */
export async function writeFixtures(input: {
  readonly model: AgentModel;
  readonly limits: AgentSettings["limits"];
  /** The bounty's ticket key, null for one written here, and its spec. */
  readonly task: {
    readonly issueKey: string | null;
    readonly draft: SpecDraft;
  };
  /** The snapshot the slice was cut from, extracted. */
  readonly sourceDir: string;
  readonly commitSha: string;
  readonly slice: LoadedSliceRun;
  readonly included: readonly {
    readonly path: string;
    readonly text: string;
  }[];
  readonly dataModel: DataModel | null;
  readonly signal: AbortSignal;
  readonly log: (line: string) => void;
  readonly step?: ((text: string) => void) | undefined;
  readonly timing?: RunTiming | undefined;
}): Promise<WrittenFixtures | null> {
  const { slice } = input;
  input.log("Fixtures agent started.");
  const index = await indexRepository(input.sourceDir, input.signal);
  const first = slice.manifest.included[0]?.path;
  const sourceOptions =
    first === undefined
      ? undefined
      : nearestCompilerOptions(input.sourceDir, first);
  const check = (candidate: {
    fixtures: FixtureSubmission["fixtures"];
    scenario: string;
  }) =>
    checkFixtures({
      root: input.sourceDir,
      sourceOptions,
      included: input.included,
      stubs: slice.stubs,
      packages: slice.manifest.requiredBuildInputs.packages.map(
        (pkg) => pkg.name,
      ),
      contract: slice.contract,
      fixtures: candidate.fixtures,
      scenario: candidate.scenario,
    });
  let checks = 0;
  let accepted: FixtureSubmission | null = null;
  const checkTool: AgentTool = {
    name: "check_fixtures",
    describe: (call, result) =>
      result.content.startsWith("No checks are left")
        ? null
        : result.isError === true
          ? "Checked the fixtures: they do not compile yet"
          : `Checked ${fixtureCount(call)}: they compile`,
    description: `Type-check fixtures against the slice's declaration stubs and the walkthrough against the slice, as the generated project would. At most ${FIXTURE_CHECKS_MAX} checks per run.`,
    inputSchema: {
      properties: { fixtures: fixtureItems, scenario: scenarioProperty },
      required: ["fixtures", "scenario"],
      additionalProperties: false,
    },
    async run(raw) {
      const parsed = checkInput.safeParse(raw);
      if (!parsed.success) return invalidInput(parsed.error.issues);
      if (checks >= FIXTURE_CHECKS_MAX)
        return {
          content: "No checks are left. Call submit_fixtures now.",
          isError: true,
        };
      checks += 1;
      const result = check(parsed.data);
      return result.ok
        ? { content: "Fixtures and walkthrough compile." }
        : { content: result.problems.join("\n"), isError: true };
    },
  };
  const submitTool: AgentTool = {
    name: "submit_fixtures",
    describe: (call, result) =>
      result.accepted === true
        ? `Submitted ${fixtureCount(call)} and the walkthrough`
        : null,
    description:
      "Submit the fixtures and the walkthrough. They are type-checked once more and must compile.",
    inputSchema: {
      properties: {
        fixtures: fixtureItems,
        scenario: scenarioProperty,
        summary: {
          type: "string",
          description: "What the walkthrough shows, in a few sentences.",
        },
      },
      required: ["fixtures", "scenario", "summary"],
      additionalProperties: false,
    },
    async run(raw) {
      const parsed = fixtureSubmissionSchema.safeParse(raw);
      if (!parsed.success) return invalidInput(parsed.error.issues);
      const result = check(parsed.data);
      if (!result.ok)
        return { content: result.problems.join("\n"), isError: true };
      accepted = parsed.data;
      return { content: "Recorded.", accepted: true };
    },
  };
  let stubChars = 0;
  const stubSections: string[] = [];
  const unquoted: string[] = [];
  for (const stub of slice.stubs) {
    if (stubChars + stub.text.length > PROMPT_STUB_CHARS) {
      unquoted.push(stub.module);
      continue;
    }
    stubChars += stub.text.length;
    stubSections.push(`// ${stub.module}\n${stub.text.trim()}`);
  }
  const { dataModel } = input;
  const outcome = await runAgent({
    model: input.model,
    step: input.step,
    onTurn: input.timing?.turn,
    system: FIXTURES_SYSTEM_PROMPT,
    prompt: [
      bountySection(input.task.issueKey, input.task.draft),
      `The slice, at commit ${input.commitSha}. Entry points: ${slice.manifest.entryPoints.join(", ")}. Included files:\n${slice.manifest.included.map((file) => file.path).join("\n")}`,
      `Cut modules and their declaration stubs:\n\n${stubSections.join("\n\n") || "(none)"}${
        unquoted.length === 0
          ? ""
          : `\n\nAlso cut, stubs not quoted here (read the original source): ${unquoted.join(", ")}`
      }`,
      `The whole repository, for reading the original code behind the stubs:\n${repositoryOverview(index)}`,
      ...(dataModel === null
        ? []
        : [
            `The repository's data model has ${dataModel.entities.length} entities; \`data_model\` gives each one's fields, enum values and relations.`,
          ]),
    ].join("\n\n"),
    tools: [
      ...repositoryTools(index),
      ...(dataModel === null ? [] : [dataModelTool(dataModel)]),
      checkTool,
      submitTool,
    ],
    submitTool: "submit_fixtures",
    limits: input.limits,
    signal: input.signal,
    log: input.log,
  });
  const answer = accepted as FixtureSubmission | null;
  input.log(
    answer === null
      ? `Fixtures agent stopped (${outcome.stopped}) with no set kept.`
      : `Fixtures agent wrote ${answer.fixtures.length} fixture(s) and a walkthrough.`,
  );
  return answer === null ? null : { ...answer, usage: outcome.usage };
}

export function createFixturesAdapter(settings: AgentSettings): ToolAdapter {
  return {
    name: "fixtures",
    version: FIXTURES_TOOL_VERSION,
    async run(input: ToolRunInput): Promise<ArtifactFile[]> {
      const params = input.params;
      if (!isFixturesParams(params)) throw new AnalysisError("tool_failed");
      const snapshot = snapshotOf(input);
      if (settings.model === null) {
        input.log("No agent model is configured on this worker.");
        throw new AnalysisError("agent_unavailable");
      }
      const task = await input.inputs.getTask(
        params.proposalId,
        params.specRevision,
      );
      if (task === null || task.specHash !== params.specHash)
        throw new AnalysisError("tool_failed");
      const slice = await loadSliceRun(
        input.inputs,
        params.sliceRunId,
        snapshot.snapshotId,
      );
      const written = await writeFixtures({
        model: settings.model,
        limits: settings.limits,
        task,
        sourceDir: input.sourceDir,
        commitSha: snapshot.commitSha,
        slice,
        included: await readIncludedSource(input.sourceDir, slice.manifest),
        dataModel:
          params.dataModelRunId === undefined
            ? null
            : await loadDataModel(
                input.inputs,
                params.dataModelRunId,
                snapshot.snapshotId,
              ),
        signal: input.signal,
        log: input.log,
        step: input.step,
        timing: input.timing,
      });
      if (written === null) throw new AnalysisError("agent_incomplete");
      const { usage, ...answer } = written;
      const set: FixtureSet = {
        schemaVersion: FIXTURE_SET_SCHEMA_VERSION,
        toolVersion: FIXTURES_TOOL_VERSION,
        sliceRunId: slice.run.id,
        sourceSnapshotId: snapshot.snapshotId,
        sourceCommitSha: snapshot.commitSha,
        proposalId: params.proposalId,
        specRevision: params.specRevision,
        ...answer,
        usage,
      };
      await mkdir(input.outDir, { recursive: true });
      const absolutePath = join(input.outDir, "fixture-set.json");
      await writeFile(absolutePath, canonicalJson(set), "utf8");
      input.log(`Fixture set recorded: ${set.fixtures.length} fixtures.`);
      return [
        {
          path: "fixture-set.json",
          absolutePath,
          kind: "fixture_set",
          contentType: "application/json",
          meta: JSON.parse(canonicalJson(set)) as Record<string, unknown>,
        },
      ];
    },
  };
}

/** A call's fixtures, as a step says them: "4 fixtures". */
function fixtureCount(input: unknown): string {
  const count = inputCount(input, "fixtures");
  return `${count} ${count === 1 ? "fixture" : "fixtures"}`;
}
