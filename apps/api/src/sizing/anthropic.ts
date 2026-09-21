import Anthropic from "@anthropic-ai/sdk";
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

interface ProviderMessage {
  readonly model: string;
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

export interface AnthropicSizerOptions {
  readonly apiKey?: string;
  readonly model: string;
  readonly messages?: MessagesClient;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly attemptTimeoutMs?: number;
}

export class AnthropicSizer implements Sizer {
  readonly model: string;
  readonly promptVersion = JIRA_SIZE_PROMPT_VERSION;
  readonly #messages: MessagesClient;
  readonly #now: () => number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #attemptTimeoutMs: number;

  constructor(options: AnthropicSizerOptions) {
    this.model = options.model;
    this.#messages =
      options.messages ??
      (new Anthropic({
        apiKey: options.apiKey,
        // The workflow owns the complete two-request budget.
        maxRetries: 0,
      }).messages as unknown as MessagesClient);
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
        const message = await this.#messages.create(
          this.#request(input, attempt > 0),
          { signal: attemptSignal.signal },
        );
        const parsed = parseMessage(message);
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
      system: JIRA_SIZE_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `${retry ? "The previous result was invalid. Return exactly one valid tool call.\n\n" : ""}Ticket data:\n${JSON.stringify(input)}`,
        },
      ],
      tools: [
        {
          name: TOOL_NAME,
          description: "Return the ticket size and a short private rationale.",
          strict: true,
          input_schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              complexity: { enum: ["S", "M", "L", "XL", "unsized"] },
              confidence: { enum: ["low", "medium", "high"] },
              rationale: { type: "string", minLength: 1, maxLength: 500 },
              unsizedReason: { type: "string", minLength: 1, maxLength: 120 },
            },
            required: ["complexity", "confidence", "rationale"],
          },
        },
      ],
      tool_choice: {
        type: "tool",
        name: TOOL_NAME,
        disable_parallel_tool_use: true,
      },
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

function parseMessage(message: ProviderMessage): SizedTicket | null {
  const toolUses = message.content.filter(({ type }) => type === "tool_use");
  if (toolUses.length !== 1 || toolUses[0]?.name !== TOOL_NAME) return null;
  const parsed = sizingResultSchema.safeParse(toolUses[0].input);
  if (!parsed.success) return null;
  return {
    result: parsed.data,
    actualModel: message.model,
    usage: {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
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
