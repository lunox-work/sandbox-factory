import { SEAM_KINDS } from "sandbox-factory";
/**
 * The scope adapter: an agent reads the source at the run's commit and
 * proposes the slice for one ticket.
 *
 * The agent explores with read-only tools and checks candidate requests
 * with the very computation the slice tool runs. Its answer is accepted
 * only when that computation agrees: every seam it names is a module the
 * request cuts. The proposal is recorded with the deterministic verdict on
 * exactly that request, for a person to review in the slice picker; this
 * tool never starts a slice itself.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  SCOPE_PROPOSAL_SCHEMA_VERSION,
  SCOPE_TOOL_VERSION,
  boundarySummary,
  canonicalJson,
  isScopeParams,
  scopeProblems,
  sliceRequestOf,
} from "sandbox-factory";
import type {
  ScopeCheck,
  ScopeProposal,
  ScopeSubmission,
  SliceParams,
} from "sandbox-factory";
import {
  SLICE_BUDGET_LIMITS,
  SLICE_ENTRY_POINTS_MAX,
  entryPointSchema,
  scopeSubmissionSchema,
} from "@sandbox-factory/shared";
import { z } from "zod";
import { AnalysisError } from "../errors.js";
import type { AgentSettings, AgentTool } from "../agent/loop.js";
import { runAgent } from "../agent/loop.js";
import { SCOPE_SYSTEM_PROMPT, bountySection } from "../agent/prompts.js";
import {
  graphNeighboursTool,
  indexRepository,
  invalidInput,
  repositoryOverview,
  repositoryTools,
} from "../agent/repo-tools.js";
import { snapshotOf } from "./adapter.js";
import type { ArtifactFile, ToolAdapter, ToolRunInput } from "./adapter.js";
import { analyseSlice, loadGraph } from "./slice.js";
import type { LoadedGraph, SliceAnalysis } from "./slice.js";

/** Candidate requests one run may check before it must submit. */
export const SCOPE_CHECKS_MAX = 8;

const checkInput = z.strictObject({
  entryPoints: z.array(entryPointSchema).min(1).max(SLICE_ENTRY_POINTS_MAX),
  maxFiles: z
    .number()
    .int()
    .min(SLICE_BUDGET_LIMITS.maxFiles.min)
    .max(SLICE_BUDGET_LIMITS.maxFiles.max),
  maxDepth: z
    .number()
    .int()
    .min(SLICE_BUDGET_LIMITS.maxDepth.min)
    .max(SLICE_BUDGET_LIMITS.maxDepth.max),
  includeInferred: z.boolean(),
});
const submitInput = z.strictObject({
  entryPoints: z.array(
    z.strictObject({ path: z.string(), reason: z.string() }),
  ),
  maxFiles: z.number().int(),
  maxDepth: z.number().int(),
  includeInferred: z.boolean(),
  seams: z.array(
    z.strictObject({
      module: z.string(),
      kind: z.string(),
      reason: z.string(),
    }),
  ),
  summary: z.string(),
  risks: z.array(z.string()),
  pattern: z.strictObject({ path: z.string(), reason: z.string() }).nullable(),
});

const requestProperties = {
  maxFiles: {
    type: "integer",
    description: `Most files the slice may include (${SLICE_BUDGET_LIMITS.maxFiles.min}-${SLICE_BUDGET_LIMITS.maxFiles.max}).`,
  },
  maxDepth: {
    type: "integer",
    description: `Most imports away from an entry point (${SLICE_BUDGET_LIMITS.maxDepth.min}-${SLICE_BUDGET_LIMITS.maxDepth.max}); 0 includes the entry points alone.`,
  },
  includeInferred: {
    type: "boolean",
    description:
      "Also follow relations the structure analysis inferred rather than read from imports. Usually false.",
  },
};

const failureDetail = (error: unknown): string =>
  error instanceof AnalysisError && error.code === "too_large"
    ? "That request copies more than 64 MB of source."
    : error instanceof AnalysisError && error.code === "tool_failed"
      ? "That request includes nothing: no entry point names a file in the structure analysis."
      : "That request could not be sliced.";

/** What a check tells the agent: the console's bounded summary of the slice. */
function checkReport(analysis: SliceAnalysis): string {
  return JSON.stringify(boundarySummary(analysis.contract, analysis.manifest));
}

