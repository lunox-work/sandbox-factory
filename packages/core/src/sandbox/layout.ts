/**
 * Where a version keeps what a submission may not change, and how it is
 * graded: the grading layout. The platform's own projects keep their
 * harness under `sandbox/`, mock packages under `mocks/` and both suites
 * under `tests/` (`PLATFORM_LAYOUT`); a folder cut by carveout and
 * uploaded keeps its harness under `carveout/` and its tests beside the
 * code, and its build manifest records that layout (`layout`).
 *
 * The shape is carveout's `FolderLayout` (`carveout/api`), written here so
 * core keeps carveout's pure entry as its only dependency; the worker maps
 * a folder's layout into it. A manifest without one is the platform's
 * layout, so every version built before layouts grades as it did.
 */

import { PSEUDONYMS_FILE } from "./aliases.js";
import type { HiddenTestRun } from "./build.js";
import { TASK_DESCRIPTOR_PATH } from "./descriptor.js";
import {
  declarationPath,
  ENV_FILE,
  HARNESS_DIR,
  MOCKS_DIR,
  MOCK_RUNTIME_PATH,
  PRIVATE_TESTS_DIR,
  PUBLIC_TESTS_DIR,
  SANDBOX_RUN_ARGV,
  runtimePath,
} from "./project.js";

/** One command a grading job runs on the staged tree. */
export interface GradingCommand {
  readonly name: "install" | "build" | "public-tests";
  readonly argv: readonly string[];
}

/** How one test file runs on its own, with a TAP report on stdout. */
export interface LayoutTestRun {
  /** The command, before the file. */
  readonly argv: readonly string[];
  /** Whether the file is given as its emitted JavaScript rather than its source. */
  readonly emitted: boolean;
}

export interface GradingLayout {
  /** Generated code a submission never changes. */
  readonly harnessDir: string;
  /** The mock packages. */
  readonly mocksDir: string;
  /** The recording mock runtime, which task code never imports. */
  readonly mockRuntimePath: string;
  /** The fixture environment every run reads (`--env-file`). */
  readonly envFile: string;
  /** Top-level directories a submission never writes into. */
  readonly harnessRoots: readonly string[];
  /** Root files that configure the run, each with why a change to it is refused. */
  readonly configFiles: Readonly<Record<string, string>>;
  /** What a grading job runs, in order, before the hidden tests. */
  readonly commands: readonly GradingCommand[];
  readonly tests: {
    /** The public suite's directory; null when tests sit beside their code. */
    readonly publicDir: string | null;
    /** Where hidden tests are staged; null when each goes at its own path. */
    readonly privateDir: string | null;
    /** The public test files the version holds. */
    readonly files: readonly string[];
    /** One hidden test on its own, by the runner it imports. */
    readonly run: {
      readonly "node:test": LayoutTestRun;
      readonly vitest: LayoutTestRun | null;
    };
  };
}

/** The platform's own project: `sandbox/`, `mocks/`, `tests/{public,private}`. */
export const PLATFORM_LAYOUT: GradingLayout = {
  harnessDir: HARNESS_DIR,
  mocksDir: MOCKS_DIR,
  mockRuntimePath: MOCK_RUNTIME_PATH,
  envFile: ENV_FILE,
  harnessRoots: [
    HARNESS_DIR,
    MOCKS_DIR,
    PUBLIC_TESTS_DIR.split("/")[0] ?? "tests",
    PRIVATE_TESTS_DIR.split("/")[0] ?? "tests",
    "node_modules",
  ],
  configFiles: {
    "package.json":
      "package.json is the version's; scripts and dependencies are not the submission's to change.",
    "package-lock.json": "The lockfile is the version's.",
    ".npmrc": ".npmrc is the version's.",
    ".nvmrc": ".nvmrc is the version's.",
    ".gitignore": ".gitignore is the version's.",
    [ENV_FILE]: `${ENV_FILE} is the version's fixture environment.`,
    [TASK_DESCRIPTOR_PATH]: `${TASK_DESCRIPTOR_PATH} is the version's.`,
  },
  commands: [
    {
      name: "install",
      argv: ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"],
    },
    {
      name: "build",
      argv: ["node", "node_modules/typescript/bin/tsc", "-p", "tsconfig.json"],
    },
    { name: "public-tests", argv: SANDBOX_RUN_ARGV.test },
  ],
  tests: {
    publicDir: PUBLIC_TESTS_DIR,
    privateDir: PRIVATE_TESTS_DIR,
    files: [],
    run: {
      "node:test": {
        argv: [
          "node",
          `--env-file=${ENV_FILE}`,
          "--test",
          "--test-reporter=tap",
        ],
        emitted: true,
      },
      vitest: null,
    },
  },
};

