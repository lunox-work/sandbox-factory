/**
 * The Anthropic model behind the agent loop.
 *
 * One streamed Messages call per turn on the beta endpoint, for the
 * server-side refusal fallback. Adaptive thinking at high effort, strict
 * tool schemas, and automatic prompt caching: the loop resends a growing
 * transcript every turn, so the cached prefix is most of each request. An
 * authentication, permission or unknown-model failure is the worker's
 * configuration, not the run's, and says so with `agent_unavailable`.
 */

import Anthropic from "@anthropic-ai/sdk";
import { AnalysisError } from "../errors.js";
import type { AgentModel } from "./loop.js";

/** Room for adaptive thinking plus a large submission in one turn. */
export const AGENT_MAX_OUTPUT_TOKENS = 64_000;

type MessagesClient = Pick<Anthropic["beta"]["messages"], "stream">;

export function createAnthropicModel(options: {
  readonly apiKey: string;
  readonly model: string;
  /** A stand-in for the SDK's beta messages resource, in tests. */
  readonly messages?: MessagesClient;
}): AgentModel {
  const messages =
    options.messages ??
    new Anthropic({ apiKey: options.apiKey, maxRetries: 4 }).beta.messages;
  return {
    model: options.model,
    async turn(request, signal) {
      let message;
      try {
        message = await messages
          .stream(
            {
              model: options.model,
              max_tokens: AGENT_MAX_OUTPUT_TOKENS,
              system: [{ type: "text", text: request.system }],
              tools: request.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                input_schema: {
                  type: "object" as const,
                  ...tool.inputSchema,
                },
                strict: tool.strict ?? true,
              })),
              messages: [...request.messages],
              thinking: { type: "adaptive" },
              output_config: { effort: "high" },
              cache_control: { type: "ephemeral" },
              betas: ["server-side-fallback-2026-07-01"],
              fallbacks: "default",
            },
            { signal },
          )
          .finalMessage();
      } catch (error) {
        if (
          error instanceof Anthropic.AuthenticationError ||
          error instanceof Anthropic.PermissionDeniedError ||
          error instanceof Anthropic.NotFoundError
        )
          throw new AnalysisError("agent_unavailable");
        throw error;
      }
      return {
        content: message.content,
        stopReason: message.stop_reason,
        usage: {
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
          cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
        },
      };
    },
  };
}