export function createScopeAdapter(settings: AgentSettings): ToolAdapter {
  return {
    name: "scope",
    version: SCOPE_TOOL_VERSION,
    async run(input: ToolRunInput): Promise<ArtifactFile[]> {
      const params = input.params;
      if (!isScopeParams(params)) throw new AnalysisError("tool_failed");
      const snapshot = snapshotOf(input);
      if (settings.model === null) {
        input.log("No agent model is configured on this worker.");
        throw new AnalysisError("agent_unavailable");
      }
      input.log("Scope agent started.");
      const task = await input.inputs.getTask(
        params.proposalId,
        params.specRevision,
      );
      if (task === null || task.specHash !== params.specHash)
        throw new AnalysisError("tool_failed");
      const graph: LoadedGraph = await loadGraph(
        input.inputs,
        params.graphRunId,
        snapshot.snapshotId,
      );
      const index = await indexRepository(input.sourceDir, input.signal);
      const slice = (request: {
        entryPoints: readonly string[];
        maxFiles: number;
        maxDepth: number;
        includeInferred: boolean;
      }) => {
        const sliceParams: SliceParams = {
          deadlineMinutes: params.deadlineMinutes,
          graphRunId: graph.run.id,
          entryPoints: [...new Set(request.entryPoints)].sort(),
          budget: { maxFiles: request.maxFiles, maxDepth: request.maxDepth },
          includeInferred: request.includeInferred,
        };
        return analyseSlice({
          sourceDir: input.sourceDir,
          graph,
          params: sliceParams,
          run: snapshot,
          signal: input.signal,
          log: () => {},
        });
      };
      let checks = 0;
      let accepted: { submission: ScopeSubmission; check: ScopeCheck } | null =
        null;
      const checkScope: AgentTool = {
        name: "check_scope",
        description: `Slice a candidate request exactly as the slice tool would, and report the included files, the cut modules and the symbols used from each, the public surface, the services and environment variables touched, and the blockers. At most ${SCOPE_CHECKS_MAX} checks per run.`,
        inputSchema: {
          properties: {
            entryPoints: {
              type: "array",
              items: { type: "string" },
              description: "Repository file paths the slice starts from.",
            },
            ...requestProperties,
          },
          required: ["entryPoints", "maxFiles", "maxDepth", "includeInferred"],
          additionalProperties: false,
        },
        async run(raw) {
          const parsed = checkInput.safeParse(raw);
          if (!parsed.success) return invalidInput(parsed.error.issues);
          if (checks >= SCOPE_CHECKS_MAX)
            return {
              content: "No checks are left. Call submit_scope now.",
              isError: true,
            };
          checks += 1;
          try {
            return { content: checkReport(await slice(parsed.data)) };
          } catch (error) {
            if (input.signal.aborted) throw error;
            return { content: failureDetail(error), isError: true };
          }
        },
      };
      const submitScope: AgentTool = {
        name: "submit_scope",
        description:
          "Submit the slice for the ticket. It is sliced once more to check it; every seam must be a module the request cuts.",
        inputSchema: {
          properties: {
            entryPoints: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  path: { type: "string" },
                  reason: {
                    type: "string",
                    description: "Why the ticket needs this file.",
                  },
                },
                required: ["path", "reason"],
                additionalProperties: false,
              },
            },
            ...requestProperties,
            seams: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  module: { type: "string" },
                  kind: {
                    type: "string",
                    enum: [...SEAM_KINDS],
                  },
                  reason: {
                    type: "string",
                    description: "Why mocking this module is safe.",
                  },
                },
                required: ["module", "kind", "reason"],
                additionalProperties: false,
              },
            },
            summary: {
              type: "string",
              description:
                "Two to four sentences on what the developer will see and change.",
            },
            risks: { type: "array", items: { type: "string" } },
            pattern: {
              type: ["object", "null"],
              description:
                "The closest existing code that already does what the ticket asks elsewhere in the repository, for the developer to follow; null when there is none.",
              properties: {
                path: {
                  type: "string",
                  description: "The repository file that holds the pattern.",
                },
                reason: {
                  type: "string",
                  description:
                    "What it does that the ticket's change can copy.",
                },
              },
              required: ["path", "reason"],
              additionalProperties: false,
            },
          },
          required: [
            "entryPoints",
            "maxFiles",
            "maxDepth",
            "includeInferred",
            "seams",
            "summary",
            "risks",
            "pattern",
          ],
          additionalProperties: false,
        },
        async run(raw) {
          const shaped = submitInput.safeParse(raw);
          if (!shaped.success) return invalidInput(shaped.error.issues);
          const parsed = scopeSubmissionSchema.safeParse({
            entryPoints: shaped.data.entryPoints,
            budget: {
              maxFiles: shaped.data.maxFiles,
              maxDepth: shaped.data.maxDepth,
            },
            includeInferred: shaped.data.includeInferred,
            seams: shaped.data.seams,
            summary: shaped.data.summary,
            risks: shaped.data.risks,
            pattern: shaped.data.pattern,
          });
          if (!parsed.success) return invalidInput(parsed.error.issues);
          const submission: ScopeSubmission = parsed.data;
          if (
            submission.pattern != null &&
            !index.sizes.has(submission.pattern.path)
          )
            return {
              content: `${submission.pattern.path} is not a file in the repository, so it cannot be the pattern.`,
              isError: true,
            };
          const request = sliceRequestOf(submission);
          let analysis: SliceAnalysis;
          try {
            analysis = await slice({
              entryPoints: request.entryPoints,
              maxFiles: request.budget.maxFiles,
              maxDepth: request.budget.maxDepth,
              includeInferred: request.includeInferred,
            });
          } catch (error) {
            if (input.signal.aborted) throw error;
            return { content: failureDetail(error), isError: true };
          }
          const problems = scopeProblems(
            submission,
            analysis.contract.outbound.map((module) => module.module),
          );
          if (problems.length > 0)
            return { content: problems.join("\n"), isError: true };
          accepted = {
            submission,
            check: {
              stubCoverage: analysis.contract.stubCoverage,
              ready: analysis.ready,
              includedFiles: analysis.manifest.included.length,
              outboundModules: analysis.contract.outbound.length,
              blockers: analysis.contract.blockers.length,
            },
          };
          return { content: "Recorded.", accepted: true };
        },
      };
      const outcome = await runAgent({
        model: settings.model,
        system: SCOPE_SYSTEM_PROMPT,
        prompt: [
          bountySection(task.issueKey, task.draft),
          `The repository, at commit ${snapshot.commitSha}:\n${repositoryOverview(index)}`,
          `The structure analysis has ${graph.graph.nodes.length} nodes and ${graph.graph.links.length} relations.`,
        ].join("\n\n"),
        tools: [
          ...repositoryTools(index),
          graphNeighboursTool(graph.graph),
          checkScope,
          submitScope,
        ],
        submitTool: "submit_scope",
        limits: settings.limits,
        signal: input.signal,
        log: input.log,
      });
      const answer = accepted as {
        submission: ScopeSubmission;
        check: ScopeCheck;
      } | null;
      if (answer === null) throw new AnalysisError("agent_incomplete");
      const proposal: ScopeProposal = {
        schemaVersion: SCOPE_PROPOSAL_SCHEMA_VERSION,
        toolVersion: SCOPE_TOOL_VERSION,
        sourceSnapshotId: snapshot.snapshotId,
        sourceCommitSha: snapshot.commitSha,
        graphRunId: graph.run.id,
        proposalId: params.proposalId,
        specRevision: params.specRevision,
        ...answer.submission,
        check: answer.check,
        usage: outcome.usage,
      };
      await mkdir(input.outDir, { recursive: true });
      const absolutePath = join(input.outDir, "scope-proposal.json");
      await writeFile(absolutePath, canonicalJson(proposal), "utf8");
      input.log(
        `Scope proposal recorded: ${proposal.entryPoints.length} entry points, ${proposal.check.includedFiles} files, ${proposal.check.blockers} blockers.`,
      );
      return [
        {
          path: "scope-proposal.json",
          absolutePath,
          kind: "scope_proposal",
          contentType: "application/json",
          meta: JSON.parse(canonicalJson(proposal)) as Record<string, unknown>,
        },
      ];
    },
  };
}
