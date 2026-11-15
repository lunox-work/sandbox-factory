/**
 * What submitting, retrying and grading again share, whoever submits: a
 * workspace's owner or admin (`routes.ts`) or an invited contributor
 * (`contributors.ts`). Each route decides who may act and on which
 * version or submission first; these take the owner it settled on.
 *
 * Files are stored as `submittedFilesText` writes them, hashed, under the
 * version, before the submission row names them, and graded by a
 * `submission_grade` run. Guide and editor files the version does not
 * list as editable (`withoutGuideFiles`: `TASK.md`, `.vscode/`…) and the
 * build's output beside its source (`withoutBuildOutput`: a `.js` beside
 * its `.ts`, any `.map`) are dropped before storing, as a zipped folder's
 * are (`folder-upload.ts`) and as the `?dryRun=1` preview reports them, so
 * an editor's change or a build never refuses the task; the version's copy
 * is what grading runs either way, so no grading rule changed.
 *
 * `?dryRun=1` on a `files[]` submission answers what it would submit, as a
 * zipped folder's does (`folderSubmission`'s preview: the files it changes
 * or adds, the guide files dropped, and every refusal grading would make,
 * by path), and stores nothing. What an agent calls before it submits.
 */

import type {
  StoredSubmission,
  StoredSubmissionMerge,
} from "@sandbox-factory/db";
import {
  createSubmissionSchema,
  type SubmissionDto,
} from "@sandbox-factory/shared";
import type { Context } from "hono";
import { createHash } from "node:crypto";
import {
  folderSubmission,
  isSubmissionGradeParams,
  submittedFilesText,
  withoutBuildOutput,
  withoutGuideFiles,
  type FolderFile,
  type FolderVersionFile,
  type SubmissionGradeParams,
} from "sandbox-factory";

import { enqueueGrade, gradeParams, gradeRefused } from "./grading.js";
import type { SandboxRouteOptions } from "./options.js";
import {
  projectFileText,
  publicProject,
  versionRules,
  type PublicProject,
} from "./project.js";

/** Whether the request asks only for what would be submitted. */
export const isDryRun = (c: Context) =>
  ["1", "true"].includes(c.req.query("dryRun") ?? "");

const sha256Text = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

/**
 * What `files` would submit to `project`, as a folder holding the version
 * with those files laid over it would: the same rules, so a preview here
 * and a zipped folder's agree. Nothing is stored.
 */
async function filesPreview(
  c: Context,
  options: Pick<ReceivingStores, "objects">,
  project: PublicProject | null,
  files: readonly { readonly path: string; readonly text: string }[],
): Promise<Response> {
  if (project === null) return c.json({ error: "Not found." }, 404);
  if (project.files.length === 0)
    return c.json(
      {
        error: "The version has no built project to compare with.",
        code: "not_built",
      },
      409,
    );
  const rules = await versionRules(options.objects, project);
  const sent = new Map(files.map((file) => [file.path, file]));
  const folder: FolderFile[] = files.map((file) => ({
    path: file.path,
    sha256: sha256Text(file.text),
    text: file.text,
  }));
  const version: FolderVersionFile[] = [];
  for (const own of project.files) {
    const mine = sent.get(own.path);
    if (mine === undefined) {
      // Left out: the version's text stands, as it does when submitted.
      folder.push({ path: own.path, sha256: own.sha256, text: null });
      version.push({ path: own.path, sha256: own.sha256 });
      continue;
    }
    if (sha256Text(mine.text) === own.sha256) {
      version.push({ path: own.path, sha256: own.sha256 });
      continue;
    }
    const text = await projectFileText(options.objects, own);
    if (text === null)
      return c.json(
        {
          error: "The version's project could not be read.",
          code: "project_mismatch",
        },
        502,
      );
    version.push({ path: own.path, sha256: own.sha256, text });
  }
  const result = folderSubmission({
    files: folder,
    version,
    editablePaths: rules.editablePaths,
    layout: rules.layout,
  });
  return c.json(
    {
      preview: {
        files: result.changed.map(({ path, change }) => ({ path, change })),
        ignored: [...result.ignored],
        skipped: result.buildOutput,
        missing: [],
        refused: result.refused.map(({ path, reason }) => ({ path, reason })),
      },
    },
    200,
  );
}

