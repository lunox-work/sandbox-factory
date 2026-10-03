import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  EnqueueAnalysisResult,
  NewBountyProfile,
  ProfileTransition,
  StoredAnalysisRun,
  StoredArtifact,
  StoredBountyProfile,
  StoredBountySpec,
  StoredRepoSnapshot,
} from "@sandbox-factory/db";
import {
  AGENT_DEADLINE_MINUTES,
  type ScopeProposalDto,
  type SliceBoundarySummaryDto,
} from "@sandbox-factory/shared";
import {
  canonicalJson,
  isScopeParams,
  isSliceParams,
  toolOfParams,
  treeFacts,
} from "sandbox-factory";
import type {
  AnalysisParams,
  AnalysisTool,
  ProfileStatus,
} from "sandbox-factory";

import { BountyProfiler, PROFILE_SWEEP_MS } from "../src/bounty/profiler.js";

const OWNER = "org_1";

const request: NewBountyProfile = {
  proposalId: "bpr_1",
  specRevision: 2,
  specHash: "h".repeat(64),
  snapshotId: "rsn_1",
  ticket: { issueType: "Bug", priority: "High" },
};

const scopeMeta: ScopeProposalDto = {
  schemaVersion: 1,
  toolVersion: "scope@2",
  sourceSnapshotId: "rsn_1",
  sourceCommitSha: "c".repeat(40),
  graphRunId: "arn_graphify_1",
  proposalId: "bpr_1",
  specRevision: 2,
  entryPoints: [
    { path: "src/scheduler/interview.ts", reason: "saves it" },
    { path: "src/mailer/invite.ts", reason: "sends it" },
  ],
  budget: { maxFiles: 20, maxDepth: 2 },
  includeInferred: false,
  seams: [{ module: "src/db/client.ts", kind: "database", reason: "I/O" }],
  summary: "The developer fixes invitation delivery.",
  risks: ["Retries only exist as a mock."],
  pattern: { path: "src/mailer/offer.ts", reason: "retries idempotently" },
  check: {
    stubCoverage: "full",
    ready: true,
    includedFiles: 3,
    outboundModules: 1,
    blockers: 0,
  },
  usage: {
    model: "agent",
    turns: 4,
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  },
};

const boundaryMeta: SliceBoundarySummaryDto = {
  schemaVersion: 1,
  language: "typescript",
  stubCoverage: "full",
  ready: true,
  counts: {
    includedFiles: 3,
    includedBytes: 9_000,
    outboundModules: 1,
    inboundModules: 0,
    stubs: 1,
    publicSymbols: 0,
    externals: 2,
    blockers: 0,
  },
  included: [
    "src/scheduler/interview.ts",
    "src/scheduler/calendar.ts",
    "src/mailer/invite.ts",
  ],
  outbound: [],
  inbound: [],
  externals: {
    packages: [{ specifier: "nodemailer", service: "email" }],
    environment: ["SMTP_HOST"],
  },
  blockers: [],
  truncated: false,
};

const facts = treeFacts([
  { path: "src/scheduler/interview.ts", size: 4_000 },
  { path: "src/scheduler/calendar.ts", size: 2_000 },
  { path: "src/mailer/invite.ts", size: 3_000 },
  { path: "src/mailer/invite.test.ts", size: 1_000 },
  { path: "src/mailer/offer.ts", size: 3_000 },
  { path: ".github/workflows/ci.yml", size: 300 },
]);

function artifact(
  runId: string,
  kind: StoredArtifact["kind"],
  meta: unknown,
): StoredArtifact {
  return {
    id: `art_${runId}_${kind}`,
    runId,
    kind,
    path: `${kind}.json`,
    objectKey: `runs/${runId}/${kind}.json`,
    contentType: "application/json",
    sizeBytes: 1,
    sha256: "0".repeat(64),
    meta: meta as Record<string, unknown> | null,
    createdAt: "2026-10-03T00:00:00.000Z",
  };
}

