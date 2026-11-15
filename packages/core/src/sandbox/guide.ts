/**
 * What a contributor, or the coding agent they work with, reads and opens
 * first in a generated project: `TASK.md` (the bounty in prose, with its
 * approved scenarios, its confirmed decisions when the disclosure scans
 * pass them, how it is accepted and how to submit), `AGENTS.md`
 * (commands and rules, which agents load without asking), `CLAUDE.md`
 * (carveout's one-line import of `AGENTS.md`) and `.vscode/` (build output
 * hidden beside its source, the workspace's TypeScript, build/test/dev
 * tasks and debug launches that map breakpoints to `.ts` through the
 * compiler's source maps). A slice's project and a starter's write the
 * same files (`generateProject`, `generateStarterProject`), from the
 * version's listing and spec after the name table renamed them, so they
 * carry public names only and go through the build's vocabulary scan with
 * every other public file.
 *
 * Nothing here names a hidden test, its folder or how many there are:
 * `TASK.md` says hidden tests are keyed to the scenarios, which is what a
 * verdict already tells (`SubmissionResult.failedScenarios`), and never
 * which scenarios have one, so none reads as unjudged. The wording of
 * `AGENTS.md` follows carveout's slice `AGENTS.md` (`renderSliceAgents`)
 * where the two projects work alike.
 *
 * Paths come in as `GuidePaths` rather than from `project.ts`, which calls
 * this module: core keeps no runtime import cycle.
 */

import type { SpecDraft } from "../pricing/spec.js";
import { SANDBOX_COMMANDS } from "./build.js";
import { TASK_DESCRIPTOR_PATH } from "./descriptor.js";
import type { GeneratedFile, ProjectVersion } from "./project.js";
import { scanSecrets } from "./secrets.js";
import { publicVocabularyLeaks } from "./vocabulary.js";

export const TASK_GUIDE_PATH = "TASK.md";
export const AGENTS_GUIDE_PATH = "AGENTS.md";
/** Claude Code's name for `AGENTS.md`, which it imports, as carveout's cut writes it. */
export const CLAUDE_GUIDE_PATH = "CLAUDE.md";
export const VSCODE_DIR = ".vscode";

/** Where a generated project keeps what the guide names. */
export interface GuidePaths {
  readonly harnessDir: string;
  readonly mocksDir: string;
  readonly publicTestsDir: string;
  readonly envFile: string;
  /** The walkthrough's source, `sandbox/run.ts`. */
  readonly runPath: string;
  readonly mockRuntimePath: string;
  readonly ambientPath: string;
}

export interface ContributorGuideInput {
  readonly version: Pick<
    ProjectVersion,
    "title" | "specSummary" | "versionId" | "version" | "complexity"
  >;
  /** The approved spec in public names; null when the bounty has none. */
  readonly spec: SpecDraft | null;
  /**
   * The spec's decisions in public names, only when a person confirmed
   * them and the build's disclosure scans pass them
   * (`disclosableDecisions`); absent or empty, `TASK.md` names none.
   */
  readonly decisions?: readonly string[];
  readonly editable: readonly string[];
  readonly publicTests: readonly string[];
  /** Whether modules and packages outside the task are recording mocks (a slice), or nothing is mocked (a starter). */
  readonly mocks: boolean;
  /** Whether the project compiles `.tsx`, whose output is a `.js` too. */
  readonly jsx: boolean;
  readonly paths: GuidePaths;
}

const emittedOf = (path: string) =>
  path
    .replace(/\.mts$/, ".mjs")
    .replace(/\.cts$/, ".cjs")
    .replace(/\.tsx?$/, ".js");

