/**
 * Pseudonyms for a sliced version that has none: an agent reads the slice
 * as the workspace wrote it and gives each name that says whose code it is
 * (the company, the product, its customers, and the identifiers named
 * after them) a neutral public name that keeps its meaning. Each table is
 * checked as the build will apply it: the rules must hold as a set, map
 * the project back byte for byte, leave the contract, spec and fixtures
 * readable, generate a project, and leave no public file naming the
 * workspace. A table is accepted only when that check is clean, so a
 * draft whose agent gave up keeps none, and the build's own check then
 * says what is left.
 *
 * Unlike the hidden-tests agent, this one reads the private source: it is
 * there to find the names that must not leave it.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentUsage, AliasRule, SpecDraft } from "sandbox-factory";
import { aliasRulesSchema } from "@sandbox-factory/shared";
import { z } from "zod";
import type {
  AgentModel,
  AgentSettings,
  AgentTool,
  AgentToolResult,
} from "../agent/loop.js";
import { inputCount, runAgent } from "../agent/loop.js";
import {
  PSEUDONYMS_SYSTEM_PROMPT,
  pseudonymsSection,
} from "../agent/prompts.js";
import {
  indexRepository,
  invalidInput,
  repositoryOverview,
  repositoryTools,
} from "../agent/repo-tools.js";
import type { RunTiming } from "../timing.js";

/** What the build says of a table: why it cannot be applied, if it cannot. */
export interface PseudonymCheck {
  /** Each reason the table cannot stand; none when it is clean. */
  readonly problems: readonly string[];
  /** Replacements each rule made, in the table's order. */
  readonly applied: readonly number[];
}

/** A table whose check was clean. */
export interface WrittenPseudonyms {
  readonly rules: readonly AliasRule[];
  readonly summary: string;
  readonly usage: AgentUsage;
}

const aliasesProperty = {
  type: "array",
  description:
    "The pseudonyms, applied in order: each name that says whose code this is, and the neutral one contributors read instead.",
  items: {
    type: "object",
    properties: {
      before: {
        type: "string",
        description: "The name as the workspace writes it.",
      },
      after: {
        type: "string",
        description: "The neutral name contributors read.",
      },
      kind: {
        type: "string",
        enum: ["identifier", "text", "path"],
        description:
          "identifier: a TypeScript name, matched whole. text: a word or phrase, matched anywhere, case-sensitive. path: a file or folder name in paths and import specifiers.",
      },
      paths: {
        type: "array",
        items: { type: "string" },
        description:
          "Repository paths the rule is limited to, files or folders. Leave it out to apply the rule everywhere.",
      },
    },
    required: ["before", "after", "kind"],
    additionalProperties: false,
  },
};
const candidateSchema = z.object({ aliases: aliasRulesSchema.min(1) });
const submissionSchema = candidateSchema.extend({
  summary: z.string().trim().min(1).max(2_000),
});

/** A table, as a step says it: "4 pseudonyms". */
function ruleCount(input: unknown): string {
  const count = inputCount(input, "aliases");
  return `${count} ${count === 1 ? "pseudonym" : "pseudonyms"}`;
}

/** What a check says to the agent: its problems, or what each rule did. */
function report(rules: readonly AliasRule[], check: PseudonymCheck): string {
  if (check.problems.length > 0)
    return [
      `The table does not hold (${check.problems.length} problem(s)):`,
      ...check.problems.map((problem) => `- ${problem}`),
    ].join("\n");
  return [
    "The table holds: it maps back, the project generates and no public file names the workspace.",
    ...rules.map(
      (rule, index) =>
        `${index + 1}. ${rule.kind} ${rule.before} -> ${rule.after}: ${check.applied[index] ?? 0} replacement(s)`,
    ),
  ].join("\n");
}

/** The problems a table has, the build's and a rule that renames nothing. */
function problemsOf(
  rules: readonly AliasRule[],
  check: PseudonymCheck,
): string[] {
  if (check.problems.length > 0) return [...check.problems];
  return rules.flatMap((rule, index) =>
    (check.applied[index] ?? 0) === 0
      ? [`Rule ${index + 1} (${rule.before}) renames nothing; remove it.`]
      : [],
  );
}