/** An analysis queue that keeps one run per tool and params, like the store. */
class FakeRuns {
  readonly runs = new Map<string, StoredAnalysisRun>();
  readonly enqueued: {
    snapshotId: string;
    tool: AnalysisTool | undefined;
    params: AnalysisParams;
    requestedBy: string | null;
    maxActive: number | undefined;
  }[] = [];
  /** Per tool, an answer other than a fresh queued run. */
  readonly refuse = new Map<AnalysisTool, EnqueueAnalysisResult>();
  /** Per tool, the status a fresh run is created in. */
  readonly startAs = new Map<AnalysisTool, StoredAnalysisRun["status"]>();
  obsoleteLogKey: string | undefined;

  enqueue = async (
    _owner: string,
    snapshotId: string,
    input: {
      tool?: AnalysisTool;
      params: AnalysisParams;
      requestedBy: string | null;
      maxActive?: number;
    },
  ): Promise<EnqueueAnalysisResult> => {
    this.enqueued.push({
      snapshotId,
      tool: input.tool,
      params: input.params,
      requestedBy: input.requestedBy,
      maxActive: input.maxActive,
    });
    const tool = input.tool ?? "graphify";
    assert.equal(toolOfParams(input.params), tool);
    const refused = this.refuse.get(tool);
    if (refused !== undefined) return refused;
    const id = `arn_${tool}_${this.runs.size + 1}`;
    const existing = [...this.runs.values()].find(
      (run) =>
        run.tool === tool &&
        canonicalJson(run.params) === canonicalJson(input.params),
    );
    if (existing !== undefined)
      return { ok: true, run: existing, created: false };
    const run: StoredAnalysisRun = {
      id,
      snapshotId,
      repoId: "ghr_1",
      tool,
      toolVersion: `${tool}@1`,
      params: input.params,
      status: this.startAs.get(tool) ?? "queued",
      attempt: 0,
      maxAttempts: 2,
      errorCode: this.startAs.get(tool) === "failed" ? "tool_failed" : null,
      errorDetail: null,
      startedAt: null,
      finishedAt: null,
      deadlineAt: null,
      createdAt: "2026-10-03T00:00:00.000Z",
    };
    this.runs.set(id, run);
    return {
      ok: true,
      run,
      created: true,
      ...(this.obsoleteLogKey === undefined
        ? {}
        : { obsoleteLogKey: this.obsoleteLogKey }),
    };
  };

  get = async (_owner: string, id: string) => this.runs.get(id) ?? null;

  /** The run of one tool, as the queue holds it. */
  of(tool: AnalysisTool): StoredAnalysisRun {
    const run = [...this.runs.values()].find(
      (candidate) => candidate.tool === tool,
    );
    assert.ok(run, `no ${tool} run`);
    return run;
  }

  finish(
    tool: AnalysisTool,
    status: StoredAnalysisRun["status"],
    errorCode: StoredAnalysisRun["errorCode"] = null,
  ) {
    const run = this.of(tool);
    this.runs.set(run.id, { ...run, status, errorCode });
  }
}

/** The profile store, in memory, with its compare-and-set step. */
class FakeProfiles {
  readonly rows = new Map<string, StoredBountyProfile>();
  /** Set to make `advance` behave as though another sweep moved first. */
  raced = false;

  request = async (owner: string, input: NewBountyProfile) => {
    if (input.proposalId === "bpr_other") return null;
    const existing = [...this.rows.values()].find(
      (row) =>
        row.proposalId === input.proposalId &&
        row.specRevision === input.specRevision,
    );
    if (existing !== undefined) return existing;
    const row: StoredBountyProfile = {
      id: `bpf_${this.rows.size + 1}`,
      organizationId: owner,
      ...input,
      status: "queued",
      errorCode: null,
      runErrorCode: null,
      scopeRunId: null,
      sliceRunId: null,
      profile: null,
      createdAt: "2026-10-03T00:00:00.000Z",
      updatedAt: "2026-10-03T00:00:00.000Z",
    };
    this.rows.set(row.id, row);
    return row;
  };

  pending = async (owner: string) =>
    [...this.rows.values()].filter(
      (row) =>
        row.organizationId === owner &&
        ["queued", "scoping", "slicing"].includes(row.status),
    );

  organizationsWithPending = async () => [
    ...new Set(
      [...this.rows.values()]
        .filter((row) => ["queued", "scoping", "slicing"].includes(row.status))
        .map((row) => row.organizationId),
    ),
  ];

