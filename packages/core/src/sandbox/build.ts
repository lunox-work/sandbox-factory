/**
 * The runnable package a version builds, and the evaluation it runs under.
 *
 * `build-manifest.json` binds the generated project to its inputs: the
 * slice manifest or the starter, the transform, the approved task, the toolchain and the
 * evaluator environment, with every file hashed and classified. The
 * evaluation-provider adapter is the seam between the worker and whichever
 * isolated runner executes checks; the worker ships a local process
 * provider for development and the test double, and a hosted provider is
 * qualified separately (Decision 5 of the sandbox plan). Nothing here
 * depends on a provider SDK.
 */

import {
  DISCLOSURE_FINDINGS_EVALUATED,
  DISCLOSURE_FINDINGS_RECORDED,
  type DisclosureFindingRecord,
} from "./disclosure.js";
import type { CarriedTestsRecord } from "./carried-tests.js";
import type { GradingLayout } from "./layout.js";
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

/**
 * One hidden test's run (`EvaluationCommand.hidden`). The provider runs it
 * in a fresh copy of the tree the job sealed (`EvaluationJob.seal`), into
 * which it puts back this test's `entry` alone, never another hidden
 * test: with `load: "memory"` as a file the platform's runner reads,
 * deletes and imports from memory under the entry's own URL before any
 * task code loads, and the argv word equal to `entry` names that runner
 * instead; with `load: "disk"` at its own path, for a runner that reads
 * the file itself (Vitest), which task code can then read too.
 */
export interface HiddenTestRun {
  /** The file the command runs, as the job held it before the seal. */
  readonly entry: string;
  readonly load: "memory" | "disk";
}

export interface EvaluationCommand {
  readonly argv: readonly string[];
  /** A hidden test's run: in a fresh copy of the sealed tree, with it alone. */
  readonly hidden?: HiddenTestRun;
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
  /**
   * Withholds `paths` (every hidden test's files, `hiddenTestFiles`) once
   * the build has run and before any task code does: each is kept by the
   * provider outside the job's reach and removed from the tree, and the
   * tree as it then stands is the copy every hidden run starts from, out
   * of reach of what the job runs later. Once per job; a hidden run before
   * it is refused.
   */
  seal(paths: readonly string[]): Promise<void>;
  destroy(): Promise<void>;
  /**
   * Whether the job's network egress was cut before any command but the
   * trusted lockfile preparation and install ran. Absent for a provider that
   * does not control egress, such as `local-process`.
   */
  egressCut?(): boolean;
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
  /** `EvaluationJob.egressCut` when the job ended; absent when it has none. */
  readonly egressCut?: boolean;
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
  /** How long it ran; absent from reports written before this was kept. */
  readonly durationMs?: number;
}

