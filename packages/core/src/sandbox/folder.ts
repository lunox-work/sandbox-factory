/**
 * A contributor's whole project folder as a submission: the folder they
 * downloaded and worked in, zipped or picked in the browser, compared with
 * the version's public project to find what they changed.
 *
 * What a folder holds beyond the task is sorted three ways before anything
 * is taken:
 *
 * - **Skipped** without being read: installed packages (`node_modules/`),
 *   version control (`.git/`), the OS's own files (`__MACOSX/`,
 *   `.DS_Store`, `._*`, `Thumbs.db`, `desktop.ini`) and what the build
 *   writes beside its source (a `.js` beside a `.ts`, every `.map`) unless
 *   the version has that file. Matched by name alone (`skippedName`), so a
 *   reader need not inflate them.
 * - **Ignored**, read but never submitted: the guide and editor files
 *   (`isGuidePath`: `TASK.md`, `AGENTS.md`, `CLAUDE.md`, `README.md`,
 *   `.vscode/`, `.idea/`, and `.lunox/`, where the VS Code extension notes
 *   which contribution a folder is), which are the contributor's to read
 *   and their editor's to write. Unless the version lists one as editable.
 * - **Taken** or **refused**: every other file that differs from the
 *   version's. A changed editable file and a new file are graded by
 *   `gradingTree`'s own rules, so what this refuses is what grading would;
 *   a changed read-only file is refused by name ("revert it"), as grading
 *   refuses it. Nothing is refused that grading would take.
 *
 * A file that differs from the version's only in line endings (CRLF for
 * LF) is unchanged. A version file the folder lacks keeps the version's
 * text, as a `files[]` submission that leaves it out does; an editable one
 * is refused instead, since the contributor most likely deleted it and a
 * submission cannot express a deletion yet (the merge patch carries whole
 * files only).
 *
 * Pure: the caller reads the archive and the version's bytes. The JSON
 * `files[]` route drops guide files and build output the same way
 * (`withoutGuideFiles`, `withoutBuildOutput`), so its `?dryRun=1` preview,
 * which runs this, and its submission agree.
 */

import {
  AGENTS_GUIDE_PATH,
  CLAUDE_GUIDE_PATH,
  LUNOX_DIR,
  TASK_GUIDE_PATH,
  VSCODE_DIR,
} from "./guide.js";
import { gradingTree, type GradingRefusal } from "./grading.js";
import { PLATFORM_LAYOUT, type GradingLayout } from "./layout.js";

/** The guide files at the project's root, beside `.vscode/`. */
export const GUIDE_FILES: readonly string[] = [
  TASK_GUIDE_PATH,
  AGENTS_GUIDE_PATH,
  CLAUDE_GUIDE_PATH,
  "README.md",
];
/** Editor folders: settings an editor (or its extension) writes as it pleases. */
export const EDITOR_DIRS: readonly string[] = [VSCODE_DIR, ".idea", LUNOX_DIR];

/** Whether a path is a guide or editor file, the contributor's and never a submission's. */
export function isGuidePath(path: string): boolean {
  return (
    GUIDE_FILES.includes(path) ||
    EDITOR_DIRS.some((dir) => path.startsWith(`${dir}/`))
  );
}

/**
 * Submitted files without the guide and editor files the version does not
 * list as editable, and the paths dropped. What a `files[]` submission is
 * stored as, so a changed `.vscode/settings.json` sent along with the task
 * is not refused; the version's own copy is graded either way.
 */
export function withoutGuideFiles<T extends { readonly path: string }>(
  files: readonly T[],
  editablePaths: readonly string[],
): { readonly kept: T[]; readonly ignored: string[] } {
  const editable = new Set(editablePaths);
  const kept: T[] = [];
  const ignored: string[] = [];
  for (const file of files)
    if (isGuidePath(file.path) && !editable.has(file.path))
      ignored.push(file.path);
    else kept.push(file);
  return { kept, ignored };
}

const SKIPPED_SEGMENTS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "__MACOSX",
]);
const SKIPPED_NAMES: ReadonlySet<string> = new Set([
  ".DS_Store",
  "Thumbs.db",
  "desktop.ini",
]);

