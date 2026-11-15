/**
 * A submission sent as the contributor's whole project folder, zipped
 * (`POST …/submissions/zip`, and `…/retry/zip`; the body is the archive,
 * `Content-Type: application/zip`). The server reads it and compares it
 * with the version's public project, the handout's listed hashes, so the
 * rules live in one place (`folderSubmission` in core): what differs in an
 * editable path, or is new where grading takes new files, is submitted;
 * guide and editor files are left out; a changed read-only file, a
 * deleted task file or anything else grading would refuse is answered by
 * path (422 `folder_refused`) before any submission exists. `?dryRun=1`
 * answers what would be submitted, refusals included, and stores nothing.
 *
 * The archive is bounded as sent (`folderBodyLimit`), by the reader
 * (`unzip.ts`: no ZIP64, encryption, unsafe names or bombs) and here: skipped
 * entries (`node_modules/`, `.git/`, OS files) are never inflated, and the
 * rest are capped in count and bytes before a byte is read.
 *
 * Each route decides who may act on which version first, as `files[]`
 * submissions do; this takes the owner it settled on.
 */

import { createHash } from "node:crypto";

import {
  createSubmissionSchema,
  PROJECT_ARCHIVE_MAX_BYTES,
  SUBMISSION_ZIP_MAX_BYTES,
  type FolderPreviewDto,
} from "@sandbox-factory/shared";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  folderPrefix,
  folderSubmission,
  skippedName,
  TASK_DESCRIPTOR_PATH,
  type FolderFile,
  type FolderVersionFile,
} from "sandbox-factory";

import {
  projectFileText,
  publicProject,
  versionRules,
  type ProjectFile,
} from "./project.js";
import {
  isDryRun,
  storeFiles,
  submissionsUnavailable,
  type Received,
  type ReceivingStores,
} from "./submission-service.js";
import {
  isZipProblem,
  listZip,
  readZipEntry,
  type ZipListing,
  type ZipProblem,
} from "./unzip.js";

/** What is read of a folder past the entries skipped unread. */
export const FOLDER_READ_LIMITS = {
  files: 5_000,
  fileBytes: 8 * 1024 * 1024,
  totalBytes: PROJECT_ARCHIVE_MAX_BYTES,
} as const;

/** The types a zipped folder arrives as; browsers and OSes differ. */
const ZIP_TYPES = new Set([
  "application/zip",
  "application/x-zip-compressed",
  "application/x-zip",
  "application/octet-stream",
]);

/**
 * The request body limit, answered in this API's shape before the body
 * is read.
 */
export const folderBodyLimit = bodyLimit({
  maxSize: SUBMISSION_ZIP_MAX_BYTES,
  onError: (c) =>
    c.json(
      {
        error: `A zipped folder is at most ${SUBMISSION_ZIP_MAX_BYTES / 1024 / 1024} MB. Leave node_modules out of it.`,
        code: "zip_too_large",
      },
      413,
    ),
});

const sha256Of = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const utf8 = new TextDecoder("utf-8", { fatal: true });
const textOrNull = (bytes: Uint8Array) => {
  try {
    return utf8.decode(bytes);
  } catch {
    return null;
  }
};

/** A reader's refusal, as the route answers it. */
function zipRefusal(c: Context, problem: ZipProblem): Response {
  const path = "path" in problem ? problem.path : undefined;
  const lead =
    problem.code === "unsafe_path" || problem.code === "duplicate_path"
      ? `The archive's entry ${path ?? ""} cannot be unpacked safely: `
      : problem.code === "entry_too_large"
        ? `${path ?? "A file"} is too large to submit. `
        : problem.code === "too_many_entries"
          ? "The archive is too large to read. "
          : "The upload is not a ZIP this server reads. ";
  const status =
    problem.code === "entry_too_large"
      ? 413
      : problem.code === "too_many_entries"
        ? 422
        : 400;
  return c.json(
    {
      error: `${lead}${problem.detail}`,
      code:
        problem.code === "unsafe_path" || problem.code === "duplicate_path"
          ? "unsafe_zip"
          : problem.code === "entry_too_large" ||
              problem.code === "too_many_entries"
            ? problem.code
            : "invalid_zip",
      ...(path === undefined ? {} : { path }),
    },
    status,
  );
}

const refuse = (
  c: Context,
  status: 409 | 413 | 422,
  code: string,
  error: string,
) => ({ response: c.json({ error, code }, status) }) as const;

/** The paths a refusal names in its sentence, the rest counted. */
function named(paths: readonly string[]): string {
  const shown = paths.slice(0, 8);
  return paths.length > shown.length
    ? `${shown.join(", ")} and ${paths.length - shown.length} more`
    : shown.join(", ");
}

/**
 * Reads a zipped project folder against `versionOf`'s version and stores
 * what it submits, or answers why not: the preview on a dry run, a
 * refusal by path, or the archive's own problem.
 */
