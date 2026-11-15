/**
 * How a hidden test runs without task code reading it: the files every
 * evaluation provider puts in a hidden run's fresh copy of the sealed tree
 * (`EvaluationJob.seal`, `EvaluationCommand.hidden`). Both providers build
 * a run from these functions, so they differ only in how they copy and
 * write.
 *
 * The job withholds every hidden test (source, emitted JavaScript,
 * declaration, maps) once the build has compiled them and before the
 * walkthrough or public suite runs any task code, keeping their text in
 * the worker. The tree as it then stands is the hidden runs' pristine
 * copy, out of reach of the job's later processes (another uid locally,
 * root-owned in E2B). Each hidden run gets a fresh copy of it with two
 * files in `.sandbox-hidden/`, written after the copy while nothing of the
 * job runs:
 *
 * - the test's emitted module (the payload), and
 * - a runner named after the test (`<name>.test.mjs`), which node:test's
 *   argv names in place of the test. It reads the payload, deletes it,
 *   then registers a module hook that answers the test's own URL
 *   (`tests/private/<name>.test.js`, absent from disk) with that text,
 *   once, and imports it. Relative imports, `import.meta.url` and test
 *   names are the test's own; a file that fails to load is still a point
 *   the runner reports for the file as a whole (`WHOLE_FILE_POINT`), as
 *   before, so `privateTestOutcome` reads every run as it did.
 *
 * Task code loads only through the test's imports, after the deletion: it
 * finds no hidden test on disk, neither this one nor another, and the
 * runner holds nothing a module can import. `module.register` (Node 20.6+,
 * so the toolchain's 22.12 floor) keeps the text in the loader thread;
 * `module.registerHooks` is the fallback where `register` is gone.
 *
 * Node's permission model (`--permission`) was weighed and not used: it is
 * `--experimental-permission` on 22.12, it cannot drop a read once the test
 * is read (the text would still have to arrive by another channel),
 * `node --test` under it needs `--allow-child-process`, and scoping reads
 * or writes would change what honest hidden tests and task code may do on
 * versions already calibrated without it.
 *
 * What this does not stop, by design or for now:
 * - A function a test passes into task code can be `toString`ed, and a
 *   value it passes is the value; an error's stack names the test's URL and
 *   line numbers. Task code sees what the test hands it.
 * - Code that bypasses the task-code check (`taskCodeProblems`) can open
 *   `node:inspector` or read `/proc/self/mem` and find the loaded source.
 * - A layout whose hidden tests run under Vitest (`load: "disk"`) puts the
 *   source back at its path: only "one hidden test per run" applies.
 * - `local-process` running jobs as the worker (no isolation uid) keeps
 *   nothing from the job: its pristine copy is the job's to write and a
 *   process that left the group outlives the command. It is not an
 *   isolation boundary.
 * - Scenario keys and the titles of public `spec.test.ts` todos say what
 *   the hidden tests cover, by design.
 */

import { posix } from "node:path";
import type { HiddenTestRun, StagedFile } from "sandbox-factory";

/** Where a hidden run's runner and payload sit, at the copy's root. */
export const HIDDEN_RUN_DIR = ".sandbox-hidden";

/** Which loader API the runner uses; `auto` prefers `module.register`. */
export type HiddenRunnerHooks = "auto" | "async" | "sync";

/**
 * The runner's path for `entry`: named after the test, ending `.test.mjs`
 * so a file that never ran its tests is still reported as a whole-file
 * point.
 */
export function hiddenRunnerPath(entry: string): string {
  const name = posix.basename(entry).replace(/\.[cm]?js$/, "");
  return `${HIDDEN_RUN_DIR}/${name.endsWith(".test") ? name : `${name}.test`}.mjs`;
}

const payloadPath = (entry: string) =>
  hiddenRunnerPath(entry).replace(/\.test\.mjs$/, ".payload");

/** `to` relative to the directory of `from`, both from the copy's root. */
function relativeUrl(from: string, to: string): string {
  const rel = posix.relative(posix.dirname(from), to);
  return rel.startsWith(".") ? rel : `./${rel}`;
}

