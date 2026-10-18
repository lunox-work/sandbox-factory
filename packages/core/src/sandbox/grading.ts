/**
 * What a submission is graded on: the version's own files with only the
 * contributor's task files taken from the submission, and the commands the
 * version runs on them.
 *
 * Everything that decides how a submission is judged is the version's:
 * `package.json` and its scripts, the lockfile, `.npmrc`, `tsconfig.json`,
 * `sandbox.env`, the harness under `sandbox/`, the mocks, the stubs, both
 * test suites and `.gitignore`. A submission that changes any of them is
 * refused with the reasons, never quietly repaired, so the contributor
 * learns what was not taken. A file the submission carries unchanged is not
 * a change and is ignored.
 *
 * A submission may change each editable path and add new TypeScript files
 * beside them: in a directory that already holds an editable file, never
 * at the root or under a harness or test directory, never a declaration or
 * test file, and never one whose emitted JavaScript or declaration lands on
 * a file the version has (a stub's runtime among them). It cannot delete:
 * an editable path it leaves out keeps the version's text.
 *
 * Every file a submission changes or adds is also read for the test run
 * (`taskCodeProblems`): code that imports `sandbox/mock.js` or a mock
 * package's internals could record the calls a hidden test expects or
 * reset its mocks, and the runner's own modules could rewrite its
 * assertions, so both are refused, as is any import the check cannot read
 * (`require`, `getBuiltinModule`, `import()` of anything but a string).
 * An unchanged file is the version's own and is not read again.
 *
 * That check is an advisory lint, not a boundary: it matches text, and
 * JavaScript has more ways to name a module or evaluate a string than any
 * text match follows (an alias of `Function`, a property name built at run
 * time). It refuses the plain spellings so a contributor learns early what
 * grading will not trust. What grading does trust is process isolation:
 * task code runs only in processes the grader reads from outside, each
 * hidden test in its own from a fresh copy of the version's files, and no
 * other hidden test, credential or grading state is loaded beside it.
 */

import { TASK_DESCRIPTOR_PATH } from "./descriptor.js";
import {
  ENV_FILE,
  HARNESS_DIR,
  MOCKS_DIR,
  MOCK_RUNTIME_PATH,
  PRIVATE_TESTS_DIR,
  PUBLIC_TESTS_DIR,
  SANDBOX_RUN_ARGV,
  declarationPath,
  dirnameOf,
  isScript,
  runtimePath,
  type GeneratedFile,
} from "./project.js";

/** One file of a submission, as the contributor's tree holds it. */
export interface SubmittedFile {
  readonly path: string;
  readonly text: string;
  /** A symbolic link, whose `text` is its target; never taken. */
  readonly symlink?: boolean;
}

export interface GradingRefusal {
  readonly path: string;
  readonly reason: string;
}

export interface GradingTree {
  /** The files a grading job is staged with; empty when anything is refused. */
  readonly files: readonly GeneratedFile[];
  /** The paths the submission changed or added, sorted. */
  readonly changed: readonly string[];
  readonly refused: readonly GradingRefusal[];
}

/**
 * The commands a grading job runs, in order, on the staged tree: install
 * from the version's lockfile with no scripts, compile with the installed
 * compiler, then the public suite. None goes through `npm run`, so no
 * script of any `package.json` decides what runs; each hidden test then
 * runs on its own with `privateTestArgv`, read by the worker's
 * `privateTestOutcome`.
 *
 * The hidden tests must run from a fresh copy of the version's files, never
 * the tree the build and public suite already ran on: task code runs there
 * with `node:fs` and can rewrite `tests/private` before they are read.
 */
export const GRADING_COMMANDS: readonly {
  readonly name: "install" | "build" | "public-tests";
  readonly argv: readonly string[];
}[] = [
  {
    name: "install",
    argv: ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"],
  },
  {
    name: "build",
    argv: ["node", "node_modules/typescript/bin/tsc", "-p", "tsconfig.json"],
  },
  { name: "public-tests", argv: SANDBOX_RUN_ARGV.test },
];

/** Top-level directories a submission never writes to. */
const HARNESS_ROOTS = [
  HARNESS_DIR,
  MOCKS_DIR,
  PUBLIC_TESTS_DIR.split("/")[0] ?? "tests",
  PRIVATE_TESTS_DIR.split("/")[0] ?? "tests",
  "node_modules",
];
/** Root files that configure the run; named for the refusal they get. */
const CONFIG_FILES: Readonly<Record<string, string>> = {
  "package.json":
    "package.json is the version's; scripts and dependencies are not the submission's to change.",
  "package-lock.json": "The lockfile is the version's.",
  ".npmrc": ".npmrc is the version's.",
  ".nvmrc": ".nvmrc is the version's.",
  ".gitignore": ".gitignore is the version's.",
  [ENV_FILE]: `${ENV_FILE} is the version's fixture environment.`,
  [TASK_DESCRIPTOR_PATH]: `${TASK_DESCRIPTOR_PATH} is the version's.`,
};