  advance = async (
    _owner: string,
    id: string,
    from: ProfileStatus,
    to: ProfileTransition,
  ) => {
    const row = this.rows.get(id);
    if (this.raced || row === undefined || row.status !== from) return false;
    this.rows.set(id, {
      ...row,
      status: to.status,
      ...(to.status === "scoping" ? { scopeRunId: to.scopeRunId } : {}),
      ...(to.status === "slicing" ? { sliceRunId: to.sliceRunId } : {}),
      ...(to.status === "ready" ? { profile: to.profile } : {}),
      ...(to.status === "failed"
        ? { errorCode: to.errorCode, runErrorCode: to.runErrorCode ?? null }
        : {}),
    });
    return true;
  };

  only(): StoredBountyProfile {
    const [row] = this.rows.values();
    assert.ok(row);
    return row;
  }
}

function harness() {
  const runs = new FakeRuns();
  const profiles = new FakeProfiles();
  const artifacts = new Map<string, StoredArtifact[]>();
  const snapshots = new Map<string, StoredRepoSnapshot>([
    ["rsn_1", { id: "rsn_1", facts } as unknown as StoredRepoSnapshot],
  ]);
  const specs = new Map<string, StoredBountySpec>([
    [
      "bpr_1:2",
      {
        revision: 2,
        draft: {
          feature: "Invitations",
          background: [],
          scenarios: [
            {
              id: "s1",
              kind: "happy",
              title: "One invitation",
              steps: [{ keyword: "Then", text: "one email" }],
              origin: "draft",
            },
          ],
          openQuestions: [],
          assumptions: ["Retries key on a token."],
        },
      } as unknown as StoredBountySpec,
    ],
  ]);
  const errors: string[] = [];
  const removed: string[] = [];
  let launches = 0;
  let launchFails = false;
  const profiler = new BountyProfiler({
    profiles,
    runs,
    artifacts: {
      list: async (_owner, runId) => artifacts.get(runId) ?? [],
    },
    snapshots: { get: async (_owner, id) => snapshots.get(id) ?? null },
    specs: {
      get: async (_owner, proposalId, revision) =>
        specs.get(`${proposalId}:${revision}`) ?? null,
    },
    ensureWorker: async () => {
      launches += 1;
      if (launchFails) throw new Error("no capacity");
    },
    removeObject: async (key) => {
      removed.push(key);
    },
    maxActive: 4,
    intervalMs: 60_000,
    onError: (code) => errors.push(code),
  });
  return {
    profiler,
    runs,
    profiles,
    artifacts,
    snapshots,
    specs,
    errors,
    removed,
    launches: () => launches,
    failLaunches: () => {
      launchFails = true;
    },
  };
}

/** Finishes the scope run with a recorded proposal, as the worker would. */
function scoped(h: ReturnType<typeof harness>, meta: unknown = scopeMeta) {
  h.runs.finish("scope", "succeeded");
  h.artifacts.set(h.runs.of("scope").id, [
    artifact(h.runs.of("scope").id, "scope_proposal", meta),
  ]);
}

function sliced(h: ReturnType<typeof harness>, meta: unknown = boundaryMeta) {
  h.runs.finish("slice", "succeeded");
  h.artifacts.set(h.runs.of("slice").id, [
    artifact(h.runs.of("slice").id, "slice_manifest", { includedFiles: 3 }),
    artifact(h.runs.of("slice").id, "boundary_contract", meta),
  ]);
}

