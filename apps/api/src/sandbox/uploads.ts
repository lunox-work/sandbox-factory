/**
 * The checks an uploaded hand-off folder meets before anything is stored
 * (`POST /sandboxes/uploads`), and the files a passing submission on one
 * answers with (`GET /sandboxes/submissions/:sid/files`).
 *
 * An upload is what `carveout handoff --platform` sends: a folder cut and
 * pseudonymised on the maintainer's machine, text only, with the
 * maintainer's acceptance tests renamed into the folder's names. The
 * platform never has the private names or the receipt, so it checks what
 * it can: the folder says it is public and in pseudonyms, none of the
 * workspace's own names is in it (the union check builds block on), no
 * credential is in it, and every path is a plain one. A refusal names
 * files, never a term or a secret.
 */

import { createHash } from "node:crypto";
import { UPLOAD_LIMITS, type CreateUploadDto } from "@sandbox-factory/shared";
import {
  isSecretPath,
  pathProblem,
  publicVocabularyLeaks,
  scanSecrets,
} from "sandbox-factory";

/** What every upload holds: the cut's record, its manifest and its lockfile. */
export const REQUIRED_UPLOAD_FILES = [
  "carveout.json",
  "package.json",
  "package-lock.json",
] as const;

export interface UploadRefusal {
  readonly status: 400 | 409;
  readonly body: {
    readonly error: string;
    readonly code: string;
    readonly files?: readonly string[];
  };
}

const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

const refuse = (
  status: 400 | 409,
  code: string,
  error: string,
  files?: readonly string[],
): { refusal: UploadRefusal } => ({
  refusal: {
    status,
    body: {
      error,
      code,
      ...(files === undefined ? {} : { files: [...new Set(files)].sort() }),
    },
  },
});

/** Why a path cannot be in an upload; null when it can. */
function uploadPathProblem(path: string): string | null {
  return (
    pathProblem(path) ??
    (path
      .split("/")
      .some((part) => part === "node_modules" || part.toLowerCase() === ".git")
      ? "node_modules and .git are never uploaded."
      : null)
  );
}

/**
 * A root `.npmrc` is configuration carveout writes (`ignore-scripts`,
 * `engine-strict`); any other file a secret path names, or one holding an
 * npm credential, is a credential file.
 */
function secretFile(path: string, text: string): boolean {
  if (path === ".npmrc")
    return /(?:^|\n)\s*[^#;\n]*(?:_auth|_authToken|_password|username)\s*=/i.test(
      text,
    );
  return isSecretPath(path);
}

/**
 * The upload checked, or the refusal it gets. `vocabulary` is the
 * workspace's names (`workspaceVocabulary`).
 */
export function checkUpload(
  body: CreateUploadDto,
  vocabulary: readonly string[],
): { refusal: UploadRefusal } | { recordSha256: string } {
  const all = [...body.files, ...body.acceptanceTests];
  const large = all
    .filter(
      (file) => Buffer.byteLength(file.text, "utf8") > UPLOAD_LIMITS.fileBytes,
    )
    .map((file) => file.path);
  if (large.length > 0)
    return refuse(
      400,
      "upload_too_large",
      `A file is over ${UPLOAD_LIMITS.fileBytes} bytes.`,
      large,
    );
  const total = body.files.reduce(
    (sum, file) => sum + Buffer.byteLength(file.text, "utf8"),
    0,
  );
  if (total > UPLOAD_LIMITS.bytes)
    return refuse(
      400,
      "upload_too_large",
      `The folder is over ${UPLOAD_LIMITS.bytes} bytes.`,
    );
  const seen = new Set<string>();
  const bad: string[] = [];
  for (const file of all) {
    if (
      uploadPathProblem(file.path) !== null ||
      file.text.includes("\0") ||
      seen.has(file.path)
    )
      bad.push(file.path);
    seen.add(file.path);
  }
  if (bad.length > 0)
    return refuse(
      400,
      "invalid_files",
      "Each file is text at a plain relative path, once, outside node_modules and .git; an acceptance test is at a path the folder does not hold.",
      bad,
    );
  const byPath = new Map(body.files.map((file) => [file.path, file.text]));
  const missing = REQUIRED_UPLOAD_FILES.filter((path) => !byPath.has(path));
  if (missing.length > 0)
    return refuse(
      400,
      "incomplete_folder",
      "A hand-off folder holds carveout.json, package.json and package-lock.json.",
      missing,
    );
  const recordText = byPath.get("carveout.json") ?? "";
  let record: {
    publicScrubbed?: unknown;
    request?: { public?: unknown };
    lockfile?: unknown;
  };
  try {
    record = JSON.parse(recordText) as typeof record;
  } catch {
    return refuse(400, "not_public_folder", "carveout.json is not a record.", [
      "carveout.json",
    ]);
  }
  if (
    record === null ||
    typeof record !== "object" ||
    record.publicScrubbed !== true ||
    record.request?.public !== true
  )
    return refuse(
      400,
      "not_public_folder",
      "Only a public folder in pseudonyms is uploaded: cut it with carveout handoff (public by default), never --keep-names.",
      ["carveout.json"],
    );
  if (record.lockfile !== true)
    return refuse(
      400,
      "incomplete_folder",
      "The folder was cut without resolving its lockfile (--offline); cut it with one.",
      ["package-lock.json"],
    );
  const recordSha256 = sha256(recordText);
  if (recordSha256 !== body.carveout.recordSha256)
    return refuse(
      400,
      "record_mismatch",
      "carveout.recordSha256 is not the hash of the carveout.json uploaded.",
      ["carveout.json"],
    );
  const leaked = publicVocabularyLeaks(all, vocabulary).flatMap(
    (leak) => leak.files,
  );
  if (leaked.length > 0)
    return refuse(
      409,
      "names_leaked",
      "The upload holds names this workspace goes by. Add them to the cut (--name, or names in carveout.config.json) and hand off again.",
      leaked,
    );
  const secrets = [
    ...all
      .filter((file) => secretFile(file.path, file.text))
      .map((file) => file.path),
    ...scanSecrets(all).map((finding) => finding.file),
  ];
  if (secrets.length > 0)
    return refuse(
      409,
      "secret_file",
      "The upload holds a credential or a credential file. Remove it and hand off again.",
      secrets,
    );
  return { recordSha256 };
}

/**
 * What a passing submission on an uploaded version answers with: each
 * submitted file whose text is not the version's, at a plain path, and
 * none at a hidden test's path or under the layout's hidden-tests
 * directory.
 */
export function changedSubmissionFiles(input: {
  readonly submitted: readonly {
    readonly path: string;
    readonly text: string;
  }[];
  readonly publicText: (path: string) => string | null;
  readonly hiddenPaths: ReadonlySet<string>;
  readonly privateDir: string | null;
}): { path: string; text: string }[] {
  return input.submitted
    .filter(
      (file) =>
        pathProblem(file.path) === null &&
        !input.hiddenPaths.has(file.path) &&
        (input.privateDir === null ||
          !(
            file.path === input.privateDir ||
            file.path.startsWith(`${input.privateDir}/`)
          )) &&
        input.publicText(file.path) !== file.text,
    )
    .map(({ path, text }) => ({ path, text }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
