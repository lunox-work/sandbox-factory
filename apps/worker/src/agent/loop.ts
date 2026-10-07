/**
 * The agent loop the scope and fixtures tools share.
 *
 * A model is given read-only tools and one submit tool, and runs until the
 * submit tool accepts an answer, the budget or the turn limit is spent, or
 * the model declines. The loop owns the limits rather than a runner:
 * the token ceiling is enforced here, the run's abort signal reaches every
 * model call and tool, and nothing of the conversation outlives the call.
 * Only fixed lines (turn numbers, tool names and counts, token totals) are
 * logged; tool inputs and results never are, because they carry source.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { AgentUsage } from "sandbox-factory";
import { AnalysisError } from "../errors.js";

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type ContentBlock = Anthropic.Beta.Messages.BetaContentBlock;
type ToolResultBlock = Anthropic.Beta.Messages.BetaToolResultBlockParam;
type TextBlock = Anthropic.Beta.Messages.BetaTextBlockParam;

export interface AgentToolDefinition {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for strict tool use: every property required, no extras. */
  readonly inputSchema: Record<string, unknown>;
  /**
   * False to send the schema as guidance only. Strict schemas compile to
   * one grammar per request, which has a size limit; a tool past it is
   * loose, and its input is still checked when it runs.
   */
  readonly strict?: boolean;
}
export interface AgentToolResult {
  readonly content: string;
  readonly isError?: boolean;
  /** Set by the submit tool when it accepts the answer; ends the loop. */
  readonly accepted?: boolean;
}
export interface AgentTool extends AgentToolDefinition {
  run(input: unknown, signal: AbortSignal): Promise<AgentToolResult>;
}
export interface AgentTurn {
  readonly content: readonly ContentBlock[];
  readonly stopReason: string | null;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
  };
}
/** One model behind the loop; the Anthropic one, or a script in tests. */
export interface AgentModel {
  readonly model: string;
  turn(
    request: {
      readonly system: string;
      readonly tools: readonly AgentToolDefinition[];
      readonly messages: readonly MessageParam[];
    },
    signal: AbortSignal,
  ): Promise<AgentTurn>;
}
export interface AgentLimits {
  readonly maxTurns: number;
  /** Every token the provider reports, cached or not, input or output. */
  readonly maxTokens: number;
}
/** What a worker gives its agent tools. */
export interface AgentSettings {
  /** Null when the worker has no model configured. */
  readonly model: AgentModel | null;
  readonly limits: AgentLimits;
}
export const AGENT_LIMITS_DEFAULT: AgentLimits = {
  maxTurns: 40,
  maxTokens: 4_000_000,
};
/** Spent past this share of either limit, the agent is told to submit. */
export const AGENT_WARNING_SHARE = 0.8;

export type AgentStop =
  "accepted" | "budget" | "turns" | "refusal" | "no_answer";
export interface AgentOutcome {
  readonly stopped: AgentStop;
  readonly usage: AgentUsage;
}

const NUDGES_MAX = 2;

export async function runAgent(input: {
  readonly model: AgentModel;
  readonly system: string;
  readonly prompt: string;
  readonly tools: readonly AgentTool[];
  readonly submitTool: string;
  readonly limits: AgentLimits;
  readonly signal: AbortSignal;
  readonly log: (line: string) => void;
}): Promise<AgentOutcome> {
  const { limits, signal, submitTool } = input;
  const byName = new Map(input.tools.map((tool) => [tool.name, tool]));
  const definitions = input.tools.map(
    ({ name, description, inputSchema, strict }) => ({
      name,
      description,
      inputSchema,
      ...(strict === undefined ? {} : { strict }),
    }),
  );
  const messages: MessageParam[] = [
    { role: "user", content: [{ type: "text", text: input.prompt }] },
  ];
  const usage = {
    model: input.model.model,
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  const spent = () =>
    usage.inputTokens +
    usage.outputTokens +
    usage.cacheReadTokens +
    usage.cacheWriteTokens;
  let warned = false;
  let nudges = 0;
  let stopped: AgentStop | null = null;
  while (stopped === null) {
    signal.throwIfAborted();
    if (spent() >= limits.maxTokens) {
      stopped = "budget";
      break;
    }
    if (usage.turns >= limits.maxTurns) {
      stopped = "turns";
      break;
    }
    const reply = await input.model.turn(
      { system: input.system, tools: definitions, messages },
      signal,
    );
    usage.turns += 1;
    usage.inputTokens += reply.usage.inputTokens;
    usage.outputTokens += reply.usage.outputTokens;
    usage.cacheReadTokens += reply.usage.cacheReadTokens;
    usage.cacheWriteTokens += reply.usage.cacheWriteTokens;
    // The assistant turn goes back unchanged: thinking blocks included.
    messages.push({ role: "assistant", content: [...reply.content] });
    if (reply.stopReason === "refusal") {
      stopped = "refusal";
      break;
    }
    const calls = reply.content.filter(
      (block): block is Anthropic.Beta.Messages.BetaToolUseBlock =>
        block.type === "tool_use",
    );
    if (calls.length === 0) {
      if (nudges >= NUDGES_MAX) {
        stopped = "no_answer";
        break;
      }
      nudges += 1;
      messages.push({
        role: "user",
        content: [
          {
            type: "text",
            text: `Answer by calling ${submitTool}.`,
          },
        ],
      });
      continue;
    }
    const results: ToolResultBlock[] = [];
    const counts = new Map<string, number>();
    let accepted = false;
    for (const call of calls) {
      counts.set(call.name, (counts.get(call.name) ?? 0) + 1);
      const tool = byName.get(call.name);
      let result: AgentToolResult;
      if (reply.stopReason === "max_tokens")
        // A call cut off mid-input can parse as a valid, shorter one.
        result = {
          content:
            "Your reply was cut off before this call was complete. Send it again, shorter.",
          isError: true,
        };
      else if (tool === undefined)
        result = {
          content: `There is no tool named ${call.name}.`,
          isError: true,
        };
      else
        try {
          result = await tool.run(call.input, signal);
        } catch (error) {
          // A coded failure is the platform's, not the agent's to correct:
          // the evaluator would not start, or a stage failed. It ends the
          // run under its own code rather than reading as a bad input the
          // agent spends its next run on.
          if (signal.aborted || error instanceof AnalysisError) throw error;
          input.log(`Tool ${call.name} failed.`);
          result = { content: "The tool failed on that input.", isError: true };
        }
      if (result.accepted === true && call.name === submitTool) accepted = true;
      results.push({
        type: "tool_result",
        tool_use_id: call.id,
        content: result.content,
        ...(result.isError === true ? { is_error: true } : {}),
      });
    }
    input.log(
      `Turn ${usage.turns}: ${[...counts.entries()]
        .map(([name, count]) => `${name} x${count}`)
        .join(", ")}.`,
    );
    if (accepted) {
      stopped = "accepted";
      break;
    }
    const content: (ToolResultBlock | TextBlock)[] = [...results];
    if (
      !warned &&
      (spent() >= limits.maxTokens * AGENT_WARNING_SHARE ||
        usage.turns >= limits.maxTurns * AGENT_WARNING_SHARE)
    ) {
      warned = true;
      content.push({
        type: "text",
        text: `Your budget is nearly spent. Call ${submitTool} with your best answer now.`,
      });
    }
    messages.push({ role: "user", content });
  }
  input.log(
    `Agent stopped (${stopped}) after ${usage.turns} turns and ${spent()} tokens.`,
  );
  return { stopped, usage };
}