/** Who made a submission, as the workspace knows them; null for its own. */
export type SubmissionContributor = SubmissionDto["contributor"];

/** A submission as the workspace reads it. */
export const submissionOf = (
  stored: StoredSubmission,
  merge: StoredSubmissionMerge | null = null,
  contributor: SubmissionContributor = null,
): SubmissionDto => ({
  id: stored.id,
  sandboxVersionId: stored.sandboxVersionId,
  status: stored.status,
  errorCode: stored.errorCode ?? null,
  verdict: stored.result?.verdict ?? null,
  public: stored.result?.public ?? null,
  hidden: stored.result?.hidden ?? null,
  failedScenarios: [...(stored.result?.failedScenarios ?? [])],
  refused: [...(stored.result?.refused ?? [])],
  carryBack: stored.result?.carryBack ?? null,
  runId: stored.runId,
  retryOf: stored.retryOf,
  merge:
    merge === null
      ? null
      : {
          pullRequestNumber: merge.pullRequestNumber,
          pullRequestUrl: merge.pullRequestUrl,
          branch: merge.branch,
          createdAt: merge.createdAt,
          when: merge.mergeWhen,
          pullRequestState: merge.pullRequestState,
          ci: {
            state: merge.ciState,
            summary:
              merge.ciSummary === null
                ? null
                : { ...merge.ciSummary, failing: [...merge.ciSummary.failing] },
            headSha: merge.ciHeadSha,
            checkedAt: merge.ciCheckedAt,
          },
          mergedCommitSha: merge.mergedCommitSha,
          mergedAt: merge.mergedAt,
          mergeError: merge.mergeError,
        },
  contributor,
  createdAt: stored.createdAt,
  updatedAt: stored.updatedAt,
});

export type Received =
  | { readonly response: Response }
  | {
      readonly store: NonNullable<SandboxRouteOptions["submissions"]>;
      readonly versionId: string;
      readonly patchKey: string;
      readonly patchSha256: string;
    };

/** The stores receiving submitted files reads. */
export type ReceivingStores = Pick<
  SandboxRouteOptions,
  "submissions" | "objects" | "sandboxes" | "runs" | "artifacts"
>;

/** The deployment's refusal when it keeps no submissions; undefined when it does. */
export function submissionsUnavailable(
  c: Context,
  options: Pick<SandboxRouteOptions, "submissions" | "objects">,
): Response | undefined {
  return options.submissions === undefined || options.objects.put === undefined
    ? c.json(
        {
          error: "Submissions are not taken on this deployment.",
          code: "submissions_unavailable",
        },
        503,
      )
    : undefined;
}

/**
 * Stores files as a submission's patch: canonical, by their hash, under
 * the version, before any row names them.
 */
export async function storeFiles(
  options: Pick<SandboxRouteOptions, "submissions" | "objects">,
  owner: string,
  versionId: string,
  files: readonly { readonly path: string; readonly text: string }[],
): Promise<Exclude<Received, { readonly response: Response }>> {
  const { submissions, objects } = options;
  if (submissions === undefined || objects.put === undefined)
    throw new Error("Submissions are not taken on this deployment.");
  const text = submittedFilesText(files);
  const patchSha256 = createHash("sha256").update(text, "utf8").digest("hex");
  const patchKey = `submissions/${owner}/${versionId}/${patchSha256}.json`;
  await objects.put(patchKey, Buffer.from(text, "utf8"));
  return { store: submissions, versionId, patchKey, patchSha256 };
}

/**
 * The checks a write of submitted files shares once the caller may act:
 * the deployment, the body, the version (`versionOf`, null for none of
 * theirs). Guide and editor files and build output are dropped; the rest
 * are stored.
 */
