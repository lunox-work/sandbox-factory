import type { AnalysisErrorCode } from "sandbox-factory";

/** Only this fixed code crosses into persisted errors; tool text stays private. */
export class AnalysisError extends Error {
  constructor(readonly code: AnalysisErrorCode) {
    super(code);
  }
}
export class CommandError extends Error {
  constructor(readonly exitCode: number | null) {
    super("Worker command failed.");
  }
}
