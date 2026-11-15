/**
 * The project generation step of `sandbox_build`, on one of two engines:
 * `platform` (the default), core's own `generateProject`, or `carveout`,
 * carveout's `generateProject` (`carveout/api`) with the platform's layers
 * put over its output. The carveout engine is a measured step toward one
 * generator (audit E2): off unless the adapter is created with it, and
 * recorded in the build manifest (`engines.projectGenerator`) when on, so
 * a version built either way grades and rebuilds as it was built.
 *
 * What the carveout engine writes, from the same aliased input:
 *
 * - carveout's harness: `carveout/` (mock runtime, ambient declarations,
 *   asset loader, walkthrough, test runner, interface test under
 *   `carveout/tests/`), mock packages under `carveout/packages/`,
 *   placeholder environment in `carveout.env`, and carveout's
 *   configuration (`package.json` scripts run `node carveout/test.js`,
 *   which finds every test in the folder and runs each on its runner).
 * - What carveout writes from the platform's input through its hooks
 *   (`carveoutInputOf`, carveout ≥ 0.5.0): fixture defaults in the stubs'
 *   runtimes, the walkthrough a version supplies, source maps (and their
 *   output ignored), the package's version and npm pin.
 * - The platform's layers, which carveout's generator has no input for
 *   (`platformLayers`): public names for mocked packages and environment
 *   variables, applied to the input before carveout reads it
 *   (`withPublicNames`); `tests/public/spec.test.ts`, the carried tests
 *   under `tests/public/carried/` and the hidden tests under
 *   `tests/private/`; the contributor guide (`TASK.md`, `AGENTS.md`,
 *   `CLAUDE.md`, `.vscode/`), the descriptor and the platform's README in
 *   carveout's paths.
 * - The grading layout (`carveoutLayout`): carveout's `folderLayout` for
 *   the harness, its configuration and its commands, with the platform's
 *   test folders (`tests/public`, `tests/private`) so hidden tests stage
 *   and seal as the platform's do, and `tests/` among the roots a
 *   submission never writes into.
 *
 * The build runs a carveout project's walkthrough, public suite and single
 * tests with carveout's commands (`ProjectRun`); grading and the reversed
 * check read the recorded layout. Everything here is pure.
 */

import {
  AMBIENT_PATH as CARVEOUT_AMBIENT_PATH,
  ENV_FILE as CARVEOUT_ENV_FILE,
  HARNESS_DIR as CARVEOUT_HARNESS_DIR,
  MOCKS_DIR as CARVEOUT_MOCKS_DIR,
  MOCK_RUNTIME_PATH as CARVEOUT_MOCK_RUNTIME_PATH,
  RUN_PATH as CARVEOUT_RUN_PATH,
  SANDBOX_RUN_ARGV as CARVEOUT_RUN_ARGV,
  folderLayout,
  generateProject as carveoutGenerateProject,
} from "carveout/api";
import type {
  GeneratedProject as CarveoutGeneratedProject,
  ProjectInput as CarveoutProjectInput,
} from "carveout/api";
import {
  CARRIED_TESTS_DIR,
  CARRIED_TEST_FILE,
  HARNESS_DIR,
  PLATFORM_LAYOUT,
  PRIVATE_TESTS_DIR,
  PUBLIC_TESTS_DIR,
  SANDBOX_COMMANDS,
  SANDBOX_RUN_ARGV,
  SANDBOX_TOOLCHAIN,
  TASK_DESCRIPTOR_PATH,
  TASK_DESCRIPTOR_SCHEMA_VERSION,
  contributorGuideFiles,
  fixtureMockPath,
  fixtureProblems,
  generateProject,
  hiddenTestRun,
  isScript,
  packageNameOf,
  privateTestArgv,
  projectReadme,
  renameEnvironmentReads,
  replaceScriptImports,
  runtimePath,
  scanSecrets,
  scenarioProblems,
  secretBlockers,
  specTests,
  unresolvedScenarioImports,
} from "sandbox-factory";
import type {
  GeneratedFile,
  GradingLayout,
  GuidePaths,
  HiddenTestRun,
  ImportRewrite,
  ProjectBlocker,
  ProjectInput,
  TaskDescriptor,
} from "sandbox-factory";
import { gradingLayoutOf } from "./folder-layout.js";

