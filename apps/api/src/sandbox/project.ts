/**
 * A built version's public project, as a contributor gets it: the files
 * its build committed under `project/`, at their paths in the project.
 *
 * Nothing here decides who may read it. The handout, the archive and the
 * paged file read call `publicProject` after their own access check, so a
 * later route (a contributor's invite) reuses the same builder under
 * another rule. Nothing under `private/` can reach an archive or a page:
 * both are built from `publicProject`'s list alone, which is the
 * handout's, and every file's bytes are checked against the size and
 * sha256 the handout lists before they are served.
 */

import { createHash } from "node:crypto";

import type {
  AnalysisRunStore,
  ArtifactStore,
  ObjectStore,
  SandboxStore,
  StoredArtifact,
} from "@sandbox-factory/db";
import {
  HANDOUT_PAGE_MAX_FILES,
  PROJECT_ARCHIVE_MAX_BYTES,
  SANDBOX_FILE_TEXT_MAX_BYTES,
  type HandoutFilesDto,
} from "@sandbox-factory/shared";

import {
  layoutOf,
  TASK_DESCRIPTOR_PATH,
  type GradingLayout,
  type SandboxBuildManifest,
} from "sandbox-factory";

import { textOf } from "../object-text.js";
import { zip, ZIP_MAX_ENTRIES, type ZipArchive } from "./zip.js";

/** The build's folder of what contributors get. */
const PROJECT_PREFIX = "project/";

/** One public file, at its path in the project, and where its bytes are. */
export interface ProjectFile {
  readonly path: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly objectKey: string;
}

export interface PublicProject {
  readonly versionId: string;
  /** The build run whose committed files these are; null before a build. */
  readonly run: { readonly id: string; readonly status: string } | null;
  /** Every artifact the run committed, private ones included. */
  readonly artifacts: readonly StoredArtifact[];
  /** The public files, in the order the run committed them. */
  readonly files: readonly ProjectFile[];
  /**
   * The folder the archive unpacks to: the sandbox's id and the version's
   * number, both opaque, so no title (which a person wrote and may name
   * the workspace) reaches a contributor's disk.
   */
  readonly root: string;
}

/** The public files among a build's committed artifacts. */
export function projectFilesOf(
  artifacts: readonly StoredArtifact[],
): ProjectFile[] {
  return artifacts
    .filter((file) => file.path.startsWith(PROJECT_PREFIX))
    .map(({ path, sizeBytes, sha256, objectKey }) => ({
      path: path.slice(PROJECT_PREFIX.length),
      sizeBytes,
      sha256,
      objectKey,
    }));
}

/**
 * A version's public project in `owner`, or null when there is no such
 * version. Only what its build run committed: a running build's preview
 * may change.
 */
export async function publicProject(
  stores: {
    readonly sandboxes: Pick<SandboxStore, "getVersion">;
    readonly runs: Pick<AnalysisRunStore, "get">;
    readonly artifacts: Pick<ArtifactStore, "list">;
  },
  owner: string,
  versionId: string,
): Promise<PublicProject | null> {
  const stored = await stores.sandboxes.getVersion(owner, versionId);
  if (stored === null) return null;
  const runId = stored.source.buildRunId;
  const run = runId === null ? null : await stores.runs.get(owner, runId);
  const artifacts =
    run === null ? [] : await stores.artifacts.list(owner, run.id);
  return {
    versionId: stored.version.id,
    run: run === null ? null : { id: run.id, status: run.status },
    artifacts,
    files: projectFilesOf(artifacts),
    root: rootOf(stored.version.sandboxId, stored.version.version),
  };
}

/** `sbx_ab12-v3`: lower-case letters, digits, `-` and `_` only. */
export function rootOf(sandboxId: string, version: number): string {
  const id = sandboxId.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  return `${id === "" ? "sandbox" : id}-v${version}`;
}

/**
 * A path an unzipper writes where it says: relative, `/`-separated, no
 * `.`, `..` or empty segment, no backslash, drive or control character.
 */
