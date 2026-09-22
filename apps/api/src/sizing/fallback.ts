import {
  SizerError,
  type SizedTicket,
  type Sizer,
  type SizingInput,
  type SizingRequestOptions,
} from "./sizer.js";

export interface FallbackSizerOptions {
  readonly primary: Sizer;
  readonly fallback: Sizer;
  /** Called once per handover, with the primary's code. Never a provider body. */
  readonly onFallback?: (code: SizerError["code"]) => void;
}

/**
 * Two providers behind one `Sizer`: the primary answers, and its failures hand
 * the same ticket to the fallback.
 *
 * `sizing_cancelled` is the one code that does not hand over. It means the run
 * itself was aborted or its deadline is spent, so a second provider would be
 * started against a signal that is already aborted — and every other code,
 * including the `stopsRun` `sizing_configuration`, is precisely the case the
 * fallback exists for: a key that is missing, revoked, or out of credit should
 * degrade to the other provider rather than stop the run.
 *
 * The fallback's own error is what propagates when both fail. That keeps the
 * `stopsRun` contract honest: the run stops only if the provider that actually
 * had the last word says it should.
 */
export class FallbackSizer implements Sizer {
  readonly #primary: Sizer;
  readonly #fallback: Sizer;
  readonly #onFallback: ((code: SizerError["code"]) => void) | undefined;

  constructor(options: FallbackSizerOptions) {
    this.#primary = options.primary;
    this.#fallback = options.fallback;
    this.#onFallback = options.onFallback;
  }

  /** The primary's model. `actualModel` on each sized ticket records the truth. */
  get model(): string {
    return this.#primary.model;
  }

  get promptVersion(): string {
    return this.#primary.promptVersion;
  }

  async size(
    input: SizingInput,
    options: SizingRequestOptions = {},
  ): Promise<SizedTicket> {
    try {
      return await this.#primary.size(input, options);
    } catch (error) {
      if (error instanceof SizerError && error.code === "sizing_cancelled") {
        throw error;
      }
      if (options.signal?.aborted === true) {
        throw new SizerError("sizing_cancelled", false);
      }
      if (error instanceof SizerError) this.#onFallback?.(error.code);
      return await this.#fallback.size(input, options);
    }
  }
}