export interface PrivateTestOutcome {
  readonly path: string;
  readonly expected: "pass" | "fail";
  /**
   * `flaky` when two runs of the file disagreed on any test in it: like
   * `error`, a test that judges nothing.
   */
  readonly observed: "pass" | "fail" | "error" | "flaky";
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
 * tests must pass on the unfixed source, at least one hidden test must be
 * one that fails before the fix, and every hidden test must do what the
 * owner said it would, the same way twice. A build or harness failure is never accepted as "the
 * test that fails before the fix".
 */
export function baselineVerdict(input: {
  readonly steps: readonly BaselineStep[];
  readonly privateTests: readonly PrivateTestOutcome[];
  /**
   * What each declared hidden test is expected to do, run or not: a step
   * that fails first leaves `privateTests` empty without the version
   * lacking hidden tests. The outcomes' expectations when absent.
   */
  readonly declared?: readonly ("pass" | "fail")[];
}): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  for (const step of input.steps)
    if (step.name !== "private-test" && !step.ok)
      reasons.push(
        step.timedOut
          ? `${step.name} timed out.`
          : `${step.name} exited with ${step.exitCode ?? "no code"}.`,
      );
  // A submission is judged by the hidden tests that fail before the fix,
  // so a sandbox with none could never accept one (`submissionVerdict`).
  const declared =
    input.declared ?? input.privateTests.map((outcome) => outcome.expected);
  if (!declared.includes("fail"))
    reasons.push(
      declared.length === 0
        ? "No hidden test judges a submission."
        : "No hidden test is expected to fail before the fix.",
    );
  for (const outcome of input.privateTests)
    if (outcome.observed === "error")
      reasons.push(`${outcome.path} could not run.`);
    else if (outcome.observed === "flaky")
      reasons.push(`${outcome.path} gave different results on two runs.`);
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
  /** The slice's inputs; null for a generated version, which has none. */
  readonly sourceSnapshotId: string | null;
  readonly sourceCommitSha: string | null;
  readonly sliceRunId: string | null;
  readonly manifestSha256: string | null;
  readonly contractSha256: string | null;
  /**
   * A generated version's starter set, in place of the slice. Absent from
   * a sliced version's manifest, which reads as it did before starters.
   */
  readonly starterSha256?: string;
  readonly transformConfigSha256: string;
  readonly approvedTaskSha256: string;
  readonly toolchain: Toolchain;
  readonly toolchainDigest: string;
  /**
   * The engines the build ran on: the carveout release that renamed it,
   * checked its vocabulary and extracted its stubs. Absent from a build made
   * before carveout 0.3.0, whose names carry back under the platform's
   * renaming of then (`ALIASES_V1`); present, under the release's.
   */
  readonly engines?: { readonly carveout: string };
  /**
   * Where the version keeps its harness and tests, and the commands that
   * grade it (`layout.ts`). Absent: the platform's own layout, as every
   * build made before uploads.
   */
  readonly layout?: GradingLayout;
  /**
   * A version uploaded as a carveout hand-off folder: the hash of its
   * `carveout.json` and the carveout release that cut it. Absent otherwise.
   */
  readonly upload?: {
    readonly recordSha256: string;
    readonly carveoutVersion: string;
  };
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
  /**
   * The publication gates the build ran (`freezeReadiness`). Absent from a
   * build made before them: such a draft is built again before it is
   * published, and a version already published stands on its first
   * publication (`gatesOf`).
   */
  readonly gates?: PublicationGates;
  /**
   * The hidden suite's commitment, as the handout publishes it, fixed when
   * the build wrote the suite. Absent from a build made before it, whose
   * handout keeps the hash it always showed (version 1).
   */
  readonly hiddenCommitment?: HiddenCommitment;
  /**
   * The repository's tests the build carried and dropped, with why, when
   * its slice asked for them (`carried-tests.ts`). Owners' only. Absent
   * otherwise: no test was carried.
   */
  readonly carriedTests?: CarriedTestsRecord;
}

/**
 * The version of the handout's `hiddenSha256` a build records. Version 1,
 * computed by the API for a build that recorded none, is duediligence's
 * `hiddenSha256` over every file under `private/` keyed
 * `tests/private/<rel>`, the name table and an upload's folder paths
 * included. Version 2 is the same manifest (`<sha256>  <path>` lines in
 * byte order, then `calibration.kept`, the sorted paths' JSON) over the
 * hidden tests alone (`stagedHiddenTest`), each at the path the judge
 * stages it at: `tests/private/<rel>` in the platform's layout, which is
 * exactly duediligence's hash, and the folder path in an upload's.
 */
export const HIDDEN_COMMITMENT_VERSION = 2;

export interface HiddenCommitment {
  readonly version: typeof HIDDEN_COMMITMENT_VERSION;
  /** How many hidden tests it covers. */
  readonly hiddenTests: number;
  /** Null for a build with no hidden test. */
  readonly hiddenSha256: string | null;
}

/**
 * What a build proves of the two gates a version is published on. A
 * failed round trip leaves the build ready, its baseline being sound, but
 * holds publication: contributors' work on it could not be merged back.
 */
