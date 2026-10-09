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
  progress: null,
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
function fixture(role = "owner", tool: StoredAnalysisRun["tool"] = run.tool) {
  // The run the repository's list and lookups answer with.
  const shown: StoredAnalysisRun = { ...run, tool };
  /** What the runs list was asked for, call by call. */
  const listed: unknown[][] = [];
  let launches = 0;
  const keys: string[] = [];
  let limit = false;
  const enqueued: { tool: string; params: unknown }[] = [];
  /** Each move of a repository's context, as `owner/repo@snapshot`. */
  const contexts: string[] = [];
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
      list: async (...args: unknown[]) => {
        listed.push(args);
        return [shown];
      },
      get: async (owner: string, id: string) =>
        owner === "org_1" && id === run.id ? shown : null,
      logKey: async (owner: string, id: string) =>
        owner === "org_1" && id === run.id ? "logs/private.log" : null,
    },
    repos: {
      get: async (owner: string, id: string) =>
        owner === "org_1" && id === "ghr_1" ? { id } : null,
      setContextSnapshot: async (
        owner: string,
        id: string,
        snapshotId: string,
      ) => {
        contexts.push(`${owner}/${id}@${snapshotId}`);
        return true;
      },
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
        owner !== "org_1"
          ? null
          : id === "art_1"
            ? {
                runId: run.id,
                objectKey: "runs/private/graph.html",
                path: "graph.html",
                sizeBytes: 5,
              }
            : id === "art_png"
              ? {
                  runId: run.id,
                  objectKey: "runs/private/a.png",
                  path: "a.png",
                  sizeBytes: 3,
                }
              : id === "art_big"
                ? {
                    runId: run.id,
                    objectKey: "runs/private/big.json",
                    path: "big.json",
                    sizeBytes: 2_000_000,
                  }
                : id === "art_gone"
                  ? {
                      runId: run.id,
                      objectKey: "runs/private/gone",
                      path: "gone.md",
                      sizeBytes: 1,
                    }
                  : null,
    },
    objects: {
      get: async (key: string) =>
        key === "logs/private.log"
          ? new TextEncoder().encode("Analysis artifacts uploaded.")
          : key === "runs/private/graph.html"
            ? new TextEncoder().encode("<svg>")
            : key === "runs/private/a.png"
              ? new Uint8Array([137, 0, 1])
              : undefined,
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
  // As `requireMembership` does: the owner is the path's, so a request for
  // another workspace reads that workspace's rows, of which there are none.
  app.use("/api/v1/orgs/:orgId/*", async (c, next) => {
    c.set("user", {
      id: "user_1",
      email: "test@example.test",
      name: "User",
    } as never);
    c.set("member", {
      role,
      organizationId: c.req.param("orgId"),
    } as never);
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
    contexts,
    listed,
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
test("a builder that reads the map queues behind the snapshot's graph run", async () => {
  const f = fixture();
  for (const tool of ["abstractions", "data_model"])
    assert.equal(
      (await f.request("repositories/ghr_1/runs", { tool })).status,
      202,
    );
  assert.deepEqual(f.enqueued, [
    { tool: "graphify", params: { deadlineMinutes: 30 } },
    {
      tool: "abstractions",
      params: {
        deadlineMinutes: 30,
        builder: "abstractions",
        graphRunId: run.id,
      },
    },
    { tool: "graphify", params: { deadlineMinutes: 30 } },
    {
      tool: "data_model",
      params: {
        deadlineMinutes: 30,
        builder: "data_model",
        graphRunId: run.id,
      },
    },
  ]);
  assert.equal(f.launches(), 2);
  // A graph that failed is reported before anything is queued behind it.
  f.options.runs.enqueue = async () => ({
    ok: true,
    created: false,
    run: { ...run, status: "failed" },
  });
  const failed = await f.request("repositories/ghr_1/runs", {
    tool: "abstractions",
  });
  assert.equal(failed.status, 409);
  assert.equal(
    ((await failed.json()) as { code: string }).code,
    "graph_failed",
  );
  // A refused builder still wakes a worker for the graph it queued.
  for (const [reason, status] of [
    ["graph_mismatch", 409],
    ["run_limit", 409],
    ["not-found", 404],
  ] as const) {
    f.options.runs.enqueue = async (_owner, _snapshot, input) =>
      input.tool === "graphify"
        ? { ok: true, created: true, run: { ...run, status: "queued" } }
        : { ok: false, reason };
    const before = f.launches();
    const response = await f.request("repositories/ghr_1/runs", {
      tool: "data_model",
    });
    assert.equal(response.status, status);
    assert.equal(f.launches(), before + 1);
  }
  f.options.runs.enqueue = async (_owner, _snapshot, input) =>
    input.tool === "graphify"
      ? { ok: false, reason: "run_limit" }
      : { ok: true, created: false, run };
  assert.equal(
    (await f.request("repositories/ghr_1/runs", { tool: "abstractions" }))
      .status,
    409,
  );
});
test("Build all queues the whole set once the cap admits its first run", async () => {
  const f = fixture();
  // One slot left under the default cap of three.
  let active = 2;
  const caps: number[] = [];
  f.options.runs.enqueue = async (_owner, _snapshot, input) => {
    const cap = input.maxActive ?? 3;
    caps.push(cap);
    if (active >= cap) return { ok: false, reason: "run_limit" };
    active++;
    const tool = input.tool ?? "graphify";
    return {
      ok: true,
      created: true,
      run: {
        ...run,
        id: `arn_${tool}`,
        tool,
        params: input.params,
        status: "queued",
      } as StoredAnalysisRun,
    };
  };
  const response = await f.request("repositories/ghr_1/builds", {
    snapshotId: "rsn_1",
  });
  assert.equal(response.status, 202);
  const { runs } = (await response.json()) as { runs: StoredAnalysisRun[] };
  assert.deepEqual(
    runs.map((each) => each.tool),
    [
      "graphify",
      "dependency_cruiser",
      "deepwiki",
      "abstractions",
      "data_model",
    ],
  );
  // The map readers read the graph run the set queued first.
  assert.deepEqual(runs[4]?.params, {
    deadlineMinutes: 30,
    builder: "data_model",
    graphRunId: "arn_graphify",
  });
  assert.deepEqual(caps, [3, 8, 8, 8, 8]);
  assert.equal(f.launches(), 1);
  // The set's snapshot is now the repository's context.
  assert.deepEqual(f.contexts, ["org_1/ghr_1@rsn_1"]);
  // With no slot left, the first run is refused and nothing is queued,
  // and the context stays where it was.
  caps.length = 0;
  const full = await f.request("repositories/ghr_1/builds", {});
  assert.equal(full.status, 409);
  assert.equal(((await full.json()) as { code: string }).code, "run_limit");
  assert.deepEqual(caps, [3]);
  assert.equal(f.launches(), 1);
  assert.deepEqual(f.contexts, ["org_1/ghr_1@rsn_1"]);
});
test("Build all answers built runs as is, with each builder's parameters", async () => {
  const f = fixture();
  const response = await f.request("repositories/ghr_1/builds", {});
  assert.equal(response.status, 202);
  assert.deepEqual(f.enqueued, [
    { tool: "graphify", params: { deadlineMinutes: 30 } },
    {
      tool: "dependency_cruiser",
      params: { deadlineMinutes: 30, builder: "dependency_cruiser" },
    },
    { tool: "deepwiki", params: { deadlineMinutes: 60, builder: "deepwiki" } },
    {
      tool: "abstractions",
      params: {
        deadlineMinutes: 30,
        builder: "abstractions",
        graphRunId: run.id,
      },
    },
    {
      tool: "data_model",
      params: {
        deadlineMinutes: 30,
        builder: "data_model",
        graphRunId: run.id,
      },
    },
  ]);
  // Nothing new was queued, so no worker is woken; the built set still
  // becomes the repository's context, as moving back to it does.
  assert.equal(f.launches(), 0);
  assert.deepEqual(f.contexts, ["org_1/ghr_1@rsn_1"]);
});
test("Build all skips the map readers when the graph is out of retries", async () => {
  const f = fixture();
  const tools: string[] = [];
  f.options.runs.enqueue = async (_owner, _snapshot, input) => {
    tools.push(input.tool ?? "graphify");
    return {
      ok: true,
      created: false,
      run:
        input.tool === "graphify"
          ? { ...run, status: "failed", attempt: 2 }
          : run,
    };
  };
  const response = await f.request("repositories/ghr_1/builds", {});
  assert.equal(response.status, 202);
  assert.deepEqual(tools, ["graphify", "dependency_cruiser", "deepwiki"]);
  assert.equal(((await response.json()) as { runs: unknown[] }).runs.length, 3);
});
test("Build all is refused for members, bad input, and other repositories", async () => {
  const f = fixture();
  assert.equal(
    (await fixture("member").request("repositories/ghr_1/builds", {})).status,
    403,
  );
  assert.equal(
    (await f.request("repositories/ghr_1/builds", { tool: "graphify" })).status,
    400,
  );
  for (const snapshotId of ["other-repo", "missing"])
    assert.equal(
      (await f.request("repositories/ghr_1/builds", { snapshotId })).status,
      404,
    );
  assert.equal(
    (await f.request("repositories/ghr_1/builds", {}, "org_2")).status,
    404,
  );
  assert.deepEqual(f.enqueued, []);
  assert.deepEqual(f.contexts, []);
});
test("a set refused partway still wakes a worker for what it queued", async () => {
  for (const [reason, status] of [
    ["graph_mismatch", 409],
    ["not-found", 404],
  ] as const) {
    const f = fixture();
    f.options.runs.enqueue = async (_owner, _snapshot, input) =>
      input.tool === "graphify"
        ? { ok: true, created: true, run: { ...run, status: "queued" } }
        : { ok: false, reason };
    const response = await f.request("repositories/ghr_1/builds", {});
    assert.equal(response.status, status);
    assert.equal(f.launches(), 1);
    // What it queued stands on the snapshot, so the context follows it.
    assert.deepEqual(f.contexts, ["org_1/ghr_1@rsn_1"]);
  }
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
test("a repository's runs can be read for one snapshot", async () => {
  // A page shows one snapshot's builds; the repository's newest page of
  // runs may no longer hold them.
  const f = fixture("member");
  assert.equal((await f.request("repositories/ghr_1/runs")).status, 200);
  assert.equal(
    (await f.request("repositories/ghr_1/runs?snapshotId=rsn_1")).status,
    200,
  );
  assert.deepEqual(f.listed, [
    ["org_1", "ghr_1", undefined, undefined],
    ["org_1", "ghr_1", 50, "rsn_1"],
  ]);
});

test("a sandbox build's run and artifacts are not a member's to read", async () => {
  // Its artifacts are a version's private sandbox, hidden tests among them,
  // which the sandbox routes keep to owners and admins.
  for (const tool of ["sandbox_build", "sandbox_starter"] as const) {
    const member = fixture("member", tool);
    const listed = (await (
      await member.request("repositories/ghr_1/runs")
    ).json()) as { runs: unknown[] };
    assert.deepEqual(listed.runs, []);
    for (const path of [
      "runs/arn_1",
      "runs/arn_1/artifacts",
      "artifacts/art_1/url",
      "artifacts/art_1/content",
    ])
      assert.equal((await member.request(path)).status, 404, path);
    assert.deepEqual(member.keys, []);
    // An admin still reads them here. (The run itself is not read: this
    // fixture's parameters are a graph run's, not a build's.)
    const admin = fixture("admin", tool);
    assert.equal((await admin.request("artifacts/art_1/url")).status, 200);
  }
});
test("members read an artifact as text, unless it is binary or too large", async () => {
  const f = fixture("member");
  const text = await f.request("artifacts/art_1/content");
  assert.equal(text.status, 200);
  assert.equal(text.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await text.json(), {
    path: "graph.html",
    sizeBytes: 5,
    text: "<svg>",
    omitted: null,
  });
  const binary = await f.request("artifacts/art_png/content");
  assert.equal(
    ((await binary.json()) as { omitted: string }).omitted,
    "binary",
  );
  const big = await f.request("artifacts/art_big/content");
  assert.equal(
    ((await big.json()) as { omitted: string }).omitted,
    "too_large",
  );
  assert.equal((await f.request("artifacts/art_gone/content")).status, 502);
  assert.equal((await f.request("artifacts/missing/content")).status, 404);
  assert.equal(
    (await f.request("artifacts/art_1/content", undefined, "org_2")).status,
    404,
  );
});
test("owners and admins read a run's log as text; members cannot", async () => {
  const owner = fixture();
  const log = await owner.request("runs/arn_1/log/content");
  assert.equal(log.status, 200);
  assert.equal(log.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await log.json(), {
    sizeBytes: 28,
    text: "Analysis artifacts uploaded.",
    omitted: null,
  });
  assert.equal((await owner.request("runs/missing/log/content")).status, 404);
  assert.equal(
    (await owner.request("runs/arn_1/log/content", undefined, "org_2")).status,
    404,
  );
  const member = fixture("member");
  assert.equal((await member.request("runs/arn_1/log/content")).status, 403);
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
