import {
  SizerError,
  type SizingRequestOptions,
  type SizingUsage,
  type StructuredCall,
  type StructuredCaller,
  type StructuredResult,
} from "./caller.js";

const MAX_ATTEMPTS = 2;

/** What one request to a provider came back with. */
export interface ProviderReply {
  readonly outcome:
    /** The one expected tool call, with its arguments as the model gave them. */
    | { readonly kind: "call"; readonly args: unknown }
    /** No call, a call to something else, or more than one. */
    | { readonly kind: "no-call" }
    /** The output limit ended the answer before the call was whole. */
    | { readonly kind: "cut-off" };
  readonly actualModel: string;
  readonly usage: SizingUsage;
}

export interface RetryingCallerOptions {
  readonly model: string;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  /** Overrides every tool's own attempt timeout. For tests. */
  readonly attemptTimeoutMs?: number;
}

/**
 * Everything about a structured call that is the same whichever provider
 * answers it: two attempts, a timeout per attempt that also fits the run's
 * deadline, cancellation, the fixed error codes, and the retry that tells
 * the model what was wrong with its first answer.
 *
 * A provider adds one method, `send`: one request, one reply. It throws
 * whatever its transport throws; an error carrying a numeric `status` and a
 * `headers` object is classified here, which is the shape both the Anthropic
 * SDK and the DeepSeek `fetch` client give their errors.
 */
export abstract class RetryingCaller implements StructuredCaller {
  readonly model: string;
  readonly #now: () => number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #attemptTimeoutMs: number | undefined;

  constructor(options: RetryingCallerOptions) {
    this.model = options.model;
    this.#now = options.now ?? Date.now;
    this.#sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#attemptTimeoutMs = options.attemptTimeoutMs;
  }

  protected abstract send<I, O>(
    tool: StructuredCall<I, O>,
    message: string,
    signal: AbortSignal,
  ): Promise<ProviderReply>;

  async call<I, O>(
    tool: StructuredCall<I, O>,
    input: I,
    options: SizingRequestOptions = {},
  ): Promise<StructuredResult<O>> {
    let problem: string | undefined;
    let inputTokens = 0;
    let outputTokens = 0;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      if (isAborted(options.signal)) {
        throw new SizerError("sizing_cancelled", false);
      }

      const attemptSignal = this.#attemptSignal(tool, options);
      try {
        const reply = await this.send(
          tool,
          userMessage(tool, input, problem),
          attemptSignal.signal,
        );
        inputTokens += reply.usage.inputTokens;
        outputTokens += reply.usage.outputTokens;

        const parsed =
          reply.outcome.kind === "call"
            ? tool.parse(reply.outcome.args)
            : ({
                ok: false,
                problem:
                  reply.outcome.kind === "cut-off"
                    ? "it was cut off at the output limit, so write less."
                    : `it was not a single ${tool.name} call.`,
              } as const);
        if (parsed.ok) {
          return {
            result: parsed.value,
            actualModel: reply.actualModel,
            usage: { inputTokens, outputTokens },
          };
        }
        if (attempt === MAX_ATTEMPTS - 1) {
          throw new SizerError("sizing_invalid_output", false);
        }
        problem = parsed.problem;
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

  #attemptSignal(
    tool: { readonly attemptTimeoutMs: number },
    options: SizingRequestOptions,
  ): {
    signal: AbortSignal;
    timedOut: () => boolean;
    cleanup: () => void;
  } {
    const timeout = this.#attemptTimeoutMs ?? tool.attemptTimeoutMs;
    const controller = new AbortController();
    const remaining =
      options.deadlineAt === undefined
        ? timeout
        : Math.max(0, options.deadlineAt.getTime() - this.#now());
    let didTimeOut = remaining === 0;
    const timer = setTimeout(
      () => {
        didTimeOut = true;
        controller.abort();
      },
      Math.min(timeout, remaining),
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
 * The data, and on a retry what was wrong with the answer before it. The
 * problem is the tool's own sentence about its own schema: the rejected
 * output is never sent back.
 */
function userMessage<I, O>(
  tool: StructuredCall<I, O>,
  input: I,
  problem: string | undefined,
): string {
  const data = tool.render(input);
  return problem === undefined
    ? data
    : `The previous result was invalid: ${problem} Return exactly one valid ${tool.name} call.\n\n${data}`;
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
