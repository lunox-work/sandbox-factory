/**
 * A starter: what a sandbox version is made of when its bounty has no
 * repository to slice.
 *
 * An agent writes it from the bounty's title, description and tech stack:
 * the source a contributor starts from under `src/`, public tests that
 * pass on it, hidden tests that say what the bounty asks and fail until it
 * is done, the packages it installs and the walkthrough `npm run dev` runs.
 * This module says what such an answer may contain and turns one into the
 * same kind of project a slice becomes: the same toolchain, commands,
 * harness layout, descriptor and baseline, with nothing cut and nothing
 * mocked. It leaves the workspace the way a slice does, too: the agent
 * writes in the bounty's own vocabulary and names the table that renames
 * it, and the project is generated from the renamed starter, so a
 * generated version has a name table like a sliced one.
 *
 * Like the slice generator, it is a pure function of its inputs: the same
 * starter gives the same files in the same order.
 */

import type { AgentUsage } from "../analysis.js";
import type { SpecDraft } from "../pricing/spec.js";
import { stackTechnology } from "../stack.js";
import {
  applyAliases,
  validateAliasRules,
  type AliasKind,
  type AliasRule,
} from "./aliases.js";
import type { ApprovedTaskSnapshot } from "./approved-task.js";
import {
  SANDBOX_COMMANDS,
  SANDBOX_TOOLCHAIN,
  type Toolchain,
} from "./build.js";
import {
  TASK_DESCRIPTOR_PATH,
  TASK_DESCRIPTOR_SCHEMA_VERSION,
  type TaskDescriptor,
} from "./descriptor.js";
import {
  AMBIENT_PATH,
  ENV_FILE,
  PRIVATE_TESTS_DIR,
  PUBLIC_TESTS_DIR,
  RUN_PATH,
  ambientDeclarations,
  isScript,
  runtimePath,
  specTests,
  tsconfigFor,
  unresolvedScenarioImports,
  type GeneratedFile,
  type GeneratedProject,
  type ProjectBlocker,
  type ProjectVersion,
} from "./project.js";
import type {
  AcceptanceTest,
  ResolvedDependency,
  ScopeRecord,
} from "./provenance.js";

/** 2 adds the name table. */
export const STARTER_SET_SCHEMA_VERSION = 2;
/** Where a starter's own source lives; everything else is harness. */
export const STARTER_SOURCE_DIR = "src";
export const STARTER_LIMITS = {
  files: 60,
  publicTests: 20,
  hiddenTests: 20,
  packages: 25,
  fileChars: 64 * 1024,
  /** Every file, test and the walkthrough together. */
  totalChars: 512 * 1024,
  scenarioChars: 20_000,
  summaryChars: 2_000,
  aliases: 50,
} as const;
/**
 * What a starter's name table renames: names and words, never paths. A
 * starter's files import each other by relative path, which a path rule
 * would leave pointing at the old name.
 */
export const STARTER_ALIAS_KINDS = [
  "identifier",
  "text",
] as const satisfies readonly AliasKind[];
/** What a source file may be: TypeScript the project compiles, or an asset it reads. */
export const STARTER_SOURCE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".json",
  ".css",
  ".html",
  ".md",
  ".txt",
  ".sql",
  ".csv",
  ".yaml",
  ".yml",
  ".graphql",
] as const;
/** The public test the spec's scenarios become, which a starter cannot replace. */
export const SPEC_TEST_PATH = `${PUBLIC_TESTS_DIR}/spec.test.ts`;