/** A manifest's layout: its own, else the platform's. */
export function layoutOf(manifest: {
  readonly layout?: GradingLayout | undefined;
}): GradingLayout {
  return manifest.layout ?? PLATFORM_LAYOUT;
}

/**
 * The command that runs one test file on its own with a TAP report on
 * stdout, `path` as the version holds its source; null when the layout has
 * no way to run that runner's tests.
 */
export function layoutTestArgv(
  layout: GradingLayout,
  path: string,
  runner: "node:test" | "vitest" = "node:test",
): readonly string[] | null {
  const run = layout.tests.run[runner];
  return run === null
    ? null
    : [...run.argv, run.emitted ? runtimePath(path) : path];
}

/**
 * Every file a hidden test can leave in a built tree: its source, its
 * emitted JavaScript and declaration, and their source maps. A job
 * withholds them all (`EvaluationJob.seal`) before task code runs.
 */
export function hiddenTestFiles(path: string): string[] {
  const emitted = runtimePath(path);
  const declaration = declarationPath(path);
  return [
    ...new Set([
      path,
      `${path}.map`,
      emitted,
      `${emitted}.map`,
      declaration,
      `${declaration}.map`,
    ]),
  ];
}

/**
 * One hidden test run on its own (`layoutTestArgv`), with what the job
 * puts back for it: node:test's emitted ES module is loaded from memory by
 * the platform's runner; a file another runner reads itself (Vitest's
 * source, a CommonJS file) goes back on disk. Both layouts that exist
 * declare `"type": "module"`, so emitted `.js` is an ES module. Null when
 * the layout has no way to run that runner's tests.
 */
export function hiddenTestRun(
  layout: GradingLayout,
  path: string,
  runner: "node:test" | "vitest" = "node:test",
): { argv: readonly string[]; hidden: HiddenTestRun } | null {
  const run = layout.tests.run[runner];
  if (run === null) return null;
  const entry = run.emitted ? runtimePath(path) : path;
  return {
    argv: [...run.argv, entry],
    hidden: {
      entry,
      load: runner === "node:test" && /\.m?js$/.test(entry) ? "memory" : "disk",
    },
  };
}

/** The runner a test file imports: Vitest when it names it, else node:test. */
export function testRunnerOf(text: string): "node:test" | "vitest" {
  return /['"]vitest(?:\/[^'"]*)?['"]/.test(text) ? "vitest" : "node:test";
}

/** Where a hidden test kept at `private/<rel>` is staged in the tree. */
export function hiddenTestPath(layout: GradingLayout, rel: string): string {
  return layout.tests.privateDir === null
    ? rel
    : `${layout.tests.privateDir}/${rel}`;
}

/** The `private/` artifact path a staged hidden test is kept at. */
export function hiddenArtifactPath(
  layout: GradingLayout,
  path: string,
): string {
  const dir = layout.tests.privateDir;
  return `private/${dir !== null && path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : path}`;
}

/**
 * A hidden test by name: a TypeScript test file, as an upload's acceptance
 * tests are (`.test.ts`, `.spec.ts`, `.mts`, `.cts`, `.tsx`) and as the
 * platform writes its own (`.test.ts`).
 */
export const HIDDEN_TEST_FILE = /\.(?:test|spec)\.[cm]?tsx?$/;

/**
 * Where a build's artifact is staged as a hidden test (`hiddenTestPath`),
 * or null when it is not one: outside `private/`, the name table kept
 * beside the tests (`private/pseudonym.lunox`), or not a test file. The
 * judge stages exactly these, and the handout counts exactly these.
 */
export function stagedHiddenTest(
  layout: GradingLayout,
  artifactPath: string,
): string | null {
  if (
    !artifactPath.startsWith("private/") ||
    artifactPath === `private/${PSEUDONYMS_FILE}`
  )
    return null;
  const rel = artifactPath.slice("private/".length);
  return HIDDEN_TEST_FILE.test(rel) ? hiddenTestPath(layout, rel) : null;
}
