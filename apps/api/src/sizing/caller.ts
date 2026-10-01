/**
 * One structured call to a model: a tool the model must call once, and the
 * checked result of that call.
 *
 * Every step of pricing that asks a model asks it this way, so the retry,
 * timeout, cancellation, fallback and validation rules are written once, in
 * the callers, and a tool is only what differs: its prompt, its schema and
 * how its answer is checked.
 */

/** A JSON Schema object, as a provider's tool definition takes it. */
export type JsonSchema = { readonly [keyword: string]: unknown };

export type ParseResult<O> =
  | { readonly ok: true; readonly value: O }
  | {
      readonly ok: false;
      /**
       * What was wrong, as one sentence naming the field and its limit. It
       * is sent back to the model on the retry, so it is built from the
       * schema's own words and **never from the model's output**.
       */
      readonly problem: string;
    };

export interface StructuredCall<I, O> {
  /** The tool the model is made to call. */
  readonly name: string;
  readonly description: string;
  readonly promptVersion: string;
  readonly system: string;
  /**
   * The tool's input schema, carrying every limit it has. Each caller
   * renders it for its provider: one definition, not one per provider.
   */
  readonly schema: JsonSchema;
  readonly maxTokens: number;
  /** How long one attempt may take. A long answer needs a long attempt. */
  readonly attemptTimeoutMs: number;
  /** The user message: the data the tool is called about. */
  readonly render: (input: I) => string;
  readonly parse: (raw: unknown) => ParseResult<O>;
}

export interface SizingUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface StructuredResult<O> {
  readonly result: O;
  readonly actualModel: string;
  /** Every attempt that reached the model, not only the one that answered. */
  readonly usage: SizingUsage;
}

export interface SizingRequestOptions {
  readonly signal?: AbortSignal;
  /** Absolute run deadline. Provider retries must fit inside it. */
  readonly deadlineAt?: Date;
}

export interface StructuredCaller {
  readonly model: string;
  call<I, O>(
    tool: StructuredCall<I, O>,
    input: I,
    options?: SizingRequestOptions,
  ): Promise<StructuredResult<O>>;
}

export type SizerErrorCode =
  | "sizing_configuration"
  | "sizing_invalid_output"
  | "sizing_timeout"
  | "sizing_cancelled"
  | "sizing_provider";

/** Safe, fixed provider failure. Never carries an upstream body or prompt. */
export class SizerError extends Error {
  constructor(
    readonly code: SizerErrorCode,
    readonly stopsRun: boolean,
  ) {
    super(code);
    this.name = "SizerError";
  }
}

type FakeAnswer = StructuredResult<unknown> | Error;

/**
 * A deterministic injectable used by executor and route tests.
 *
 * Answers by tool name, so a test that cares about one call is not at the
 * mercy of the order the executor makes the others in. A tool's answers are
 * a queue, or a function of the input for a test that does not count calls.
 */
export class FakeCaller implements StructuredCaller {
  readonly calls: { readonly tool: string; readonly input: unknown }[] = [];

  constructor(
    readonly model: string,
    private readonly answers: Readonly<
      Record<string, FakeAnswer[] | ((input: unknown) => FakeAnswer)>
    >,
  ) {}

  /** The inputs one tool was called with, in order. */
  inputsFor(tool: string): unknown[] {
    return this.calls
      .filter((call) => call.tool === tool)
      .map(({ input }) => input);
  }

  call<I, O>(
    tool: StructuredCall<I, O>,
    input: I,
  ): Promise<StructuredResult<O>> {
    this.calls.push({ tool: tool.name, input });
    const source = Object.hasOwn(this.answers, tool.name)
      ? this.answers[tool.name]
      : undefined;
    const answer =
      typeof source === "function" ? source(input) : source?.shift();
    if (answer === undefined) {
      return Promise.reject(
        new Error(`FakeCaller has no answer for ${tool.name}.`),
      );
    }
    return answer instanceof Error
      ? Promise.reject(answer)
      : Promise.resolve(answer as StructuredResult<O>);
  }
}
