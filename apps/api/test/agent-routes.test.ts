import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import type { StoredAnalysisRun } from "@sandbox-factory/db";
import {
  REPOSITORY_PROPOSALS_MAX,
  mountAnalysisRoutes,
  type AnalysisRouteOptions,
} from "../src/analysis/routes.js";
import type { AuthVariables } from "../src/routes.js";

const stamp = "2026-10-03T00:00:00.000Z";
const graphRun: StoredAnalysisRun = {
  id: "arn_graph",
  snapshotId: "rsn_1",
  repoId: "ghr_1",
  tool: "graphify",
  toolVersion: "test",
  params: { deadlineMinutes: 30 },
  status: "succeeded",
  attempt: 0,
  maxAttempts: 2,
  errorCode: null,
  errorDetail: null,
  startedAt: stamp,
  finishedAt: stamp,
  deadlineAt: stamp,
  createdAt: stamp,
};
const sliceRun: StoredAnalysisRun = {
  ...graphRun,
  id: "arn_slice",
  tool: "slice",
  params: {
    deadlineMinutes: 30,
    graphRunId: graphRun.id,
    entryPoints: ["src/a.ts"],
    budget: { maxFiles: 40, maxDepth: 3 },
    includeInferred: false,
  },
};
const task = { proposalId: "bpr_1", specRevision: 2, specHash: "h2" };
const scopeRun: StoredAnalysisRun = {
  ...graphRun,
  id: "arn_scope",
  tool: "scope",
  status: "queued",
  params: {
    deadlineMinutes: 30,
    agent: "scope",
    graphRunId: graphRun.id,
    ...task,
  },
};
const fixturesRun: StoredAnalysisRun = {
  ...graphRun,
  id: "arn_fixtures",
  tool: "fixtures",
  status: "queued",
  params: {
    deadlineMinutes: 30,
    agent: "fixtures",
    sliceRunId: sliceRun.id,
    ...task,
  },
};
const listed = (
  id: string,
  createdAt: string,
  specRevision: number | null,
  boardId: string | null,
) => ({
  id,
  issueKey: id.toUpperCase(),
  title: `Title ${id}`,
  status: "approved",
  specRevision,
  boardId,
  createdAt,
});