test("a requested profile is scoped, sliced and built from what was measured", async () => {
  const h = harness();
  await h.profiler.request(OWNER, request);
  await h.profiler.sweep();

  // The graph and the scope that reads it are queued, by nobody in particular.
  let row = h.profiles.only();
  assert.equal(row.status, "scoping");
  const [graph, scope] = h.runs.enqueued;
  assert.equal(graph?.tool, "graphify");
  assert.deepEqual(graph?.params, { deadlineMinutes: 30 });
  assert.equal(scope?.tool, "scope");
  assert.ok(scope !== undefined && isScopeParams(scope.params));
  assert.deepEqual(scope.params, {
    deadlineMinutes: AGENT_DEADLINE_MINUTES,
    agent: "scope",
    graphRunId: h.runs.of("graphify").id,
    proposalId: "bpr_1",
    specRevision: 2,
    specHash: request.specHash,
  });
  assert.equal(scope.requestedBy, null);
  assert.equal(scope.maxActive, 4);
  assert.equal(row.scopeRunId, h.runs.of("scope").id);
  assert.ok(h.launches() >= 1);

  // While the scope runs, nothing moves.
  h.runs.finish("scope", "running");
  await h.profiler.sweep();
  assert.equal(h.profiles.only().status, "scoping");

  // The scope's own request is sliced, on the graph it read.
  scoped(h);
  await h.profiler.sweep();
  row = h.profiles.only();
  assert.equal(row.status, "slicing");
  const slice = h.runs.enqueued.at(-1);
  assert.ok(slice !== undefined && isSliceParams(slice.params));
  assert.deepEqual(slice.params, {
    deadlineMinutes: 30,
    graphRunId: scopeMeta.graphRunId,
    entryPoints: ["src/mailer/invite.ts", "src/scheduler/interview.ts"],
    budget: { maxFiles: 20, maxDepth: 2 },
    includeInferred: false,
  });
  assert.equal(row.sliceRunId, h.runs.of("slice").id);

  await h.profiler.sweep();
  assert.equal(h.profiles.only().status, "slicing");

  sliced(h);
  const launchesBefore = h.launches();
  await h.profiler.sweep();
  row = h.profiles.only();
  assert.equal(row.status, "ready");
  // Building enqueues nothing, so no worker is asked for.
  assert.equal(h.launches(), launchesBefore);
  const profile = row.profile;
  assert.ok(profile !== null);
  assert.deepEqual(profile.ticket, request.ticket);
  assert.equal(profile.slice.files, 3);
  assert.deepEqual(profile.slice.modules, ["src/mailer", "src/scheduler"]);
  assert.deepEqual(profile.touchedModules, ["src/mailer", "src/scheduler"]);
  assert.deepEqual(profile.externals, {
    services: ["email"],
    environment: 1,
    seams: 1,
  });
  assert.equal(profile.spec.assumptions, 1);
  assert.deepEqual(profile.tests, {
    files: 1,
    untestedModules: ["src/scheduler"],
  });
  assert.deepEqual(profile.pattern, scopeMeta.pattern);
  assert.equal(profile.nonFunctional.ci, true);

  // Once ready, the row is out of the sweep.
  const enqueues = h.runs.enqueued.length;
  await h.profiler.sweep();
  assert.equal(h.runs.enqueued.length, enqueues);
  assert.deepEqual(h.errors, []);
});

test("at the organization's analysis cap a profile waits, and the rest of the sweep enqueues nothing", async () => {
  const h = harness();
  h.runs.refuse.set("graphify", { ok: false, reason: "run_limit" });
  await h.profiles.request(OWNER, request);
  await h.profiles.request(OWNER, { ...request, proposalId: "bpr_2" });
  await h.profiler.sweep();
  assert.deepEqual(
    [...h.profiles.rows.values()].map((row) => row.status),
    ["queued", "queued"],
  );
  // The second row was not even tried once the first met the cap.
  assert.equal(h.runs.enqueued.length, 1);

  // The graph fits but the scope does not: still queued, tried again later.
  h.runs.refuse.clear();
  h.runs.refuse.set("scope", { ok: false, reason: "run_limit" });
  await h.profiler.sweep();
  assert.equal(
    [...h.profiles.rows.values()].every((row) => row.status === "queued"),
    true,
  );

  h.runs.refuse.clear();
  await h.profiler.sweep();
  assert.equal(
    [...h.profiles.rows.values()].every((row) => row.status === "scoping"),
    true,
  );

  // A finished scope whose slice meets the cap stays scoping.
  scoped(h);
  h.runs.refuse.set("slice", { ok: false, reason: "run_limit" });
  await h.profiler.sweep();
  assert.equal(
    [...h.profiles.rows.values()].every((row) => row.status === "scoping"),
    true,
  );
});