export interface StarterFile {
  /** Relative to the project root. */
  readonly path: string;
  readonly text: string;
}
export interface StarterPackage {
  readonly name: string;
  /** An exact version: the lockfile is resolved from it. */
  readonly version: string;
}
/** What the agent answers with. */
export interface StarterSubmission {
  /** The source a contributor starts from, under `src/`. */
  readonly files: readonly StarterFile[];
  /** Under `tests/public/`; they must pass on the starter. */
  readonly publicTests: readonly StarterFile[];
  /** Under `tests/private/`; at least one must fail until the bounty is done. */
  readonly hiddenTests: readonly AcceptanceTest[];
  readonly packages: readonly StarterPackage[];
  /** TypeScript for `sandbox/run.ts`, which `npm run dev` runs. */
  readonly scenario: string;
  /** What the starter holds and what is left to do, in a few sentences. */
  readonly summary: string;
  /**
   * The name table: each name the starter takes from the bounty's own
   * vocabulary, and the neutral one contributors read instead. Applied in
   * order to everything above before the project is generated.
   */
  readonly aliases: readonly AliasRule[];
}
/** `starter-set.json`: the accepted answer, and what it was written for. */
export interface StarterSet extends StarterSubmission {
  readonly schemaVersion: typeof STARTER_SET_SCHEMA_VERSION;
  readonly toolVersion: string;
  readonly sandboxVersionId: string;
  readonly approvedTaskSha256: string;
  readonly stack: readonly string[];
  readonly usage: AgentUsage;
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const PACKAGE_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const EXACT_VERSION =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
/** The toolchain installs these; a starter does not choose them. */
const TOOLCHAIN_PACKAGES = new Set(["typescript"]);

/** A relative path with no empty, `.` or `..` segment and no backslash. */
function isPlainPath(path: string): boolean {
  return (
    path !== "" &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    path
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}

/**
 * Why a starter cannot be built as it stands, one line each; empty when it
 * can. The checks are the ones a person reviewing it would make first:
 * where each file lives, what it may be called, how much there is, and
 * whether the hidden tests can tell a finished bounty from the starter.
 */
export function starterProblems(starter: StarterSubmission): string[] {
  return [
    ...starterFileProblems(starter),
    ...nameTableProblems(starter.aliases),
  ];
}

/** The name table's problems: present, within bounds, and well formed. */
export function nameTableProblems(aliases: readonly AliasRule[]): string[] {
  const problems: string[] = [];
  if (aliases.length === 0)
    problems.push(
      "A starter needs a name table: at least one name from the bounty's own vocabulary, and the neutral name contributors read instead.",
    );
  if (aliases.length > STARTER_LIMITS.aliases)
    problems.push(`At most ${STARTER_LIMITS.aliases} names in the table.`);
  aliases.forEach((rule, index) => {
    if (!(STARTER_ALIAS_KINDS as readonly AliasKind[]).includes(rule.kind))
      problems.push(
        `Name ${index + 1} (${rule.before}): a starter renames ${STARTER_ALIAS_KINDS.join(" and ")} names, not ${rule.kind}s.`,
      );
  });
  for (const problem of validateAliasRules(aliases).problems)
    problems.push(
      `${problem.rule === null ? "Name table" : `Name ${problem.rule + 1}`}: ${problem.detail}`,
    );
  return problems;
}

/** Everything but the name table, which a renamed starter has already used. */
function starterFileProblems(
  starter: Omit<StarterSubmission, "aliases">,
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const unique = (path: string) => {
    if (seen.has(path)) problems.push(`${path} is given twice.`);
    seen.add(path);
  };
  if (starter.files.length === 0)
    problems.push(
      `A starter needs at least one source file under ${STARTER_SOURCE_DIR}/.`,
    );
  if (starter.files.length > STARTER_LIMITS.files)
    problems.push(`At most ${STARTER_LIMITS.files} source files.`);
  if (starter.publicTests.length > STARTER_LIMITS.publicTests)
    problems.push(`At most ${STARTER_LIMITS.publicTests} public tests.`);
  if (starter.hiddenTests.length > STARTER_LIMITS.hiddenTests)
    problems.push(`At most ${STARTER_LIMITS.hiddenTests} hidden tests.`);
  if (starter.packages.length > STARTER_LIMITS.packages)
    problems.push(`At most ${STARTER_LIMITS.packages} packages.`);
  for (const file of starter.files) {
    unique(file.path);
    if (
      !isPlainPath(file.path) ||
      !file.path.startsWith(`${STARTER_SOURCE_DIR}/`)
    )
      problems.push(
        `${file.path}: source files live under ${STARTER_SOURCE_DIR}/.`,
      );
    else if (
      file.path.endsWith(".d.ts") ||
      !STARTER_SOURCE_EXTENSIONS.some((extension) =>
        file.path.endsWith(extension),
      )
    )
      problems.push(
        `${file.path}: a source file is TypeScript (.ts, .tsx) or an asset (${STARTER_SOURCE_EXTENSIONS.slice(2).join(", ")}).`,
      );
  }
  for (const test of starter.publicTests) {
    unique(test.path);
    if (
      !isPlainPath(test.path) ||
      !test.path.startsWith(`${PUBLIC_TESTS_DIR}/`) ||
      !/\.test\.tsx?$/.test(test.path)
    )
      problems.push(
        `${test.path}: public tests live under ${PUBLIC_TESTS_DIR}/ and end in .test.ts or .test.tsx.`,
      );
    else if (test.path === SPEC_TEST_PATH)
      problems.push(
        `${test.path} is generated from the spec; name the test something else.`,
      );
  }
  for (const test of starter.hiddenTests) {
    unique(test.path);
    if (
      !isPlainPath(test.path) ||
      !test.path.startsWith(`${PRIVATE_TESTS_DIR}/`) ||
      !test.path.endsWith(".test.ts")
    )
      problems.push(
        `${test.path}: hidden tests live under ${PRIVATE_TESTS_DIR}/ and end in .test.ts.`,
      );
  }
  if (!starter.hiddenTests.some((test) => test.expectedBaseline === "fail"))
    problems.push(
      "At least one hidden test must fail on the starter: it is how a finished bounty is told apart from an unfinished one.",
    );
  for (const file of [
    ...starter.files,
    ...starter.publicTests,
    ...starter.hiddenTests,
  ])
    if (file.text.length > STARTER_LIMITS.fileChars)
      problems.push(
        `${file.path} is longer than ${STARTER_LIMITS.fileChars} characters.`,
      );
  const names = new Set<string>();
  for (const item of starter.packages) {
    if (names.has(item.name)) problems.push(`${item.name} is listed twice.`);
    names.add(item.name);
    if (!PACKAGE_NAME.test(item.name))
      problems.push(`${item.name} is not an npm package name.`);
    else if (TOOLCHAIN_PACKAGES.has(item.name))
      problems.push(`${item.name} comes with the toolchain; leave it out.`);
    if (!EXACT_VERSION.test(item.version))
      problems.push(
        `${item.name}@${item.version}: give an exact version, such as 1.2.3.`,
      );
  }
  if (starter.scenario.trim() === "")
    problems.push("The walkthrough is empty.");
  if (starter.scenario.length > STARTER_LIMITS.scenarioChars)
    problems.push(
      `The walkthrough is longer than ${STARTER_LIMITS.scenarioChars} characters.`,
    );
  if (starter.summary.trim() === "") problems.push("The summary is empty.");
  if (starter.summary.length > STARTER_LIMITS.summaryChars)
    problems.push(
      `The summary is longer than ${STARTER_LIMITS.summaryChars} characters.`,
    );
  const total = [
    ...starter.files,
    ...starter.publicTests,
    ...starter.hiddenTests,
    { text: starter.scenario },
  ].reduce((sum, file) => sum + file.text.length, 0);
  if (total > STARTER_LIMITS.totalChars)
    problems.push(
      `The starter is longer than ${STARTER_LIMITS.totalChars} characters in all.`,
    );
  return problems;
}

/**
 * Where the spec rides through renaming, as a slice's build carries it: a
 * file of its own, so an unscoped rule renames it with the source.
 */
const SPEC_PSEUDO_PATH = "__approved_spec__.json";

export type AliasedStarter =
  | {
      readonly ok: true;
      /** The starter in public names; its name table is the one given. */
      readonly starter: StarterSubmission;
      readonly spec: SpecDraft | null;
    }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * The starter as contributors read it: its name table applied to its
 * source, tests, walkthrough and spec, and proved to map back. A rule that
 * renames nothing is refused, as a table that hides nothing would pass for
 * one that does.
 */
export function aliasStarter(
  starter: StarterSubmission,
  spec: SpecDraft | null,
): AliasedStarter {
  const groups = [
    starter.files,
    starter.publicTests,
    starter.hiddenTests,
  ] as const;
  const inputs = [
    ...groups.flat().map(({ path, text }) => ({ path, text })),
    { path: RUN_PATH, text: starter.scenario },
    ...(spec === null
      ? []
      : [{ path: SPEC_PSEUDO_PATH, text: JSON.stringify(spec) }]),
  ];
  const aliased = applyAliases(inputs, starter.aliases);
  if (!aliased.ok)
    return {
      ok: false,
      problems: aliased.problems.map(
        (problem) =>
          `${problem.rule === null ? "Name table" : `Name ${problem.rule + 1}`}${problem.file === null ? "" : ` in ${problem.file}`}: ${problem.detail}`,
      ),
    };
  const unused = starter.aliases.flatMap((rule, index) =>
    (aliased.applied[index] ?? 0) === 0
      ? [
          `Name ${index + 1}: ${rule.before} does not occur in the starter, so it renames nothing.`,
        ]
      : [],
  );
  if (unused.length > 0) return { ok: false, problems: unused };
  let at = 0;
  const textOf = (fallback: string) => aliased.files[at++]?.text ?? fallback;
  const files = starter.files.map((file) => ({
    ...file,
    text: textOf(file.text),
  }));
  const publicTests = starter.publicTests.map((test) => ({
    ...test,
    text: textOf(test.text),
  }));
  const hiddenTests = starter.hiddenTests.map((test) => ({
    ...test,
    text: textOf(test.text),
  }));
  const scenario = textOf(starter.scenario);
  let renamedSpec: SpecDraft | null = null;
  if (spec !== null) {
    try {
      renamedSpec = JSON.parse(textOf("null")) as SpecDraft;
    } catch {
      return {
        ok: false,
        problems: ["Name table: renaming broke the spec's serialization."],
      };
    }
  }
  return {
    ok: true,
    starter: { ...starter, files, publicTests, hiddenTests, scenario },
    spec: renamedSpec,
  };
}

/** What a generated version's scope is: its source, editable and extendable. */
export function starterScope(
  starter: Pick<StarterSubmission, "files" | "packages">,
): ScopeRecord {
  return {
    editablePaths: starter.files.map((file) => file.path).sort(compare),
    generatedPaths: [],
    permittedOperations: ["edit", "add"],
    dependencies: starterDependencies(starter.packages),
    blockers: [],
  };
}

function starterDependencies(
  packages: readonly StarterPackage[],
): ResolvedDependency[] {
  return [...packages]
    .sort((a, b) => compare(a.name, b.name))
    .map((item) => ({
      name: item.name,
      kind: "package",
      version: item.version,
      resolution: "approved-package",
      detail: "Chosen for the starter.",
    }));
}

/**
 * What a generated version needs of its task before it is written: a title
 * and a description to follow, and a proposal that prices it and has been
 * approved. A bounty with none, or with one still proposed, is a draft, and
 * a draft is not generated from.
 */
export function starterTaskReadiness(
  snapshot: Pick<ApprovedTaskSnapshot, "title" | "summary" | "pricing">,
): { ready: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (snapshot.pricing === null)
    reasons.push("The bounty has no proposal; size and approve it first.");
  else if (snapshot.pricing.status !== "approved")
    reasons.push("The bounty's proposal is a draft; approve it first.");
  if (snapshot.title.trim() === "") reasons.push("The bounty has no title.");
  if (snapshot.summary.trim() === "")
    reasons.push("The bounty has no description to follow.");
  return { ready: reasons.length === 0, reasons };
}

/** Languages a starter runs in, and what runs them. */
const NODE_TECHNOLOGIES = new Set(["TypeScript", "JavaScript", "Node.js"]);

/**
 * The stack entries a starter cannot be written in: languages other than
 * TypeScript and JavaScript, and frameworks of another ecosystem. A
 * database, a service or a tool is not among them; the starter stands in
 * for it in memory.
 */
export function offNodeStack(stack: readonly string[]): string[] {
  return stack.filter((name) => {
    const technology = stackTechnology(name);
    if (technology === undefined) return false;
    if (NODE_TECHNOLOGIES.has(technology.name)) return false;
    if (technology.kind === "language") return true;
    if (technology.kind !== "framework" || technology.detect === undefined)
      return false;
    const {
      linguist: _linguist,
      files: _files,
      ...ecosystems
    } = technology.detect;
    const named = Object.keys(ecosystems);
    return named.length > 0 && !named.includes("npm");
  });
}

/**
 * Why the stack rules out a starter, or null: it names something only
 * another runtime runs, and nothing Node runs. A stack that names both is
 * written in TypeScript, with the rest left out.
 */
export function starterStackProblem(stack: readonly string[]): string | null {
  const off = offNodeStack(stack);
  if (off.length === 0) return null;
  const onNode = stack.some((name) => {
    const technology = stackTechnology(name);
    return technology !== undefined && NODE_TECHNOLOGIES.has(technology.name);
  });
  return onNode
    ? null
    : `A starter runs on Node.js and TypeScript; this bounty's stack names ${off.join(", ")}.`;
}

/** JSX is typed loosely, like every package: the starter compiles, the tests judge it. */
const JSX_DECLARATIONS = `${[
  "declare namespace JSX {",
  "  interface Element {}",
  "  interface IntrinsicElements { [name: string]: any }",
  "}",
].join("\n")}\n`;

function readme(input: {
  version: ProjectVersion;
  toolchain: Toolchain;
  editable: readonly string[];
  packages: readonly StarterPackage[];
  publicTests: readonly string[];
}): string {
  const list = (items: readonly string[], empty: string) =>
    items.length === 0 ? [empty] : items.map((item) => `- \`${item}\``);
  return `${[
    `# ${input.version.title}`,
    "",
    input.version.specSummary,
    "",
    `Task \`${input.version.versionId}\` (version ${input.version.version}, size ${input.version.complexity}).`,
    "",
    "## Run it",
    "",
    `Node ${input.toolchain.nodeRange} and npm ${input.toolchain.npm} (\`.nvmrc\` says \`${input.toolchain.node}\`). Supported on ${input.toolchain.supportedPlatforms.join(", ")}. No account, container or remote session is needed; nothing runs until you run it.`,
    "",
    "```sh",
    SANDBOX_COMMANDS.install,
    SANDBOX_COMMANDS.dev,
    SANDBOX_COMMANDS.build,
    SANDBOX_COMMANDS.test,
    "```",
    "",
    `\`${SANDBOX_COMMANDS.dev}\` runs \`${RUN_PATH}\`, a walkthrough of what the starter does today.`,
    "",
    "## What you may change",
    "",
    `The task's code lives under \`${STARTER_SOURCE_DIR}/\`. Change these files and add new ones there; everything else is harness and is rejected on submission.`,
    "",
    ...list(input.editable, "No files yet."),
    "",
    "## Packages",
    "",
    ...list(
      input.packages.map((item) => `${item.name}@${item.version}`),
      "None.",
    ),
    "",
    "## Tests",
    "",
    ...list(input.publicTests, "None."),
    "",
    "Local results help you iterate. Acceptance is decided by the platform's own run of your pushed commit, including tests that are not in this repository.",
  ].join("\n")}\n`;
}

export interface StarterProjectInput {
  readonly version: ProjectVersion;
  readonly starter: Pick<
    StarterSubmission,
    "files" | "publicTests" | "packages" | "scenario"
  >;
  /** The version's hidden tests, which may have been edited since the starter. */
  readonly acceptanceTests: readonly AcceptanceTest[];
  /** The proposal's spec, when the bounty has one; its scenarios become todo tests. */
  readonly spec: SpecDraft | null;
  readonly toolchain?: Toolchain;
}

/**
 * Generates a generated version's project. Deterministic: the same inputs
 * give the same files in the same order. A starter that breaks the rules
 * above still generates, with blockers, so the build can report them.
 */
export function generateStarterProject(
  input: StarterProjectInput,
): GeneratedProject {
  const toolchain = input.toolchain ?? SANDBOX_TOOLCHAIN;
  const { starter } = input;
  const blockers: ProjectBlocker[] = starterFileProblems({
    ...starter,
    hiddenTests: input.acceptanceTests,
    summary: "-",
  }).map((detail) => ({ code: "starter_invalid", file: null, detail }));
  const files = new Map<string, GeneratedFile>();
  const add = (file: GeneratedFile) => {
    if (files.has(file.path))
      blockers.push({
        code: "path_conflict",
        file: file.path,
        detail: `${file.path} is produced twice.`,
      });
    else files.set(file.path, file);
  };
  for (const file of starter.files)
    add({ path: file.path, text: file.text, class: "source", public: true });

  // Harness: the walkthrough, and the loose declarations the project and
  // its tests compile against.
  const jsx = [...starter.files, ...starter.publicTests].some((file) =>
    file.path.endsWith(".tsx"),
  );
  const packages = [...starter.packages].sort((a, b) =>
    compare(a.name, b.name),
  );
  add({
    path: AMBIENT_PATH,
    text: `${ambientDeclarations(packages.map((item) => item.name))}${jsx ? JSX_DECLARATIONS : ""}`,
    class: "harness",
    public: true,
  });
  add({
    path: RUN_PATH,
    text: starter.scenario,
    class: "harness",
    public: true,
  });

  // Tests.
  const publicTests: string[] = [];
  if (input.spec !== null) {
    publicTests.push(SPEC_TEST_PATH);
    add({
      path: SPEC_TEST_PATH,
      text: specTests(input.spec),
      class: "test-public",
      public: true,
    });
  }
  for (const test of starter.publicTests) {
    publicTests.push(test.path);
    add({
      path: test.path,
      text: test.text,
      class: "test-public",
      public: true,
    });
  }
  publicTests.sort(compare);
  for (const test of input.acceptanceTests)
    add({
      path: test.path,
      text: test.text,
      class: "test-private",
      public: false,
    });

  // Configuration, as a slice's project has it.
  add({
    path: "package.json",
    text: `${JSON.stringify(
      {
        name: `sandbox-task-${input.version.versionId.replace(/[^a-z0-9]/gi, "-").toLowerCase()}`,
        version: `${input.version.version}.0.0`,
        private: true,
        type: "module",
        engines: { node: toolchain.nodeRange },
        packageManager: `npm@${toolchain.npm}`,
        scripts: {
          build: "tsc -p tsconfig.json",
          dev: `npm run build && node --env-file=${ENV_FILE} ${runtimePath(RUN_PATH)}`,
          test: `npm run build && node --env-file=${ENV_FILE} --test "${PUBLIC_TESTS_DIR}/**/*.test.js"`,
        },
        dependencies: Object.fromEntries(
          packages.map((item) => [item.name, item.version]),
        ),
        devDependencies: { typescript: toolchain.typescript },
      },
      null,
      2,
    )}\n`,
    class: "config",
    public: true,
  });
  add({
    path: "tsconfig.json",
    text: tsconfigFor(jsx ? { jsx: "react-jsx" } : undefined),
    class: "config",
    public: true,
  });
  add({
    path: ".nvmrc",
    text: `${toolchain.node}\n`,
    class: "config",
    public: true,
  });
  add({
    path: ".npmrc",
    text: "engine-strict=true\nignore-scripts=true\nfund=false\naudit=false\n",
    class: "config",
    public: true,
  });
  add({
    path: ENV_FILE,
    text: "# The task reads no environment; the commands load this file anyway.\n",
    class: "config",
    public: true,
  });
  for (const specifier of unresolvedScenarioImports(starter.scenario, (path) =>
    files.has(path),
  ))
    blockers.push({
      code: "import_unrewritable",
      file: RUN_PATH,
      detail: `${specifier} does not resolve to a file in the project.`,
    });
  const emitted = [...files.values()]
    .filter((file) => isScript(file.path))
    .map((file) => runtimePath(file.path))
    .filter((path) => !files.has(path))
    .sort(compare);
  add({
    path: ".gitignore",
    text: `${["node_modules/", ...emitted].join("\n")}\n`,
    class: "config",
    public: true,
  });
  const editable = starter.files.map((file) => file.path).sort(compare);
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
  add({
    path: "README.md",
    text: readme({
      version: input.version,
      toolchain,
      editable,
      packages,
      publicTests,
    }),
    class: "config",
    public: true,
  });
  return {
    files: [...files.values()].sort((a, b) => compare(a.path, b.path)),
    importRewrites: [],
    descriptor,
    publicTests,
    blockers,
  };
}
