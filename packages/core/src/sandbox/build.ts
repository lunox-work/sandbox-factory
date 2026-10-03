/**
 * The runnable package a version builds, and the evaluation it runs under.
 *
 * `build-manifest.json` binds the generated project to its inputs: the
 * slice manifest, the transform, the approved task, the toolchain and the
 * evaluator environment, with every file hashed and classified. The
 * evaluation-provider adapter is the seam between the worker and whichever
 * isolated runner executes checks; the worker ships a local process
 * provider for development and the test double, and a hosted provider is
 * qualified separately (Decision 5 of the sandbox plan). Nothing here
 * depends on a provider SDK.
 */

import type { ImportRewrite, ProjectBlocker } from "./project.js";
import type { PathClass, ResolvedDependency } from "./provenance.js";

export const SANDBOX_BUILD_SCHEMA_VERSION = 1;

/**
 * The local toolchain contract every generated project declares. Fixed per
 * tool version so two builds of one slice are byte-identical; the
 * evaluator's image digest is recorded separately, since the runner is not
 * the freelancer's computer.
 */
export interface Toolchain {
  /** `.nvmrc` content. */
  readonly node: string;
  /** `engines.node`. */
  readonly nodeRange: string;
  readonly npm: string;
  readonly typescript: string;
  readonly testRunner: "node:test";
  readonly supportedPlatforms: readonly ("darwin" | "linux" | "win32")[];
}

export const SANDBOX_TOOLCHAIN: Toolchain = {
  node: "22",
  nodeRange: ">=22.12.0",
  npm: "10.9.2",
  typescript: "5.9.3",
  testRunner: "node:test",
  supportedPlatforms: ["darwin", "linux", "win32"],
};

/** The commands a contributor runs, with or without the extension. */
export const SANDBOX_COMMANDS = {
  install: "npm ci",
  dev: "npm run dev",
  build: "npm run build",
  test: "npm test",
} as const;
export type SandboxCommand = keyof typeof SANDBOX_COMMANDS;

export interface EvaluationEnvironment {
  /** `local-process`, `fake`, or a hosted provider's name. */
  readonly provider: string;
  /** The provider's job/environment identifier, when it has one. */
  readonly environmentId: string | null;
  /** The pinned template/image digest the job ran in, when the provider has one. */
  readonly templateDigest: string | null;
}

