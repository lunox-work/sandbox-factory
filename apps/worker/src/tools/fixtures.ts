/**
 * The fixtures adapter: for a succeeded slice, an agent writes believable
 * behaviour for the mocked calls a ticket goes through, and the walkthrough
 * `npm run dev` runs.
 *
 * The agent reads the source and the slice's declaration stubs, and its
 * answer is accepted only when every fixture type-checks against the
 * declaration it stands in for and the walkthrough compiles beside the
 * included source, under the generated project's own compiler settings.
 * The set is recorded for a person to attach to a sandbox version; the
 * build then aliases it with the version and runs the walkthrough.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  FIXTURES_TOOL_VERSION,
  FIXTURE_SET_SCHEMA_VERSION,
  canonicalJson,
  isFixturesParams,
} from "sandbox-factory";
import type { FixtureSet, FixtureSubmission } from "sandbox-factory";
import {
  fixtureSubmissionSchema,
  sandboxFixtureSchema,
} from "@sandbox-factory/shared";
import { z } from "zod";
import { AnalysisError } from "../errors.js";
import type { AgentSettings, AgentTool } from "../agent/loop.js";
import { runAgent } from "../agent/loop.js";
import { FIXTURES_SYSTEM_PROMPT, ticketSection } from "../agent/prompts.js";
import {
  indexRepository,
  invalidInput,
  repositoryOverview,
  repositoryTools,
} from "../agent/repo-tools.js";
import type { ArtifactFile, ToolAdapter, ToolRunInput } from "./adapter.js";
import { checkFixtures } from "./fixtures-check.js";
import { nearestCompilerOptions } from "./sandbox-build.js";
import { loadSliceRun, readIncludedSource } from "./slice-run.js";

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

export function createFixturesAdapter(settings: AgentSettings): ToolAdapter {
  return {
    name: "fixtures",
    version: FIXTURES_TOOL_VERSION,
    async run(input: ToolRunInput): Promise<ArtifactFile[]> {
      const params = input.params;
      if (!isFixturesParams(params)) throw new AnalysisError("tool_failed");
      if (settings.model === null) {
        input.log("No agent model is configured on this worker.");
        throw new AnalysisError("agent_unavailable");
      }
      input.log("Fixtures agent started.");
      const task = await input.inputs.getTask(
        params.proposalId,
        params.specRevision,
      );
      if (task === null || task.specHash !== params.specHash)
        throw new AnalysisError("tool_failed");
      const slice = await loadSliceRun(
        input.inputs,
        params.sliceRunId,
        input.run.snapshotId,
      );
      const included = await readIncludedSource(
        input.sourceDir,
        slice.manifest,
      );
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
          included,
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
      const outcome = await runAgent({
        model: settings.model,
        system: FIXTURES_SYSTEM_PROMPT,
        prompt: [
          ticketSection(task.issueKey, task.draft),
          `The slice, at commit ${input.run.commitSha}. Entry points: ${slice.manifest.entryPoints.join(", ")}. Included files:\n${slice.manifest.included.map((file) => file.path).join("\n")}`,
          `Cut modules and their declaration stubs:\n\n${stubSections.join("\n\n") || "(none)"}${
            unquoted.length === 0
              ? ""
              : `\n\nAlso cut, stubs not quoted here (read the original source): ${unquoted.join(", ")}`
          }`,
          `The whole repository, for reading the original code behind the stubs:\n${repositoryOverview(index)}`,
        ].join("\n\n"),
        tools: [...repositoryTools(index), checkTool, submitTool],
        submitTool: "submit_fixtures",
        limits: settings.limits,
        signal: input.signal,
        log: input.log,
      });
      const answer = accepted as FixtureSubmission | null;
      if (answer === null) throw new AnalysisError("agent_incomplete");
      const set: FixtureSet = {
        schemaVersion: FIXTURE_SET_SCHEMA_VERSION,
        toolVersion: FIXTURES_TOOL_VERSION,
        sliceRunId: slice.run.id,
        sourceSnapshotId: input.run.snapshotId,
        sourceCommitSha: input.run.commitSha,
        proposalId: params.proposalId,
        specRevision: params.specRevision,
        ...answer,
        usage: outcome.usage,
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