test("a scope that fails, or a graph that already did, fails the profile with the run's code", async () => {
  const h = harness();
  await h.profiles.request(OWNER, request);
  await h.profiler.sweep();
  h.runs.finish("scope", "failed", "agent_unavailable");
  await h.profiler.sweep();
  assert.equal(h.profiles.only().status, "failed");
  assert.equal(h.profiles.only().errorCode, "scope_failed");
  assert.equal(h.profiles.only().runErrorCode, "agent_unavailable");

  const graphFailed = harness();
  graphFailed.runs.startAs.set("graphify", "failed");
  await graphFailed.profiles.request(OWNER, request);
  await graphFailed.profiler.sweep();
  assert.equal(graphFailed.profiles.only().errorCode, "scope_failed");
  assert.equal(graphFailed.profiles.only().runErrorCode, "tool_failed");

  const scopeFailed = harness();
  scopeFailed.runs.startAs.set("scope", "failed");
  await scopeFailed.profiles.request(OWNER, request);
  await scopeFailed.profiler.sweep();
  assert.equal(scopeFailed.profiles.only().errorCode, "scope_failed");
});

test("a snapshot or run that is no longer there fails the profile as unavailable", async () => {
  const noSnapshot = harness();
  await noSnapshot.profiles.request(OWNER, request);
  noSnapshot.profiles.rows.set("bpf_1", {
    ...noSnapshot.profiles.only(),
    snapshotId: null,
  });
  await noSnapshot.profiler.sweep();
  assert.equal(noSnapshot.profiles.only().errorCode, "source_unavailable");
  assert.equal(noSnapshot.runs.enqueued.length, 0);

  const gone = harness();
  gone.runs.refuse.set("graphify", { ok: false, reason: "not-found" });
  await gone.profiles.request(OWNER, request);
  await gone.profiler.sweep();
  assert.equal(gone.profiles.only().errorCode, "source_unavailable");

  const mismatch = harness();
  mismatch.runs.refuse.set("scope", { ok: false, reason: "graph_mismatch" });
  await mismatch.profiles.request(OWNER, request);
  await mismatch.profiler.sweep();
  assert.equal(mismatch.profiles.only().errorCode, "source_unavailable");

  // A scope run pruned with its snapshot.
  const pruned = harness();
  await pruned.profiles.request(OWNER, request);
  await pruned.profiler.sweep();
  pruned.runs.runs.clear();
  await pruned.profiler.sweep();
  assert.equal(pruned.profiles.only().errorCode, "source_unavailable");

  // A scoping row whose run id was nulled by the cascade.
  const nulled = harness();
  await nulled.profiles.request(OWNER, request);
  await nulled.profiler.sweep();
  nulled.profiles.rows.set("bpf_1", {
    ...nulled.profiles.only(),
    scopeRunId: null,
  });
  await nulled.profiler.sweep();
  assert.equal(nulled.profiles.only().errorCode, "source_unavailable");
});

test("a scope or slice whose recorded output cannot be read fails as invalid", async () => {
  const h = harness();
  await h.profiles.request(OWNER, request);
  await h.profiler.sweep();
  scoped(h, { ...scopeMeta, entryPoints: [] });
  await h.profiler.sweep();
  assert.equal(h.profiles.only().errorCode, "output_invalid");

  const slice = harness();
  await slice.profiles.request(OWNER, request);
  await slice.profiler.sweep();
  scoped(slice);
  await slice.profiler.sweep();
  sliced(slice, { schemaVersion: 2 });
  await slice.profiler.sweep();
  assert.equal(slice.profiles.only().errorCode, "output_invalid");
});

test("a slice that fails, or cannot be queued against its graph, fails the profile", async () => {
  const failed = harness();
  await failed.profiles.request(OWNER, request);
  await failed.profiler.sweep();
  scoped(failed);
  await failed.profiler.sweep();
  failed.runs.finish("slice", "failed", "tool_timeout");
  await failed.profiler.sweep();
  assert.equal(failed.profiles.only().errorCode, "slice_failed");
  assert.equal(failed.profiles.only().runErrorCode, "tool_timeout");

  const already = harness();
  already.runs.startAs.set("slice", "failed");
  await already.profiles.request(OWNER, request);
  await already.profiler.sweep();
  scoped(already);
  await already.profiler.sweep();
  assert.equal(already.profiles.only().errorCode, "slice_failed");

  const mismatch = harness();
  await mismatch.profiles.request(OWNER, request);
  await mismatch.profiler.sweep();
  scoped(mismatch);
  mismatch.runs.refuse.set("slice", { ok: false, reason: "graph_mismatch" });
  await mismatch.profiler.sweep();
  assert.equal(mismatch.profiles.only().errorCode, "source_unavailable");

  // The slice run itself pruned before it was read.
  const pruned = harness();
  await pruned.profiles.request(OWNER, request);
  await pruned.profiler.sweep();
  scoped(pruned);
  await pruned.profiler.sweep();
  pruned.runs.runs.delete(pruned.runs.of("slice").id);
  await pruned.profiler.sweep();
  assert.equal(pruned.profiles.only().errorCode, "source_unavailable");
});

