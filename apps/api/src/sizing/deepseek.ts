import { BOUNTY_COMPLEXITIES } from "sandbox-factory";
import { sizingResultSchema } from "@sandbox-factory/shared";

import { JIRA_SIZE_PROMPT_VERSION, JIRA_SIZE_SYSTEM_PROMPT } from "./prompt.js";
import {
  SizerError,
  type SizedTicket,
  type Sizer,
  type SizingInput,
  type SizingRequestOptions,
} from "./sizer.js";

const TOOL_NAME = "size_bounty";
const MAX_ATTEMPTS = 2;
const ATTEMPT_TIMEOUT_MS = 45_000;
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

export interface DeepSeekSizerOptions {
  readonly apiKey?: string;
  readonly model: string;
  readonly baseUrl?: string;
  readonly completions?: CompletionsClient;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly attemptTimeoutMs?: number;
}

/**
 * The fallback provider, behind the same `Sizer` contract as `AnthropicSizer`
 * and with the same two-attempt budget, deadline handling, and fixed error
 * codes. Nothing upstream can tell the two apart except by `actualModel`,
 * which is recorded per sized ticket.
 */
export class DeepSeekSizer implements Sizer {
  readonly model: string;
  readonly promptVersion = JIRA_SIZE_PROMPT_VERSION;
  readonly #completions: CompletionsClient;
  readonly #now: () => number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #attemptTimeoutMs: number;

  constructor(options: DeepSeekSizerOptions) {
    this.model = options.model;
    this.#completions =
      options.completions ??
      fetchCompletions(options.baseUrl ?? DEFAULT_BASE_URL, options.apiKey);
    this.#now = options.now ?? Date.now;
    this.#sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#attemptTimeoutMs = options.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS;
  }

  async size(
    input: SizingInput,
    options: SizingRequestOptions = {},
  ): Promise<SizedTicket> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      if (isAborted(options.signal)) {
        throw new SizerError("sizing_cancelled", false);
      }

      const attemptSignal = this.#attemptSignal(options);
      try {
        const completion = await this.#completions.create(
          this.#request(input, attempt > 0),
          { signal: attemptSignal.signal },
        );
        const parsed = parseCompletion(completion);
        if (parsed !== null) return parsed;
        if (attempt === MAX_ATTEMPTS - 1) {
          throw new SizerError("sizing_invalid_output", false);
        }
      } catch (error) {
        if (error instanceof SizerError) throw error;
        if (isAborted(options.signal)) {
          throw new SizerError("sizing_cancelled", false);
        }
        if (attemptSignal.timedOut()) {
          if (attempt === MAX_ATTEMPTS - 1) {
            throw new SizerError("sizing_timeout", false);
          }
        } else if (isConfigurationError(error)) {
          throw new SizerError("sizing_configuration", true);
        } else if (!isTransient(error) || attempt === MAX_ATTEMPTS - 1) {
          throw new SizerError("sizing_provider", false);
        }

        await this.#waitForRetry(error, options);
      } finally {
        attemptSignal.cleanup();
      }
    }

    throw new SizerError("sizing_invalid_output", false);
  }

  #request(input: SizingInput, retry: boolean): Record<string, unknown> {
    return {
      model: this.model,
      max_tokens: 1_024,
      // DeepSeek's current models (deepseek-v4-pro, deepseek-flash) run in
      // thinking mode by default, and thinking mode rejects a forced
      // `tool_choice` with 400 "Thinking mode does not support this
      // tool_choice" — which `isConfigurationError` would turn into a run
      // stop. Sizing is one bounded classification, so thinking buys nothing
      // here and would otherwise spend the `max_tokens` budget on reasoning.
      thinking: { type: "disabled" },
      messages: [
        { role: "system", content: JIRA_SIZE_SYSTEM_PROMPT },
        {
          role: "user",
          content: `${retry ? "The previous result was invalid. Return exactly one valid tool call.\n\n" : ""}Ticket data:\n${JSON.stringify(input)}`,
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: TOOL_NAME,
            description:
              "Return the ticket size and a short private rationale.",
            parameters: {
              type: "object",
              additionalProperties: false,
              properties: {
                complexity: { enum: [...BOUNTY_COMPLEXITIES] },
                confidence: { enum: ["low", "medium", "high"] },
                rationale: { type: "string", minLength: 1, maxLength: 500 },
                unsizedReason: { type: "string", minLength: 1, maxLength: 120 },
              },
              required: ["complexity", "confidence", "rationale"],
            },
          },
        },
      ],
      tool_choice: { type: "function", function: { name: TOOL_NAME } },
    };
  }

  #attemptSignal(options: SizingRequestOptions): {
    signal: AbortSignal;
    timedOut: () => boolean;
    cleanup: () => void;
  } {
    const controller = new AbortController();
    const remaining =
      options.deadlineAt === undefined
        ? this.#attemptTimeoutMs
        : Math.max(0, options.deadlineAt.getTime() - this.#now());
    let didTimeOut = remaining === 0;
    const timer = setTimeout(
      () => {
        didTimeOut = true;
        controller.abort();
      },
      Math.min(this.#attemptTimeoutMs, remaining),
    );
    const cancel = () => controller.abort();
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (didTimeOut) controller.abort();
    return {
      signal: controller.signal,
      timedOut: () => didTimeOut,
      cleanup: () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", cancel);
      },
    };
  }

  async #waitForRetry(
    error: unknown,
    options: SizingRequestOptions,
  ): Promise<void> {
    const retryAfter = retryAfterMs(error);
    const delay = retryAfter ?? 500;
    const remaining =
      options.deadlineAt === undefined
        ? Number.POSITIVE_INFINITY
        : options.deadlineAt.getTime() - this.#now();
    if (delay >= remaining) {
      throw new SizerError("sizing_timeout", false);
    }
    await this.#sleep(Math.min(delay, 30_000));
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

function parseCompletion(completion: CompletionResponse): SizedTicket | null {
  const toolCalls = completion.choices[0]?.message?.tool_calls ?? [];
  if (toolCalls.length !== 1) return null;
  const call = toolCalls[0]?.function;
  if (call?.name !== TOOL_NAME || typeof call.arguments !== "string") {
    return null;
  }

  let args: unknown;
  try {
    args = JSON.parse(call.arguments);
  } catch {
    // A truncated or non-JSON argument string is an invalid result, not a
    // crash: the caller's retry handles it like any other malformed output.
    return null;
  }

  const parsed = sizingResultSchema.safeParse(args);
  if (!parsed.success) return null;
  return {
    result: parsed.data,
    actualModel: completion.model,
    usage: {
      inputTokens: completion.usage.prompt_tokens,
      outputTokens: completion.usage.completion_tokens,
    },
  };
}

function statusOf(error: unknown): number | undefined {
  return typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number"
    ? error.status
    : undefined;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function isConfigurationError(error: unknown): boolean {
  const status = statusOf(error);
  return status === 400 || status === 401 || status === 403 || status === 404;
}

function isTransient(error: unknown): boolean {
  const status = statusOf(error);
  return (
    status === undefined || status === 408 || status === 429 || status >= 500
  );
}

function retryAfterMs(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("headers" in error)) {
    return undefined;
  }
  const headers = error.headers;
  if (!(headers instanceof Headers)) return undefined;
  const seconds = Number(headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : undefined;
}
