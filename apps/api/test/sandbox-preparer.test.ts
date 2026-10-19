import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  StoredAnalysisRun,
  StoredArtifact,
  StoredBounty,
  StoredBountyProfile,
  StoredBountyProposal,
  StoredSandbox,
} from "@sandbox-factory/db";

import {
  SandboxPreparer,
  type SandboxPreparerOptions,
} from "../src/sandbox/preparer.js";

const at = "2026-10-16T00:00:00.000Z";

function profile(
  overrides: Partial<StoredBountyProfile> = {},
): StoredBountyProfile {
  return {
    id: "bpf_1",
    organizationId: "org_1",
    proposalId: "bpr_1",
    specRevision: 2,
    specHash: "a".repeat(64),
    snapshotId: "rsn_1",
    repository: "acme/widgets",
    status: "ready",
    errorCode: null,
    runErrorCode: null,
    scopeRunId: "arn_scope",
    sliceRunId: "arn_slice",
    preparedRunId: null,
    sliceApprovedAt: null,
    profile: null,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

/** The slice's summary, as its boundary contract's `meta` carries it. */
function summaryOf(includedFiles: number) {
  const included = Array.from(
    { length: Math.min(includedFiles, 3) },
    (_, index) => `src/f${index}.ts`,
  );
  return {
    schemaVersion: 1,
    language: "typescript",
    stubCoverage: "full",
    ready: true,
    counts: {
      includedFiles,
      includedBytes: 900,
      outboundModules: 0,
      inboundModules: 0,
      stubs: 0,
      publicSymbols: 0,
      externals: 0,
      blockers: 0,
    },
    included,
    outbound: [],
    inbound: [],
    externals: { packages: [], environment: [] },
    blockers: [],
    truncated: included.length < includedFiles,
  };
}
const narrow = summaryOf(3);
const measured = { version: "profile-v1" } as StoredBountyProfile["profile"];

const sandboxOf = (bountyId: string) =>
  ({ id: `sbx_${bountyId}`, bountyId, sourceRepoId: "ghr_1" }) as StoredSandbox;

type Sliced = Awaited<ReturnType<SandboxPreparerOptions["slice"]>>;
const started = { ok: true, slice: null, result: null, run: null } as never;
const refusedWith = (code: string) =>
  ({ ok: false, body: { error: code, code }, reason: "conflict" }) as Sliced;

function harness(
  rows: StoredBountyProfile[],
  options: {
    /** What the version service answers a cut with. */
    readonly sliced?: () => Sliced;
    /** The slice run's summary; null for one that cannot be read. */
    readonly summary?: object | null;
    /** Whether the store holds a profile; false once it was approved since. */
    readonly holds?: boolean;
    /** False when a click made the bounty's sandbox first. */
    readonly creates?: boolean;
    readonly proposal?: Partial<StoredBountyProposal>;
    readonly bounty?: Partial<StoredBounty>;
    readonly touched?: string | null;
  } = {},
) {
  const made: { owner: string; bountyId: string; sourceRepoId: unknown }[] = [];
  const sliced: { owner: string; actor: string; sandboxId: string }[] = [];
  const cuts: { sandboxId: string; requestedBy: string | null }[] = [];
  const held: string[] = [];
  const errors: string[] = [];
  /** What each error was reported with, by position in `errors`. */
  const details: unknown[] = [];
  /** Proposal reads: what a pass costs for a profile it does not start. */
  let reads = 0;
  const summary = options.summary === undefined ? narrow : options.summary;
  const preparer = new SandboxPreparer({
    profiles: {
      organizationsWithUnprepared: async () => ["org_1"],
      unprepared: async () => rows,
      holdSlice: async (_owner, profileId) => {
        held.push(profileId);
        return options.holds ?? true;
      },
    },
    runs: {
      get: async (_owner, id) =>
        id === "arn_slice"
          ? ({
              id,
              params: {
                deadlineMinutes: 30,
                graphRunId: "arn_graph",
                entryPoints: ["src/f0.ts"],
                budget: { maxFiles: 200, maxDepth: 2 },
                includeInferred: false,
              },
            } as unknown as StoredAnalysisRun)
          : null,
    },
    artifacts: {
      list: async (_owner, runId) =>
        runId === "arn_slice" && summary !== null
          ? [{ kind: "boundary_contract", meta: summary } as StoredArtifact]
          : [],
    },
    proposals: {
      get: async (_owner, id) => {
        reads += 1;
        return id === "bpr_1"
          ? ({
              id,
              bountyId: "bty_1",
              status: "approved",
              decidedBy: "user_1",
              complexity: "S",
              ...options.proposal,
            } as StoredBountyProposal)
          : null;
      },
    },
    bounties: {
      get: async (_owner, id) =>
        id === "bty_1"
          ? ({
              id,
              version: 1,
              approval: { version: 1 },
              title: "Fix the widget",
              description: "The widget is broken.",
              ...options.bounty,
            } as StoredBounty)
          : null,
    },
    sandboxes: {
      create: async (owner, input) => {
        made.push({ owner, ...input });
        return options.creates === false
          ? { ok: false, reason: "bounty_has_sandbox" }
          : { ok: true, sandbox: sandboxOf(input.bountyId) };
      },
      requestCut: async (_owner, sandboxId, requestedBy) => {
        cuts.push({ sandboxId, requestedBy });
        return true;
      },
    },
    touchedSource: async () =>
      options.touched === undefined ? "ghr_1" : options.touched,
    slice: async (owner, actor, sandbox) => {
      sliced.push({ owner, actor, sandboxId: sandbox.id });
      return options.sliced?.() ?? started;
    },
    now: () => new Date(at),
    onError: (code, error) => {
      errors.push(code);
      details.push(error);
    },
  });
  return {
    preparer,
    made,
    sliced,
    cuts,
    held,
    errors,
    details,
    reads: () => reads,
  };
}

/** Lets what a pass started asynchronously reach its next await. */
const settle = async () => {
  for (let turn = 0; turn < 5; turn += 1)
    await new Promise((resolve) => setImmediate(resolve));
};

test("a ready, approved profile's sandbox is made and its first version cut, as the price's approver", async () => {
  const h = harness([profile()]);
  await h.preparer.sweep();
  assert.deepEqual(h.made, [
    { owner: "org_1", bountyId: "bty_1", sourceRepoId: "ghr_1" },
  ]);
  assert.deepEqual(h.sliced, [
    { owner: "org_1", actor: "user_1", sandboxId: "sbx_bty_1" },
  ]);
  assert.deepEqual(h.errors, []);
});

test("a bounty a click started first, or one a person must decide, is left alone", async () => {
  // Made by a click between the listing and this pass: not an error.
  const clicked = harness([profile()], { creates: false });
  await clicked.preparer.sweep();
  assert.deepEqual(clicked.sliced, []);
  assert.deepEqual(clicked.errors, []);
  // Several repositories, or none connected; no approver; a held scope.
  for (const options of [
    { touched: null },
    { proposal: { decidedBy: null } },
    { bounty: { approval: null } },
    { proposal: { status: "proposed" as const } },
  ]) {
    const h = harness([profile()], options);
    await h.preparer.sweep();
    assert.deepEqual(h.made, [], JSON.stringify(options));
  }
  // A profile with no snapshot or slice, or whose proposal is gone.
  const gone = harness([
    profile({ proposalId: "bpr_gone" }),
    profile({ snapshotId: null }),
    profile({ sliceRunId: null }),
  ]);
  await gone.preparer.sweep();
  assert.deepEqual(gone.made, []);
});

test("the cap leaves the cut draft to the cutter and stops the pass; another refusal is reported", async () => {
  const full = harness(
    [profile(), profile({ id: "bpf_2", proposalId: "bpr_1" })],
    { sliced: () => refusedWith("run_limit") },
  );
  await full.preparer.sweep();
  assert.equal(full.sliced.length, 1);
  assert.deepEqual(full.cuts, [
    { sandboxId: "sbx_bty_1", requestedBy: "user_1" },
  ]);
  assert.deepEqual(full.errors, []);

  const refused = harness([profile(), profile({ id: "bpf_2" })], {
    sliced: () => refusedWith("scope_blocked"),
  });
  await refused.preparer.sweep();
  assert.equal(refused.sliced.length, 2);
  assert.deepEqual(refused.cuts, []);
  assert.deepEqual(refused.errors, [
    "sandbox_prepare_scope_blocked",
    "sandbox_prepare_scope_blocked",
  ]);
});

test("what the cut would refuse is refused before the sandbox is made; refused once made, the error names it", async () => {
  // A price without a priced complexity, or a title that cannot name a
  // version: no sandbox, and nothing to report, as the cut refuses it.
  for (const options of [
    { proposal: { complexity: "unsized" as const } },
    { bounty: { title: " \n " } },
  ]) {
    const h = harness([profile()], options);
    await h.preparer.sweep();
    assert.deepEqual(h.made, [], JSON.stringify(options));
    assert.deepEqual(h.errors, [], JSON.stringify(options));
  }
  // Refused by what only the sandbox could tell: made, and the sandbox
  // left with no version is named, for a person to find it.
  const refused = harness([profile()], {
    sliced: () => refusedWith("scope_blocked"),
  });
  await refused.preparer.sweep();
  assert.equal(refused.made.length, 1);
  assert.deepEqual(refused.errors, ["sandbox_prepare_scope_blocked"]);
  const [detail] = refused.details;
  assert.ok(detail instanceof Error);
  assert.match(detail.message, /sbx_bty_1/);
});

test("a profile skipped once is not read again by a timer pass, until a prompt or a change", async () => {
  const rows = [profile()];
  const h = harness(rows, { touched: null });
  await h.preparer.sweep();
  assert.equal(h.reads(), 1);
  // The timer finds the same profile at the same `updatedAt`: not read.
  await h.preparer.sweep(false);
  await h.preparer.sweep(false);
  assert.equal(h.reads(), 1);
  // Changed since: read again, once.
  rows[0] = profile({ updatedAt: "2026-10-16T00:01:00.000Z" });
  await h.preparer.sweep(false);
  await h.preparer.sweep(false);
  assert.equal(h.reads(), 2);
  // A prompted pass forgets what was skipped; so does a kick.
  await h.preparer.sweep();
  assert.equal(h.reads(), 3);
  h.preparer.kick();
  await h.preparer.stop();
  assert.equal(h.reads(), 4);
  assert.deepEqual(h.made, []);

  // One started is not remembered: listed again, it is looked at again.
  const started = harness([profile()]);
  await started.preparer.sweep();
  await started.preparer.sweep(false);
  assert.equal(started.made.length, 2);
});

test("organizations are worked on four at a time, each in its own try", async () => {
  const owners = ["org_1", "org_2", "org_3", "org_4", "org_5"];
  const asked = new Map<string, (rows: StoredBountyProfile[]) => void>();
  const errors: string[] = [];
  const preparer = new SandboxPreparer({
    profiles: {
      organizationsWithUnprepared: async () => owners,
      unprepared: (owner) =>
        new Promise((resolve, reject) => {
          asked.set(owner, (rows) =>
            owner === "org_2"
              ? reject(new Error("database blip"))
              : resolve(rows),
          );
        }),
      holdSlice: async () => true,
    },
    runs: { get: async () => null },
    artifacts: { list: async () => [] },
    proposals: { get: async () => null },
    bounties: { get: async () => null },
    sandboxes: {
      create: async () => ({ ok: false, reason: "bounty_not_found" }),
      requestCut: async () => false,
    },
    touchedSource: async () => null,
    slice: async () => started,
    onError: (code) => errors.push(code),
  });
  const pass = preparer.sweep();
  await settle();
  // Four asked before any answered; the fifth waits for a free slot.
  assert.deepEqual([...asked.keys()], owners.slice(0, 4));
  asked.get("org_2")?.([]);
  await settle();
  assert.deepEqual([...asked.keys()], owners);
  for (const owner of ["org_1", "org_3", "org_4", "org_5"])
    asked.get(owner)?.([]);
  await pass;
  assert.deepEqual(errors, ["sandbox_prepare_failed"]);
});

test("one organization's trouble is reported and the pass goes on; the timer starts once and stops", async () => {
  const errors: string[] = [];
  let passes = 0;
  const preparer = new SandboxPreparer({
    profiles: {
      organizationsWithUnprepared: async () => {
        passes += 1;
        return ["org_1"];
      },
      unprepared: async () => {
        throw new Error("database blip");
      },
      holdSlice: async () => true,
    },
    runs: { get: async () => null },
    artifacts: { list: async () => [] },
    proposals: { get: async () => null },
    bounties: { get: async () => null },
    sandboxes: {
      create: async () => ({ ok: false, reason: "bounty_not_found" }),
      requestCut: async () => false,
    },
    touchedSource: async () => null,
    slice: async () => started,
    intervalMs: 60_000,
    onError: (code) => errors.push(code),
  });
  await preparer.sweep();
  assert.deepEqual(errors, ["sandbox_prepare_failed"]);
  // A kick mid-pass runs once more after it.
  preparer.start();
  preparer.start();
  preparer.kick();
  await preparer.stop();
  assert.ok(passes >= 2);
  // Stopped, a kick starts nothing.
  const before = passes;
  preparer.kick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(passes, before);
});

test("a wide slice nobody approved is not started, and one measured ready before approvals waits for one", async () => {
  // Ready from a wide slice before approvals were asked for: held to wait,
  // as it was measured, and nothing handed to an agent.
  const wide = harness(
    [profile({ profile: measured }), profile({ id: "bpf_2" })],
    { summary: summaryOf(41) },
  );
  await wide.preparer.sweep();
  assert.deepEqual(wide.made, []);
  assert.deepEqual(wide.held, ["bpf_1", "bpf_2"]);

  // Approved between the read and the hold: the store holds nothing, and
  // this pass still starts nothing from the stale read.
  const raced = harness([profile({ profile: measured })], {
    summary: summaryOf(41),
    holds: false,
  });
  await raced.preparer.sweep();
  assert.deepEqual(raced.held, ["bpf_1"]);
  assert.deepEqual(raced.made, []);

  // A slice whose summary cannot be read cannot be told within the limits.
  const unread = harness([profile()], { summary: null });
  await unread.preparer.sweep();
  assert.deepEqual(unread.made, []);
  assert.deepEqual(unread.held, []);

  // Approved, it is started without its slice being read again.
  const approved = harness([profile({ sliceApprovedAt: at })], {
    summary: summaryOf(41),
  });
  await approved.preparer.sweep();
  assert.equal(approved.made.length, 1);
  assert.deepEqual(approved.held, []);
});