test("building needs the snapshot, the spec revision and the scope it came from", async () => {
  const build = async (
    change: (h: ReturnType<typeof harness>) => void,
  ): Promise<StoredBountyProfile> => {
    const h = harness();
    await h.profiles.request(OWNER, request);
    await h.profiler.sweep();
    scoped(h);
    await h.profiler.sweep();
    sliced(h);
    change(h);
    await h.profiler.sweep();
    return h.profiles.only();
  };
  assert.equal(
    (await build((h) => h.snapshots.clear())).errorCode,
    "source_unavailable",
  );
  assert.equal(
    (await build((h) => h.specs.clear())).errorCode,
    "source_unavailable",
  );
  assert.equal(
    (
      await build((h) =>
        h.profiles.rows.set("bpf_1", {
          ...h.profiles.only(),
          snapshotId: null,
        }),
      )
    ).errorCode,
    "source_unavailable",
  );
  assert.equal(
    (
      await build((h) =>
        h.profiles.rows.set("bpf_1", {
          ...h.profiles.only(),
          scopeRunId: null,
        }),
      )
    ).errorCode,
    "output_invalid",
  );
});

test("a row another sweep moved first is left alone", async () => {
  const h = harness();
  await h.profiles.request(OWNER, request);
  h.profiles.raced = true;
  await h.profiler.sweep();
  assert.equal(h.profiles.only().status, "queued");
});

test("a request never throws, and asks nothing for another organization's proposal", async () => {
  const h = harness();
  await h.profiler.request(OWNER, { ...request, proposalId: "bpr_other" });
  assert.equal(h.profiles.rows.size, 0);

  h.profiles.request = async () => {
    throw new Error("database down");
  };
  await h.profiler.request(OWNER, request);
  assert.deepEqual(h.errors, ["bounty_profile_request_failed"]);
});

test("one row's failure does not stop the others, and a failed launch is reported", async () => {
  const h = harness();
  await h.profiles.request(OWNER, request);
  await h.profiles.request(OWNER, { ...request, proposalId: "bpr_2" });
  const enqueue = h.runs.enqueue;
  let calls = 0;
  h.runs.enqueue = async (...args) => {
    calls += 1;
    if (calls === 1) throw new Error("blip");
    return enqueue(...args);
  };
  h.failLaunches();
  await h.profiler.sweep();
  const statuses = [...h.profiles.rows.values()].map((row) => row.status);
  assert.deepEqual(statuses, ["queued", "scoping"]);
  assert.deepEqual(h.errors, [
    "bounty_profile_step_failed",
    "analysis_worker_launch_failed",
  ]);
});

test("a re-queued run's old log is removed from the bucket", async () => {
  const h = harness();
  h.runs.obsoleteLogKey = "logs/old.txt";
  await h.profiles.request(OWNER, request);
  await h.profiler.sweep();
  assert.deepEqual(h.removed, ["logs/old.txt", "logs/old.txt"]);
});

test("a sweep asked for mid-sweep runs again after it, and the timer starts once", async () => {
  const h = harness();
  let passes = 0;
  const discover = h.profiles.organizationsWithPending;
  h.profiles.organizationsWithPending = async () => {
    passes += 1;
    return discover();
  };
  const first = h.profiler.sweep();
  const second = h.profiler.sweep();
  await Promise.all([first, second]);
  assert.equal(passes, 2);

  h.profiler.start();
  h.profiler.start();
  await h.profiler.stop();
  assert.ok(passes >= 3);
  assert.equal(PROFILE_SWEEP_MS, 30_000);

  // A sweep that throws is reported, not raised.
  h.profiles.organizationsWithPending = async () => {
    throw new Error("database down");
  };
  h.profiler.kick();
  await h.profiler.stop();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(h.errors.includes("bounty_profile_sweep_failed"));
});
