/**
 * The CI judge: a pull request judged against a published version's hidden
 * suite from the repository's own GitHub Actions run, with no secret on
 * either side (`duediligence ci --platform`, its `action.yml`).
 *
 *   POST /api/judge      { workspace, versionId, files }  → 202 { submission }
 *   GET  /api/judge/:id                                    → { submission }
 *
 * Outside `/api/v1`, as GitHub's webhook is: the caller has no session. It
 * is authenticated by the run's GitHub OIDC token (`oidc.ts`), and admitted
 * only when the token's `repository_id` is the repository the version was
 * sliced from, through a healthy installation. The files are the PR's, in
 * the repository's names and paths; grading carries them forward to the
 * version's (`forwardChange`) on its snapshot, then grades as any
 * submission. Only the verdict, counts and failing scenario keys answer.
 */

import { createHash } from "node:crypto";

import type {
  AnalysisRunStore,
  GithubRepoStore,
  ObjectStore,
  SandboxStore,
  StoredSubmission,
  SubmissionStore,
} from "@sandbox-factory/db";
import {
  createSubmissionSchema,
  submissionResponseSchema,
} from "@sandbox-factory/shared";
import type { Context, Env, Hono } from "hono";
import { submittedFilesText } from "sandbox-factory";
import { z } from "zod";

import type { GithubOidcVerifier } from "./oidc.js";

export interface JudgeRouteOptions {
  readonly verifier: GithubOidcVerifier;
  readonly sandboxes: Pick<SandboxStore, "getVersion" | "get">;
  readonly repos: Pick<GithubRepoStore, "get">;
  /** Whether the repository's installation is healthy. */
  readonly installationHealthy: (
    organizationId: string,
    connectionId: string,
  ) => Promise<boolean>;
  readonly submissions: Pick<SubmissionStore, "create" | "get">;
  readonly objects: Pick<ObjectStore, "put">;
  readonly runs: Pick<AnalysisRunStore, "enqueue">;
  readonly ensureWorker: () => Promise<void>;
  readonly onLaunchError?: () => void;
  readonly maxActive?: number;
}

const judgeRequestSchema = createSubmissionSchema.extend({
  workspace: z.string().min(1).max(64),
  versionId: z.string().min(1).max(64),
});

/** What the CLI reads: the verdict, counts and scenario keys, as a submission. */
const answer = (stored: StoredSubmission) =>
  submissionResponseSchema.parse({
    submission: {
      id: stored.id,
      sandboxVersionId: stored.sandboxVersionId,
      status: stored.status,
      verdict: stored.result?.verdict ?? null,
      public: stored.result?.public ?? null,
      hidden: stored.result?.hidden ?? null,
      failedScenarios: [...(stored.result?.failedScenarios ?? [])],
      refused: [...(stored.result?.refused ?? [])],
      runId: null,
      retryOf: stored.retryOf,
      merge: null,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
    },
  });

export function mountJudgeRoutes<E extends Env>(
  app: Hono<E>,
  options: JudgeRouteOptions,
): void {
  const refused = (
    c: Context<E>,
    status: 401 | 403 | 404,
    code: string,
    error: string,
  ) => c.json({ error, code }, status);

  /**
   * The workflow run's repository, when its token is GitHub's, meant for
   * this platform, and the repository is the one `versionId` was sliced
   * from in `workspace`, through a healthy installation. Every refusal past
   * the token reads as not found, so a workspace's versions cannot be
   * probed from another repository.
   */
  const admitted = async (
    c: Context<E>,
    workspace: string,
    versionId: string,
  ) => {
    const bearer = /^Bearer (.+)$/.exec(
      c.req.header("Authorization") ?? "",
    )?.[1];
    if (bearer === undefined)
      return {
        response: refused(
          c,
          401,
          "oidc_required",
          "A GitHub Actions OIDC token is needed: give the job `permissions: id-token: write`.",
        ),
      };
    const verified = await options.verifier.verify(bearer);
    if (!verified.ok)
      return {
        response: refused(
          c,
          401,
          `oidc_${verified.reason}`,
          "The GitHub OIDC token was not accepted.",
        ),
      };
    const notFound = { response: refused(c, 404, "not_found", "Not found.") };
    const stored = await options.sandboxes.getVersion(workspace, versionId);
    if (stored === null || stored.version.frozenAt === null) return notFound;
    const sandbox = await options.sandboxes.get(
      workspace,
      stored.version.sandboxId,
    );
    if (sandbox === null || sandbox.sourceRepoId === null) return notFound;
    const repo = await options.repos.get(workspace, sandbox.sourceRepoId);
    if (
      repo === null ||
      repo.syncStatus === "gone" ||
      repo.externalId !== verified.claims.repositoryId ||
      !(await options.installationHealthy(workspace, repo.connectionId))
    )
      return notFound;
    return { stored, claims: verified.claims };
  };

  app.post("/api/judge", async (c) => {
    const parsed = judgeRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      return c.json(
        { error: "Invalid submission.", code: "invalid_submission" },
        400,
      );
    const { workspace, versionId, files } = parsed.data;
    const found = await admitted(c, workspace, versionId);
    if ("response" in found) return found.response;
    const text = submittedFilesText(files);
    const patchSha256 = createHash("sha256").update(text, "utf8").digest("hex");
    const patchKey = `submissions/${workspace}/${versionId}/${patchSha256}.json`;
    await options.objects.put(patchKey, Buffer.from(text, "utf8"));
    const created = await options.submissions.create(workspace, {
      sandboxVersionId: versionId,
      submittedBy: null,
      patchKey,
      patchSha256,
    });
    if (!created.ok) return refused(c, 404, "not_found", "Not found.");
    if (created.created) {
      const queued = await options.runs.enqueue(
        workspace,
        found.stored.source.sourceSnapshotId,
        {
          tool: "submission_grade",
          params: {
            deadlineMinutes: 60,
            grader: "submission",
            submissionId: created.submission.id,
            sandboxVersionId: versionId,
            patchSha256,
            names: "repository",
          },
          requestedBy: null,
          maxActive: options.maxActive ?? 3,
        },
      );
      if (!queued.ok)
        return c.json(
          {
            error: "The workspace's active analysis limit has been reached.",
            code: "run_limit",
          },
          409,
        );
      await options.ensureWorker().catch(() => options.onLaunchError?.());
    }
    return c.json(answer(created.submission), created.created ? 202 : 200);
  });

  app.get("/api/judge/:id", async (c) => {
    const workspace = c.req.query("workspace") ?? "";
    const submission = await options.submissions.get(
      workspace,
      c.req.param("id"),
    );
    // The token is checked against the submission's version either way.
    const found = await admitted(
      c,
      workspace,
      submission?.sandboxVersionId ?? "",
    );
    if ("response" in found) return found.response;
    if (submission === null) return refused(c, 404, "not_found", "Not found.");
    c.header("Cache-Control", "no-store");
    return c.json(answer(submission));
  });
}
