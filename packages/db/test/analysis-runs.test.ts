import assert from "node:assert/strict";
import { test } from "node:test";
import { GRAPHIFY_TOOL_VERSION } from "sandbox-factory";
import { createAnalysisRunStore } from "../src/analysis-runs.js";
import { createArtifactStore } from "../src/artifacts.js";
import type { AnalysisRunRow, ArtifactRow } from "../src/schema.js";
import { createFakeDb, createSequencedFakeDb } from "./fake-db.js";

const now = new Date("2026-10-02T00:00:00Z");
const row = (overrides: Partial<AnalysisRunRow> = {}): AnalysisRunRow => ({
  id: "run",
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