export function isSafeProjectPath(path: string): boolean {
  if (path === "" || path.startsWith("/") || /[\\\0-\x1f\x7f]/.test(path))
    return false;
  if (/^[A-Za-z]:/.test(path)) return false;
  return path
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** In archive order: by path, so the same files always zip the same way. */
function ordered(files: readonly ProjectFile[]): ProjectFile[] {
  return [...files].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
}

/**
 * The project's name: a hash over the archive format, its root and each
 * file's sha256 and path. The archive's bytes follow from these alone, so
 * it is the archive's (strong) ETag, and a page cursor carries it to tell
 * a rebuilt project from the one it started on.
 */
export function projectSha256(project: PublicProject): string {
  const hash = createHash("sha256").update(`zip-v1\n${project.root}\n`);
  for (const file of ordered(project.files))
    hash.update(`${file.sha256}  ${file.path}\n`);
  return hash.digest("hex");
}

/** Why a project cannot be served; each a fixed `code` the route answers. */
export type ProjectRefusal =
  | { readonly code: "not_built" }
  | { readonly code: "project_too_large" }
  | { readonly code: "unsafe_path"; readonly path: string }
  | { readonly code: "artifacts_unavailable"; readonly path: string }
  | { readonly code: "project_mismatch"; readonly path: string };

const sha256Of = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** Reads one file and checks it is the one the handout lists. */
async function verified(
  objects: Pick<ObjectStore, "get">,
  file: ProjectFile,
): Promise<Uint8Array | ProjectRefusal> {
  const bytes = await objects.get(file.objectKey);
  if (bytes === undefined)
    return { code: "artifacts_unavailable", path: file.path };
  if (bytes.byteLength !== file.sizeBytes || sha256Of(bytes) !== file.sha256)
    return { code: "project_mismatch", path: file.path };
  return bytes;
}

const isRefusal = (value: unknown): value is ProjectRefusal =>
  typeof value === "object" && value !== null && "code" in value;

/** How many objects are read at once. */
const READ_CONCURRENCY = 8;

/** `read` over `items` with at most `READ_CONCURRENCY` running, in order. */
async function readAll<T, R>(
  items: readonly T[],
  read: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await read(items[index] as T);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(READ_CONCURRENCY, items.length) }, worker),
  );
  return results;
}

/** The checks every serving makes before it reads a byte. */
function preflight(project: PublicProject): ProjectRefusal | undefined {
  if (project.files.length === 0) return { code: "not_built" };
  const total = project.files.reduce((sum, file) => sum + file.sizeBytes, 0);
  if (
    total > PROJECT_ARCHIVE_MAX_BYTES ||
    project.files.length > ZIP_MAX_ENTRIES
  )
    return { code: "project_too_large" };
  const unsafe = project.files.find((file) => !isSafeProjectPath(file.path));
  return unsafe === undefined
    ? undefined
    : { code: "unsafe_path", path: unsafe.path };
}

/**
 * The project as one `.zip`, every file under `root/`. Every file is read
 * and checked before the first byte is answered, so a mismatch is a
 * refusal, never a partial download; `PROJECT_ARCHIVE_MAX_BYTES` bounds
 * what that holds in memory.
 */
export async function projectArchive(
  objects: Pick<ObjectStore, "get">,
  project: PublicProject,
): Promise<ZipArchive | ProjectRefusal> {
  const refused = preflight(project);
  if (refused !== undefined) return refused;
  const files = ordered(project.files);
  const read = await readAll(files, (file) => verified(objects, file));
  const refusal = read.find(isRefusal);
  if (refusal !== undefined) return refusal;
  return zip(
    files.map((file, index) => ({
      name: `${project.root}/${file.path}`,
      bytes: read[index] as Uint8Array,
    })),
  );
}

const CURSOR = /^([a-f0-9]{12})\.(\d{1,6})$/;

/**
 * One page of the project's files with their contents, from `cursor`
 * (null for the first), within `maxBytes` of encoded content, for an
 * agent to write the project out file by file. Files come in archive
 * order; a cursor names the project it was cut from, so one from before a
 * rebuild is refused (`cursor_stale`) rather than skipping or repeating.
 */
export async function projectPage(
  objects: Pick<ObjectStore, "get">,
  project: PublicProject,
  cursor: string | null,
  maxBytes: number,
): Promise<
  | Omit<HandoutFilesDto, "versionId">
  | ProjectRefusal
  | { readonly code: "invalid_cursor" | "cursor_stale" }