/**
 * Whether an archive entry is skipped by its name alone, wherever it sits:
 * installed packages, version control and the OS's own files. Never part
 * of a project, so never read.
 */
export function skippedName(name: string): boolean {
  const segments = name.split("/").filter((segment) => segment !== "");
  const base = segments.at(-1) ?? "";
  return (
    segments.some((segment) => SKIPPED_SEGMENTS.has(segment)) ||
    SKIPPED_NAMES.has(base) ||
    base.startsWith("._")
  );
}

/** The sources a build would emit `path` from. */
function emittingSources(path: string): string[] {
  if (path.endsWith(".mjs")) return [`${path.slice(0, -4)}.mts`];
  if (path.endsWith(".cjs")) return [`${path.slice(0, -4)}.cts`];
  if (path.endsWith(".js") || path.endsWith(".jsx")) {
    const stem = path.replace(/\.jsx?$/, "");
    return [`${stem}.ts`, `${stem}.tsx`];
  }
  return [];
}

interface PathSet {
  has(path: string): boolean;
}

/**
 * Whether `path` is what the build writes beside its source rather than
 * the contributor's work: any `.map`, or a `.js` (`.jsx`, `.mjs`, `.cjs`)
 * beside its `.ts` among the files sent (`present`) or the version's. A
 * file the version itself has is never build output.
 */
export function isBuildOutput(
  path: string,
  present: PathSet,
  version: PathSet,
): boolean {
  if (version.has(path)) return false;
  return (
    path.endsWith(".map") ||
    emittingSources(path).some(
      (source) => present.has(source) || version.has(source),
    )
  );
}

/**
 * Submitted files without the build output among them (`isBuildOutput`),
 * and the paths dropped: what a `files[]` submission is stored as, exactly
 * what its preview and a zipped folder leave out. Grading would refuse a
 * new `.js` as a file outside the task, and its build writes it anyway.
 */
export function withoutBuildOutput<T extends { readonly path: string }>(
  files: readonly T[],
  versionPaths: Iterable<string>,
): { readonly kept: T[]; readonly dropped: string[] } {
  const present = new Set(files.map((file) => file.path));
  const version = new Set(versionPaths);
  const kept: T[] = [];
  const dropped: string[] = [];
  for (const file of files)
    if (isBuildOutput(file.path, present, version)) dropped.push(file.path);
    else kept.push(file);
  return { kept, dropped };
}

/**
 * The folder the entries share as their one top directory, which a zipped
 * folder holds everything under (`sbx_1-v2/src/a.ts`), as `"sbx_1-v2/"`;
 * `""` when the entries sit at the root. Chosen by which reading lands
 * more of them on the version's paths, so a folder zipped from inside
 * reads as well as one zipped from outside.
 */
export function folderPrefix(
  names: readonly string[],
  versionPaths: ReadonlySet<string>,
): string {
  const files = names.filter((name) => !name.endsWith("/"));
  const first = files[0]?.split("/")[0];
  if (
    first === undefined ||
    !files.every((name) => name.startsWith(`${first}/`))
  )
    return "";
  const prefix = `${first}/`;
  const hits = (strip: string) =>
    files.filter((name) => versionPaths.has(name.slice(strip.length))).length;
  return hits(prefix) >= hits("") ? prefix : "";
}

/** One file of the folder, at its path in the project, as read. */
export interface FolderFile {
  readonly path: string;
  readonly sha256: string;
  /** Its text; null when it is not UTF-8. */
  readonly text: string | null;
  readonly symlink?: boolean;
}

/** One file of the version's public project, by its listed hash. */
export interface FolderVersionFile {
  readonly path: string;
  readonly sha256: string;
  /**
   * Its text, needed for each path the folder holds with another hash: to
   * tell a line-ending change from an edit, and for grading's own check.
   */
  readonly text?: string;
}