export interface PublicationGates {
  /**
   * The unchanged project carried back to the repository's names
   * (`noChangeRoundTrip`); `not_applicable` for a version with no
   * repository (generated, or uploaded), which has nothing to carry to.
   */
  readonly roundTrip: {
    readonly status: "passed" | "failed" | "not_applicable";
    readonly files: number;
    readonly problems: readonly {
      readonly path: string;
      readonly reason: string;
    }[];
  };
  /**
   * The disclosure scan over every public file: the workspace's names
   * (`publicVocabularyLeaks`), credentials (`scanSecrets`) and the text
   * beyond the vocabulary that says whose code it is (`scanDisclosure`:
   * addresses, hosts, copyright and author lines, ticket keys, chat links,
   * `TODO(name)`): in a sliced build since `sandbox_build@13`, a starter
   * since `sandbox_starter@6` and an upload since `sandbox_import@2`. An
   * uploaded folder's names and credentials are scanned by the upload
   * route before it is stored.
   */
  readonly disclosure: {
    /**
     * `pending_acknowledgement`: names and credentials clean, and findings
     * beyond them that publication checks against the draft's
     * acknowledgements (`acknowledgedAt: "publish"`); not a blocker, so
     * the build stays ready.
     */
    readonly status: "passed" | "failed" | "pending_acknowledgement";
    readonly scannedBy: "build" | "upload";
    /** Workspace names checked; 0 when the upload route scanned. */
    readonly names: number;
    /**
     * Blocking findings: workspace names and credentials in public files,
     * and, where the build read the acknowledgements, the `scanDisclosure`
     * findings no owner acknowledged.
     */
    readonly blocking: number;
    /**
     * Where the `scanDisclosure` findings are acknowledged. `build` (or
     * absent): a sliced build read the draft's acknowledgements, which are
     * part of its transform, and blocked on the rest. `publish`: an
     * uploaded or generated version's build read none, so its files never
     * depend on them, and publication checks the draft's list against
     * `findings` (`openDisclosureFindings`) with no build again.
     */
    readonly acknowledgedAt?: "build" | "publish";
    /**
     * The `scanDisclosure` findings, acknowledged or not: the first
     * `DISCLOSURE_FINDINGS_RECORDED`, or, acknowledged at publication,
     * the first `DISCLOSURE_FINDINGS_EVALUATED`; absent from a build made
     * before them.
     */
    readonly findings?: readonly DisclosureFindingRecord[];
    /** How many findings there were in all, and how many acknowledged. */
    readonly total?: number;
    readonly acknowledged?: number;
  };
}

/**
 * The disclosure gate, from a build's blockers and the names it checked,
 * and, from a build that ran `scanDisclosure`, its findings marked
 * acknowledged or not (`disclosureRecords`) with their full count. A scan
 * acknowledged at publication (`acknowledgedAt: "publish"`) blocks on
 * nothing here: its findings, all of them recorded, leave the gate
 * `pending_acknowledgement` for publication to settle.
 */
export function disclosureGate(
  blockers: readonly ProjectBlocker[],
  names: number,
  scannedBy: "build" | "upload" = "build",
  scan?: {
    readonly findings: readonly DisclosureFindingRecord[];
    readonly total: number;
    readonly unacknowledged: number;
    readonly acknowledgedAt?: "build" | "publish";
  },
): PublicationGates["disclosure"] {
  const atPublish = scan?.acknowledgedAt === "publish";
  const scans = blockers.filter(
    (blocker) =>
      blocker.code === "vocabulary_leaked" || blocker.code === "secret_found",
  ).length;
  const blocking = scans + (atPublish ? 0 : (scan?.unacknowledged ?? 0));
  return {
    status:
      blocking > 0
        ? "failed"
        : atPublish && (scan?.total ?? 0) > 0
          ? "pending_acknowledgement"
          : "passed",
    scannedBy,
    names,
    blocking,
    ...(scan === undefined
      ? {}
      : {
          ...(atPublish ? { acknowledgedAt: "publish" as const } : {}),
          findings: scan.findings.slice(
            0,
            atPublish
              ? DISCLOSURE_FINDINGS_EVALUATED
              : DISCLOSURE_FINDINGS_RECORDED,
          ),
          total: scan.total,
          acknowledged: atPublish ? 0 : scan.total - scan.unacknowledged,
        }),
  };
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
  /**
   * The disclosure gate as the build recorded it, its findings for an
   * owner to rename or acknowledge; absent from a build made before gates.
   */
  readonly disclosure?: PublicationGates["disclosure"];
  /** How many of the repository's tests were carried and dropped; absent when none were asked for. */
  readonly carriedTests?: { readonly kept: number; readonly dropped: number };
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
    ...(manifest.gates === undefined
      ? {}
      : { disclosure: manifest.gates.disclosure }),
    ...(manifest.carriedTests === undefined
      ? {}
      : {
          carriedTests: {
            kept: manifest.carriedTests.kept.length,
            dropped: manifest.carriedTests.dropped.length,
          },
        }),
  };
}
