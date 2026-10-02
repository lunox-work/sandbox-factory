import type {
  AnalysisRunStore,
  ArtifactStore,
  GithubRepoStore,
  ObjectStore,
  RepoSnapshotStore,
  StoredArtifact,
} from "@sandbox-factory/db";
import {
  analysisRunResponseSchema,
  analysisRunListSchema,
  artifactListSchema,
  enqueueAnalysisSchema,
} from "@sandbox-factory/shared";
import type { Hono } from "hono";
import { rankAtLeast } from "../routes.js";
import type { AuthVariables } from "../routes.js";

export interface AnalysisRouteOptions {
  readonly runs: AnalysisRunStore;
  readonly artifacts: ArtifactStore;
  readonly repos: GithubRepoStore;
  readonly snapshots: RepoSnapshotStore;
  readonly objects: ObjectStore;
  readonly ensureWorker: () => Promise<void>;
  readonly maxActive?: number;
  readonly onLaunchError?: () => void;
}
const publicArtifact = ({ objectKey: _key, ...dto }: StoredArtifact) => dto;
export function mountAnalysisRoutes(
  app: Hono<{ Variables: AuthVariables }>,
  options: AnalysisRouteOptions,
): void {
  const base = "/api/v1/orgs/:orgId/github";
  app.post(`${base}/repositories/:id/runs`, async (c) => {
    if (!rankAtLeast(c.get("member").role, "admin"))
      return c.json(
        { error: "Only owners and admins can start analysis." },
        403,
      );
    const owner = c.req.param("orgId");
    const repoId = c.req.param("id");
    const repo = await options.repos.get(owner, repoId);
    if (repo === null) return c.json({ error: "Not found." }, 404);
    const body = enqueueAnalysisSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!body.success)
      return c.json({ error: "Invalid analysis request." }, 400);
    const snapshot =
      body.data.snapshotId === undefined
        ? await options.snapshots.current(owner, repoId)
        : await options.snapshots.get(owner, body.data.snapshotId);
    if (snapshot === null || snapshot.repoId !== repoId)
      return c.json({ error: "No source snapshot is available." }, 404);
    const result = await options.runs.enqueue(owner, snapshot.id, {
      params: body.data.params,
      requestedBy: c.get("user").id,
      maxActive: options.maxActive ?? 3,
    });
    if (!result.ok)
      return result.reason === "run_limit"
        ? c.json(
            {
              error: "The active analysis limit has been reached.",
              code: "run_limit",
            },
            409,
          )
        : c.json({ error: "Not found." }, 404);
    if (result.obsoleteLogKey !== undefined)
      await options.objects.remove(result.obsoleteLogKey).catch(() => {});
    await options.ensureWorker().catch(() => options.onLaunchError?.());
    return c.json(analysisRunResponseSchema.parse({ run: result.run }), 202);
  });
  app.get(`${base}/repositories/:id/runs`, async (c) => {
    const owner = c.req.param("orgId");
    const repoId = c.req.param("id");
    if ((await options.repos.get(owner, repoId)) === null)
      return c.json({ error: "Not found." }, 404);
    return c.json(
      analysisRunListSchema.parse({
        runs: await options.runs.list(owner, repoId),
      }),
    );
  });
  app.get(`${base}/runs/:id`, async (c) => {
    const run = await options.runs.get(c.req.param("orgId"), c.req.param("id"));
    return run === null
      ? c.json({ error: "Not found." }, 404)
      : c.json(analysisRunResponseSchema.parse({ run }));
  });
  app.get(`${base}/runs/:id/artifacts`, async (c) => {
    const owner = c.req.param("orgId"),
      id = c.req.param("id");
    if ((await options.runs.get(owner, id)) === null)
      return c.json({ error: "Not found." }, 404);
    return c.json(
      artifactListSchema.parse({
        artifacts: (await options.artifacts.list(owner, id)).map(
          publicArtifact,
        ),
      }),
    );
  });
  app.get(`${base}/artifacts/:id/url`, async (c) => {
    const artifact = await options.artifacts.get(
      c.req.param("orgId"),
      c.req.param("id"),
    );
    if (artifact === null) return c.json({ error: "Not found." }, 404);
    c.header("Cache-Control", "no-store");
    return c.json({
      url: await options.objects.signedUrl(artifact.objectKey, 900),
    });
  });
  app.get(`${base}/runs/:id/log/url`, async (c) => {
    if (!rankAtLeast(c.get("member").role, "admin"))
      return c.json(
        { error: "Only owners and admins can read analysis logs." },
        403,
      );
    const key = await options.runs.logKey(
      c.req.param("orgId"),
      c.req.param("id"),
    );
    if (key === null) return c.json({ error: "No log is available." }, 404);
    c.header("Cache-Control", "no-store");
    return c.json({ url: await options.objects.signedUrl(key, 900) });
  });
}