/** Which generator writes a build's project. */
export type ProjectGenerator = "platform" | "carveout";

/** How the build runs a project an engine wrote, once it is built. */
export interface ProjectRun {
  /** The walkthrough, `npm run dev` without its build. */
  readonly dev: readonly string[];
  /** The public suite, `npm test` without its build. */
  readonly publicTests: readonly string[];
  /** One test file on its own with a TAP report (hidden and carried tests). */
  readonly oneTest: (path: string) => {
    readonly argv: readonly string[];
    readonly hidden: HiddenTestRun;
  };
}

/** The platform's own project's commands, as the build has always run them. */
export const PLATFORM_RUN: ProjectRun = {
  dev: SANDBOX_RUN_ARGV.dev,
  publicTests: SANDBOX_RUN_ARGV.test,
  oneTest: (path) => ({
    argv: privateTestArgv(path),
    hidden: { entry: runtimePath(path), load: "memory" },
  }),
};

/** What an engine made of a project input. */
export interface EngineProject {
  readonly files: GeneratedFile[];
  readonly blockers: ProjectBlocker[];
  readonly importRewrites: readonly ImportRewrite[];
  /** The grading layout to record; undefined for the platform's own. */
  readonly layout: GradingLayout | undefined;
}

/** Where a carveout project keeps what the platform's guide names. */
export const CARVEOUT_GUIDE_PATHS: GuidePaths = {
  harnessDir: CARVEOUT_HARNESS_DIR,
  mocksDir: CARVEOUT_MOCKS_DIR,
  publicTestsDir: PUBLIC_TESTS_DIR,
  envFile: CARVEOUT_ENV_FILE,
  runPath: CARVEOUT_RUN_PATH,
  mockRuntimePath: CARVEOUT_MOCK_RUNTIME_PATH,
  ambientPath: CARVEOUT_AMBIENT_PATH,
};

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The grading layout of a carveout project: carveout's `folderLayout` of
 * a folder that generated `generated` and keeps a lockfile, with the
 * platform's test folders.
 */
export function carveoutLayout(
  generated: readonly string[],
  publicTests: readonly string[],
): GradingLayout {
  // `folderLayout` reads only the record's generated paths, whether it
  // keeps a lockfile and its carried tests.
  const record = {
    generated: generated.map((path) => ({ path })),
    lockfile: true,
    tests: { carried: [] },
  } as unknown as Parameters<typeof folderLayout>[0];
  const base = gradingLayoutOf(folderLayout(record));
  const testsRoot = PUBLIC_TESTS_DIR.split("/")[0] ?? "tests";
  // A refusal says why in the platform's words where it has them; the
  // record of a cut (`carveout.json`) is a hand-off folder's, not here.
  const configFiles: Record<string, string> = {};
  for (const [path, reason] of Object.entries(base.configFiles))
    if (path !== "carveout.json")
      configFiles[path] =
        path === CARVEOUT_ENV_FILE
          ? `${CARVEOUT_ENV_FILE} is the version's fixture environment.`
          : (PLATFORM_LAYOUT.configFiles[path] ?? reason);
  return {
    ...base,
    configFiles,
    harnessRoots: [
      ...new Set([
        ...base.harnessRoots.filter((root) => root !== "node_modules"),
        testsRoot,
        "node_modules",
      ]),
    ],
    tests: {
      ...base.tests,
      publicDir: PUBLIC_TESTS_DIR,
      privateDir: PRIVATE_TESTS_DIR,
      files: [...publicTests].sort(compare),
    },
  };
}

/**
 * How the build runs a carveout project: carveout's walkthrough argv, its
 * runner for the public suite and its layout's single-test command
 * (`--import` of the asset loader, TAP to stdout), the hidden runner's
 * memory load as on the platform's layout.
 */
export const CARVEOUT_RUN: ProjectRun = (() => {
  const layout = carveoutLayout([], []);
  const publicTests = layout.commands.find(
    (command) => command.name === "public-tests",
  );
  return {
    dev: CARVEOUT_RUN_ARGV.dev,
    publicTests: publicTests?.argv ?? ["node", "carveout/test.js"],
    oneTest: (path: string) => {
      const run = hiddenTestRun(layout, path);
      return run ?? PLATFORM_RUN.oneTest(path);
    },
  };
})();

