/**
 * The part of `duediligence/api` the worker calls, typed from its
 * documentation (`bin/api.mjs`, `bin/rules.mjs`); the package ships plain
 * JavaScript. The version is pinned exactly in package.json, so a change
 * here follows a deliberate bump.
 */
declare module "duediligence/api" {
  /** One test's outcome, as a duediligence runner reports it. */
  export interface SuiteTest {
    readonly name: string;
    readonly ok: boolean;
    readonly skipped: boolean;
    readonly error: { readonly message: string } | null;
  }
  /** A suite's results, as a duediligence runner prints them. */
  export interface SuiteResult {
    readonly compiled: boolean;
    readonly compileOutput?: string;
    readonly files: readonly {
      readonly file: string;
      readonly crashed: boolean;
      readonly timedOut: boolean;
      readonly tests: readonly SuiteTest[];
    }[];
  }
  /**
   * The calibration rule: a test is kept only if it fails on the skeleton
   * inside its test and the reference passes it; `reference` null drops
   * every test left. Ids are `<file> :: <test name>`.
   */
  export function calibrate(input: {
    readonly skeleton: SuiteResult;
    readonly reference: SuiteResult | null;
  }): {
    readonly status: "ok" | "dropped";
    readonly reason: string | null;
    readonly hiddenWritten: number;
    readonly kept: readonly string[];
    readonly dropped: readonly {
      readonly id: string;
      readonly reason: string;
    }[];
  };
  /** The absolute path of prompts/<name>.md inside the package. */
  export function promptPath(name: string): string;
  /** prompts/<name>.md with each `{{key}}` filled; a missing key throws. */
  export function renderPrompt(
    name: string,
    values: Readonly<Record<string, string>>,
  ): string;
}
