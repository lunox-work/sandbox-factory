import type { BountySizingResult } from "sandbox-factory";

export interface SizingInput {
  readonly summary: string;
  readonly descriptionText: string;
  readonly issueType: string;
}

export interface SizingUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface SizedTicket {
  readonly result: BountySizingResult;
  readonly actualModel: string;
  readonly usage: SizingUsage;
}

export interface SizingRequestOptions {
  readonly signal?: AbortSignal;
  /** Absolute run deadline. Provider retries must fit inside it. */
  readonly deadlineAt?: Date;
}

export interface Sizer {
  readonly model: string;
  readonly promptVersion: string;
  size(
    input: SizingInput,
    options?: SizingRequestOptions,
  ): Promise<SizedTicket>;
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

/** A deterministic injectable used by executor and route tests. */
export class FakeSizer implements Sizer {
  readonly calls: SizingInput[] = [];

  constructor(
    readonly model: string,
    readonly promptVersion: string,
    private readonly answers: Array<SizedTicket | Error>,
  ) {}

  size(input: SizingInput): Promise<SizedTicket> {
    this.calls.push(input);
    const answer = this.answers.shift();
    if (answer === undefined) {
      return Promise.reject(new Error("FakeSizer has no answer."));
    }
    return answer instanceof Error
      ? Promise.reject(answer)
      : Promise.resolve(answer);
  }
}