function fixture(role = "owner") {
  const enqueued: { tool: string; snapshot: string; params: unknown }[] = [];
  const removed: string[] = [];
  let launches = 0;
  let refuse:
    "run_limit" | "graph_mismatch" | "slice_mismatch" | "not-found" | null =
    null;
  let graphStatus: StoredAnalysisRun["status"] = "succeeded";
  const options = {
    runs: {
      enqueue: async (
        _owner: string,
        snapshot: string,
        input: { tool: string; params: unknown },
      ) => {
        enqueued.push({ tool: input.tool, snapshot, params: input.params });
        if (input.tool === "graphify")
          return {
            ok: true,
            created: false,
            run: { ...graphRun, status: graphStatus },
          };
        if (refuse !== null) return { ok: false, reason: refuse };
        return {
          ok: true,
          created: true,
          run: input.tool === "scope" ? scopeRun : fixturesRun,
          obsoleteLogKey: "logs/old.log",
        };
      },
      get: async (owner: string, id: string) =>
        owner !== "org_1"
          ? null
          : id === sliceRun.id
            ? sliceRun
            : id === "arn_running_slice"
              ? { ...sliceRun, id, status: "running" }
              : id === graphRun.id
                ? graphRun
                : null,
    },
    repos: {
      get: async (owner: string, id: string) =>
        owner === "org_1" && id === "ghr_1" ? { id } : null,
    },
    snapshots: {
      current: async () => ({ id: "rsn_1", repoId: "ghr_1", treeKey: "t" }),
      get: async (_owner: string, id: string) =>
        id === "rsn_other" ? { id, repoId: "ghr_2", treeKey: "t" } : null,
    },
    objects: {
      remove: async (key: string) => {
        removed.push(key);
      },
    },
    ensureWorker: async () => {
      launches += 1;
    },
    proposals: {
      get: async (owner: string, id: string) =>
        owner !== "org_1"
          ? null
          : id === "bpr_1"
            ? { id, specRevision: 2 }
            : id === "bpr_unspecced"
              ? { id, specRevision: null }
              : null,
      // Newest first, as the store pages them, for the repository asked.
      list: async (_owner: string, options: { repoId?: string }) =>
        options.repoId === "ghr_1"
          ? [
              listed("bpr_4", "2026-10-04T00:00:00.000Z", 1, null),
              listed("bpr_3", "2026-10-03T00:00:00.000Z", 1, "jbd_2"),
              listed("bpr_2", "2026-10-02T00:00:00.000Z", null, "jbd_1"),
              listed("bpr_1", "2026-10-01T00:00:00.000Z", 2, "jbd_1"),
            ]
          : [listed("bpr_9", "2026-10-05T00:00:00.000Z", 1, "jbd_3")],
    },
    specs: {
      get: async (_owner: string, proposalId: string, revision: number) =>
        proposalId === "bpr_1" && (revision === 2 || revision === 1)
          ? { revision, specHash: `h${revision}` }
          : null,
    },
    boards: {
      list: async () => [
        { id: "jbd_1", name: "Shop", sourceRepoId: "ghr_1" },
        { id: "jbd_2", name: "Ops", sourceRepoId: "ghr_1" },
        { id: "jbd_3", name: "Other", sourceRepoId: "ghr_2" },
      ],
    },
  } as unknown as AnalysisRouteOptions;
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("user", { id: "user_1" } as never);
    c.set("member", { role, organizationId: "org_1" } as never);
    await next();
  });
  mountAnalysisRoutes(app, options);
  const request = (path: string, body?: unknown, org = "org_1") =>
    app.request(
      `/api/v1/orgs/${org}/github/${path}`,
      body === undefined
        ? {}
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
    );
  return {
    request,
    enqueued,
    removed,
    launches: () => launches,
    refuse: (reason: typeof refuse) => {
      refuse = reason;
    },
    graphFails: () => {
      graphStatus = "failed";
    },
  };
}

test("a scope run names the proposal's spec revision and queues behind the graph", async () => {
  const f = fixture();
  const response = await f.request("repositories/ghr_1/scope", {
    proposalId: "bpr_1",
  });
  assert.equal(response.status, 202);
  const body = (await response.json()) as {
    run: StoredAnalysisRun;
    graphRun: StoredAnalysisRun;
  };
  assert.equal(body.run.id, "arn_scope");
  assert.equal(body.graphRun.id, "arn_graph");
  // The graph run keeps the console's deadline; the agent gets longer.
  assert.deepEqual(f.enqueued[0]?.params, { deadlineMinutes: 30 });
  assert.deepEqual(f.enqueued[1], {
    tool: "scope",
    snapshot: "rsn_1",
    params: {
      deadlineMinutes: 60,
      agent: "scope",
      graphRunId: "arn_graph",
      proposalId: "bpr_1",
      specRevision: 2,
      specHash: "h2",
    },
  });
  assert.deepEqual(f.removed, ["logs/old.log"]);
  assert.equal(f.launches(), 1);
  // An older revision can be named.
  await f.request("repositories/ghr_1/scope", {
    proposalId: "bpr_1",
    specRevision: 1,
  });
  assert.equal((f.enqueued[3]?.params as { specHash: string }).specHash, "h1");
});