/** Why a path cannot name a file in the tree; null when it can. */
function pathProblem(path: string): string | null {
  if (path === "") return "The path is empty.";
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path))
    return "The path is absolute.";
  if (path.includes("\\") || path.includes("\0"))
    return "The path holds a backslash or a NUL.";
  if (
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  )
    return "The path has an empty, `.` or `..` segment.";
  return null;
}

/** Names the mock runtime exports for tests; task code never uses them. */
const MOCK_CONTROLS = /\b(?:recordedCalls|mockImplementation|resetMocks)\b/;
/** Every module specifier a text names, as written. */
const SPECIFIERS =
  /\b(?:from|import)\s*(['"])([^'"\n]+)\1|\bimport\s*\(\s*(['"])([^'"\n]+)\3\s*\)/g;
/**
 * Node modules that reach the test run itself: the runner, the assertions
 * a hidden test imports (whose functions are writable properties), module
 * loading hooks and code evaluation. Task code has no use for them.
 */
const RUN_MODULES =
  /^(?:node:)?(?:test|assert|assert\/strict|module|vm|inspector)(?:\/.*)?$/;

/**
 * Why a changed or added task file could reach the test run instead of
 * being judged by it: the mock runtime, whose recorded calls and installed
 * implementations a hidden test reads and resets; the harness and mock
 * packages' internals; the runner's own modules; or a module named in a
 * way this check cannot follow (`require`, `getBuiltinModule`, `import()`
 * of anything but one string, an absolute path or URL, a bare specifier
 * that climbs, code evaluated from a string, Node's internal bindings,
 * `process` or `globalThis` read by a computed name). Specifiers resolve
 * against the file's directory. Advisory only, as the header says: a
 * file this passes is not thereby safe to run beside the hidden tests.
 */
export function taskCodeProblems(path: string, text: string): string[] {
  const problems: string[] = [];
  if (MOCK_CONTROLS.test(text))
    problems.push(
      "Task code must not use recordedCalls, mockImplementation or resetMocks; they are for tests.",
    );
  if (/\brequire\s*\(|\bcreateRequire\b|\bgetBuiltinModule\b/.test(text))
    problems.push("Task code must import modules, not require them.");
  if (
    /\bprocess\s*(?:\?\.|\.)\s*(?:binding|dlopen)\b|\b_linkedBinding\b/.test(
      text,
    )
  )
    problems.push(
      "Task code must not load Node's internal bindings or native addons.",
    );
  if (/\bimport\s*\(\s*(?!(['"])[^'"\n]+\1\s*\))/.test(text))
    problems.push("A dynamic import must name its module as one string.");
  // `eval(...)` and `Function(...)`, and `Function` reached the plain other
  // ways: `Reflect.construct`, an `async` function's prototype, and a
  // `.constructor` called rather than read.
  if (
    /\beval\s*\(|\bFunction\s*\(|\bReflect\s*\.\s*construct\b|\bgetPrototypeOf\s*\(\s*async\b|\.\s*constructor\s*\(/.test(
      text,
    )
  )
    problems.push("Task code must not evaluate strings as code.");
  // `process["getBuiltin" + "Module"]`, `globalThis["ev" + "al"]`: a name
  // built at run time that the checks above cannot read.
  if (/\b(?:process|globalThis)\s*(?:\?\.\s*)?\[/.test(text))
    problems.push(
      "Task code must not read process or globalThis by a computed name.",
    );
  const dir = dirnameOf(path);
  for (const match of text.matchAll(SPECIFIERS)) {
    const specifier = match[2] ?? match[4] ?? "";
    if (RUN_MODULES.test(specifier)) {
      problems.push(`${specifier} belongs to the test run, not the task.`);
      continue;
    }
    if (
      specifier.startsWith("/") ||
      (specifier.includes(":") && !specifier.startsWith("node:"))
    ) {
      problems.push(`${specifier} names a module by absolute path or URL.`);
      continue;
    }
    const relative = specifier.startsWith(".");
    const target = relative
      ? resolveFrom(dir, specifier)
      : specifier.split("/").includes("..")
        ? null
        : specifier;
    if (target === null) {
      problems.push(`${specifier} leaves the project.`);
      continue;
    }
    const top = target.split("/")[0];
    if (relative && (top === HARNESS_DIR || top === MOCKS_DIR))
      problems.push(
        `${specifier} reaches ${target.startsWith(MOCK_RUNTIME_PATH.replace(/\.js$/, "")) ? "the mock runtime" : "the harness"}; task code imports only task code, stubs and packages.`,
      );
  }
  return [...new Set(problems)];
}

/** `../a/b.js` from `src/x` is `src/a/b.js`; null when it leaves the root. */
function resolveFrom(dir: string, specifier: string): string | null {
  const parts = dir.split("/").filter(Boolean);
  for (const part of specifier.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/");
}

/**
 * The tree a submission is graded on: the version's files, public and
 * private, with the submission's task files in place of theirs. Pure; the
 * worker stages `files` and runs `GRADING_COMMANDS` only when nothing was
 * refused.
 */
export function gradingTree(input: {
  /** Every file of the version's build, hidden tests and lockfile included. */
  readonly versionFiles: readonly GeneratedFile[];
  /** The descriptor's `editablePaths`. */
  readonly editablePaths: readonly string[];
  readonly submission: readonly SubmittedFile[];
}): GradingTree {
  const refused: GradingRefusal[] = [];
  const refuse = (path: string, reason: string) =>
    refused.push({ path, reason });
  const version = new Map(input.versionFiles.map((file) => [file.path, file]));
  // Every path the version has or compiles to, as a case-insensitive file
  // system would see it.
  const lowered = new Map(
    input.versionFiles.flatMap((file) => [
      [file.path.toLowerCase(), file.path] as const,
      ...(isScript(file.path)
        ? [[runtimePath(file.path).toLowerCase(), file.path] as const]
        : []),
    ]),
  );
  const editable = new Set(input.editablePaths);
  const owned = new Set(
    input.editablePaths
      .map(dirnameOf)
      .filter(
        (dir) => dir !== "" && !HARNESS_ROOTS.includes(dir.split("/")[0] ?? ""),
      ),
  );
  const taken = new Map<string, string>();
  const seen = new Set<string>();
  for (const file of input.submission) {
    const { path } = file;
    if (seen.has(path)) {
      refuse(path, "The submission holds this path twice.");
      continue;
    }
    seen.add(path);
    const problem = pathProblem(path);
    if (problem !== null) {
      refuse(path, problem);
      continue;
    }
    if (file.symlink === true) {
      refuse(path, "Symbolic links are not taken.");
      continue;
    }
    const existing = version.get(path);
    if (existing !== undefined && existing.text === file.text) continue;
    if (editable.has(path)) {
      taken.set(path, file.text);
      continue;
    }
    const why = newFileProblem(path, version, lowered, owned);
    if (why !== null) {
      refuse(path, why);
      continue;
    }
    taken.set(path, file.text);
  }
  for (const [path, text] of taken)
    for (const reason of taskCodeProblems(path, text)) refuse(path, reason);
  const changed = [...taken.keys()].sort(compare);
  if (refused.length > 0)
    return {
      files: [],
      changed,
      refused: refused.sort((a, b) => compare(a.path, b.path)),
    };
  const files = new Map(version);
  for (const [path, text] of taken)
    files.set(path, {
      path,
      text,
      class: "source",
      public: version.get(path)?.public ?? true,
    });
  return {
    files: [...files.values()].sort((a, b) => compare(a.path, b.path)),
    changed,
    refused: [],
  };
}

/** Why a path outside the editable list cannot be added; null when it can. */
function newFileProblem(
  path: string,
  version: ReadonlyMap<string, GeneratedFile>,
  lowered: ReadonlyMap<string, string>,
  owned: ReadonlySet<string>,
): string | null {
  const config = CONFIG_FILES[path];
  if (config !== undefined) return config;
  if (/^tsconfig[^/]*\.json$/.test(path))
    return "Compiler configuration is the version's.";
  const top = path.split("/")[0] ?? "";
  if (path.includes("/") && HARNESS_ROOTS.includes(top))
    return `${top}/ is the version's harness.`;
  const existing = version.get(path);
  if (existing !== undefined)
    return `${path} is a ${existing.class} file of the version, not a task file.`;
  if (!isScript(path) || !/\.tsx?$/.test(path))
    return "Only TypeScript files (.ts, .tsx) can be added.";
  if (/\.(?:test|spec)\.tsx?$/.test(path))
    return "Test files are the version's.";
  if (!owned.has(dirnameOf(path)))
    return "New files go beside the task's editable files, in a directory that already holds one.";
  for (const output of [path, runtimePath(path), declarationPath(path)]) {
    const clash = lowered.get(output.toLowerCase());
    if (clash !== undefined && clash !== path)
      return `It would land on ${clash}, a file of the version.`;
  }
  return null;
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