> {
  const refused = preflight(project);
  if (refused !== undefined) return refused;
  const sha256 = projectSha256(project);
  let start = 0;
  if (cursor !== null) {
    const match = CURSOR.exec(cursor);
    if (match === null) return { code: "invalid_cursor" };
    if (match[1] !== sha256.slice(0, 12)) return { code: "cursor_stale" };
    start = Number(match[2]);
    if (start <= 0 || start >= project.files.length)
      return { code: "invalid_cursor" };
  }
  const files = ordered(project.files);
  const page: HandoutFilesDto["files"] = [];
  let used = 0;
  let index = start;
  for (; index < files.length; index++) {
    if (page.length === HANDOUT_PAGE_MAX_FILES) break;
    const file = files[index] as ProjectFile;
    const omitted = {
      ...listed(file),
      encoding: null,
      content: null,
      omitted: "too_large" as const,
    };
    // Text is at most its byte length, so a file over the cap is listed
    // unread; base64 is longer, so a binary file is measured once encoded.
    if (file.sizeBytes > SANDBOX_FILE_TEXT_MAX_BYTES) {
      page.push(omitted);
      continue;
    }
    if (page.length > 0 && used + file.sizeBytes > maxBytes) break;
    const bytes = await verified(objects, file);
    if (isRefusal(bytes)) return bytes;
    const text = textOf(bytes);
    const entry =
      text === null
        ? {
            encoding: "base64" as const,
            content: Buffer.from(bytes).toString("base64"),
          }
        : { encoding: "utf8" as const, content: text };
    if (entry.content.length > SANDBOX_FILE_TEXT_MAX_BYTES) {
      page.push(omitted);
      continue;
    }
    if (page.length > 0 && used + entry.content.length > maxBytes) break;
    used += entry.content.length;
    page.push({ ...listed(file), ...entry, omitted: null });
  }
  return {
    root: project.root,
    sha256,
    total: files.length,
    files: page,
    nextCursor: index < files.length ? `${sha256.slice(0, 12)}.${index}` : null,
  };
}

const listed = ({ path, sizeBytes, sha256 }: ProjectFile) => ({
  path,
  sizeBytes,
  sha256,
});

/**
 * One of a project's files as text, checked against its listed size and
 * sha256; null when it is absent, unreadable, altered or not UTF-8.
 */
export async function projectFileText(
  objects: Pick<ObjectStore, "get">,
  file: Pick<ProjectFile, "objectKey" | "sizeBytes" | "sha256"> | undefined,
): Promise<string | null> {
  if (file === undefined) return null;
  const bytes = await objects.get(file.objectKey);
  if (
    bytes === undefined ||
    bytes.byteLength !== file.sizeBytes ||
    sha256Of(bytes) !== file.sha256
  )
    return null;
  return textOf(bytes);
}

/** What a version lets a submission change, as its build recorded it. */
export interface VersionRules {
  /** The descriptor's `editablePaths`; empty when it cannot be read. */
  readonly editablePaths: readonly string[];
  /** The descriptor's `versionId`, null when it cannot be read. */
  readonly descriptorVersionId: string | null;
  /** The build manifest's grading layout, else the platform's. */
  readonly layout: GradingLayout;
}

/**
 * The rules a built version's own files state: the editable paths in its
 * `sandbox-task.json` and the layout in its build manifest, the two a
 * grading run reads.
 */
export async function versionRules(
  objects: Pick<ObjectStore, "get">,
  project: PublicProject,
): Promise<VersionRules> {
  const descriptorText = await projectFileText(
    objects,
    project.files.find((file) => file.path === TASK_DESCRIPTOR_PATH),
  );
  let editablePaths: string[] = [];
  let descriptorVersionId: string | null = null;
  try {
    const parsed = JSON.parse(descriptorText ?? "null") as {
      editablePaths?: unknown;
      versionId?: unknown;
    } | null;
    if (
      Array.isArray(parsed?.editablePaths) &&
      parsed.editablePaths.every((path) => typeof path === "string")
    )
      editablePaths = parsed.editablePaths as string[];
    if (typeof parsed?.versionId === "string")
      descriptorVersionId = parsed.versionId;
  } catch {
    // Unreadable: nothing is editable, and the grading run says so.
  }
  const manifestText = await projectFileText(
    objects,
    project.artifacts.find((file) => file.path === "build-manifest.json"),
  );
  let recorded: GradingLayout | undefined;
  try {
    recorded = (
      JSON.parse(manifestText ?? "null") as Pick<
        SandboxBuildManifest,
        "layout"
      > | null
    )?.layout;
  } catch {
    recorded = undefined;
  }
  return {
    editablePaths,
    descriptorVersionId,
    layout: layoutOf({ layout: recorded }),
  };
}