export interface FolderSubmission {
  /** The files to submit, each whole, sorted by path; empty when refused. */
  readonly files: readonly { readonly path: string; readonly text: string }[];
  /** What the submission changes or adds, sorted by path. */
  readonly changed: readonly {
    readonly path: string;
    readonly change: "changed" | "added";
  }[];
  /** Guide and editor files that differ from the version's, never submitted. */
  readonly ignored: readonly string[];
  /** Build output beside its source, not read. */
  readonly buildOutput: number;
  /** Read-only version files the folder lacks; the version's text stands. */
  readonly missing: readonly string[];
  /** How many of the version's files the folder holds; 0 for another folder. */
  readonly matched: number;
  /** Why it cannot be submitted, by path; empty when it can. */
  readonly refused: readonly GradingRefusal[];
}

const lf = (text: string) => text.replace(/\r\n/g, "\n");
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * What a folder submits: its files that differ from the version's, guide
 * and editor files and build output aside, with every refusal grading
 * would make of them, by path. Entries `skippedName` skips should not be
 * passed; build output is recognised here, against the folder's sources
 * and the version's.
 */
export function folderSubmission(input: {
  readonly files: readonly FolderFile[];
  readonly version: readonly FolderVersionFile[];
  /** The descriptor's `editablePaths`. */
  readonly editablePaths: readonly string[];
  readonly layout?: GradingLayout;
}): FolderSubmission {
  const layout = input.layout ?? PLATFORM_LAYOUT;
  const version = new Map(input.version.map((file) => [file.path, file]));
  const editable = new Set(input.editablePaths);
  const present = new Set(input.files.map((file) => file.path));
  const refused: GradingRefusal[] = [];
  const ignored: string[] = [];
  const candidates: { path: string; text: string }[] = [];
  let buildOutput = 0;
  let matched = 0;
  for (const file of input.files) {
    const { path } = file;
    const own = version.get(path);
    if (own !== undefined) matched += 1;
    if (isBuildOutput(path, present, version)) {
      buildOutput += 1;
      continue;
    }
    if (own !== undefined && own.sha256 === file.sha256) continue;
    const guide = isGuidePath(path) && !editable.has(path);
    if (file.symlink === true) {
      if (!guide)
        refused.push({ path, reason: "Symbolic links are not taken." });
      continue;
    }
    if (
      own !== undefined &&
      file.text !== null &&
      own.text !== undefined &&
      lf(own.text) === lf(file.text)
    )
      continue;
    if (guide) {
      ignored.push(path);
      continue;
    }
    if (own !== undefined && !editable.has(path)) {
      refused.push({
        path,
        reason: `${layout.configFiles[path] ?? "This file is the version's, not a task file."} Revert it to the version's text.`,
      });
      continue;
    }
    if (file.text === null) {
      refused.push({
        path,
        reason: "Only text files are submitted; this one is not UTF-8 text.",
      });
      continue;
    }
    candidates.push({ path, text: file.text });
  }
  const missing: string[] = [];
  for (const own of input.version) {
    if (present.has(own.path)) continue;
    if (editable.has(own.path))
      refused.push({
        path: own.path,
        reason:
          "Deleted. A submission cannot delete a file yet: restore it from the downloaded project.",
      });
    else if (!isGuidePath(own.path)) missing.push(own.path);
  }
  // Grading's own rules on what is left: a new file where one may go,
  // and task code that keeps clear of the test run.
  const tree = gradingTree({
    versionFiles: input.version.map((file) => ({
      path: file.path,
      text: file.text ?? "",
      class: "source",
      public: true,
    })),
    editablePaths: input.editablePaths,
    submission: candidates,
    layout,
  });
  refused.push(...tree.refused);
  const changed = candidates
    .map(({ path }) => ({
      path,
      change: version.has(path) ? ("changed" as const) : ("added" as const),
    }))
    .sort((a, b) => compare(a.path, b.path));
  return {
    files:
      refused.length > 0
        ? []
        : [...candidates].sort((a, b) => compare(a.path, b.path)),
    changed,
    ignored: ignored.sort(compare),
    buildOutput,
    missing: missing.sort(compare),
    matched,
    refused: refused.sort((a, b) => compare(a.path, b.path)),
  };
}