export async function receiveFolder(
  c: Context,
  options: ReceivingStores,
  owner: string,
  versionOf: () => Promise<string | null>,
): Promise<Received> {
  const unavailable = submissionsUnavailable(c, options);
  if (unavailable !== undefined) return { response: unavailable };
  const type = (c.req.header("content-type") ?? "").split(";")[0]?.trim();
  if (type === undefined || !ZIP_TYPES.has(type.toLowerCase()))
    return {
      response: c.json(
        {
          error: "Send the zipped folder as the body, as application/zip.",
          code: "unsupported_media_type",
        },
        415,
      ),
    };
  const versionId = await versionOf();
  if (versionId === null)
    return { response: c.json({ error: "Not found." }, 404) };
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  const listing = listZip(bytes);
  if (isZipProblem(listing)) return { response: zipRefusal(c, listing) };

  const project = await publicProject(options, owner, versionId);
  if (project === null)
    return { response: c.json({ error: "Not found." }, 404) };
  if (project.files.length === 0)
    return refuse(
      c,
      409,
      "not_built",
      "The version has no built project to compare with.",
    );
  const rules = await versionRules(options.objects, project);
  const byPath = new Map(project.files.map((file) => [file.path, file]));

  const kept: ZipListing[] = [];
  let skipped = 0;
  for (const entry of listing) {
    if (entry.directory) continue;
    if (skippedName(entry.name)) skipped += 1;
    else kept.push(entry);
  }
  if (kept.length > FOLDER_READ_LIMITS.files)
    return refuse(
      c,
      422,
      "too_many_entries",
      `The folder holds ${kept.length} files besides node_modules and .git; at most ${FOLDER_READ_LIMITS.files} are read. Zip the downloaded project folder.`,
    );
  const declared = kept.reduce((sum, entry) => sum + entry.size, 0);
  if (declared > FOLDER_READ_LIMITS.totalBytes)
    return refuse(
      c,
      413,
      "zip_too_large",
      `The folder's files come to ${declared} bytes unpacked; at most ${FOLDER_READ_LIMITS.totalBytes} are read.`,
    );
  const prefix = folderPrefix(
    kept.map((entry) => entry.name),
    new Set(byPath.keys()),
  );

  const files: FolderFile[] = [];
  const versionTexts = new Map<string, string>();
  for (const entry of kept) {
    const data = readZipEntry(bytes, entry, FOLDER_READ_LIMITS.fileBytes);
    if (isZipProblem(data)) return { response: zipRefusal(c, data) };
    const path = entry.name.slice(prefix.length);
    const sha256 = sha256Of(data);
    files.push({
      path,
      sha256,
      text: textOrNull(data),
      ...(entry.symlink ? { symlink: true } : {}),
    });
    const own = byPath.get(path);
    if (own !== undefined && own.sha256 !== sha256) {
      const text = await projectFileText(options.objects, own);
      if (text === null)
        return {
          response: c.json(
            {
              error: "The version's project could not be read.",
              code: "project_mismatch",
            },
            502,
          ),
        };
      versionTexts.set(path, text);
    }
  }

  // Another version's folder, by its descriptor: say so, rather than
  // naming every file that differs.
  const descriptor = files.find((file) => file.path === TASK_DESCRIPTOR_PATH);
  const uploadedVersionId = versionIdOf(descriptor?.text ?? null);
  if (
    uploadedVersionId !== null &&
    rules.descriptorVersionId !== null &&
    uploadedVersionId !== rules.descriptorVersionId
  )
    return refuse(
      c,
      422,
      "wrong_version",
      `This folder is the project of ${uploadedVersionId}, not of this version. Download this version's project and work in that.`,
    );

  const version: FolderVersionFile[] = project.files.map(
    (file: ProjectFile) => {
      const text = versionTexts.get(file.path);
      return {
        path: file.path,
        sha256: file.sha256,
        ...(text === undefined ? {} : { text }),
      };
    },
  );
  const result = folderSubmission({
    files,
    version,
    editablePaths: rules.editablePaths,
    layout: rules.layout,
  });
  if (result.matched === 0)
    return refuse(
      c,
      422,
      "not_the_project",
      "None of the version's files is in this folder. Zip the project folder you downloaded and worked in.",
    );
  const preview: FolderPreviewDto = {
    files: result.changed.map(({ path, change }) => ({ path, change })),
    ignored: [...result.ignored],
    skipped: skipped + result.buildOutput,
    missing: [...result.missing],
    refused: result.refused.map(({ path, reason }) => ({ path, reason })),
  };
  if (isDryRun(c)) return { response: c.json({ preview }, 200) };
  if (result.refused.length > 0)
    return {
      response: c.json(
        {
          error: `This folder cannot be submitted as it is: ${named([...new Set(result.refused.map((refusal) => refusal.path))])}. Revert, restore or remove ${result.refused.length === 1 ? "it" : "them"} as each reason says, and upload again.`,
          code: "folder_refused",
          refused: preview.refused,
          preview,
        },
        422,
      ),
    };
  if (result.files.length === 0)
    return {
      response: c.json(
        {
          error:
            "The folder changes no task file. Edit the files TASK.md lists, then upload it again.",
          code: "no_changes",
          preview,
        },
        422,
      ),
    };
  const sized = createSubmissionSchema.safeParse({ files: result.files });
  if (!sized.success)
    return refuse(
      c,
      422,
      "submission_too_large",
      sized.error.issues[0]?.message ?? "The submission is too large.",
    );
  return storeFiles(options, owner, versionId, result.files);
}

/** The `versionId` a descriptor's text names; null when it names none. */
function versionIdOf(text: string | null): string | null {
  if (text === null) return null;
  try {
    const value = (JSON.parse(text) as { versionId?: unknown } | null)
      ?.versionId;
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}
