/**
 * The contribution folder on disk: unpacking a downloaded archive into it,
 * the extension's note of which contribution it is, and reading it back
 * as the zip a submission uploads.
 *
 * Unpacking trusts nothing in the archive. `zip.ts` refuses unsafe names
 * before a byte is inflated; here symbolic links in the archive are
 * refused, every target is resolved under the folder's real path again,
 * and no target may pass through or land on a symbolic link already in a
 * folder being overwritten, all before the first file is written; each
 * parent's real path is checked again as it is written.
 *
 * Reading the folder skips what the API skips unread (`skippedName`:
 * `node_modules/`, `.git/`, OS files), the extension's own `.lunox/`, and
 * the build's output beside its source (`isBuildOutput`, judged against
 * the version's files as the API judges it), so none of it is uploaded.
 * Symbolic links are not followed or uploaded; they are reported.
 */

import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import { PROJECT_ARCHIVE_MAX_BYTES } from "@sandbox-factory/shared";
import { isBuildOutput, LUNOX_DIR, skippedName } from "sandbox-factory";

import {
  listZip,
  readZipEntry,
  ZipError,
  type ZipEntry,
  type ZipListing,
} from "./zip.js";

/** The extension's note, at the project's root. Never holds a token. */
export const CONTRIBUTION_NOTE_PATH = `${LUNOX_DIR}/contribution.json`;

export interface ContributionNote {
  readonly schemaVersion: 1;
  readonly versionId: string;
  /** The folder name the archive packs everything under (`sbx_1-v2`). */
  readonly root: string;
  /** The platform it was downloaded from. */
  readonly platformUrl: string;
}

/** What one archive may unpack to, summed over its declared sizes. */
export const UNPACK_LIMITS = {
  files: 10_000,
  totalBytes: PROJECT_ARCHIVE_MAX_BYTES,
} as const;

/** What one upload may hold: the API reads at most this many files. */
export const COLLECT_LIMITS = { files: 5_000 } as const;

/** Names an OS drops into any folder; a folder of only these is empty. */
const OS_LITTER = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

export type FolderState = "missing" | "empty" | "occupied";