/** The run commands of an engine's projects. */
export function projectRunOf(engine: ProjectGenerator): ProjectRun {
  return engine === "carveout" ? CARVEOUT_RUN : PLATFORM_RUN;
}

/** Generates a build's project on `engine`. */
export function generateOnEngine(
  engine: ProjectGenerator,
  input: ProjectInput,
): EngineProject {
  if (engine === "carveout") return carveoutProject(input);
  const project = generateProject(input);
  return {
    files: [...project.files],
    blockers: [...project.blockers],
    importRewrites: project.importRewrites,
    layout: undefined,
  };
}

/** The carveout engine: carveout's project with the platform's layers. */
export function carveoutProject(input: ProjectInput): EngineProject {
  const named = withPublicNames(input);
  return platformLayers(carveoutGenerateProject(carveoutInputOf(named)), named);
}

/**
 * The input with the version's public names applied where carveout's
 * generator would otherwise write private ones: each mocked package the
 * table renamed takes its public name in the dependencies and in the
 * sources' imports, and each environment variable in the manifest's
 * externals, the sources' `process.env` reads and the walkthrough. What
 * the platform's generator does inside itself, done before carveout reads
 * the input, so carveout's mock packages and `carveout.env` carry public
 * names only. `publicNames` is spent: the result has none.
 */
export function withPublicNames(input: ProjectInput): ProjectInput {
  const publicPackage = new Map<string, string>();
  for (const dependency of input.dependencies) {
    const to = input.publicNames?.packages?.[dependency.name];
    if (
      dependency.kind === "package" &&
      dependency.resolution === "runtime-mock" &&
      to !== undefined &&
      to !== dependency.name
    )
      publicPackage.set(dependency.name, to);
  }
  const publicEnvironment = new Map(
    Object.entries(input.publicNames?.environment ?? {}).filter(
      ([from, to]) => from !== to,
    ),
  );
  const { publicNames: _spent, ...rest } = input;
  if (publicPackage.size === 0 && publicEnvironment.size === 0) return rest;
  const renameImport = (specifier: string) => {
    if (specifier.startsWith(".") || specifier.startsWith("/"))
      return specifier;
    const name = packageNameOf(specifier);
    const to = publicPackage.get(name);
    return to === undefined
      ? specifier
      : `${to}${specifier.slice(name.length)}`;
  };
  return {
    ...rest,
    sources: input.sources.map((source) =>
      isScript(source.path)
        ? {
            ...source,
            text: renameEnvironmentReads(
              replaceScriptImports(source.text, (_index, specifier) =>
                renameImport(specifier),
              ),
              publicEnvironment,
            ),
          }
        : source,
    ),
    dependencies: input.dependencies.map((dependency) => {
      const to = publicPackage.get(dependency.name);
      return to === undefined ? dependency : { ...dependency, name: to };
    }),
    manifest: {
      ...input.manifest,
      externals: {
        ...input.manifest.externals,
        environment: input.manifest.externals.environment.map((item) => ({
          ...item,
          name: publicEnvironment.get(item.name) ?? item.name,
        })),
      },
    },
    ...(input.scenario === undefined || input.scenario === null
      ? {}
      : {
          scenario: renameEnvironmentReads(input.scenario, publicEnvironment),
        }),
  };
}

/** The package name a version's project goes by, as the platform names it. */
export function projectPackageName(versionId: string): string {
  return `sandbox-task-${versionId.replace(/[^a-z0-9]/gi, "-").toLowerCase()}`;
}

/**
 * What carveout's generator reads of the platform's input. The slice's
 * manifest, contract and dependencies are carveout's own shapes (the
 * platform's slice is carveout's analysis), declared twice: once in core,
 * once in carveout. The hooks carry what the platform's generator writes
 * that carveout's would not on its own.
 */