export async function writePseudonyms(input: {
  readonly model: AgentModel;
  readonly limits: AgentSettings["limits"];
  readonly task: {
    readonly title: string;
    readonly summary: string;
    readonly spec: SpecDraft | null;
  };
  /** The slice as the workspace wrote it: its sources and stubs. */
  readonly files: readonly { readonly path: string; readonly text: string }[];
  /** The names the build checks no public file carries. */
  readonly vocabulary: readonly string[];
  /** The build's check of a table; pure, so cheap to repeat. */
  readonly check: (rules: readonly AliasRule[]) => PseudonymCheck;
  /**
   * A table drafted before the fixtures were written, which this check
   * refuses: the agent starts from it, told why, and what it spent counts
   * toward this table's usage.
   */
  readonly drafted?: WrittenPseudonyms | undefined;
  readonly signal: AbortSignal;
  readonly log: (line: string) => void;
  readonly step?: ((text: string) => void) | undefined;
  readonly timing?: RunTiming | undefined;
}): Promise<WrittenPseudonyms | null> {
  // The slice, for the repository tools to read.
  const root = await mkdtemp(join(tmpdir(), "pseudonyms-"));
  try {
    for (const file of input.files) {
      const path = join(root, file.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.text, "utf8");
    }
    const index = await indexRepository(root, input.signal);
    const checkTool: AgentTool = {
      name: "check_pseudonyms",
      describe: (call, result) =>
        result.isError === true
          ? null
          : `Checked ${ruleCount(call)}: they hold`,
      description:
        "Check a table as the build will apply it: the rules as a set, the inverse proof, the contract, spec and fixtures, the generated project, and every public file for the workspace's names. Shows each problem, or what each rule renamed.",
      inputSchema: {
        properties: { aliases: aliasesProperty },
        required: ["aliases"],
        additionalProperties: false,
      },
      async run(raw): Promise<AgentToolResult> {
        const parsed = candidateSchema.safeParse(raw);
        if (!parsed.success) return invalidInput(parsed.error.issues);
        const rules = parsed.data.aliases;
        const check = input.check(rules);
        const problems = problemsOf(rules, check);
        return problems.length === 0
          ? { content: report(rules, check) }
          : {
              content: report(rules, { ...check, problems }),
              isError: true,
            };
      },
    };
    let accepted: Omit<WrittenPseudonyms, "usage"> | null = null;
    const submitTool: AgentTool = {
      name: "submit_pseudonyms",
      describe: (call, result) =>
        result.accepted === true ? `Submitted ${ruleCount(call)}` : null,
      description:
        "Submit the table. It is checked once more, and accepted when it holds.",
      inputSchema: {
        properties: {
          aliases: aliasesProperty,
          summary: {
            type: "string",
            description: "What the table renames, and why, in a few sentences.",
          },
        },
        required: ["aliases", "summary"],
        additionalProperties: false,
      },
      async run(raw): Promise<AgentToolResult> {
        const parsed = submissionSchema.safeParse(raw);
        if (!parsed.success) return invalidInput(parsed.error.issues);
        const rules = parsed.data.aliases;
        const check = input.check(rules);
        const problems = problemsOf(rules, check);
        if (problems.length > 0)
          return {
            content: report(rules, { ...check, problems }),
            isError: true,
          };
        accepted = { rules, summary: parsed.data.summary };
        return { content: "Recorded.", accepted: true };
      },
    };
    input.log("Pseudonyms agent started.");
    const outcome = await runAgent({
      model: input.model,
      step: input.step,
      onTurn: input.timing?.turn,
      system: PSEUDONYMS_SYSTEM_PROMPT,
      prompt: pseudonymsSection({
        title: input.task.title,
        summary: input.task.summary,
        spec: input.task.spec,
        vocabulary: input.vocabulary,
        unrenamed: input.check([]).problems,
        overview: repositoryOverview(index),
        ...(input.drafted === undefined
          ? {}
          : {
              drafted: {
                rules: input.drafted.rules,
                problems: problemsOf(
                  input.drafted.rules,
                  input.check(input.drafted.rules),
                ),
              },
            }),
      }),
      tools: [...repositoryTools(index), checkTool, submitTool],
      submitTool: "submit_pseudonyms",
      limits: input.limits,
      signal: input.signal,
      log: input.log,
    });
    const answer = accepted as Omit<WrittenPseudonyms, "usage"> | null;
    input.log(
      answer === null
        ? `Pseudonyms agent stopped (${outcome.stopped}) with no table kept.`
        : `Pseudonyms agent wrote ${answer.rules.length} pseudonym(s).`,
    );
    return answer === null
      ? null
      : {
          ...answer,
          usage:
            input.drafted === undefined
              ? outcome.usage
              : addUsage(input.drafted.usage, outcome.usage),
        };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Two agents' spend on one table, under the later one's model. */
function addUsage(first: AgentUsage, second: AgentUsage): AgentUsage {
  return {
    model: second.model,
    turns: first.turns + second.turns,
    inputTokens: first.inputTokens + second.inputTokens,
    outputTokens: first.outputTokens + second.outputTokens,
    cacheReadTokens: first.cacheReadTokens + second.cacheReadTokens,
    cacheWriteTokens: first.cacheWriteTokens + second.cacheWriteTokens,
  };
}

/**
 * The table for a slice once its fixtures are written: one drafted beside
 * the fixtures agent when it holds against them too, else an agent's,
 * started from that draft. Null when no agent settles one.
 */
export async function settlePseudonyms(
  drafted: WrittenPseudonyms | null,
  write: (
    drafted: WrittenPseudonyms | undefined,
  ) => Promise<WrittenPseudonyms | null>,
  check: (rules: readonly AliasRule[]) => PseudonymCheck,
  log: (line: string) => void,
): Promise<WrittenPseudonyms | null> {
  if (drafted === null) return write(undefined);
  const problems = problemsOf(drafted.rules, check(drafted.rules));
  if (problems.length === 0) {
    log("The pseudonyms drafted beside the fixtures hold against them.");
    return drafted;
  }
  log(
    `The pseudonyms drafted beside the fixtures do not hold against them (${problems.length} problem(s)); an agent amends the table.`,
  );
  return write(drafted);
}