export async function folderState(path: string): Promise<FolderState> {
  try {
    const names = await readdir(path);
    return names.every((name) => OS_LITTER.has(name)) ? "empty" : "occupied";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

/** The one top folder every entry sits under (`sbx_1-v2/`), or `""`. */
function topFolder(entries: readonly ZipListing[]): string {
  const first = entries[0]?.name.split("/")[0];
  if (first === undefined) return "";
  const prefix = `${first}/`;
  return entries.every(
    (entry) => entry.name.startsWith(prefix) || entry.name === first,
  ) && entries.some((entry) => entry.name.startsWith(prefix))
    ? prefix
    : "";
}

/** Whether a path under `base`, or a folder between, is a symbolic link. */
async function linkOnPath(base: string, target: string): Promise<boolean> {
  const steps = target.slice(base.length).split(sep).filter(Boolean);
  let at = base;
  for (const step of steps) {
    at = join(at, step);
    const found = await lstat(at).catch(() => null);
    if (found === null) return false;
    if (found.isSymbolicLink()) return true;
  }
  return false;
}

const inside = (base: string, path: string) =>
  path === base || path.startsWith(base.endsWith(sep) ? base : base + sep);

/**
 * Unpacks the archive into `destination`, its one top folder stripped,
 * replacing files with the same names. Throws `ZipError` before writing
 * anything when an entry is unsafe or the archive is over its limits.
 */
export async function unpackArchive(
  bytes: Uint8Array,
  destination: string,
): Promise<{ readonly files: number; readonly root: string }> {
  const entries = listZip(bytes);
  const prefix = topFolder(entries);
  const files = entries.filter((entry) => !entry.directory);
  for (const entry of files)
    if (entry.symlink)
      throw new ZipError(
        "unsafe_path",
        `${entry.name} is a symbolic link; links are not unpacked.`,
      );
  if (files.length > UNPACK_LIMITS.files)
    throw new ZipError(
      "too_many_entries",
      `The archive holds ${files.length} files; at most ${UNPACK_LIMITS.files} are unpacked.`,
    );
  const total = files.reduce((sum, entry) => sum + entry.size, 0);
  if (total > UNPACK_LIMITS.totalBytes)
    throw new ZipError(
      "entry_too_large",
      `The archive unpacks to ${total} bytes; at most ${UNPACK_LIMITS.totalBytes}.`,
    );
  await mkdir(destination, { recursive: true });
  const base = await realpath(destination);
  const planned = files.map((entry) => {
    const name = entry.name.slice(prefix.length);
    const target = resolve(base, ...name.split("/"));
    if (name === "" || !inside(base, target) || target === base)
      throw new ZipError(
        "unsafe_path",
        `${entry.name} would land outside the folder.`,
      );
    return { entry, target };
  });
  // On disk, before anything is written: no path may pass through, or
  // land on, a symbolic link already in the folder.
  for (const { entry, target } of planned)
    if (await linkOnPath(base, target))
      throw new ZipError(
        "unsafe_path",
        `${entry.name}: the folder holds a symbolic link on its path; nothing is written through one.`,
      );
  for (const { entry, target } of planned) {
    const data = readZipEntry(bytes, entry, UNPACK_LIMITS.totalBytes);
    const parent = dirname(target);
    await mkdir(parent, { recursive: true });
    // Checked again as written, should the folder change meanwhile.
    if (!inside(base, await realpath(parent)))
      throw new ZipError(
        "unsafe_path",
        `${entry.name}: a folder on its path links outside the project.`,
      );
    await writeFile(target, data);
  }
  return { files: planned.length, root: prefix.replace(/\/$/, "") };
}

export async function writeNote(
  folder: string,
  note: ContributionNote,
): Promise<void> {
  await mkdir(join(folder, LUNOX_DIR), { recursive: true });
  await writeFile(
    join(folder, ...CONTRIBUTION_NOTE_PATH.split("/")),
    `${JSON.stringify(note, null, 2)}\n`,
  );
}

/** The folder's note, or null when it has none or it is not one. */
export async function readNote(
  folder: string,
): Promise<ContributionNote | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      await readFile(
        join(folder, ...CONTRIBUTION_NOTE_PATH.split("/")),
        "utf8",
      ),
    );
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const note = parsed as Record<string, unknown>;
  return note["schemaVersion"] === 1 &&
    typeof note["versionId"] === "string" &&
    note["versionId"] !== "" &&
    typeof note["root"] === "string" &&
    typeof note["platformUrl"] === "string"
    ? {
        schemaVersion: 1,
        versionId: note["versionId"],
        root: note["root"],
        platformUrl: note["platformUrl"],
      }
    : null;
}

export interface CollectedFolder {
  /** Each file at its `/`-separated path in the project, sorted. */
  readonly entries: readonly ZipEntry[];
  /** Left out: installed packages, version control, OS files, `.lunox/`, build output. */
  readonly skipped: number;
  /** Symbolic links, neither followed nor uploaded. */
  readonly links: readonly string[];
}

/**
 * The folder's files as a submission uploads them. `versionPaths` are the
 * version's files (the handout's list): one of them is never build output.
 */
export async function collectFolder(
  root: string,
  versionPaths: ReadonlySet<string>,
): Promise<CollectedFolder> {
  const paths: string[] = [];
  const links: string[] = [];
  let skipped = 0;
  async function walk(directory: string, prefix: string): Promise<void> {
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children) {
      const path = `${prefix}${child.name}`;
      if (skippedName(path) || path === LUNOX_DIR) {
        skipped += 1;
        continue;
      }
      if (child.isSymbolicLink()) links.push(path);
      else if (child.isDirectory())
        await walk(join(directory, child.name), `${path}/`);
      else if (child.isFile()) paths.push(path);
    }
  }
  await walk(root, "");
  const present = new Set(paths);
  const kept = paths
    .filter((path) => {
      const output = isBuildOutput(path, present, versionPaths);
      if (output) skipped += 1;
      return !output;
    })
    .sort();
  if (kept.length > COLLECT_LIMITS.files)
    throw new RangeError(
      `The folder holds ${kept.length} files to upload; at most ${COLLECT_LIMITS.files} are read.`,
    );
  const entries: ZipEntry[] = [];
  for (const path of kept)
    entries.push({
      name: path,
      bytes: await readFile(join(root, ...path.split("/"))),
    });
  return { entries, skipped, links: links.sort() };
}
