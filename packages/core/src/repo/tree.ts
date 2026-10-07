/**
 * What a repository's file list says about it, without reading a file.
 *
 * The input is the tree a snapshot records: every file's path and size, as
 * Git lists them at one commit. The output, `TreeFacts`, is the `file-tree`
 * fact source the pricing ladder reads, and what the sizing draft's
 * repository outline is drawn from: which modules there are and how big,
 * what the code is written in, how much of it is tests, and whether the
 * repository carries lockfiles, migrations or infrastructure.
 *
 * Pure and deterministic: the same entries in any order give the same facts,
 * so two snapshots of one commit cannot disagree and a test needs no fixture
 * beyond a list of paths.
 */

/** One file in a tree. Directories are implied by the paths under them. */
export interface TreeEntry {
  /** Repository-relative, `/`-separated, no leading slash. */
  readonly path: string;
  /** In bytes. A submodule, which has none, counts as zero. */
  readonly size: number;
}

/** One module: a top-level unit of the repository, as `moduleOf` draws it. */
export interface TreeModule {
  /** `packages/db`, `src/api`, `docs`, or `.` for files at the root. */
  readonly path: string;
  readonly files: number;
  readonly bytes: number;
  readonly testFiles: number;
  /** File counts by extension, keys sorted; see `extensionOf`. */
  readonly extensions: Readonly<Record<string, number>>;
}

export interface TreeFacts {
  /** Bumped when what a fact means changes, so stored facts can be told apart. */
  readonly version: typeof TREE_FACTS_VERSION;
  readonly fileCount: number;
  readonly totalBytes: number;
  /**
   * GitHub stops listing a tree past its own size cap and says so. The facts
   * then describe the files it did list, which is a lower bound.
   */
  readonly truncated: boolean;
  readonly testFiles: number;
  /** Sorted by path. */
  readonly modules: readonly TreeModule[];
  /** File counts by extension across the repository, keys sorted. */
  readonly extensions: Readonly<Record<string, number>>;
  /** Paths of dependency lockfiles, sorted, at most `PATH_LIST_MAX`. */
  readonly lockfiles: readonly string[];
  /**
   * Directories holding schema migrations, sorted. Not capped: the pricing
   * profile asks whether a touched module holds migrations, and a cap would
   * answer no for every module past it. Only the outermost are kept, so a
   * repository lists about one per module that keeps migrations, and the
   * module list is not capped either; surfaces that show it cap what they
   * show.
   */
  readonly migrationDirectories: readonly string[];
  /**
   * Directories holding deployment or CI configuration, and CI files known
   * by name (`CI_FILE_NAMES`, as their paths), sorted, capped.
   */
  readonly infraDirectories: readonly string[];
}

export const TREE_FACTS_VERSION = 1;

/** The most paths any one list in `TreeFacts` keeps. */
export const PATH_LIST_MAX = 50;

/** The module that holds the files at the repository's root. */
export const ROOT_MODULE = ".";

/**
 * Directories whose children are the modules, rather than the directory
 * itself: `packages/db` and `packages/web` are two modules, where `docs/a`
 * and `docs/b` are both `docs`.
 */
export const MODULE_ROOTS: readonly string[] = [
  "src",
  "lib",
  "libs",
  "packages",
  "apps",
  "services",
  "modules",
  "crates",
  "cmd",
  "internal",
  "pkg",
];

/** The key for a file with no extension: `Dockerfile`, `.gitignore`. */
export const NO_EXTENSION = "(none)";

/** File names that pin a dependency graph, in any directory. */
export const LOCKFILE_NAMES: readonly string[] = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "deno.lock",
  "Cargo.lock",
  "Gemfile.lock",
  "poetry.lock",
  "Pipfile.lock",
  "uv.lock",
  "pdm.lock",
  "composer.lock",
  "go.sum",
  "mix.lock",
  "Podfile.lock",
  "packages.lock.json",
  "gradle.lockfile",
  "flake.lock",
];

/** Directory names that hold schema migrations. */
export const MIGRATION_DIRECTORY_NAMES: readonly string[] = [
  "migrations",
  "migration",
  "migrate",
  "alembic",
];

/** Directory names that hold deployment or CI configuration. */
export const INFRA_DIRECTORY_NAMES: readonly string[] = [
  "infra",
  "infrastructure",
  "terraform",
  "deploy",
  "deployment",
  "deployments",
  "k8s",
  "kubernetes",
  "helm",
  ".circleci",
];