/** The hook module `module.register` loads, from a `data:` URL. */
const ASYNC_HOOKS = [
  "let target;",
  "let source = null;",
  "export function initialize(data) {",
  "  target = data.target;",
  "  source = data.source;",
  "}",
  "export async function resolve(specifier, context, next) {",
  "  if (specifier === target) return { url: target, format: 'module', shortCircuit: true };",
  "  return next(specifier, context);",
  "}",
  "export async function load(url, context, next) {",
  "  if (url !== target || source === null) return next(url, context);",
  "  const text = source;",
  "  source = null;",
  "  return { format: 'module', source: text, shortCircuit: true };",
  "}",
].join("\n");

/**
 * The runner module for `entry`: platform code with no secret in it, only
 * the payload's and the test's paths relative to itself.
 */
export function hiddenRunnerSource(
  entry: string,
  hooks: HiddenRunnerHooks = "auto",
): string {
  const runner = hiddenRunnerPath(entry);
  return `${[
    "// The platform's hidden-test runner: reads the test, deletes it, and",
    "// imports it from memory under its own URL before any task code loads.",
    'import { readFileSync, rmSync } from "node:fs";',
    'import * as nodeModule from "node:module";',
    "",
    `const payload = new URL(${JSON.stringify(relativeUrl(runner, payloadPath(entry)))}, import.meta.url);`,
    `const target = new URL(${JSON.stringify(relativeUrl(runner, entry))}, import.meta.url).href;`,
    "let source;",
    "try {",
    '  source = readFileSync(payload, "utf8");',
    "} catch {",
    '  throw new Error("The hidden test was not built.");',
    "}",
    "rmSync(payload, { force: true });",
    `const hooks = ${JSON.stringify(hooks)};`,
    'const useAsync = typeof nodeModule.register === "function" && hooks !== "sync";',
    'if (!useAsync && typeof nodeModule.registerHooks !== "function")',
    '  throw new Error("This Node has no module hooks to load the hidden test.");',
    "if (useAsync) {",
    "  nodeModule.register(",
    `    ${JSON.stringify(`data:text/javascript,${encodeURIComponent(ASYNC_HOOKS)}`)},`,
    "    { data: { target, source } },",
    "  );",
    "} else {",
    "  let held = source;",
    "  nodeModule.registerHooks({",
    "    resolve(specifier, context, next) {",
    '      if (specifier === target) return { url: target, format: "module", shortCircuit: true };',
    "      return next(specifier, context);",
    "    },",
    "    load(url, context, next) {",
    "      if (url !== target || held === null) return next(url, context);",
    "      const text = held;",
    "      held = null;",
    '      return { format: "module", source: text, shortCircuit: true };',
    "    },",
    "  });",
    "}",
    "source = null;",
    "await import(target);",
  ].join("\n")}\n`;
}

/**
 * What a hidden run writes into its fresh copy after copying, by path from
 * the copy's root, and the argv it runs. `text` is the withheld entry's
 * text, null when the build left none (the runner then fails the file, as
 * a missing test did). `load: "disk"` puts the entry back at its own path
 * and runs the argv as given.
 */
export function hiddenRunFiles(
  hidden: HiddenTestRun,
  argv: readonly string[],
  text: string | null,
  hooks: HiddenRunnerHooks = "auto",
): { readonly files: StagedFile[]; readonly argv: readonly string[] } {
  if (hidden.load === "disk")
    return {
      files: text === null ? [] : [{ path: hidden.entry, text }],
      argv,
    };
  const at = argv.indexOf(hidden.entry);
  if (at < 0 || argv.indexOf(hidden.entry, at + 1) >= 0)
    throw new Error("A hidden run's argv names its entry exactly once.");
  const runner = hiddenRunnerPath(hidden.entry);
  return {
    files: [
      { path: runner, text: hiddenRunnerSource(hidden.entry, hooks) },
      ...(text === null ? [] : [{ path: payloadPath(hidden.entry), text }]),
    ],
    argv: argv.map((word, index) => (index === at ? runner : word)),
  };
}