test("a scope run refuses members, bad bodies, other repositories and proposals without a spec", async () => {
  const f = fixture();
  const status = async (path: string, body: unknown, role = "owner") =>
    (await (role === "owner" ? f : fixture(role)).request(path, body)).status;
  assert.equal(
    await status("repositories/ghr_1/scope", { proposalId: "bpr_1" }, "member"),
    403,
  );
  assert.equal(
    await status("repositories/ghr_1/scope", { proposal: "x" }),
    400,
  );
  assert.equal(
    await status("repositories/ghr_9/scope", { proposalId: "bpr_1" }),
    404,
  );
  assert.equal(
    await status("repositories/ghr_1/scope", {
      proposalId: "bpr_1",
      snapshotId: "rsn_other",
    }),
    404,
  );
  for (const body of [
    { proposalId: "bpr_missing" },
    { proposalId: "bpr_unspecced" },
    { proposalId: "bpr_1", specRevision: 7 },
  ]) {
    const response = await f.request("repositories/ghr_1/scope", body);
    assert.equal(response.status, 404);
    assert.equal(
      ((await response.json()) as { code: string }).code,
      "spec_not_found",
    );
  }
  for (const [reason, expected] of [
    ["run_limit", 409],
    ["graph_mismatch", 409],
    ["not-found", 404],
  ] as const) {
    f.refuse(reason);
    assert.equal(
      await status("repositories/ghr_1/scope", { proposalId: "bpr_1" }),
      expected,
    );
  }
  const failed = fixture();
  failed.graphFails();
  const response = await failed.request("repositories/ghr_1/scope", {
    proposalId: "bpr_1",
  });
  assert.equal(response.status, 409);
  assert.equal(
    ((await response.json()) as { code: string }).code,
    "graph_failed",
  );
});

test("a fixtures run is written for a succeeded slice, on its snapshot", async () => {
  const f = fixture();
  const response = await f.request("runs/arn_slice/fixtures", {
    proposalId: "bpr_1",
  });
  assert.equal(response.status, 202);
  assert.equal(
    ((await response.json()) as { run: StoredAnalysisRun }).run.id,
    "arn_fixtures",
  );
  assert.deepEqual(f.enqueued, [
    {
      tool: "fixtures",
      snapshot: "rsn_1",
      params: {
        deadlineMinutes: 60,
        agent: "fixtures",
        sliceRunId: "arn_slice",
        proposalId: "bpr_1",
        specRevision: 2,
        specHash: "h2",
      },
    },
  ]);
  assert.equal(
    (
      await fixture("member").request("runs/arn_slice/fixtures", {
        proposalId: "bpr_1",
      })
    ).status,
    403,
  );
  assert.equal(
    (await f.request("runs/arn_graph/fixtures", { proposalId: "bpr_1" }))
      .status,
    404,
  );
  const running = await f.request("runs/arn_running_slice/fixtures", {
    proposalId: "bpr_1",
  });
  assert.equal(running.status, 409);
  assert.equal(
    ((await running.json()) as { code: string }).code,
    "slice_not_ready",
  );
  assert.equal((await f.request("runs/arn_slice/fixtures", {})).status, 400);
  assert.equal(
    (
      await f.request("runs/arn_slice/fixtures", {
        proposalId: "bpr_unspecced",
      })
    ).status,
    404,
  );
  for (const [reason, expected] of [
    ["run_limit", 409],
    ["slice_mismatch", 409],
    ["not-found", 404],
  ] as const) {
    f.refuse(reason);
    assert.equal(
      (await f.request("runs/arn_slice/fixtures", { proposalId: "bpr_1" }))
        .status,
      expected,
    );
  }
});

test("a repository's proposals are the specced ones whose tickets are about it, newest first", async () => {
  const f = fixture("member");
  const response = await f.request("repositories/ghr_1/proposals");
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    proposals: {
      id: string;
      boardName: string | null;
      title: string | null;
    }[];
  };
  // A ticket written here has no board; one from Jira names its own.
  assert.deepEqual(
    body.proposals.map((proposal) => [proposal.id, proposal.boardName]),
    [
      ["bpr_4", null],
      ["bpr_3", "Ops"],
      ["bpr_1", "Shop"],
    ],
  );
  assert.equal(body.proposals[2]?.title, "Title bpr_1");
  assert.equal((await f.request("repositories/ghr_9/proposals")).status, 404);
  assert.equal(REPOSITORY_PROPOSALS_MAX, 100);
});