export function carveoutInputOf(input: ProjectInput): CarveoutProjectInput {
  const toolchain = input.toolchain ?? SANDBOX_TOOLCHAIN;
  const scenario = input.scenario ?? null;
  return {
    origin: {
      repository: null,
      name: projectPackageName(input.version.versionId),
    },
    manifest: input.manifest as unknown as CarveoutProjectInput["manifest"],
    contract: input.contract as unknown as CarveoutProjectInput["contract"],
    sources: input.sources,
    stubs: input.stubs,
    dependencies: input.dependencies,
    knownSpecifiers: input.knownSpecifiers,
    ...(input.compilerOptions === undefined
      ? {}
      : { compilerOptions: input.compilerOptions }),
    ...(input.packageModules === undefined
      ? {}
      : { packageModules: input.packageModules }),
    ...(input.toolchain === undefined
      ? {}
      : {
          toolchain: input.toolchain as unknown as NonNullable<
            CarveoutProjectInput["toolchain"]
          >,
        }),
    hooks: {
      sourceMaps: true,
      mockDefaults: (input.fixtures ?? []).map((item) => ({
        module: item.module,
        path: fixtureMockPath(item),
        implementation: item.implementation,
      })),
      ...(scenario === null ? {} : { walkthrough: scenario }),
      packageVersion: `${input.version.version}.0.0`,
      packageManager: `npm@${toolchain.npm}`,
    },
  };
}

/** A carveout blocker as the platform records it. */
function platformBlocker(
  blocker: CarveoutGeneratedProject["blockers"][number],
): ProjectBlocker {
  return blocker.code === "test_runner_mocked"
    ? {
        code: "mock_unsupported",
        file: blocker.file,
        detail: `${blocker.code}: ${blocker.detail}`,
      }
    : { code: blocker.code, file: blocker.file, detail: blocker.detail };
}

/**
 * carveout's generated project with what the platform adds over it (see
 * the module comment), from the input `withPublicNames` gave. Blockers
 * are the platform's codes; the layout is `carveoutLayout`.
 */