export async function receiveFiles(
  c: Context,
  options: ReceivingStores,
  owner: string,
  versionOf: () => Promise<string | null>,
): Promise<Received> {
  const unavailable = submissionsUnavailable(c, options);
  if (unavailable !== undefined) return { response: unavailable };
  const parsed = createSubmissionSchema.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success)
    return {
      response: c.json(
        { error: "Invalid submission.", code: "invalid_submission" },
        400,
      ),
    };
  const versionId = await versionOf();
  if (versionId === null)
    return { response: c.json({ error: "Not found." }, 404) };
  const project = await publicProject(options, owner, versionId);
  if (isDryRun(c))
    return {
      response: await filesPreview(c, options, project, parsed.data.files),
    };
  const { editablePaths } =
    project === null
      ? { editablePaths: [] }
      : await versionRules(options.objects, project);
  // The preview's rules (`folderSubmission`), in the same order: build
  // output first, judged against every file sent, then guide files.
  const built = withoutBuildOutput(
    parsed.data.files,
    project?.files.map((file) => file.path) ?? [],
  );
  const { kept } = withoutGuideFiles(built.kept, editablePaths);
  if (kept.length === 0)
    return {
      response: c.json(
        {
          error:
            "The submission holds only guide and editor files (TASK.md, README.md, .vscode/…) or build output (a .js beside its .ts, .map), which are never submitted. Send the task files you changed.",
          code: "no_task_files",
        },
        400,
      ),
    };
  return storeFiles(options, owner, versionId, kept);
}

/**
 * Queues a submission's grading run when it has none live, and answers
 * with the submission (through `answer`, which shapes it for the reader):
 * a new one; one still `queued`, whose first enqueue may have been refused
 * at the active-run limit (a live or ended run is found by its cache key,
 * never doubled); and an errored one graded again (`regrade`), with the
 * snapshot and parameters its run had. 202 when a run was queued, else 200
 * as it stands.
 */
export async function gradeSubmission(
  c: Context,
  options: Pick<
    SandboxRouteOptions,
    | "runs"
    | "sandboxes"
    | "submissions"
    | "maxActive"
    | "ensureWorker"
    | "onLaunchError"
  >,
  owner: string,
  made: { submission: StoredSubmission; created: boolean },
  {
    regrade = false,
    requestedBy,
    answer,
  }: {
    readonly regrade?: boolean;
    readonly requestedBy: string;
    readonly answer: (
      submission: StoredSubmission,
      status: 200 | 202,
    ) => Response | Promise<Response>;
  },
): Promise<Response> {
  const stored = made.submission;
  if (!made.created && !regrade && stored.status !== "queued")
    return answer(stored, 200);
  const previous =
    regrade && stored.runId !== null
      ? await options.runs.get(owner, stored.runId)
      : null;
  let snapshotId: string | null;
  let params: SubmissionGradeParams;
  if (
    previous !== null &&
    isSubmissionGradeParams(previous.params) &&
    previous.params.submissionId === stored.id
  ) {
    // The run it had, as it was: the CI judge's files keep their names.
    snapshotId = previous.snapshotId;
    params = previous.params;
  } else {
    // A version sliced from a repository is graded on its snapshot, so
    // a pass can be carried back to the commit it was cut at.
    const version = await options.sandboxes.getVersion(
      owner,
      stored.sandboxVersionId,
    );
    snapshotId = version?.source.sourceSnapshotId ?? null;
    params = gradeParams(stored);
  }
  const queued = await enqueueGrade(
    options.runs,
    owner,
    snapshotId,
    params,
    requestedBy,
    options.maxActive ?? 3,
  );
  if (!queued.ok) return gradeRefused(c, queued);
  if (
    regrade &&
    !queued.created &&
    queued.run.status !== "queued" &&
    queued.run.status !== "running"
  )
    return c.json(
      {
        error:
          "The submission's grading run has used its attempts. Retry it with other files.",
        code: "regrade_spent",
      },
      409,
    );
  if (queued.created)
    await options.ensureWorker().catch(() => options.onLaunchError?.());
  // The store moves a submission with its run (reopened, or errored once
  // the run has ended for good): answer with it as it now stands.
  const current = made.created
    ? stored
    : ((await options.submissions?.get(owner, stored.id)) ?? stored);
  return answer(current, made.created || queued.created ? 202 : 200);
}

/** What a retry is refused with, by the store's reason. */
export const RETRY_REFUSALS = {
  not_finished: "The submission has no verdict yet.",
  passed: "The submission passed; there is nothing to retry.",
  is_retry: "A retry is not retried.",
  retry_used: "The submission's one retry was already made.",
  same_patch: "These files were already submitted against the version.",
  contributor_submission:
    "An invited contributor made this submission; only they can retry it.",
} as const;
