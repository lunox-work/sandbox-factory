import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ABSTRACTIONS_TOOL_VERSION,
  DATA_MODEL_TOOL_VERSION,
  FIXTURES_TOOL_VERSION,
  GRAPHIFY_TOOL_VERSION,
  SANDBOX_BUILD_RUN_VERSION,
  SCOPE_TOOL_VERSION,
  SLICE_TOOL_VERSION,
  STARTER_TOOL_VERSION,
} from "sandbox-factory";
import { createAnalysisRunStore } from "../src/analysis-runs.js";
import { createArtifactStore } from "../src/artifacts.js";
import type { AnalysisRunRow, ArtifactRow } from "../src/schema.js";
import { createFakeDb, createSequencedFakeDb } from "./fake-db.js";

const now = new Date("2026-10-02T00:00:00Z");
const row = (overrides: Partial<AnalysisRunRow> = {}): AnalysisRunRow => ({
  id: "run",
  organizationId: "owner",
  snapshotId: "snapshot",
  tool: "graphify",
  toolVersion: GRAPHIFY_TOOL_VERSION,
  params: { deadlineMinutes: 30 },
  paramsHash: "hash",
  status: "queued",
  attempt: 0,
  maxAttempts: 2,
  requestedBy: "user",
  leaseToken: null,
  leaseExpiresAt: null,
  heartbeatAt: null,
  deadlineAt: null,
  errorCode: null,
  errorDetail: null,
  progress: null,
  logKey: null,
  startedAt: null,
  finishedAt: null,
  createdAt: now,
  ...overrides,
});
const input = { params: { deadlineMinutes: 30 }, requestedBy: "user" };
const item = {
  kind: "graph_json" as const,
  path: "graph.json",
  objectKey: "runs/run/lease/graph.json",
  contentType: "application/json",
  sizeBytes: 2,
  sha256: "a".repeat(64),
  meta: null,
};