/**
 * Files that configure CI by their name alone, in any directory. They are
 * listed among `infraDirectories` by path, since a repository whose only CI
 * is a root `.gitlab-ci.yml` has no directory to name.
 */
export const CI_FILE_NAMES: readonly string[] = [
  ".gitlab-ci.yml",
  "Jenkinsfile",
  "azure-pipelines.yml",
  "bitbucket-pipelines.yml",
];

/** Directory names whose files are all tests. */
const TEST_DIRECTORY_NAMES: readonly string[] = ["__tests__", "test", "tests"];

const LOCKFILES = new Set(LOCKFILE_NAMES);
const MIGRATION_DIRECTORIES = new Set(MIGRATION_DIRECTORY_NAMES);
const INFRA_DIRECTORIES = new Set(INFRA_DIRECTORY_NAMES);
const CI_FILES = new Set(CI_FILE_NAMES);
const TEST_DIRECTORIES = new Set(TEST_DIRECTORY_NAMES);
const ROOTS = new Set(MODULE_ROOTS);

/** A path without a leading `./` or `/` and without a trailing `/`. */
export function normalizePath(path: string): string {
  const trimmed = path.trim().replace(/^(?:\.\/|\/)+/, "");
  // A scan rather than /\/+$/, which backtracks quadratically on a long run
  // of slashes that does not end the string; paths come from GitHub's trees.
  let end = trimmed.length;
  while (end > 0 && trimmed[end - 1] === "/") end -= 1;
  return trimmed.slice(0, end);
}

/**
 * The module a file belongs to. A file under one of `MODULE_ROOTS` belongs
 * to the root's child directory (`packages/db/src/x.ts` → `packages/db`),
 * or to the root itself when it sits directly in it (`src/main.ts` →
 * `src`). Anything else belongs to its first directory, and a file at the
 * repository's root to `ROOT_MODULE`.
 */
export function moduleOf(path: string): string {
  const segments = normalizePath(path).split("/");
  const [first, second] = segments;
  if (first === undefined || segments.length === 1) return ROOT_MODULE;
  if (ROOTS.has(first) && second !== undefined && segments.length > 2) {
    return `${first}/${second}`;
  }
  return first;
}

/**
 * A file's extension, lower-cased and without its dot, or `NO_EXTENSION`.
 * A leading dot names a hidden file rather than starting an extension, so
 * `.gitignore` has none and `.eslintrc.json` is `json`.
 */
export function extensionOf(path: string): string {
  const name = normalizePath(path).split("/").at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  return dot <= 0 || dot === name.length - 1
    ? NO_EXTENSION
    : name.slice(dot + 1).toLowerCase();
}

/**
 * Whether a file is a test: named `*.test.*` or `*.spec.*`, or anywhere
 * under a `__tests__`, `test` or `tests` directory.
 */
export function isTestFile(path: string): boolean {
  const segments = normalizePath(path).split("/");
  const name = segments.at(-1) ?? "";
  if (/\.(?:test|spec)\.[^.]+$/i.test(name)) return true;
  return segments.slice(0, -1).some((segment) => TEST_DIRECTORIES.has(segment));
}