export interface EvaluationLimits {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export const EVALUATION_LIMITS: EvaluationLimits = {
  timeoutMs: 10 * 60 * 1000,
  maxOutputBytes: 256 * 1024,
};

export interface EvaluationCommand {
  readonly argv: readonly string[];
  /** Relative to the job's working directory. */
  readonly cwd?: string;
  /** Fixture values only; the adapter never passes its own environment. */
  readonly env?: Readonly<Record<string, string>>;
  readonly limits?: EvaluationLimits;
}

export interface EvaluationExecResult {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly outputTruncated: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

export interface StagedFile {
  readonly path: string;
  readonly text: string;
}

/** One isolated job: fresh, staged with exactly what it is given, destroyed. */
export interface EvaluationJob {
  readonly id: string;
  readonly environment: EvaluationEnvironment;
  stage(files: readonly StagedFile[]): Promise<void>;
  exec(command: EvaluationCommand): Promise<EvaluationExecResult>;
  /** A text file the job produced, such as the lockfile; null when absent. */
  read(path: string): Promise<string | null>;
  destroy(): Promise<void>;
}

export interface EvaluationProvider {
  readonly name: string;
  create(spec: {
    readonly label: string;
    readonly signal: AbortSignal;
  }): Promise<EvaluationJob>;
}

export const STAGE_STATES = [
  "created",
  "running",
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
] as const;
export type StageState = (typeof STAGE_STATES)[number];

/** The record kept for every job, written before it starts and kept on retry. */
export interface StageExecution {
  readonly stage: "baseline" | "public" | "private";
  readonly sequence: number;
  readonly environment: EvaluationEnvironment;
  readonly jobId: string;
  readonly inputsSha256: string;
  readonly state: StageState;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly teardown: "destroyed" | "failed" | "pending";
}

export interface BaselineStep {
  readonly name:
    "prepare" | "install" | "build" | "dev" | "public-tests" | "private-test";
  readonly argv: readonly string[];
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly ok: boolean;
  /** Which private test, for `private-test` steps. */
  readonly path: string | null;
}

export interface PrivateTestOutcome {
  readonly path: string;
  readonly expected: "pass" | "fail";
  readonly observed: "pass" | "fail" | "error";
  readonly ok: boolean;
}

export interface BaselineReport {
  readonly executions: readonly StageExecution[];
  readonly steps: readonly BaselineStep[];
  readonly privateTests: readonly PrivateTestOutcome[];
  readonly ok: boolean;
  readonly reasons: readonly string[];
}

/**
 * The baseline rule: install, build, the dev walkthrough and the public
 * tests must pass on the unfixed source, and every hidden test must do
 * what the owner said it would. A build or harness failure is never accepted as "the test that
 * fails before the fix".
 */
export function baselineVerdict(input: {
  readonly steps: readonly BaselineStep[];
  readonly privateTests: readonly PrivateTestOutcome[];
}): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  for (const step of input.steps)
    if (step.name !== "private-test" && !step.ok)
      reasons.push(
        step.timedOut
          ? `${step.name} timed out.`
          : `${step.name} exited with ${step.exitCode ?? "no code"}.`,
      );
  for (const outcome of input.privateTests)
    if (outcome.observed === "error")
      reasons.push(`${outcome.path} could not run.`);
    else if (!outcome.ok)
      reasons.push(
        `${outcome.path} was expected to ${outcome.expected} on the baseline and ${outcome.observed}ed.`,
      );
  return { ok: reasons.length === 0, reasons };
}

export interface BuildFileRecord {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly class: PathClass;
  /** Whether the file is part of the public project. */
  readonly public: boolean;
}

export interface SandboxBuildManifest {
  readonly schemaVersion: typeof SANDBOX_BUILD_SCHEMA_VERSION;
  readonly toolVersion: string;
  readonly sandboxVersionId: string;
  readonly sourceSnapshotId: string;
  readonly sourceCommitSha: string;
  readonly sliceRunId: string;
  readonly manifestSha256: string;
  readonly contractSha256: string;
  readonly transformConfigSha256: string;
  readonly approvedTaskSha256: string;
  readonly toolchain: Toolchain;
  readonly toolchainDigest: string;
  readonly evaluator: EvaluationEnvironment | null;
  readonly files: readonly BuildFileRecord[];
  readonly importRewrites: readonly ImportRewrite[];
  readonly renames: readonly { readonly from: string; readonly to: string }[];
  readonly dependencies: readonly ResolvedDependency[];
  /** Over every generated harness file: mocks, tests, config, descriptor. */
  readonly harnessSha256: string;
  readonly publicTestsSha256: string;
  readonly privateTestsSha256: string;
  /** Over every public file, the hash a published baseline must reproduce. */
  readonly publicProjectSha256: string;
  readonly baseline: BaselineReport | null;
  readonly blockers: readonly ProjectBlocker[];
  readonly ready: boolean;
}

/** The bounded view of a build the console renders. */
export interface BuildSummary {
  readonly schemaVersion: 1;
  readonly ready: boolean;
  readonly files: number;
  readonly publicFiles: number;
  readonly publicTests: number;
  readonly privateTests: number;
  readonly mocks: number;
  readonly importRewrites: number;
  readonly toolchainDigest: string;
  readonly harnessSha256: string;
  readonly evaluator: EvaluationEnvironment | null;
  readonly baseline: {
    readonly ok: boolean;
    readonly reasons: readonly string[];
    readonly steps: readonly { name: string; ok: boolean }[];
  } | null;
  readonly blockers: readonly ProjectBlocker[];
}

export function buildSummary(manifest: SandboxBuildManifest): BuildSummary {
  const count = (cls: PathClass) =>
    manifest.files.filter((file) => file.class === cls).length;
  return {
    schemaVersion: 1,
    ready: manifest.ready,
    files: manifest.files.length,
    publicFiles: manifest.files.filter((file) => file.public).length,
    publicTests: count("test-public"),
    privateTests: count("test-private"),
    mocks: count("mock"),
    importRewrites: manifest.importRewrites.length,
    toolchainDigest: manifest.toolchainDigest,
    harnessSha256: manifest.harnessSha256,
    evaluator: manifest.evaluator,
    baseline:
      manifest.baseline === null
        ? null
        : {
            ok: manifest.baseline.ok,
            reasons: manifest.baseline.reasons.slice(0, 20),
            steps: manifest.baseline.steps.map((step) => ({
              name:
                step.path === null ? step.name : `${step.name} ${step.path}`,
              ok: step.ok,
            })),
          },
    blockers: manifest.blockers.slice(0, 50),
  };
}
