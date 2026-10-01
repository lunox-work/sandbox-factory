import type { StructuredCall } from "./caller.js";
import {
  RetryingCaller,
  type ProviderReply,
  type RetryingCallerOptions,
} from "./retrying.js";

const DEFAULT_BASE_URL = "https://api.deepseek.com";

/**
 * The shape DeepSeek returns from `POST /chat/completions`. It is the
 * OpenAI-compatible schema, which differs from Anthropic's in all three places
 * this file cares about: the tool call lives under `message.tool_calls` rather
 * than in a content array, its arguments arrive as a JSON *string* rather than
 * a parsed object, and usage is `prompt_tokens`/`completion_tokens`.
 */
interface CompletionResponse {
  readonly model: string;
  readonly choices: readonly {
    readonly finish_reason?: string | null;
    readonly message?: {
      readonly tool_calls?: readonly {
        readonly function?: {
          readonly name?: string;
          readonly arguments?: string;
        };
      }[];
    };
  }[];
  readonly usage: {
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
  };
}

/**
 * The single seam this adapter is built on, mirroring `MessagesClient` in
 * `anthropic.ts`: tests inject a function here instead of a network.
 */
export interface CompletionsClient {
  create(
    params: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<CompletionResponse>;
}

export interface DeepSeekCallerOptions extends RetryingCallerOptions {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly completions?: CompletionsClient;
}

/**
 * The fallback provider, behind the same `StructuredCaller` contract as
 * `AnthropicCaller` and, through `RetryingCaller`, with the same two-attempt
 * budget, deadline handling, and fixed error codes. Nothing upstream can
 * tell the two apart except by `actualModel`, which is recorded with every
 * result.
 */
export class DeepSeekCaller extends RetryingCaller {
  readonly #completions: CompletionsClient;

  constructor(options: DeepSeekCallerOptions) {
    super(options);
    this.#completions =
      options.completions ??
      fetchCompletions(options.baseUrl ?? DEFAULT_BASE_URL, options.apiKey);
  }

  protected override async send<I, O>(
    tool: StructuredCall<I, O>,
    message: string,
    signal: AbortSignal,
  ): Promise<ProviderReply> {
    const completion = await this.#completions.create(
      {
        model: this.model,
        max_tokens: tool.maxTokens,
        // DeepSeek's current models (deepseek-v4-pro, deepseek-flash) run in
        // thinking mode by default, and thinking mode rejects a forced
        // `tool_choice` with 400 "Thinking mode does not support this
        // tool_choice" — which a caller classifies as a configuration
        // error, a run stop. Each call here is one bounded extraction, so
        // thinking buys nothing and would otherwise spend the `max_tokens`
        // budget on reasoning.
        thinking: { type: "disabled" },
        messages: [
          { role: "system", content: tool.system },
          { role: "user", content: message },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              // The schema as the tool declares it: unlike Anthropic's
              // strict mode, this endpoint takes the limits as written.
              parameters: tool.schema,
            },
          },
        ],
        tool_choice: { type: "function", function: { name: tool.name } },
      },
      { signal },
    );
    return {
      outcome: outcomeOf(completion, tool.name),
      actualModel: completion.model,
      usage: {
        inputTokens: completion.usage.prompt_tokens,
        outputTokens: completion.usage.completion_tokens,
      },
    };
  }
}

/**
 * A `fetch` client for DeepSeek's OpenAI-compatible endpoint. Non-2xx
 * responses become an error carrying `status` and `headers`, which is the
 * contract `isConfigurationError`, `isTransient`, and `retryAfterMs` read —
 * the same fields the Anthropic SDK puts on its own errors.
 */
function fetchCompletions(
  baseUrl: string,
  apiKey: string | undefined,
): CompletionsClient {
  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  return {
    async create(params, options) {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey ?? ""}`,
        },
        body: JSON.stringify(params),
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      });
      if (!response.ok) {
        // The body is deliberately dropped: it may echo the prompt, and
        // upstream only ever renders the fixed `SizerError` codes.
        throw new ProviderHttpError(response.status, response.headers);
      }
      return (await response.json()) as CompletionResponse;
    },
  };
}

class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    readonly headers: Headers,
  ) {
    super(`deepseek_http_${status}`);
    this.name = "ProviderHttpError";
  }
}

function outcomeOf(
  completion: CompletionResponse,
  toolName: string,
): ProviderReply["outcome"] {
  const choice = completion.choices[0];
  if (choice?.finish_reason === "length") return { kind: "cut-off" };
  const toolCalls = choice?.message?.tool_calls ?? [];
  if (toolCalls.length !== 1) return { kind: "no-call" };
  const call = toolCalls[0]?.function;
  if (call?.name !== toolName || typeof call.arguments !== "string") {
    return { kind: "no-call" };
  }

  try {
    return { kind: "call", args: JSON.parse(call.arguments) };
  } catch {
    // A non-JSON argument string is an invalid result, not a crash: the
    // caller's retry handles it like any other malformed output.
    return { kind: "no-call" };
  }
}