test("enqueue locks owner and snapshot, normalizes cache key and writes one queued run", async () => {
  const fake = createSequencedFakeDb([
    [{ id: "owner" }],
    [{ repoId: "repo" }],
    [],
    [],
    [row()],
  ]);
  const result = await createAnalysisRunStore(fake.db).enqueue(
    "owner",
    "snapshot",
    input,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.created, true);
  assert.equal(result.run.repoId, "repo");
  assert.equal(fake.calls[0]?.lock, "update");
  assert.equal(fake.calls[1]?.lock, "key share");
  assert.match(String(fake.calls[4]?.values?.["paramsHash"]), /^[a-f0-9]{64}$/);
});
const starterInput = {
  tool: "sandbox_starter" as const,
  params: {
    deadlineMinutes: 60,
    agent: "starter" as const,
    sandboxVersionId: "sbv_1",
    approvedTaskSha256: "a".repeat(64),
    stack: ["TypeScript"],
  },
  requestedBy: "user",
};
test("a starter run reads no snapshot: it is the organization's, cached under it", async () => {
  const fake = createSequencedFakeDb([
    [{ id: "owner" }],
    [],
    [],
    [
      row({
        snapshotId: null,
        tool: "sandbox_starter",
        toolVersion: STARTER_TOOL_VERSION,
        params: starterInput.params,
      }),
    ],
  ]);
  const result = await createAnalysisRunStore(fake.db).enqueue(
    "owner",
    null,
    starterInput,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.run.snapshotId, null);
  assert.equal(result.run.repoId, null);
  // No snapshot was looked up: owner lock, cache, spend cap, insert.
  assert.equal(fake.calls.length, 4);
  assert.equal(fake.calls[3]?.values?.["organizationId"], "owner");
  assert.equal(fake.calls[3]?.values?.["snapshotId"], null);
  // A tool reads a snapshot exactly when it reads source.
  await assert.rejects(
    createAnalysisRunStore(
      createSequencedFakeDb([[{ id: "owner" }]]).db,
    ).enqueue("owner", "snapshot", starterInput),
    /snapshot does not match/,
  );
  await assert.rejects(
    createAnalysisRunStore(
      createSequencedFakeDb([[{ id: "owner" }]]).db,
    ).enqueue("owner", null, input),
    /snapshot does not match/,
  );
});
test("a slice run needs a graphify run on the same snapshot and waits for it", async () => {
  const params = {
    deadlineMinutes: 30,
    graphRunId: "graph",
    entryPoints: ["src/main.ts"],
    budget: { maxFiles: 40, maxDepth: 3 },
    includeInferred: false,
  };
  const fake = createSequencedFakeDb([
    [{ id: "owner" }],
    [{ repoId: "repo" }],
    [{ id: "graph" }],
    [],
    [],
    [row({ tool: "slice", toolVersion: SLICE_TOOL_VERSION, params })],
  ]);
  const result = await createAnalysisRunStore(fake.db).enqueue(
    "owner",
    "snapshot",
    { tool: "slice", params, requestedBy: "user" },
  );
  assert.equal(result.ok && result.run.tool, "slice");
  assert.equal(fake.calls[5]?.values?.["tool"], "slice");
  assert.equal(fake.calls[5]?.values?.["toolVersion"], SLICE_TOOL_VERSION);
  const mismatch = createSequencedFakeDb([
    [{ id: "owner" }],
    [{ repoId: "repo" }],
    [],
  ]);
  assert.deepEqual(
    await createAnalysisRunStore(mismatch.db).enqueue("owner", "snapshot", {
      tool: "slice",
      params,
      requestedBy: "user",
    }),
    { ok: false, reason: "graph_mismatch" },
  );
  await assert.rejects(
    createAnalysisRunStore(
      createSequencedFakeDb([[{ id: "owner" }], [{ repoId: "repo" }]]).db,
    ).enqueue("owner", "snapshot", { tool: "slice", ...input }),
    /do not match/,
  );
  const build = {
    deadlineMinutes: 30,
    sliceRunId: "slice",
    sandboxVersionId: "sbv_1",
    manifestSha256: "m".repeat(64),
    contractSha256: "c".repeat(64),
    transformConfigSha256: "t".repeat(64),
    approvedTaskSha256: "a".repeat(64),
  };
  const built = createSequencedFakeDb([
    [{ id: "owner" }],
    [{ repoId: "repo" }],
    [],
    [],
    [
      row({
        tool: "sandbox_build",
        toolVersion: SANDBOX_BUILD_RUN_VERSION,
        params: build,
      }),
    ],
  ]);
  const buildResult = await createAnalysisRunStore(built.db).enqueue(
    "owner",
    "snapshot",
    {
      tool: "sandbox_build",
      params: build,
      requestedBy: "user",
    },
  );
  assert.equal(buildResult.ok && buildResult.run.tool, "sandbox_build");
  assert.equal(
    built.calls[4]?.values?.["toolVersion"],
    SANDBOX_BUILD_RUN_VERSION,
  );
  await assert.rejects(
    createAnalysisRunStore(
      createSequencedFakeDb([[{ id: "owner" }], [{ repoId: "repo" }]]).db,
    ).enqueue("owner", "snapshot", {
      tool: "graphify",
      params: build,
      requestedBy: "user",
    }),
    /do not match/,
  );
  // A row from a newer deploy is skipped by reads instead of failing them.
  const unknown = {
    run: row({ tool: "future_tool" }),
    repoId: "repo",
    organizationId: "owner",
  };
  const mixed = createAnalysisRunStore(
    createFakeDb([unknown, { ...unknown, run: row() }]).db,
  );
  assert.equal(
    await createAnalysisRunStore(createFakeDb([unknown]).db).get(
      "owner",
      "run",
    ),
    null,
  );
  assert.deepEqual(
    (await mixed.list("owner", "repo")).map((run) => run.tool),
    ["graphify"],
  );
  // The claim query only takes known tools; were one to slip through, the
  // mapping still refuses it rather than inventing a tool.
  await assert.rejects(
    createAnalysisRunStore(
      createSequencedFakeDb([
        [row({ tool: "future_tool", status: "running" })],
        [{ repoId: "repo" }],
      ]).db,
    ).claimNext("lease", now),
    /Unknown analysis tool/,
  );
});
test("the builders that read the map need a graphify run on the same snapshot", async () => {
  for (const [builder, version] of [
    ["abstractions", ABSTRACTIONS_TOOL_VERSION],
    ["data_model", DATA_MODEL_TOOL_VERSION],
  ] as const) {
    const params = { deadlineMinutes: 30, builder, graphRunId: "graph" };
    const fake = createSequencedFakeDb([
      [{ id: "owner" }],
      [{ repoId: "repo" }],
      [{ id: "graph" }],
      [],
      [],
      [row({ tool: builder, toolVersion: version, params })],
    ]);
    const result = await createAnalysisRunStore(fake.db).enqueue(
      "owner",
      "snapshot",
      { tool: builder, params, requestedBy: "user" },
    );
    assert.equal(result.ok && result.run.tool, builder);
    assert.equal(fake.calls[5]?.values?.["toolVersion"], version);
    assert.deepEqual(
      await createAnalysisRunStore(
        createSequencedFakeDb([[{ id: "owner" }], [{ repoId: "repo" }], []]).db,
      ).enqueue("owner", "snapshot", {
        tool: builder,
        params,
        requestedBy: "user",
      }),
      { ok: false, reason: "graph_mismatch" },
    );
  }
});
test("agent runs check the run they build on: a scope reads a graph, fixtures a finished slice", async () => {
  const task = {
    deadlineMinutes: 30,
    proposalId: "p1",
    specRevision: 2,
    specHash: "h",
  };
  const scope = { ...task, agent: "scope" as const, graphRunId: "graph" };
  const scoped = createSequencedFakeDb([
    [{ id: "owner" }],
    [{ repoId: "repo" }],
    [{ id: "graph" }],
    [],
    [],
    [row({ tool: "scope", toolVersion: SCOPE_TOOL_VERSION, params: scope })],
  ]);
  const result = await createAnalysisRunStore(scoped.db).enqueue(
    "owner",
    "snapshot",
    { tool: "scope", params: scope, requestedBy: "user" },
  );
  assert.equal(result.ok && result.run.tool, "scope");
  assert.equal(scoped.calls[5]?.values?.["toolVersion"], SCOPE_TOOL_VERSION);
  assert.deepEqual(
    await createAnalysisRunStore(
      createSequencedFakeDb([[{ id: "owner" }], [{ repoId: "repo" }], []]).db,
    ).enqueue("owner", "snapshot", {
      tool: "scope",
      params: scope,
      requestedBy: "user",
    }),
    { ok: false, reason: "graph_mismatch" },
  );
  const fixtures = { ...task, agent: "fixtures" as const, sliceRunId: "slice" };
  const written = createSequencedFakeDb([
    [{ id: "owner" }],
    [{ repoId: "repo" }],
    [{ id: "slice" }],
    [],
    [],
    [
      row({
        tool: "fixtures",
        toolVersion: FIXTURES_TOOL_VERSION,
        params: fixtures,
      }),
    ],
  ]);
  const fixtureResult = await createAnalysisRunStore(written.db).enqueue(
    "owner",
    "snapshot",
    { tool: "fixtures", params: fixtures, requestedBy: "user" },
  );
  assert.equal(fixtureResult.ok && fixtureResult.run.tool, "fixtures");
  assert.deepEqual(
    await createAnalysisRunStore(
      createSequencedFakeDb([[{ id: "owner" }], [{ repoId: "repo" }], []]).db,
    ).enqueue("owner", "snapshot", {
      tool: "fixtures",
      params: fixtures,
      requestedBy: "user",
    }),
    { ok: false, reason: "slice_mismatch" },
  );
});
test("enqueue refuses missing ownership, snapshot and the spend cap", async () => {
  for (const responses of [[], [[{ id: "owner" }], []]]) {
    const fake = createSequencedFakeDb(responses);
    assert.deepEqual(
      await createAnalysisRunStore(fake.db).enqueue("owner", "snapshot", input),
      { ok: false, reason: "not-found" },
    );
  }
  const fake = createSequencedFakeDb([
    [{ id: "owner" }],
    [{ repoId: "repo" }],
    [],
    [row(), row(), row()],
  ]);
  assert.deepEqual(
    await createAnalysisRunStore(fake.db).enqueue("owner", "snapshot", input),
    { ok: false, reason: "run_limit" },
  );
});
test("cached succeeded, active or exhausted runs return without spending again", async () => {
  for (const existing of [
    row(),
    row({ status: "running" }),
    row({ status: "succeeded" }),
    row({ status: "failed", attempt: 2 }),
  ]) {
    const fake = createSequencedFakeDb([
      [{ id: "owner" }],
      [{ repoId: "repo" }],
      [existing],
    ]);
    const result = await createAnalysisRunStore(fake.db).enqueue(
      "owner",
      "snapshot",
      input,
    );
    assert.equal(result.ok && result.created, false);
    assert.equal(fake.calls.length, 3);
  }
});
test("manual retry increments attempt; missing returned write is an error", async () => {
  const fake = createSequencedFakeDb([
    [{ id: "owner" }],
    [{ repoId: "repo" }],
    [row({ status: "failed" })],
    [],
    [row({ attempt: 1 })],
  ]);
  assert.equal(
    (await createAnalysisRunStore(fake.db).enqueue("owner", "snapshot", input))
      .ok,
    true,
  );
  assert.equal(fake.calls[4]?.values?.["attempt"], 1);
  const missing = createSequencedFakeDb([
    [{ id: "owner" }],
    [{ repoId: "repo" }],
    [],
    [],
    [],
  ]);
  await assert.rejects(
    createAnalysisRunStore(missing.db).enqueue("owner", "snapshot", input),
    /did not return/,
  );
});
test("get and list are owner scoped, ordered and bounded", async () => {
  const fake = createFakeDb([
    {
      run: row({ startedAt: now, deadlineAt: now, finishedAt: now }),
      repoId: "repo",
      organizationId: "owner",
    },
  ]);
  const store = createAnalysisRunStore(fake.db);
  assert.equal((await store.get("owner", "run"))?.startedAt, now.toISOString());
  assert.equal((await store.list("owner", "repo", 999)).length, 1);
  assert.equal(fake.calls[1]?.limited, 50);
  assert.ok(fake.calls.every((call) => call.filtered));
  assert.equal(
    await createAnalysisRunStore(createFakeDb([]).db).get("other", "run"),
    null,
  );
});
test("the latest succeeded context run is owner scoped and one row", async () => {
  const fake = createFakeDb([
    {
      run: row({
        tool: "data_model",
        toolVersion: DATA_MODEL_TOOL_VERSION,
        params: { deadlineMinutes: 30, builder: "data_model", graphRunId: "g" },
        status: "succeeded",
        finishedAt: now,
      }),
      repoId: "repo",
      organizationId: "owner",
    },
  ]);
  const store = createAnalysisRunStore(fake.db);
  const found = await store.latestSucceeded("owner", "snapshot", "data_model");
  assert.equal(found?.tool, "data_model");
  assert.equal(fake.calls[0]?.limited, 1);
  assert.ok(fake.calls[0]?.filtered);
  assert.equal(
    await createAnalysisRunStore(createFakeDb([]).db).latestSucceeded(
      "owner",
      "snapshot",
      "abstractions",
    ),
    null,
  );
});
test("claim returns the source and owner, while empty or deleted source returns null", async () => {
  const context = {
    repoId: "repo",
    organizationId: "owner",
    commitSha: "a".repeat(40),
    repoFullName: "acme/app",
    externalRepoId: "42",
    sizeKb: 1,
    installationId: "5",
  };
  const fake = createSequencedFakeDb([[row({ status: "running" })], [context]]);
  const claimed = await createAnalysisRunStore(fake.db).claimNext("lease", now);
  assert.equal(claimed?.leaseToken, "lease");
  assert.equal(claimed?.organizationId, "owner");
  assert.equal(
    await createAnalysisRunStore(createFakeDb([]).db).claimNext("lease", now),
    null,
  );
  // A run with no snapshot is claimed with its owner and no source.
  const sourceless = createSequencedFakeDb([
    [row({ status: "running", snapshotId: null, organizationId: "owner" })],
  ]);
  const starter = await createAnalysisRunStore(sourceless.db).claimNext(
    "lease",
    now,
  );
  assert.equal(sourceless.calls.length, 1);
  assert.equal(starter?.organizationId, "owner");
  assert.equal(starter?.commitSha, null);
  assert.equal(starter?.repoId, null);
  assert.equal(
    await createAnalysisRunStore(
      createSequencedFakeDb([[row()], []]).db,
    ).claimNext("lease", now),
    null,
  );
});
test("lease mutations refuse stale writes; finish inserts artifacts only after a fenced update", async () => {
  for (const present of [false, true]) {
    const fake = createFakeDb(present ? [{ id: "run" }] : []);
    const store = createAnalysisRunStore(fake.db);
    assert.equal(await store.heartbeat("owner", "run", "lease", now), present);
    const progress = {
      count: 1,
      steps: [{ at: now.toISOString(), text: "Read src/a.ts" }],
    };
    assert.equal(
      await store.recordProgress("owner", "run", "lease", progress, now),
      present,
    );
    assert.deepEqual(
      fake.calls.find(({ values }) => values?.["progress"] !== undefined)
        ?.values?.["progress"],
      progress,
    );
    assert.equal(
      await store.finish(
        "owner",
        "run",
        "lease",
        [item],
        "logs/run/lease.log",
        now,
      ),
      present,
    );
    assert.equal(
      fake.calls.filter((call) => call.kind === "insert").length,
      present ? 1 : 0,
    );
    assert.equal(
      await store.fail("owner", "run", "lease", "tool_failed", null, now),
      present,
    );
    assert.equal(await store.release("owner", "run", "lease", now), present);
    assert.equal(await store.failExpired("owner", now), present ? 1 : 0);
    assert.ok(
      fake.calls
        .filter((call) => call.kind === "update")
        .every((call) => call.filtered),
    );
  }
  const broken = createSequencedFakeDb([
    [{ id: "run" }],
    new Error("insert failed"),
  ]);
  await assert.rejects(
    createAnalysisRunStore(broken.db).finish(
      "owner",
      "run",
      "lease",
      [item],
      "log",
      now,
    ),
    /insert failed/,
  );
});
test("watchdog discovery deduplicates owners and reads queue health", async () => {
  const fake = createSequencedFakeDb([
    [{ organizationId: "a" }, { organizationId: "a" }, { organizationId: "b" }],
    [{ id: "queued" }],
    [{ id: "live" }],
    [{ logKey: "log" }],
    [],
  ]);
  const store = createAnalysisRunStore(fake.db);
  assert.deepEqual(await store.organizationsWithExpiredRuns(now), ["a", "b"]);
  assert.deepEqual(await store.queueState(now), {
    queued: true,
    freshWorker: true,
  });
  assert.equal(await store.logKey("a", "run"), "log");
  assert.equal(await store.logKey("b", "run"), null);
  assert.deepEqual(
    await createAnalysisRunStore(createFakeDb([]).db).queueState(now),
    { queued: false, freshWorker: false },
  );
});
test("artifacts are owner-scoped and never convert dates or expose an absent row incorrectly", async () => {
  const artifact: ArtifactRow = {
    id: "artifact",
    runId: "run",
    ...item,
    createdAt: now,
  };
  const fake = createFakeDb([{ artifact }]);
  const store = createArtifactStore(fake.db);
  assert.equal(
    (await store.get("owner", "artifact"))?.createdAt,
    now.toISOString(),
  );
  assert.equal((await store.list("owner", "run"))[0]?.path, "graph.json");
  assert.ok(fake.calls.every((call) => call.filtered));
  assert.equal(
    await createArtifactStore(createFakeDb([]).db).get("other", "artifact"),
    null,
  );
});