/** The facts for one tree. `entries` may arrive in any order. */
export function treeFacts(
  entries: readonly TreeEntry[],
  options: { readonly truncated?: boolean } = {},
): TreeFacts {
  const modules = new Map<
    string,
    { files: number; bytes: number; testFiles: number; extensions: Counts }
  >();
  const extensions: Counts = new Map();
  const lockfiles = new Set<string>();
  const migrationDirectories = new Set<string>();
  const infraDirectories = new Set<string>();
  const ciFiles = new Set<string>();
  let totalBytes = 0;
  let testFiles = 0;
  let fileCount = 0;

  for (const entry of entries) {
    const path = normalizePath(entry.path);
    if (path === "") continue;
    const size = Number.isFinite(entry.size) && entry.size > 0 ? entry.size : 0;
    const segments = path.split("/");
    const name = segments.at(-1) ?? "";
    const extension = extensionOf(path);
    const test = isTestFile(path);

    fileCount += 1;
    totalBytes += size;
    if (test) testFiles += 1;
    bump(extensions, extension);

    const key = moduleOf(path);
    const module = modules.get(key) ?? {
      files: 0,
      bytes: 0,
      testFiles: 0,
      extensions: new Map(),
    };
    module.files += 1;
    module.bytes += size;
    if (test) module.testFiles += 1;
    bump(module.extensions, extension);
    modules.set(key, module);

    if (LOCKFILES.has(name)) lockfiles.add(path);
    const directories = segments.slice(0, -1);
    directories.forEach((segment, index) => {
      const directory = directories.slice(0, index + 1).join("/");
      if (MIGRATION_DIRECTORIES.has(segment.toLowerCase())) {
        migrationDirectories.add(directory);
      }
      if (INFRA_DIRECTORIES.has(segment.toLowerCase())) {
        infraDirectories.add(directory);
      }
    });
    // CI and Terraform are recognised by what they hold, wherever they sit.
    if (directories.join("/") === ".github/workflows") {
      infraDirectories.add(".github/workflows");
    }
    if (extension === "tf" && directories.length > 0) {
      infraDirectories.add(directories.join("/"));
    }
    if (CI_FILES.has(name)) ciFiles.add(path);
  }

  return {
    version: TREE_FACTS_VERSION,
    fileCount,
    totalBytes,
    truncated: options.truncated ?? false,
    testFiles,
    modules: [...modules.entries()]
      .sort(([left], [right]) => compare(left, right))
      .map(([path, module]) => ({
        path,
        files: module.files,
        bytes: module.bytes,
        testFiles: module.testFiles,
        extensions: sortedCounts(module.extensions),
      })),
    extensions: sortedCounts(extensions),
    lockfiles: capped(lockfiles),
    migrationDirectories: outermost(migrationDirectories),
    // A CI file is kept even inside a listed directory (`infra/Jenkinsfile`
    // under `infra`): it is what says the repository runs CI.
    infraDirectories: capped(
      new Set([...outermost(infraDirectories), ...ciFiles]),
    ),
  };
}

/**
 * The modules a set of paths touches: each module a path falls inside, and
 * each module inside a path that names a directory (`packages` touches every
 * `packages/*`). Paths matching no module are ignored. Sorted, no repeats.
 *
 * What turns the files or directories a bounty names into the modules the
 * pricing ladder counts as touched.
 */
export function modulesFor(
  facts: Pick<TreeFacts, "modules">,
  paths: readonly string[],
): string[] {
  const touched = new Set<string>();
  const hasRoot = facts.modules.some(({ path }) => path === ROOT_MODULE);
  for (const raw of paths) {
    const path = normalizePath(raw);
    if (path === "") continue;
    let directory = false;
    let container: string | undefined;
    for (const { path: module } of facts.modules) {
      if (module === ROOT_MODULE) continue;
      if (path === module || module.startsWith(`${path}/`)) {
        directory = true;
        touched.add(module);
      } else if (path.startsWith(`${module}/`)) {
        if (container === undefined || module.length > container.length) {
          container = module;
        }
      }
    }
    // A module such as `src` counts only its direct files when `src/api`
    // is also a module. A directory still touches all modules inside it.
    if (!directory && container !== undefined) touched.add(container);
    // One segment naming no directory is a file at the root.
    if (hasRoot && !directory && !path.includes("/")) touched.add(ROOT_MODULE);
  }
  return [...touched].sort(compare);
}

/**
 * A module's extensions, most files first, ties by name: what the module is
 * mostly written in.
 */
export function dominantExtensions(
  module: Pick<TreeModule, "extensions">,
  limit: number,
): string[] {
  return Object.entries(module.extensions)
    .sort(([a, left], [b, right]) => right - left || compare(a, b))
    .slice(0, Math.max(0, limit))
    .map(([extension]) => extension);
}

type Counts = Map<string, number>;

function bump(counts: Counts, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

/** Code-point order, not locale order, so the result is the same everywhere. */
function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedCounts(counts: Counts): Record<string, number> {
  return Object.fromEntries(
    [...counts.entries()].sort(([left], [right]) => compare(left, right)),
  );
}

function capped(paths: Set<string>): string[] {
  return [...paths].sort(compare).slice(0, PATH_LIST_MAX);
}

/**
 * The directories not inside another listed one, sorted: `infra`, not
 * `infra/env`. Uncapped; a caller that stores a display list caps it.
 */
function outermost(directories: Set<string>): string[] {
  const sorted = [...directories].sort(compare);
  return sorted.filter(
    (directory) =>
      !sorted.some(
        (other) => other !== directory && directory.startsWith(`${other}/`),
      ),
  );
}