export function platformLayers(
  raw: CarveoutGeneratedProject,
  input: ProjectInput,
): EngineProject {
  const toolchain = input.toolchain ?? SANDBOX_TOOLCHAIN;
  const blockers: ProjectBlocker[] = raw.blockers.map(platformBlocker);
  const files = new Map<string, GeneratedFile>(
    raw.files.map((file) => [file.path, { ...file }]),
  );
  const added: GeneratedFile[] = [];
  const add = (file: GeneratedFile) => {
    if (files.has(file.path))
      blockers.push({
        code: "path_conflict",
        file: file.path,
        detail: `${file.path} is produced twice.`,
      });
    else {
      files.set(file.path, file);
      added.push(file);
    }
  };
  const rewrite = (path: string, change: (text: string) => string) => {
    const file = files.get(path);
    if (file !== undefined)
      files.set(path, { ...file, text: change(file.text) });
  };
  const pathOf = new Map<string, string>([
    ...input.sources.map(
      (source) => [source.originalPath, source.path] as const,
    ),
    ...input.stubs.map((stub) => [stub.module, stub.path] as const),
  ]);

  // Fixture defaults: carveout writes them into the stubs' runtimes
  // (`mockDefaults`); the platform checks them.
  const fixtures = input.fixtures ?? [];
  for (const problem of fixtureProblems(fixtures, input.contract.outbound)) {
    const item =
      problem.fixture === null ? undefined : fixtures[problem.fixture];
    blockers.push({
      code: "fixture_invalid",
      file: item === undefined ? null : item.module,
      detail: problem.detail,
    });
  }

  // The version's walkthrough, written by carveout in place of its own
  // (`walkthrough`), its imports resolved from carveout's harness folder as
  // from the platform's.
  const scenario = input.scenario ?? null;
  if (scenario !== null) {
    for (const problem of scenarioProblems(scenario))
      blockers.push({
        code: "fixture_invalid",
        file: CARVEOUT_RUN_PATH,
        detail: problem.detail,
      });
    for (const specifier of unresolvedScenarioImports(scenario, (path) =>
      files.has(
        path.startsWith(`${HARNESS_DIR}/`)
          ? `${CARVEOUT_HARNESS_DIR}/${path.slice(HARNESS_DIR.length + 1)}`
          : path,
      ),
    ))
      blockers.push({
        code: "import_unrewritable",
        file: CARVEOUT_RUN_PATH,
        detail: `${specifier} does not resolve to a file in the project.`,
      });
  }

  // Tests: carveout's (its interface test), the spec's todos, the carried
  // tests, then the hidden tests, private.
  const publicTests = [...raw.tests];
  const specTest = `${PUBLIC_TESTS_DIR}/spec.test.ts`;
  add({
    path: specTest,
    text: specTests(input.spec),
    class: "test-public",
    public: true,
  });
  publicTests.push(specTest);
  for (const test of [...(input.carriedTests ?? [])].sort((a, b) =>
    compare(a.path, b.path),
  )) {
    if (
      !test.path.startsWith(`${CARRIED_TESTS_DIR}/`) ||
      !CARRIED_TEST_FILE.test(test.path) ||
      test.path.split("/").some((part) => part === "" || part === "..")
    ) {
      blockers.push({
        code: "test_path_invalid",
        file: test.path,
        detail: `Carried tests live under ${CARRIED_TESTS_DIR}/ and end in .test.ts or .test.tsx.`,
      });
      continue;
    }
    publicTests.push(test.path);
    add({
      path: test.path,
      text: test.text,
      class: "test-public",
      public: true,
    });
  }
  for (const test of input.acceptanceTests) {
    if (
      !test.path.startsWith(`${PRIVATE_TESTS_DIR}/`) ||
      !test.path.endsWith(".test.ts") ||
      test.path.split("/").some((part) => part === "" || part === "..")
    ) {
      blockers.push({
        code: "test_path_invalid",
        file: test.path,
        detail: `Hidden tests live under ${PRIVATE_TESTS_DIR}/ and end in .test.ts.`,
      });
      continue;
    }
    add({
      path: test.path,
      text: test.text,
      class: "test-private",
      public: false,
    });
  }

  // The contributor's guide, descriptor and README, in carveout's paths.
  const editable = input.sources.map((source) => source.path).sort(compare);
  for (const file of contributorGuideFiles({
    version: input.version,
    spec: input.spec,
    ...(input.decisions === undefined ? {} : { decisions: input.decisions }),
    editable,
    publicTests,
    mocks: true,
    jsx: input.sources.some((source) => source.path.endsWith(".tsx")),
    paths: CARVEOUT_GUIDE_PATHS,
  }))
    add(file);
  const descriptor: TaskDescriptor = {
    schemaVersion: TASK_DESCRIPTOR_SCHEMA_VERSION,
    sandboxId: input.version.sandboxId,
    versionId: input.version.versionId,
    version: input.version.version,
    title: input.version.title,
    specSummary: input.version.specSummary,
    complexity: input.version.complexity,
    tags: input.version.tags,
    commands: SANDBOX_COMMANDS,
    toolchain,
    editablePaths: editable,
    publicTests,
    testSummary: [
      { label: "public", count: publicTests.length },
      {
        label: "scenarios",
        count: input.spec === null ? 0 : input.spec.scenarios.length,
      },
    ],
  };
  add({
    path: TASK_DESCRIPTOR_PATH,
    text: `${JSON.stringify(descriptor, null, 2)}\n`,
    class: "descriptor",
    public: true,
  });
  const packages = input.dependencies
    .filter((dependency) => dependency.kind === "package")
    .sort((a, b) => compare(a.name, b.name));
  rewrite("README.md", () =>
    projectReadme(
      {
        version: input.version,
        toolchain,
        editable,
        mockedModules: input.contract.outbound
          .flatMap((module) => {
            const path = pathOf.get(module.module);
            return path === undefined ? [] : [path];
          })
          .sort(compare),
        mockedPackages: packages
          .filter((dependency) => dependency.resolution === "runtime-mock")
          .map((dependency) => dependency.name),
        approvedPackages: packages.flatMap((dependency) =>
          dependency.resolution === "approved-package" &&
          dependency.version !== null
            ? [{ name: dependency.name, version: dependency.version }]
            : [],
        ),
        environment: input.manifest.externals.environment.map(
          (item) => item.name,
        ),
        rewrites: raw.importRewrites,
        publicTests,
        fixtures: fixtures.length,
        walkthrough: scenario !== null,
      },
      CARVEOUT_GUIDE_PATHS,
    ),
  );
  // carveout scanned what it wrote; what the platform added is scanned too.
  blockers.push(
    ...secretBlockers(scanSecrets(added.filter((file) => file.public))),
  );
  const all = [...files.values()].sort((a, b) => compare(a.path, b.path));
  return {
    files: all,
    blockers,
    importRewrites: raw.importRewrites,
    layout: carveoutLayout(
      all.filter((file) => file.class !== "source").map((file) => file.path),
      publicTests,
    ),
  };
}