/** A fence longer than any run of backticks in `text`. */
function fenceFor(text: string): string {
  const longest = Math.max(
    2,
    ...[...text.matchAll(/`+/g)].map((match) => match[0].length),
  );
  return "`".repeat(longest + 1);
}

/** The spec as Gherkin, each scenario under a comment naming its key. */
export function specGherkin(spec: SpecDraft): string {
  const lines = [`Feature: ${spec.feature}`];
  if (spec.background.length > 0) {
    lines.push("", "  Background:");
    spec.background.forEach((step, index) =>
      lines.push(`    ${index === 0 ? "Given" : "And"} ${step}`),
    );
  }
  for (const scenario of spec.scenarios) {
    lines.push("", `  # ${scenario.id}`, `  Scenario: ${scenario.title}`);
    for (const step of scenario.steps)
      lines.push(`    ${step.keyword} ${step.text}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The confirmed decisions `TASK.md` may carry: all of them, already in
 * public names, when neither disclosure scan (the workspace's vocabulary,
 * credentials) finds anything in their text, else none. All or none, so a
 * list with an item withheld never reads as complete; and none rather than
 * a build blocked or a name leaked, since an older name table never had to
 * cover text no public file carried. The hidden tests are held to them
 * either way; the contributor reads them only when they are safe to show.
 */
export function disclosableDecisions(
  decisions: readonly string[],
  vocabulary: readonly string[],
): readonly string[] {
  if (decisions.length === 0) return [];
  const file = { path: TASK_GUIDE_PATH, text: decisionList(decisions) };
  return publicVocabularyLeaks([file], vocabulary).length === 0 &&
    scanSecrets([file]).length === 0
    ? decisions
    : [];
}

const decisionList = (decisions: readonly string[]) =>
  decisions.map((text) => `- ${text.replace(/\s+/g, " ").trim()}`).join("\n");

/** The command that runs one public test file, as `npm test` runs them all. */
function oneTestCommand(paths: GuidePaths): string {
  return `${SANDBOX_COMMANDS.build} && node --env-file=${paths.envFile} --test ${paths.publicTestsDir}/<name>.test.js`;
}

/** `TASK.md`: the bounty, its scenarios, how it is judged and how it is submitted. */
export function taskGuide(input: ContributorGuideInput): string {
  const { version, spec, paths } = input;
  const scenarios = spec?.scenarios ?? [];
  const gherkin =
    spec === null || scenarios.length === 0 ? null : specGherkin(spec);
  const fence = gherkin === null ? "" : fenceFor(gherkin);
  const harness = [
    `\`${paths.harnessDir}/\``,
    ...(input.mocks
      ? [
          `\`${paths.mocksDir}/\``,
          "the `.d.ts` stubs and the mock `.js` beside them",
        ]
      : []),
    `everything under \`${paths.publicTestsDir.split("/")[0] ?? "tests"}/\``,
    "`package.json`",
    "`package-lock.json`",
    "`tsconfig.json`",
    "`.npmrc`",
    "`.nvmrc`",
    "`.gitignore`",
    `\`${paths.envFile}\``,
    `\`${TASK_DESCRIPTOR_PATH}\``,
  ];
  return `${[
    `# Task: ${version.title}`,
    "",
    version.specSummary,
    "",
    `Task \`${version.versionId}\` (version ${version.version}, size ${version.complexity}). Commands and working rules are in \`${AGENTS_GUIDE_PATH}\`.`,
    "",
    "## Scenarios",
    "",
    ...(gherkin === null
      ? ["The approved spec names no scenarios; the summary above is the task."]
      : [
          `The approved spec. \`${paths.publicTestsDir}/spec.test.ts\` holds each scenario as a \`todo\` test, which \`${SANDBOX_COMMANDS.test}\` reports without failing.`,
          "",
          `${fence}gherkin`,
          gherkin.trimEnd(),
          fence,
        ]),
    ...((input.decisions ?? []).length === 0
      ? []
      : [
          "",
          "## Decided",
          "",
          "Where the ticket was silent, the spec decided these, and the client confirmed each. They are part of the task: the hidden tests hold a submission to them as to the scenarios.",
          "",
          decisionList(input.decisions ?? []),
        ]),
    "",
    "## Accepted when",
    "",
    `- The public tests pass: \`${SANDBOX_COMMANDS.test}\` builds the project, and a type error fails the build.`,
    `- The platform's hidden acceptance tests pass. They are not in this project and are not handed out. Each is keyed to one scenario above (${scenarios.length === 0 ? "`s1`, `s2`…" : scenarios.map((scenario) => `\`${scenario.id}\``).join(", ")}); a failing one is reported by that key alone, never by its name, its code or its output.`,
    "- The platform judges the files you submit on its own copy of this version: its own install, build and tests, not your local run.",
    "",
    "## What you may change",
    "",
    "Only these files are the task:",
    "",
    ...(input.editable.length === 0
      ? ["No editable files."]
      : input.editable.map((path) => `- \`${path}\``)),
    "",
    "You may also add new TypeScript files (`.ts`, `.tsx`) beside them, in a directory that already holds one of them: never at the root, never a test or a declaration file.",
    "",
    `Read-only: ${harness.join(", ")}. They are the version's. This file, \`${AGENTS_GUIDE_PATH}\`, \`${CLAUDE_GUIDE_PATH}\`, \`README.md\` and \`${VSCODE_DIR}/\` are for you; leave them out of a submission too.`,
    "",
    "## What gets a submission refused",
    "",
    "The verdict is `refused`, with each file and why, when a submission:",
    "",
    "- changes or adds a file outside the task: a weakened, skipped or rewritten public test, or a test file added, among them. Leaving a file out never deletes it; it keeps the version's text.",
    "- changes `package.json`, the lockfile, compiler or npm configuration, the fixture environment or the scripts that run the tests.",
    "- adds a way to pass the tests without the code: telling a test run from a real one, ending the process early, swallowing uncaught errors, or rewriting the assertion library, the runner or a built-in.",
    `- reaches the test run from task code: the mock runtime's controls (\`recordedCalls\`, \`mockImplementation\`, \`resetMocks\`) or \`${paths.harnessDir}/\`, the modules \`node:test\`, \`node:assert\`, \`node:module\`, \`node:vm\` or \`node:inspector\`, \`require\`, \`eval\` or \`Function\`, or \`process\` and \`globalThis\` read by a computed name.`,
    "- looks for the hidden tests: code that names where they would be. They are never on disk while task code runs.",
    "- holds a symbolic link, an absolute path or the same path twice.",
    "",
    "## Submit",
    "",
    "A submission is the files you changed or added, each whole, at its path in this project. There is no push, branch or pull request, and nothing is read from your machine.",
    "",
    `- With the platform's MCP server: \`submit_patch\` with this version's id (\`${version.versionId}\`) and \`files: [{ path, text }]\`; read the verdict with \`get_verdict\`.`,
    `- With its API: \`POST /api/v1/orgs/<workspace>/sandboxes/versions/${version.versionId}/submissions\` with \`{ "files": [{ "path": "...", "text": "..." }] }\`.`,
    "",
    "Grading runs in the background. The verdict is `passed`, `incomplete` (a public test fails), `overfit` (the public tests pass, a hidden test fails, with its scenario key) or `refused`, with the public and hidden counts.",
    "",
    "## One retry",
    "",
    "A submission that did not pass can be retried once, with changed files (`retry` on the MCP server, or `POST …/sandboxes/submissions/<submissionId>/retry`). A retry is not retried, and a passed submission has nothing to retry.",
    "",
    "When grading could not run at all (the verdict is missing and the submission is `errored`: timed out, interrupted, or failed on the platform's side), it is graded again with the same files. That is not your doing and does not spend the retry.",
  ].join("\n")}\n`;
}

/** `AGENTS.md`: what an agent, or a person, needs before the first command. */
export function agentsGuide(input: ContributorGuideInput): string {
  const { paths } = input;
  const emittedRun = emittedOf(paths.runPath);
  return `${[
    "# This folder is a sandbox",
    "",
    `A standalone project for one task. The task, what is accepted and how to submit are in \`${TASK_GUIDE_PATH}\`: read it first.`,
    "",
    "## Commands",
    "",
    `- \`${SANDBOX_COMMANDS.install}\`: installs from the lockfile with no scripts. Nothing else needs setting up: no account, credential or network service.`,
    `- \`${SANDBOX_COMMANDS.build}\`: \`tsc\`. It writes a \`.js\` and a \`.js.map\` beside each \`.ts\`, a new file's too: leave them; only the source is submitted. A type error fails the build, and so \`${SANDBOX_COMMANDS.test}\`.`,
    `- \`${SANDBOX_COMMANDS.test}\`: builds, then runs the public tests (\`${paths.publicTestsDir}/**/*.test.js\`) with node:test.`,
    `- \`${SANDBOX_COMMANDS.dev}\`: builds, then runs the walkthrough \`${paths.runPath}\` (\`${emittedRun}\`).`,
    `- One test file: \`${oneTestCommand(paths)}\`. One test by name: add \`--test-name-pattern "<name>"\`.`,
    `- Every command loads \`${paths.envFile}\` (\`--env-file\`): fixture values, none of them real.`,
    `- VS Code: \`${VSCODE_DIR}/launch.json\` debugs the walkthrough, the public tests and the test file open in the editor, building first; breakpoints in \`.ts\` bind through the source maps. \`${VSCODE_DIR}/settings.json\` hides the build's \`.js\` and \`.js.map\` beside their source.`,
    "",
    "## Rules",
    "",
    `- Edit only the files \`${TASK_GUIDE_PATH}\` lists under What you may change (\`editablePaths\` in \`${TASK_DESCRIPTOR_PATH}\`), and add \`.ts\` files beside them.`,
    `- Never edit the public tests (\`${paths.publicTestsDir}/\`), \`${paths.harnessDir}/\`${input.mocks ? `, \`${paths.mocksDir}/\`, the stubs` : ""}, \`package.json\`, the lockfile or the root configuration: a submission that changes one is refused. Tests you write to iterate stay local; a test file in a submission is refused too.`,
    "- No new package and no network: `package.json` and the lockfile are the version's, and nothing here may reach a real service.",
    ...(input.mocks
      ? [
          `- Modules outside the task are \`.d.ts\` stubs beside generated \`.js\` runtimes, and service packages are mock packages under \`${paths.mocksDir}/\`. Their values are recording mocks (\`${paths.mockRuntimePath}\`): any property or call answers with another mock and is recorded. In a test, \`mockImplementation(path, fn)\` gives one behaviour and \`recordedCalls()\` reads the calls back; task code never imports them. The README's Mocks section lists every mocked module and package.`,
        ]
      : []),
    `- Node's modules and globals are typed \`any\` (\`${paths.ambientPath}\`), as the task's code was checked; do not add \`@types/node\`.`,
    "- Do not look for the hidden acceptance tests: they are not in this folder, and code that names where they would be is refused.",
    "- No code that tells a test run from a real one, ends the run early, or rewrites the assertion library or a built-in.",
  ].join("\n")}\n`;
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** `.vscode/settings.json`, `tasks.json` and `launch.json`. */
export function vscodeFiles(
  input: Pick<ContributorGuideInput, "jsx" | "paths">,
): {
  readonly path: string;
  readonly text: string;
}[] {
  const { paths } = input;
  const debug = {
    type: "node",
    request: "launch",
    preLaunchTask: "npm: build",
    cwd: "${workspaceFolder}",
    sourceMaps: true,
    outFiles: ["${workspaceFolder}/**/*.js", "!**/node_modules/**"],
    skipFiles: ["<node_internals>/**"],
  };
  const node = ["--env-file=" + paths.envFile, "--enable-source-maps"];
  return [
    {
      path: `${VSCODE_DIR}/launch.json`,
      text: json({
        version: "0.2.0",
        configurations: [
          {
            name: "Walkthrough (npm run dev)",
            ...debug,
            runtimeArgs: node,
            program: `\${workspaceFolder}/${emittedOf(paths.runPath)}`,
          },
          {
            name: "Public tests (npm test)",
            ...debug,
            runtimeExecutable: "node",
            runtimeArgs: [
              ...node,
              "--test",
              `${paths.publicTestsDir}/**/*.test.js`,
            ],
          },
          {
            name: "Test file in the editor",
            ...debug,
            runtimeExecutable: "node",
            runtimeArgs: [
              ...node,
              "--test",
              "${relativeFileDirname}/${fileBasenameNoExtension}.js",
            ],
          },
        ],
      }),
    },
    {
      path: `${VSCODE_DIR}/settings.json`,
      text: json({
        // Each `.js` and `.js.map` the build writes beside its source; a
        // mock's `.js` beside its `.d.ts` stub stays in view.
        "files.exclude": {
          "**/*.js": { when: "$(basename).ts" },
          ...(input.jsx ? { "**/*.[j]s": { when: "$(basename).tsx" } } : {}),
          "**/*.mjs": { when: "$(basename).mts" },
          "**/*.cjs": { when: "$(basename).cts" },
          "**/*.js.map": true,
          "**/*.mjs.map": true,
          "**/*.cjs.map": true,
        },
        "search.exclude": {
          "**/node_modules": true,
          "package-lock.json": true,
        },
        "typescript.tsdk": "node_modules/typescript/lib",
        "typescript.enablePromptUseWorkspaceTsdk": true,
      }),
    },
    {
      path: `${VSCODE_DIR}/tasks.json`,
      text: json({
        version: "2.0.0",
        tasks: [
          {
            type: "npm",
            script: "build",
            label: "npm: build",
            group: { kind: "build", isDefault: true },
            problemMatcher: ["$tsc"],
          },
          {
            type: "npm",
            script: "test",
            label: "npm: test",
            group: { kind: "test", isDefault: true },
            problemMatcher: ["$tsc"],
          },
          {
            type: "npm",
            script: "dev",
            label: "npm: dev",
            problemMatcher: ["$tsc"],
          },
        ],
      }),
    },
  ];
}

/** Every file the guide adds to a project, public configuration all. */
export function contributorGuideFiles(
  input: ContributorGuideInput,
): GeneratedFile[] {
  return [
    { path: TASK_GUIDE_PATH, text: taskGuide(input) },
    { path: AGENTS_GUIDE_PATH, text: agentsGuide(input) },
    { path: CLAUDE_GUIDE_PATH, text: `@${AGENTS_GUIDE_PATH}\n` },
    ...vscodeFiles(input),
  ].map((file) => ({ ...file, class: "config", public: true }));
}
