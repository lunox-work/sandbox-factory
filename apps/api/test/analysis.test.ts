import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { ECSClient } from "@aws-sdk/client-ecs";
import type { StoredAnalysisRun } from "@sandbox-factory/db";
import {
  mountAnalysisRoutes,
  type AnalysisRouteOptions,
} from "../src/analysis/routes.js";
import { WorkerLauncher } from "../src/github/launcher.js";
import { AnalysisWatchdog } from "../src/analysis/watchdog.js";
import type { AuthVariables } from "../src/routes.js";
const stamp = "2026-10-01T00:00:00.000Z";
const run: StoredAnalysisRun = {
  id: "arn_1",
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
  ...run,
  id: "arn_slice",
  tool: "slice",
  status: "queued",
  params: {
    deadlineMinutes: 30,
    graphRunId: run.id,
    entryPoints: ["src/main.ts"],
    budget: { maxFiles: 40, maxDepth: 3 },
    includeInferred: false,
  },
};
function fixture(role = "owner") {
  let launches = 0;
  const keys: string[] = [];
  let limit = false;
  const enqueued: { tool: string; params: unknown }[] = [];
  const options = {
    runs: {
      enqueue: async (
        _owner: string,
        _snapshot: string,
        input: { tool?: string; params: unknown },
      ) => {
        enqueued.push({ tool: input.tool ?? "graphify", params: input.params });
        return limit
          ? { ok: false, reason: "run_limit" }
          : {
              ok: true,
              created: false,
              run: input.tool === "slice" ? sliceRun : run,
            };
      },
      list: async () => [run],
      get: async (owner: string, id: string) =>
        owner === "org_1" && id === run.id ? run : null,
      logKey: async (owner: string, id: string) =>
        owner === "org_1" && id === run.id ? "logs/private.log" : null,
    },
    repos: {
      get: async (owner: string, id: string) =>
        owner === "org_1" && id === "ghr_1" ? { id } : null,
    },
    snapshots: {
      current: async () => ({
        id: "rsn_1",
        repoId: "ghr_1",
        treeKey: "trees/1",
      }),
      get: async (_owner: string, id: string) =>
        id === "rsn_1"
          ? { id, repoId: "ghr_1", treeKey: "trees/1" }
          : id === "other-repo"
            ? { id, repoId: "ghr_other", treeKey: "trees/2" }
            : null,
    },
    tree: async (key: string) =>
      key === "trees/1"
        ? {
            version: 1,
            commitSha: "a".repeat(40),
            treeSha: "b".repeat(40),
            truncated: false,
            entries: [
              {
                path: "src/main.ts",
                type: "blob",
                mode: "100644",
                sha: "c",
                size: 1,
              },
              {
                path: "src/util.ts",
                type: "blob",
                mode: "100644",
                sha: "d",
                size: 1,
              },
            ],
          }
        : null,
    artifacts: {
      list: async () => [
        {
          id: "art_1",
          runId: run.id,
          kind: "graph_html",
          path: "graph.html",
          objectKey: "runs/private/graph.html",
          contentType: "text/html",
          sizeBytes: 5,
          sha256: "a".repeat(64),
          meta: null,
          createdAt: stamp,
        },
      ],
      get: async (owner: string, id: string) =>
        owner === "org_1" && id === "art_1"
          ? { objectKey: "runs/private/graph.html" }
          : null,
    },
    objects: {
      signedUrl: async (key: string, ttl: number) => {
        assert.equal(ttl, 900);
        keys.push(key);
        return "https://objects.test/signed";
      },
    },
    ensureWorker: async () => {
      launches++;
    },
  } as unknown as AnalysisRouteOptions;
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("user", {
      id: "user_1",
      email: "test@example.test",
      name: "User",
    } as never);
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
    options,
    keys,
    enqueued,
    setLimit: () => {
      limit = true;
    },
    launches: () => launches,
  };
}
test("a slice checks its entry points against the tree and queues behind the graph run", async () => {
  const f = fixture();
  const response = await f.request("repositories/ghr_1/slices", {
    entryPoints: ["src/util.ts", "src", "src/main.ts"],
    budget: { maxFiles: 5 },
  });
  assert.equal(response.status, 202);
  const body = (await response.json()) as {
    run: StoredAnalysisRun;
    graphRun: StoredAnalysisRun;
  };
  assert.equal(body.run.id, "arn_slice");
  assert.equal(body.graphRun.id, "arn_1");
  assert.deepEqual(f.enqueued, [
    { tool: "graphify", params: { deadlineMinutes: 30 } },
    {
      tool: "slice",
      params: {
        deadlineMinutes: 30,
        graphRunId: "arn_1",
        entryPoints: ["src", "src/main.ts", "src/util.ts"],
        budget: { maxFiles: 5, maxDepth: 3 },
        includeInferred: false,
      },
    },
  ]);
  assert.equal(f.launches(), 1);
  assert.equal(
    (
      await fixture("member").request("repositories/ghr_1/slices", {
        entryPoints: ["src/main.ts"],
      })
    ).status,
    403,
  );
  assert.equal(
    (await f.request("repositories/ghr_1/slices", { entryPoints: [] })).status,
    400,
  );
  assert.equal(
    (
      await f.request("repositories/missing/slices", {
        entryPoints: ["src/main.ts"],
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await f.request("repositories/ghr_1/slices", {
        entryPoints: ["src/main.ts"],
        snapshotId: "other-repo",
      })
    ).status,
    404,
  );
  const unknown = await f.request("repositories/ghr_1/slices", {
    entryPoints: ["lib/x.ts", "src/main.ts"],
  });
  assert.equal(unknown.status, 400);
  assert.deepEqual(
    ((await unknown.json()) as { entryPoints: string[] }).entryPoints,
    ["lib/x.ts"],
  );
  f.options.snapshots.current = async () =>
    ({ id: "rsn_2", repoId: "ghr_1", treeKey: "trees/none" }) as never;
  assert.equal(
    (
      await f.request("repositories/ghr_1/slices", {
        entryPoints: ["src/main.ts"],
      })
    ).status,
    502,
  );
  f.options.snapshots.current = async () =>
    ({ id: "rsn_1", repoId: "ghr_1", treeKey: "trees/1" }) as never;
  f.setLimit();
  assert.equal(
    (
      await f.request("repositories/ghr_1/slices", {
        entryPoints: ["src/main.ts"],
      })
    ).status,
    409,
  );
});
test("a slice reports a failed or mismatched graph run and cleans obsolete logs", async () => {
  const f = fixture();
  const removed: string[] = [];
  Object.assign(f.options.objects, {
    remove: async (key: string) => {
      removed.push(key);
    },
  });
  f.options.runs.enqueue = async (_owner, _snapshot, input) =>
    input.tool === "slice"
      ? { ok: false, reason: "graph_mismatch" }
      : {
          ok: true,
          created: true,
          run: { ...run, status: "queued" },
          obsoleteLogKey: "logs/old.log",
        };
  const mismatch = await f.request("repositories/ghr_1/slices", {
    entryPoints: ["src/main.ts"],
  });
  assert.equal(mismatch.status, 409);
  assert.equal(
    ((await mismatch.json()) as { code: string }).code,
    "graph_mismatch",
  );
  assert.deepEqual(removed, ["logs/old.log"]);
  f.options.runs.enqueue = async () => ({
    ok: true,
    created: false,
    run: { ...run, status: "failed" },
  });
  const failed = await f.request("repositories/ghr_1/slices", {
    entryPoints: ["src/main.ts"],
  });
  assert.equal(failed.status, 409);
  assert.equal(
    ((await failed.json()) as { code: string }).code,
    "graph_failed",
  );
  f.options.runs.enqueue = async () => ({ ok: false, reason: "not-found" });
  assert.equal(
    (
      await f.request("repositories/ghr_1/slices", {
        entryPoints: ["src/main.ts"],
      })
    ).status,
    404,
  );
  f.options.runs.enqueue = async (_owner, _snapshot, input) =>
    input.tool === "slice"
      ? { ok: false, reason: "not-found" }
      : { ok: true, created: false, run };
  assert.equal(
    (
      await f.request("repositories/ghr_1/slices", {
        entryPoints: ["src/main.ts"],
      })
    ).status,
    404,
  );
  f.options.runs.enqueue = async (_owner, _snapshot, input) =>
    input.tool === "slice"
      ? {
          ok: true,
          created: true,
          run: sliceRun,
          obsoleteLogKey: "logs/slice.log",
        }
      : { ok: true, created: false, run };
  assert.equal(
    (
      await f.request("repositories/ghr_1/slices", {
        entryPoints: ["src/main.ts"],
      })
    ).status,
    202,
  );
  assert.deepEqual(removed, ["logs/old.log", "logs/slice.log"]);
});
test("enqueue validates scope, role, parameters, cache result, and active cap", async () => {
  const f = fixture();
  for (let i = 0; i < 2; i++) {
    const response = await f.request("repositories/ghr_1/runs", {
      tool: "graphify",
    });
    assert.equal(response.status, 202);
    assert.equal(
      ((await response.json()) as { run: StoredAnalysisRun }).run.id,
      run.id,
    );
  }
  assert.equal(f.launches(), 2);
  assert.equal(
    (
      await fixture("member").request("repositories/ghr_1/runs", {
        tool: "graphify",
      })
    ).status,
    403,
  );
  assert.equal(
    (await f.request("repositories/ghr_1/runs", { tool: "unknown" })).status,
    400,
  );
  assert.equal(
    (
      await f.request("repositories/ghr_1/runs", {
        tool: "graphify",
        snapshotId: "other-repo",
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await f.request("repositories/ghr_1/runs", {
        tool: "graphify",
        snapshotId: "missing",
      })
    ).status,
    404,
  );
  assert.equal(
    (await f.request("repositories/ghr_1/runs", { tool: "graphify" }, "org_2"))
      .status,
    404,
  );
  f.setLimit();
  const response = await f.request("repositories/ghr_1/runs", {
    tool: "graphify",
  });
  assert.equal(response.status, 409);
  assert.equal(((await response.json()) as { code: string }).code, "run_limit");
  f.options.runs.enqueue = async () => ({ ok: false, reason: "not-found" });
  assert.equal(
    (await f.request("repositories/ghr_1/runs", { tool: "graphify" })).status,
    404,
  );
});
test("a context builder names itself in its parameters", async () => {
  const f = fixture();
  assert.equal(
    (
      await f.request("repositories/ghr_1/runs", {
        tool: "dependency_cruiser",
        snapshotId: "rsn_1",
      })
    ).status,
    202,
  );
  assert.equal(
    (await f.request("repositories/ghr_1/runs", { tool: "deepwiki" })).status,
    202,
  );
  assert.deepEqual(f.enqueued, [
    {
      tool: "dependency_cruiser",
      params: { deadlineMinutes: 30, builder: "dependency_cruiser" },
    },
    { tool: "deepwiki", params: { deadlineMinutes: 60, builder: "deepwiki" } },
  ]);
});
test("launch errors keep the queued response for watchdog recovery", async () => {
  const f = fixture();
  let caught = false;
  Object.assign(f.options, {
    ensureWorker: async () => {
      throw new Error("ECS unavailable");
    },
    onLaunchError: () => {
      caught = true;
    },
  });
  assert.equal(
    (
      await f.request("repositories/ghr_1/runs", {
        tool: "graphify",
        snapshotId: "rsn_1",
      })
    ).status,
    202,
  );
  assert.equal(caught, true);
});
test("members read runs and artifacts; signed downloads are private and uncached", async () => {
  const f = fixture("member");
  assert.equal((await f.request("repositories/ghr_1/runs")).status, 200);
  assert.equal((await f.request("runs/arn_1")).status, 200);
  const artifacts = await f.request("runs/arn_1/artifacts");
  assert.doesNotMatch(await artifacts.text(), /objectKey|runs\/private/);
  const url = await f.request("artifacts/art_1/url");
  assert.equal(url.status, 200);
  assert.equal(url.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(f.keys, ["runs/private/graph.html"]);
  assert.equal((await f.request("runs/arn_1/log/url")).status, 403);
  for (const path of [
    "repositories/ghr_1/runs",
    "runs/arn_1",
    "runs/arn_1/artifacts",
    "artifacts/art_1/url",
  ])
    assert.equal((await f.request(path, undefined, "org_2")).status, 404);
  const owner = fixture();
  assert.equal((await owner.request("runs/arn_1/log/url")).status, 200);
  assert.equal((await owner.request("runs/missing/log/url")).status, 404);
});
test("launcher coalesces launches and skips fresh workers, empty queues, and local mode", async () => {
  let count = 0,
    queued = true,
    freshWorker = false;
  let now = new Date(stamp);
  const config = {
    taskDefinition: "worker",
    cluster: "cluster",
    subnets: ["subnet"],
    securityGroup: "egress",
  };
  const options = {
    runs: { queueState: async () => ({ queued, freshWorker }) },
    config,
    now: () => now,
    launch: async (input: unknown) => {
      count++;
      assert.equal((input as { launchType: string }).launchType, "FARGATE");
      return { $metadata: {}, tasks: [{}] };
    },
  };
  const launcher = new WorkerLauncher(options);
  await Promise.all([launcher.ensureWorker(), launcher.ensureWorker()]);
  assert.equal(count, 1);
  await launcher.ensureWorker();
  assert.equal(count, 1);
  now = new Date(now.getTime() + 31_000);
  freshWorker = true;
  await launcher.ensureWorker();
  assert.equal(count, 1);
  freshWorker = false;
  queued = false;
  await launcher.ensureWorker();
  assert.equal(count, 1);
  queued = true;
  await launcher.ensureWorker();
  assert.equal(count, 2);
  await new WorkerLauncher({ runs: options.runs }).ensureWorker();
  for (const output of [
    { tasks: [] },
    { failures: [{ reason: "capacity" }], tasks: [{}] },
  ])
    await assert.rejects(
      new WorkerLauncher({
        ...options,
        launch: async () => ({ $metadata: {}, ...output }),
      }).ensureWorker(),
      /could not be launched/,
    );
  const original = ECSClient.prototype.send;
  Object.assign(ECSClient.prototype, { send: async () => ({ tasks: [{}] }) });
  try {
    await new WorkerLauncher({ runs: options.runs, config }).ensureWorker();
  } finally {
    Object.assign(ECSClient.prototype, { send: original });
  }
});
test("watchdog expires owners before launch, coalesces sweeps, and stops cleanly", async () => {
  const calls: string[] = [];
  const watchdog = new AnalysisWatchdog({
    runs: {
      organizationsWithExpiredRuns: async () => ["org_1"],
      failExpired: async (owner) => {
        calls.push(owner);
        return 1;
      },
    },
    ensureWorker: async () => {
      calls.push("launch");
    },
  });
  await Promise.all([watchdog.sweep(), watchdog.sweep()]);
  assert.deepEqual(calls, ["org_1", "launch"]);
  watchdog.start();
  watchdog.start();
  await watchdog.stop();
  assert.deepEqual(calls, ["org_1", "launch", "org_1", "launch"]);
  let error = false;
  const broken = new AnalysisWatchdog({
    runs: {
      organizationsWithExpiredRuns: async () => {
        throw new Error("DB unavailable");
      },
      failExpired: async () => 0,
    },
    ensureWorker: async () => {},
    onError: () => {
      error = true;
    },
  });
  broken.start();
  await new Promise((resolve) => setImmediate(resolve));
  await broken.stop();
  assert.equal(error, true);
});
