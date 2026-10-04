import type {
  AnalysisRunStore,
  ArtifactStore,
  BountyProposalStore,
  BountySpecStore,
  GithubRepoStore,
  JiraBoardStore,
  ObjectStore,
  RepoSnapshotStore,
  StoredAnalysisRun,
  StoredArtifact,
} from "@sandbox-factory/db";
import type {
  RepositoryProposalDto,
  StoredTree,
} from "@sandbox-factory/shared";
import {
  analysisRunListSchema,
  analysisRunResponseSchema,
  artifactListSchema,
  enqueueAnalysisSchema,
  enqueueFixturesSchema,
  enqueueScopeSchema,
  enqueueSliceResponseSchema,
  enqueueSliceSchema,
  GRAPH_DEADLINE_MINUTES,
  repositoryProposalListSchema,
} from "@sandbox-factory/shared";
import type { Context, Hono } from "hono";
import { rankAtLeast } from "../access.js";
import type { AuthVariables } from "../http-context.js";
import { enqueueAnalysis } from "./enqueue.js";

export interface AnalysisRouteOptions {
  readonly runs: AnalysisRunStore;
  readonly artifacts: ArtifactStore;
  readonly repos: GithubRepoStore;
  readonly snapshots: RepoSnapshotStore;
  readonly objects: ObjectStore;
  /** A snapshot's stored file list, so slice entry points are checked against it. */
  readonly tree: (treeKey: string) => Promise<StoredTree | null>;
  readonly ensureWorker: () => Promise<void>;
  readonly maxActive?: number;
  readonly onLaunchError?: () => void;
  /** The proposals agent runs work for, and the repository each is about. */
  readonly proposals: Pick<BountyProposalStore, "get" | "list">;
  readonly specs: Pick<BountySpecStore, "get">;
  /** For naming the board a proposal's bounty came through. */
  readonly boards: Pick<JiraBoardStore, "list">;
}
/** Proposals one repository's picker lists, newest first. */
export const REPOSITORY_PROPOSALS_MAX = 100;
/** The proposal store's largest page. */
const REPOSITORY_PROPOSALS_PAGE = 50;
const publicArtifact = ({ objectKey: _key, ...dto }: StoredArtifact) => dto;
export function mountAnalysisRoutes(
  app: Hono<{ Variables: AuthVariables }>,
  options: AnalysisRouteOptions,
): void {
  const base = "/api/v1/orgs/:orgId/github";
  const runLimit = (c: Context) =>
    c.json(
      {
        error: "The active analysis limit has been reached.",
        code: "run_limit",
      },
      409,
    );

  /**
   * The snapshot's graphify run, enqueued or found: what a slice or a scope
   * reads, and waits for in the queue. A response when there is none to use.
   */
  async function graphRunFor(
    c: Context,
    owner: string,
    snapshotId: string,
    deadlineMinutes: number,
  ): Promise<{ run: StoredAnalysisRun } | { response: Response }> {
    const graph = await enqueueAnalysis(
      {
        runs: options.runs,
        removeObject: (key) => options.objects.remove(key),
      },
      owner,
      snapshotId,
      {
        tool: "graphify",
        params: { deadlineMinutes },
        requestedBy: c.get("user").id,
        maxActive: options.maxActive ?? 3,
      },
    );
    if (!graph.ok)
      return {
        response:
          graph.reason === "run_limit"
            ? runLimit(c)
            : c.json({ error: "Not found." }, 404),
      };
    if (graph.run.status === "failed")
      return {
        response: c.json(
          {
            error:
              "The structure analysis for this snapshot failed. Retry it before slicing.",
            code: "graph_failed",
          },
          409,
        ),
      };
    return { run: graph.run };
  }

  /** A proposal's spec revision, owner-scoped; its current one when none is named. */
  async function taskOf(
    owner: string,
    proposalId: string,
    specRevision: number | undefined,
  ) {
    const proposal = await options.proposals.get(owner, proposalId);
    if (proposal === null) return null;
    const revision = specRevision ?? proposal.specRevision;
    if (revision === null) return null;
    const spec = await options.specs.get(owner, proposal.id, revision);
    return spec === null
      ? null
      : {
          proposalId: proposal.id,
          specRevision: spec.revision,
          specHash: spec.specHash,
        };
  }
  const noSpec = (c: Context) =>
    c.json(
      {
        error: "The proposal has no spec to work from.",
        code: "spec_not_found",
      },
      404,
    );

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
    const result = await enqueueAnalysis(
      {
        runs: options.runs,
        removeObject: (key) => options.objects.remove(key),
      },
      owner,
      snapshot.id,
      {
        params: body.data.params,
        requestedBy: c.get("user").id,
        maxActive: options.maxActive ?? 3,
      },
    );
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
    await options.ensureWorker().catch(() => options.onLaunchError?.());
    return c.json(analysisRunResponseSchema.parse({ run: result.run }), 202);
  });
  /**
   * A slice needs the snapshot's graph, so the graphify run is enqueued (or
   * found) first and the slice waits for it in the queue. The entry points
   * must name files or directories the snapshot lists.
   */
  app.post(`${base}/repositories/:id/slices`, async (c) => {
    if (!rankAtLeast(c.get("member").role, "admin"))
      return c.json(
        { error: "Only owners and admins can start a slice." },
        403,
      );
    const owner = c.req.param("orgId");
    const repoId = c.req.param("id");
    const repo = await options.repos.get(owner, repoId);
    if (repo === null) return c.json({ error: "Not found." }, 404);
    const body = enqueueSliceSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!body.success) return c.json({ error: "Invalid slice request." }, 400);
    const snapshot =
      body.data.snapshotId === undefined
        ? await options.snapshots.current(owner, repoId)
        : await options.snapshots.get(owner, body.data.snapshotId);
    if (snapshot === null || snapshot.repoId !== repoId)
      return c.json({ error: "No source snapshot is available." }, 404);
    const tree = await options.tree(snapshot.treeKey);
    if (tree === null)
      return c.json(
        {
          error: "The file list for this snapshot could not be read.",
          code: "tree_unavailable",
        },
        502,
      );
    const entryPoints = [...new Set(body.data.entryPoints)].sort();
    const paths = new Set(tree.entries.map((entry) => entry.path));
    const unknown = entryPoints.filter(
      (point) =>
        !paths.has(point) &&
        !tree.entries.some((entry) => entry.path.startsWith(`${point}/`)),
    );
    if (unknown.length > 0)
      return c.json(
        {
          error: "Entry points must name files or directories in the snapshot.",
          code: "unknown_entry_point",
          entryPoints: unknown,
        },
        400,
      );
    const requestedBy = c.get("user").id;
    const maxActive = options.maxActive ?? 3;
    const graph = await graphRunFor(
      c,
      owner,
      snapshot.id,
      body.data.deadlineMinutes,
    );
    if ("response" in graph) return graph.response;
    const result = await enqueueAnalysis(
      {
        runs: options.runs,
        removeObject: (key) => options.objects.remove(key),
      },
      owner,
      snapshot.id,
      {
        tool: "slice",
        params: {
          deadlineMinutes: body.data.deadlineMinutes,
          graphRunId: graph.run.id,
          entryPoints,
          budget: body.data.budget,
          includeInferred: body.data.includeInferred,
        },
        requestedBy,
        maxActive,
      },
    );
    if (!result.ok && graph.run.status === "queued")
      await options.ensureWorker().catch(() => options.onLaunchError?.());
    if (!result.ok)
      return result.reason === "run_limit"
        ? c.json(
            {
              error: "The active analysis limit has been reached.",
              code: "run_limit",
            },
            409,
          )
        : result.reason === "graph_mismatch"
          ? c.json(
              {
                error:
                  "The structure analysis does not describe this snapshot.",
                code: "graph_mismatch",
              },
              409,
            )
          : c.json({ error: "Not found." }, 404);
    await options.ensureWorker().catch(() => options.onLaunchError?.());
    return c.json(
      enqueueSliceResponseSchema.parse({
        run: result.run,
        graphRun: graph.run,
      }),
      202,
    );
  });
  /**
   * The scope agent proposes a slice for one bounty. Like a slice, it reads
   * the snapshot's graph, so the graphify run goes first and the scope run
   * waits for it.
   */
  app.post(`${base}/repositories/:id/scope`, async (c) => {
    if (!rankAtLeast(c.get("member").role, "admin"))
      return c.json(
        { error: "Only owners and admins can ask for a scope." },
        403,
      );
    const owner = c.req.param("orgId");
    const repoId = c.req.param("id");
    const repo = await options.repos.get(owner, repoId);
    if (repo === null) return c.json({ error: "Not found." }, 404);
    const body = enqueueScopeSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!body.success) return c.json({ error: "Invalid scope request." }, 400);
    const snapshot =
      body.data.snapshotId === undefined
        ? await options.snapshots.current(owner, repoId)
        : await options.snapshots.get(owner, body.data.snapshotId);
    if (snapshot === null || snapshot.repoId !== repoId)
      return c.json({ error: "No source snapshot is available." }, 404);
    const task = await taskOf(
      owner,
      body.data.proposalId,
      body.data.specRevision,
    );
    if (task === null) return noSpec(c);
    // The graph run is the console's own analysis of the snapshot, cached by
    // its parameters, so it keeps the default deadline rather than the agent's.
    const graph = await graphRunFor(
      c,
      owner,
      snapshot.id,
      GRAPH_DEADLINE_MINUTES,
    );
    if ("response" in graph) return graph.response;
    const result = await enqueueAnalysis(
      {
        runs: options.runs,
        removeObject: (key) => options.objects.remove(key),
      },
      owner,
      snapshot.id,
      {
        tool: "scope",
        params: {
          deadlineMinutes: body.data.deadlineMinutes,
          agent: "scope",
          graphRunId: graph.run.id,
          ...task,
        },
        requestedBy: c.get("user").id,
        maxActive: options.maxActive ?? 3,
      },
    );
    if (!result.ok && graph.run.status === "queued")
      await options.ensureWorker().catch(() => options.onLaunchError?.());
    if (!result.ok)
      return result.reason === "run_limit"
        ? runLimit(c)
        : result.reason === "graph_mismatch"
          ? c.json(
              {
                error:
                  "The structure analysis does not describe this snapshot.",
                code: "graph_mismatch",
              },
              409,
            )
          : c.json({ error: "Not found." }, 404);
    await options.ensureWorker().catch(() => options.onLaunchError?.());
    return c.json(
      enqueueSliceResponseSchema.parse({
        run: result.run,
        graphRun: graph.run,
      }),
      202,
    );
  });
  /** The fixtures agent writes behaviour for a succeeded slice's seams. */
  app.post(`${base}/runs/:id/fixtures`, async (c) => {
    if (!rankAtLeast(c.get("member").role, "admin"))
      return c.json(
        { error: "Only owners and admins can ask for fixtures." },
        403,
      );
    const owner = c.req.param("orgId");
    const slice = await options.runs.get(owner, c.req.param("id"));
    if (slice === null || slice.tool !== "slice")
      return c.json({ error: "Not found." }, 404);
    if (slice.status !== "succeeded")
      return c.json(
        { error: "The slice has not succeeded.", code: "slice_not_ready" },
        409,
      );
    const body = enqueueFixturesSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!body.success)
      return c.json({ error: "Invalid fixtures request." }, 400);
    const task = await taskOf(
      owner,
      body.data.proposalId,
      body.data.specRevision,
    );
    if (task === null) return noSpec(c);
    const result = await enqueueAnalysis(
      {
        runs: options.runs,
        removeObject: (key) => options.objects.remove(key),
      },
      owner,
      slice.snapshotId,
      {
        tool: "fixtures",
        params: {
          deadlineMinutes: body.data.deadlineMinutes,
          agent: "fixtures",
          sliceRunId: slice.id,
          ...task,
        },
        requestedBy: c.get("user").id,
        maxActive: options.maxActive ?? 3,
      },
    );
    if (!result.ok)
      return result.reason === "run_limit"
        ? runLimit(c)
        : result.reason === "slice_mismatch"
          ? c.json(
              {
                error: "The slice has not succeeded.",
                code: "slice_not_ready",
              },
              409,
            )
          : c.json({ error: "Not found." }, 404);
    await options.ensureWorker().catch(() => options.onLaunchError?.());
    return c.json(analysisRunResponseSchema.parse({ run: result.run }), 202);
  });
  /**
   * Proposals with a spec whose bounty is about this repository: one that
   * names it, or one from a board linked to it. Written here or imported,
   * the same list.
   */
  app.get(`${base}/repositories/:id/proposals`, async (c) => {
    const owner = c.req.param("orgId");
    const repoId = c.req.param("id");
    if ((await options.repos.get(owner, repoId)) === null)
      return c.json({ error: "Not found." }, 404);
    const boardNames = new Map(
      (await options.boards.list(owner)).map(({ id, name }) => [id, name]),
    );
    const proposals: RepositoryProposalDto[] = [];
    // A page at a time, newest first, until the picker is full.
    let cursor: { createdAt: string; id: string } | undefined;
    for (;;) {
      const page = await options.proposals.list(owner, {
        repoId,
        limit: REPOSITORY_PROPOSALS_PAGE,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const proposal of page) {
        if (proposal.specRevision === null) continue;
        proposals.push({
          id: proposal.id,
          issueKey: proposal.issueKey,
          title: proposal.title,
          status: proposal.status,
          specRevision: proposal.specRevision,
          boardId: proposal.boardId,
          boardName:
            proposal.boardId === null
              ? null
              : (boardNames.get(proposal.boardId) ?? null),
          createdAt: proposal.createdAt,
        });
      }
      const last = page.at(-1);
      if (
        last === undefined ||
        page.length < REPOSITORY_PROPOSALS_PAGE ||
        proposals.length >= REPOSITORY_PROPOSALS_MAX
      )
        break;
      cursor = { createdAt: last.createdAt, id: last.id };
    }
    return c.json(
      repositoryProposalListSchema.parse({
        proposals: proposals.slice(0, REPOSITORY_PROPOSALS_MAX),
      }),
    );
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
