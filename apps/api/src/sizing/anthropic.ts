import Anthropic from "@anthropic-ai/sdk";

import type { JsonSchema, StructuredCall } from "./caller.js";
import {
  RetryingCaller,
  type ProviderReply,
  type RetryingCallerOptions,
} from "./retrying.js";

interface ProviderMessage {
  readonly model: string;
  readonly stop_reason?: string | null;
  readonly content: readonly {
    readonly type: string;
    readonly name?: string;
    readonly input?: unknown;
  }[];
  readonly usage: {
    readonly input_tokens: number;
    readonly output_tokens: number;
  };
}

interface MessagesClient {
  create(
    params: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<ProviderMessage>;
}

export interface AnthropicCallerOptions extends RetryingCallerOptions {
  readonly apiKey?: string;
  readonly messages?: MessagesClient;
}

export class AnthropicCaller extends RetryingCaller {
  readonly #messages: MessagesClient;

  constructor(options: AnthropicCallerOptions) {
    super(options);
    this.#messages =
      options.messages ??
      (new Anthropic({
        apiKey: options.apiKey,
        // The workflow owns the complete two-request budget.
        maxRetries: 0,
      }).messages as unknown as MessagesClient);
  }

  protected override async send<I, O>(
    tool: StructuredCall<I, O>,
    message: string,
    signal: AbortSignal,
  ): Promise<ProviderReply> {
    const reply = await this.#messages.create(
      {
        model: this.model,
        max_tokens: tool.maxTokens,
        system: tool.system,
        messages: [{ role: "user", content: message }],
        tools: [
          {
            name: tool.name,
            description: tool.description,
            strict: true,
            input_schema: toStrictSchema(tool.schema),
          },
        ],
        tool_choice: {
          type: "tool",
          name: tool.name,
          disable_parallel_tool_use: true,
        },
      },
      { signal },
    );
    const toolUses = reply.content.filter(({ type }) => type === "tool_use");
    return {
      outcome:
        // Checked first: a call the limit cut short still arrives as a
        // tool_use block, with whatever of its input had been written.
        reply.stop_reason === "max_tokens"
          ? { kind: "cut-off" }
          : toolUses.length === 1 && toolUses[0]?.name === tool.name
            ? { kind: "call", args: toolUses[0].input }
            : { kind: "no-call" },
      actualModel: reply.model,
      usage: {
        inputTokens: reply.usage.input_tokens,
        outputTokens: reply.usage.output_tokens,
      },
    };
  }
}

/** The limits a strict tool schema refuses, and how each reads as prose. */
const LIMITS: Readonly<Record<string, (value: unknown) => string>> = {
  minLength: (value) =>
    value === 1 ? "Non-empty" : `At least ${value} characters`,
  maxLength: (value) => `at most ${value} characters`,
  minItems: (value) => `at least ${value} ${value === 1 ? "item" : "items"}`,
  maxItems: (value) => `at most ${value} items`,
  minimum: (value) => `at least ${value}`,
  maximum: (value) => `at most ${value}`,
};

/**
 * A tool's schema as Anthropic's strict mode accepts it.
 *
 * Strict schemas reject string, number and array limits with a 400, so each
 * limit is moved out of the schema and into the field's description, where
 * the model still reads it. The tool's `parse` is what enforces it on the
 * way back.
 */
export function toStrictSchema(schema: JsonSchema): JsonSchema {
  const strict: Record<string, unknown> = {};
  const limits: string[] = [];
  for (const [keyword, value] of Object.entries(schema)) {
    const limit = Object.hasOwn(LIMITS, keyword) ? LIMITS[keyword] : undefined;
    if (limit !== undefined) {
      limits.push(limit(value));
    } else if (keyword === "properties" && isSchema(value)) {
      strict[keyword] = Object.fromEntries(
        Object.entries(value).map(([name, property]) => [
          name,
          isSchema(property) ? toStrictSchema(property) : property,
        ]),
      );
    } else if (keyword === "items" && isSchema(value)) {
      strict[keyword] = toStrictSchema(value);
    } else {
      strict[keyword] = value;
    }
  }
  if (limits.length > 0) {
    const sentence = `${capitalize(limits.join(", "))}.`;
    strict["description"] =
      typeof schema["description"] === "string"
        ? `${schema["description"]} ${sentence}`
        : sentence;
  }
  return strict;
}

function isSchema(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
