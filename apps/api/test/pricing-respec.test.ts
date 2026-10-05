/**
 * A reviewer's change to a proposal's spec: the route that starts it and
 * the run that makes it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  BountyProposalStore,
  BountyRunStore,
  BountySpecStore,
  JiraBoardStore,
  JiraIssueStore,
  StoredBountyProposal,
  StoredBountyRun,
  StoredBountySpec,
} from "@sandbox-factory/db";
import { JiraApiError } from "@sandbox-factory/jira";
import {
  stepUp,
  type RespecRequest,
  type Scenario,
  type ScenarioWeight,
  type SpecDraft,
} from "sandbox-factory";

import type { Auth } from "../src/auth.js";
import { BountyExecutor } from "../src/pricing/executor.js";
import { createApp } from "../src/routes.js";
import { FakeCaller, SizerError } from "../src/sizing/caller.js";

const requestId = "28bb313f-252a-4a1d-b656-558a215b604b";
const headers = { cookie: "session=1", "content-type": "application/json" };
const hash = "a".repeat(64);

const rateCard = {
  currency: "USD",
  xsMinor: 100,
  sMinor: 100,
  mMinor: 200,
  lMinor: 300,
  xlMinor: 400,
  revision: 1,
};

function scenario(
  id: string,
  weight: ScenarioWeight | undefined,
  overrides: Partial<Scenario> = {},
): Scenario {
  return {
    id,
    kind: "happy",
    title: `Scenario ${id}`,
    steps: [{ keyword: "Then", text: "it works" }],
    origin: "draft",
    ...(weight === undefined ? {} : { weight }),
    ...overrides,
  };
}

/** What the proposal was sized against: 2 + 1 = 3 points. */
const sizedDraft: SpecDraft = {
  feature: "CSV export",
  background: [],
  scenarios: [
    scenario("s1", "moderate"),
    scenario("s2", "light", { kind: "boundary", title: "An empty table" }),
  ],
  openQuestions: ["Is there a row limit?"],
  assumptions: [],
};

const retried = scenario("s3", "heavy", {
  kind: "recovery",
  title: "A failed export is retried",
  origin: "expansion",
});

/** The proposal's current revision: one heavy scenario added, 7 points. */
const currentDraft: SpecDraft = {
  ...sizedDraft,
  scenarios: [...sizedDraft.scenarios, retried],
};

const step = stepUp("S", sizedDraft, currentDraft);
assert.ok(step !== null && step.complexity === "S+");

function proposal(
  overrides: Partial<StoredBountyProposal> = {},
): StoredBountyProposal {
  return {
    id: "bpr_1",
    organizationId: "org_1",
    runId: "brn_sized",
    bountyId: "bty_1",
    issueKey: "APP-1",
    title: "Add CSV export",
    specHash: hash,
    specHashVersion: 2,
    rateCard,
    modelComplexity: "S",
    modelConfidence: "high",
    modelRationale: "One export path.",
    unsizedReason: null,
    inputTruncated: false,
    actualModel: "model",
    promptVersion: "jira-size-v2",
    complexity: "S+",
    sizedBy: "model",
    resizedBy: null,
    resizedAt: null,
    amountMinor: 150,
    currency: "USD",
    status: "proposed",
    revision: 4,
    version: 0,
    versionedAt: null,
    specRevision: 3,
    step,
    decidedAt: null,
    decidedBy: null,
    decisionDeliveryPolicy: null,
    repoSnapshotId: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

function storedSpec(
  revision: number,
  draft: SpecDraft,
  origin: StoredBountySpec["origin"] = "draft",
): StoredBountySpec {
  return {
    id: `bsp_${revision}`,
    organizationId: "org_1",
    proposalId: "bpr_1",
    revision,
    specHash: hash,
    specHashVersion: 2,
    draft,
    origin,
    instruction: null,
    createdBy: null,
    runId: "brn_sized",
    actualModel: "model",
    promptVersion: "draft-v2",
    createdAt: "2026-10-01T00:00:00.000Z",
  };
}

function respecRun(
  respec: RespecRequest,
  overrides: Partial<StoredBountyRun> = {},
): StoredBountyRun {
  return {
    id: "brn_respec",
    organizationId: "org_1",
    boardId: "jrb_1",
    bountyId: "bty_1",
    kind: "respec",
    sourceProposalId: "bpr_1",
    sourceRevision: 4,
    respec,
    requestId,
    status: "queued",
    selection: {
      unassignedOnly: false,
      issueTypes: [],
      minAgeDays: 0,
      minSpecChars: 0,
      categories: {},
    },
    rateCard,
    requestedModel: "model",
    promptVersion: "revise-v2",
    planned: [],
    outcomes: [],
    candidatesScanned: 0,
    skippedLive: 0,
    scanLimitReached: false,
    fatalErrorCode: null,
    startedAt: null,
    deadlineAt: null,
    finishedAt: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

const bounty = {
  key: "APP-1",
  summary: "Add CSV export",
  descriptionText: "Export the filtered table.",
  components: ["Reports"],
  updated: "2026-01-02T00:00:00.000Z",
  inputTruncated: false,
  specHash: hash,
  pricingSpecHash: hash,
};

/** The bounty the proposal prices, as the platform holds it. */
const storedBounty = {
  id: "bty_1",
  organizationId: "org_1",
  number: 1,
  key: "APP-1",
  title: "Add CSV export",
  description: "Export the filtered table.",
  components: ["Reports"],
  inputTruncated: false,
  origin: "jira",
  repoId: null,
  stack: [],
  createdBy: null,
  revision: 1,
  jira: {
    issueId: "jri_1",
    boardId: "jrb_1",
    connectionId: "jrc_1",
    externalId: "100",
    key: "APP-1",
    siteUrl: "https://acme.atlassian.net",
    removedAt: null,
  },
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

const bounties = {
  get: () => Promise.resolve(storedBounty),
  refreshFromJira: () => Promise.resolve(false),
} as never;

const usage = { inputTokens: 30, outputTokens: 70 };

function executorHarness(options: {
  request: RespecRequest;
  proposal?: StoredBountyProposal;
  caller?: FakeCaller;
  bountyHash?: string;
  bountyError?: Error;
  current?: StoredBountySpec | null;
  sized?: StoredBountySpec | null;
  written?: "respecced" | "changed" | "not-found" | "lost-lease";
  planHeld?: boolean;
  recorded?: boolean;
}) {
  const queued = respecRun(options.request);
  const plans: unknown[] = [];
  const outcomes: Record<string, unknown>[] = [];
  const finishes: { status: string; details: unknown }[] = [];
  const written: Record<string, unknown>[] = [];
  const removed: string[] = [];
  let bountyReads = 0;
  const running = {
    ...queued,
    status: "running" as const,
    deadlineAt: "2026-10-01T00:10:00.000Z",
  };
  const runs = {
    get: () => Promise.resolve(queued),
    claim: () => Promise.resolve(running),
    heartbeat: () => Promise.resolve(true),
    recordPlan: (
      _org: string,
      _id: string,
      _lease: string,
      plan: StoredBountyRun["planned"],
    ) => {
      plans.push(plan);
      return Promise.resolve(
        (options.planHeld ?? true) ? { ...running, planned: plan } : null,
      );
    },
    recordOutcome: (
      _org: string,
      _id: string,
      _lease: string,
      outcome: Record<string, unknown>,
    ) => {
      outcomes.push(outcome);
      return Promise.resolve(options.recorded ?? true);
    },
    finish: (
      _org: string,
      _id: string,
      _lease: string,
      status: string,
      details: unknown,
    ) => {
      finishes.push({ status, details });
      return Promise.resolve(null);
    },
  } as unknown as BountyRunStore;
  const source = options.proposal ?? proposal();
  const proposals = {
    get: () => Promise.resolve(source),
    respecForLease: (
      _org: string,
      _lease: string,
      _id: string,
      _revision: number,
      input: Record<string, unknown>,
    ) => {
      written.push(input);
      const status = options.written ?? "respecced";
      return Promise.resolve(
        status === "respecced"
          ? {
              status,
              proposal: source,
              previousComplexity: source.complexity,
            }
          : { status },
      );
    },
  } as unknown as BountyProposalStore;
  const specs = {
    get: () =>
      Promise.resolve(
        options.current === undefined
          ? storedSpec(3, currentDraft, "expand")
          : options.current,
      ),
    sizedRevision: () =>
      Promise.resolve(
        options.sized === undefined ? storedSpec(1, sizedDraft) : options.sized,
      ),
  } as unknown as BountySpecStore;
  const issues = {
    get: () =>
      Promise.resolve({
        id: "jri_1",
        boardId: "jrb_1",
        externalId: "100",
        key: "APP-1",
        statusCategory: "new",
        remoteCreatedAt: "2026-01-01T00:00:00.000Z",
        remoteUpdatedAt: "2026-01-02T00:00:00.000Z",
        removedAt: null,
      }),
    markRemoved: (_org: string, id: string) => {
      removed.push(id);
      return Promise.resolve(true);
    },
  } as unknown as JiraIssueStore;
  const boards = {
    forRun: () =>
      Promise.resolve({
        board: { id: "jrb_1", selection: queued.selection, pricing: {} },
        connectionId: "jrc_1",
        cloudId: "cloud_1",
        siteUrl: "https://example.test",
      }),
  } as unknown as JiraBoardStore;
  const caller = options.caller ?? new FakeCaller("model", {});
  const executor = new BountyExecutor({
    boards,
    runs,
    proposals,
    issues,
    bounties,
    specs,
    caller,
    clientFor: () =>
      Promise.resolve({
        ok: true,
        client: {
          issueSpec: () => {
            bountyReads += 1;
            return options.bountyError === undefined
              ? Promise.resolve({
                  ...bounty,
                  pricingSpecHash: options.bountyHash ?? hash,
                })
              : Promise.reject(options.bountyError);
          },
        } as never,
      }),
    now: () => new Date("2026-10-01T00:00:00.000Z"),
    leaseToken: () => "lease_1",
    setInterval: (() => 0) as never,
    clearInterval: (() => {}) as never,
  });
  return {
    run: () => executor.execute("org_1", "brn_respec"),
    plans,
    outcomes,
    finishes,
    written,
    removed,
    caller,
    bountyReads: () => bountyReads,
  };
}

test("a trim takes an added scenario out, asks no model, and the step comes back down", async () => {
  const state = executorHarness({
    request: { mode: "trim", removeScenarioIds: ["s3"] },
  });
  await state.run();

  assert.deepEqual(state.plans, [
    [
      {
        externalIssueId: "100",
        issueKey: "APP-1",
        summary: "Add CSV export",
        bountyId: "bty_1",
        categories: [],
      },
    ],
  ]);
  assert.equal(state.caller.calls.length, 0);
  assert.equal(state.bountyReads(), 0);
  const input = state.written[0] as {
    fromSpecRevision: number;
    spec: Record<string, unknown> & { draft: SpecDraft };
    step: { base: string; complexity: string; addedPoints: number };
    amountMinor: number;
    currency: string;
  };
  assert.equal(input.fromSpecRevision, 3);
  assert.deepEqual(input.spec.draft, sizedDraft);
  assert.equal(input.spec["origin"], "trim");
  assert.equal(input.spec["instruction"], "Removed A failed export is retried");
  assert.equal(input.spec["actualModel"], null);
  assert.equal(input.spec["promptVersion"], null);
  assert.equal(input.spec["specHash"], hash);
  assert.equal(input.step.base, "S");
  assert.equal(input.step.complexity, "S");
  assert.equal(input.step.addedPoints, 0);
  assert.equal(input.amountMinor, 100);
  assert.equal(input.currency, "USD");
  assert.deepEqual(state.outcomes, [
    {
      externalIssueId: "100",
      issueKey: "APP-1",
      bountyId: "bty_1",
      proposalId: "bpr_1",
      status: "proposed",
      previousComplexity: "S+",
      pointsDelta: -4,
    },
  ]);
  assert.deepEqual(state.finishes, [{ status: "succeeded", details: {} }]);
});

test("an expansion adds the model's new scenarios and the size climbs by the step", async () => {
  const permission = scenario("s1", "heavy", {
    kind: "permission",
    title: "A viewer cannot export",
    origin: "expansion",
  });
  const caller = new FakeCaller("model", {
    draft_spec: [
      {
        result: { scenarios: [permission], openQuestions: [], assumptions: [] },
        actualModel: "claude-test",
        usage,
      },
    ],
  });
  const request = { mode: "expand", kinds: ["permission"] } as const;
  const state = executorHarness({ request, caller });
  await state.run();

  // The model is shown the bounty, the spec as it stands, and the request.
  assert.deepEqual(caller.inputsFor("draft_spec"), [
    {
      bounty: {
        summary: bounty.summary,
        descriptionText: bounty.descriptionText,
        components: bounty.components,
      },
      spec: currentDraft,
      request,
    },
  ]);
  const input = state.written[0] as {
    spec: Record<string, unknown> & { draft: SpecDraft };
    step: { complexity: string; added: { title: string }[] };
    amountMinor: number;
  };
  assert.deepEqual(
    input.spec.draft.scenarios.map(({ id, origin }) => [id, origin]),
    [
      ["s1", "draft"],
      ["s2", "draft"],
      ["s3", "expansion"],
      ["s4", "expansion"],
    ],
  );
  assert.equal(input.spec["origin"], "expand");
  assert.equal(input.spec["instruction"], "More permission scenarios");
  assert.equal(input.spec["actualModel"], "claude-test");
  assert.equal(input.spec["promptVersion"], "revise-v2");
  // 3 points sized, 11 now: two half steps from S.
  assert.equal(input.step.complexity, "M");
  assert.deepEqual(
    input.step.added.map(({ title }) => title),
    ["A failed export is retried", "A viewer cannot export"],
  );
  assert.equal(input.amountMinor, 200);
  assert.deepEqual(state.outcomes[0], {
    externalIssueId: "100",
    issueKey: "APP-1",
    bountyId: "bty_1",
    proposalId: "bpr_1",
    status: "proposed",
    previousComplexity: "S+",
    pointsDelta: 4,
    actualModel: "claude-test",
    inputTokens: 30,
    outputTokens: 70,
  });
});

test("answers revise the whole spec, keep what was kept and settle the questions", async () => {
  const caller = new FakeCaller("model", {
    draft_spec: [
      {
        result: {
          ...currentDraft,
          scenarios: [
            // Renumbered by the model: matched back by kind and title.
            scenario("s9", "moderate", { title: "Scenario s1" }),
            scenario("s8", "light", {
              kind: "boundary",
              title: "An empty table",
            }),
            { ...retried, id: "s7", origin: "draft" },
            scenario("s6", "moderate", {
              kind: "boundary",
              title: "An export over 10,000 rows is refused",
            }),
          ],
          // Left in by the model; gone all the same.
          openQuestions: ["Is there a row limit?"],
        },
        actualModel: "claude-test",
        usage,
      },
    ],
  });
  const state = executorHarness({
    request: {
      mode: "answer",
      answers: [{ question: "Is there a row limit?", answer: "10,000 rows." }],
    },
    caller,
  });
  await state.run();

  const input = state.written[0] as {
    spec: Record<string, unknown> & { draft: SpecDraft };
    step: { complexity: string };
  };
  assert.deepEqual(
    input.spec.draft.scenarios.map(({ id, origin }) => [id, origin]),
    [
      ["s1", "draft"],
      ["s2", "draft"],
      ["s3", "expansion"],
      ["s4", "expansion"],
    ],
  );
  assert.deepEqual(input.spec.draft.openQuestions, []);
  assert.equal(input.spec["origin"], "answer");
  assert.equal(
    input.spec["instruction"],
    "Is there a row limit? → 10,000 rows.",
  );
  // 9 points against 3 sized: one half step, as before.
  assert.equal(input.step.complexity, "S+");
  assert.equal(state.outcomes[0]?.["pointsDelta"], 2);
});

test("a bounty that changed since it was sized is not grown", async () => {
  const caller = new FakeCaller("model", {});
  const state = executorHarness({
    request: { mode: "expand", instruction: "Cover a phone." },
    caller,
    bountyHash: "b".repeat(64),
  });
  await state.run();
  assert.equal(caller.calls.length, 0);
  assert.equal(state.written.length, 0);
  assert.equal(state.outcomes[0]?.["code"], "proposal_stale");
  assert.equal(state.outcomes[0]?.["status"], "failed");
  assert.deepEqual(state.finishes, [{ status: "failed", details: {} }]);
});

test("an expansion with nothing new writes no revision, and says so", async () => {
  const caller = new FakeCaller("model", {
    draft_spec: [
      {
        // The one scenario it wrote is one the spec has.
        result: {
          scenarios: [{ ...retried, title: "a failed  export is RETRIED" }],
          openQuestions: [],
          assumptions: [],
        },
        actualModel: "claude-test",
        usage,
      },
    ],
  });
  const state = executorHarness({
    request: { mode: "expand", kinds: ["recovery"] },
    caller,
  });
  await state.run();
  assert.equal(state.written.length, 0);
  assert.equal(state.outcomes[0]?.["status"], "skipped");
  assert.equal(state.outcomes[0]?.["code"], "nothing_added");
  // What it cost is still recorded.
  assert.equal(state.outcomes[0]?.["outputTokens"], 70);
  assert.deepEqual(state.finishes, [{ status: "succeeded", details: {} }]);
});

test("a proposal that moved, was approved or lost its step is not changed", async () => {
  for (const moved of [
    proposal({ revision: 5 }),
    proposal({ status: "approved" }),
    proposal({ step: null }),
    proposal({ specRevision: null }),
  ]) {
    const state = executorHarness({
      request: { mode: "trim", removeScenarioIds: ["s3"] },
      proposal: moved,
    });
    await state.run();
    assert.equal(state.plans.length, 0);
    assert.deepEqual(state.finishes, [
      { status: "failed", details: { fatalErrorCode: "proposal_changed" } },
    ]);
  }
});

test("a model that fails costs the change; one that refuses every call ends the run", async () => {
  const flaky = executorHarness({
    request: { mode: "expand", kinds: ["boundary"] },
    caller: new FakeCaller("model", { draft_spec: [new Error("boom")] }),
  });
  await flaky.run();
  assert.equal(flaky.outcomes[0]?.["code"], "spec_failed");
  assert.equal(flaky.written.length, 0);

  const refused = executorHarness({
    request: { mode: "expand", kinds: ["boundary"] },
    caller: new FakeCaller("model", {
      draft_spec: [new SizerError("sizing_configuration", true)],
    }),
  });
  await refused.run();
  assert.equal(refused.outcomes.length, 0);
  assert.deepEqual(refused.finishes, [
    { status: "failed", details: { fatalErrorCode: "sizing_configuration" } },
  ]);
});

test("a write that lost the race is skipped; one that lost the lease ends the run", async () => {
  const changed = executorHarness({
    request: { mode: "trim", removeScenarioIds: ["s3"] },
    written: "changed",
  });
  await changed.run();
  assert.equal(changed.outcomes[0]?.["status"], "skipped");
  assert.equal(changed.outcomes[0]?.["code"], "proposal_changed");

  const gone = executorHarness({
    request: { mode: "trim", removeScenarioIds: ["s3"] },
    written: "not-found",
  });
  await gone.run();
  assert.equal(gone.outcomes[0]?.["code"], "not_found");

  const lost = executorHarness({
    request: { mode: "trim", removeScenarioIds: ["s3"] },
    written: "lost-lease",
  });
  await lost.run();
  assert.equal(lost.outcomes.length, 0);
  assert.deepEqual(lost.finishes, [
    { status: "failed", details: { fatalErrorCode: "worker_lost" } },
  ]);
});

test("a bounty Jira no longer has keeps its text; a lost grant ends the run", async () => {
  // Marked gone, and compared as stored: what the platform holds is not
  // what this proposal was priced from, so the change is refused as stale.
  const removed = executorHarness({
    request: { mode: "expand", kinds: ["boundary"] },
    bountyError: new JiraApiError(404, "gone"),
  });
  await removed.run();
  assert.deepEqual(removed.removed, ["jri_1"]);
  assert.equal(removed.outcomes[0]?.["code"], "proposal_stale");

  const throttled = executorHarness({
    request: { mode: "expand", kinds: ["boundary"] },
    bountyError: new JiraApiError(429, "slow down"),
  });
  await throttled.run();
  assert.equal(throttled.outcomes[0]?.["code"], "jira_rate_limited");

  const revoked = executorHarness({
    request: { mode: "expand", kinds: ["boundary"] },
    bountyError: new JiraApiError(401, "no"),
  });
  await revoked.run();
  assert.equal(revoked.outcomes.length, 0);
  assert.deepEqual(revoked.finishes, [
    { status: "failed", details: { fatalErrorCode: "reconnect" } },
  ]);
});

test("a change needs the spec it changes, and a weighed one to step from", async () => {
  const missing = executorHarness({
    request: { mode: "trim", removeScenarioIds: ["s3"] },
    current: null,
  });
  await missing.run();
  assert.equal(missing.outcomes[0]?.["code"], "spec_missing");

  const unweighed = executorHarness({
    request: { mode: "trim", removeScenarioIds: ["s3"] },
    sized: storedSpec(1, {
      ...sizedDraft,
      scenarios: [scenario("s1", undefined)],
    }),
  });
  await unweighed.run();
  assert.equal(unweighed.outcomes[0]?.["code"], "spec_unweighed");

  // A removal of a scenario this revision does not have.
  const invalid = executorHarness({
    request: { mode: "trim", removeScenarioIds: ["s7"] },
  });
  await invalid.run();
  assert.equal(invalid.outcomes[0]?.["code"], "respec_invalid");

  // Answers that leave a spec with nothing in it are not stored.
  const emptied = executorHarness({
    request: {
      mode: "answer",
      answers: [{ question: "Is there a row limit?", answer: "No." }],
    },
    caller: new FakeCaller("model", {
      draft_spec: [
        {
          result: { ...sizedDraft, scenarios: [] },
          actualModel: "claude-test",
          usage,
        },
      ],
    }),
  });
  await emptied.run();
  assert.equal(emptied.outcomes[0]?.["code"], "spec_failed");
  assert.equal(emptied.outcomes[0]?.["outputTokens"], 70);
  assert.equal(emptied.written.length, 0);
});

test("a run that lost its plan or its outcome stops there", async () => {
  const unplanned = executorHarness({
    request: { mode: "trim", removeScenarioIds: ["s3"] },
    planHeld: false,
  });
  await unplanned.run();
  assert.equal(unplanned.written.length, 0);
  assert.equal(unplanned.finishes.length, 0);

  const unrecorded = executorHarness({
    request: { mode: "trim", removeScenarioIds: ["s3"] },
    recorded: false,
  });
  await unrecorded.run();
  assert.deepEqual(unrecorded.finishes, [
    { status: "failed", details: { fatalErrorCode: "worker_lost" } },
  ]);
});

/* The route that starts a change. */

function fakeAuth(): Auth {
  return {
    api: {
      getSession: () =>
        Promise.resolve({
          user: { id: "user_1", email: "u@example.test", name: "User" },
          session: { id: "session_1" },
        }),
    },
    handler: () => Promise.resolve(new Response(null, { status: 404 })),
  } as unknown as Auth;
}

function routeHarness(
  options: {
    role?: string;
    proposal?: StoredBountyProposal;
    current?: StoredBountySpec | null;
    bountyHash?: string;
    clientReady?: boolean;
    sizing?: boolean;
    create?:
      | { ok: true; created: boolean }
      | { ok: false; reason: "active"; runId: string }
      | { ok: false; reason: "request-conflict" };
  } = {},
) {
  const created: Record<string, unknown>[] = [];
  const starts: string[] = [];
  const source = options.proposal ?? proposal();
  const board = { id: "jrb_1", connectionId: "jrc_1", selection: {} };
  const sizing = options.sizing ?? true;
  const app = createApp({
    corsOrigins: ["https://app.test"],
    auth: fakeAuth(),
    organizations: {
      roleOf: () => Promise.resolve(options.role ?? "owner"),
    } as never,
    pricing: {
      rateCards: {} as never,
      runs: {
        create: (_org: string, input: Record<string, unknown>) => {
          created.push(input);
          const answer = options.create ?? { ok: true, created: true };
          return Promise.resolve(
            answer.ok
              ? {
                  ...answer,
                  run: respecRun(input["respec"] as RespecRequest),
                }
              : answer,
          );
        },
      } as never,
      proposals: {
        get: (_org: string, id: string) =>
          Promise.resolve(id === "bpr_1" ? source : null),
      } as never,
      specs: {
        get: () =>
          Promise.resolve(
            options.current === undefined
              ? storedSpec(3, currentDraft, "expand")
              : options.current,
          ),
      } as never,
      issues: {
        markRemoved: () => Promise.resolve(true),
      } as never,
      bounties,
      boards: {
        get: () => Promise.resolve(board),
        forRun: () =>
          Promise.resolve({
            board,
            connectionId: "jrc_1",
            siteUrl: "https://acme.atlassian.net",
          }),
      } as never,
      clientFor: () =>
        Promise.resolve(
          options.clientReady === false
            ? { ok: false as const, reason: "reconnect" as const }
            : {
                ok: true as const,
                client: {
                  issueSpec: () =>
                    Promise.resolve({
                      ...bounty,
                      pricingSpecHash: options.bountyHash ?? hash,
                    }),
                } as never,
              },
        ),
      ...(sizing
        ? {
            executor: {
              start: (_org: string, runId: string) => starts.push(runId),
            } as unknown as BountyExecutor,
            requestedModel: "model",
            promptVersion: "jira-size-v2",
          }
        : {}),
    },
  });
  const post = (body: unknown) =>
    app.request("/api/v1/orgs/org_1/proposals/bpr_1/respec", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  return { app, post, created, starts };
}

const trimBody = {
  expectedRevision: 4,
  requestId,
  request: { mode: "trim", removeScenarioIds: ["s3"] },
};

test("a spec change starts a respec run on the proposal's own card", async () => {
  const state = routeHarness();
  const response = await state.post(trimBody);
  assert.equal(response.status, 202);
  const body = (await response.json()) as { run: { kind: string } };
  assert.equal(body.run.kind, "respec");
  assert.deepEqual(state.created, [
    {
      boardId: "jrb_1",
      bountyId: "bty_1",
      startedBy: "user_1",
      kind: "respec",
      sourceProposalId: "bpr_1",
      sourceRevision: 4,
      respec: { mode: "trim", removeScenarioIds: ["s3"] },
      requestId,
      selection: state.created[0]?.["selection"],
      rateCard,
      requestedModel: "model",
      promptVersion: "revise-v2",
    },
  ]);
  assert.deepEqual(state.starts, ["brn_respec"]);

  // A replay of the same request starts nothing new.
  const replay = routeHarness({ create: { ok: true, created: false } });
  assert.equal((await replay.post(trimBody)).status, 202);
  assert.deepEqual(replay.starts, []);
});

test("a spec change is checked for shape, role and a configured sizer", async () => {
  const state = routeHarness();
  assert.equal((await state.post({ ...trimBody, request: {} })).status, 400);
  assert.equal(
    (
      await state.app.request("/api/v1/orgs/org_1/proposals/bpr_1/respec", {
        method: "POST",
        headers,
        body: "not json",
      })
    ).status,
    400,
  );
  assert.equal(
    (await routeHarness({ role: "member" }).post(trimBody)).status,
    403,
  );
  const unconfigured = await routeHarness({ sizing: false }).post(trimBody);
  assert.equal(unconfigured.status, 503);
  const missing = await state.app.request(
    "/api/v1/orgs/org_1/proposals/bpr_other/respec",
    { method: "POST", headers, body: JSON.stringify(trimBody) },
  );
  assert.equal(missing.status, 404);
  assert.equal(state.created.length, 0);
});

test("a spec change is refused before the run when it could only fail", async () => {
  const cases: [Parameters<typeof routeHarness>[0], unknown, string][] = [
    [{}, { ...trimBody, expectedRevision: 3 }, "proposal_changed"],
    [
      { proposal: proposal({ status: "approved" }) },
      trimBody,
      "proposal_approved",
    ],
    [{ proposal: proposal({ step: null }) }, trimBody, "respec_unavailable"],
    [{ current: null }, trimBody, "respec_unavailable"],
    [
      {},
      { ...trimBody, request: { mode: "trim", removeScenarioIds: ["s9"] } },
      "unknown_scenario",
    ],
    [
      {},
      {
        ...trimBody,
        request: {
          mode: "answer",
          answers: [{ question: "Who pays?", answer: "Nobody." }],
        },
      },
      "unknown_question",
    ],
    [{ bountyHash: "b".repeat(64) }, trimBody, "proposal_stale"],
    [{ clientReady: false }, trimBody, "spec_unavailable"],
  ];
  for (const [options, body, code] of cases) {
    const state = routeHarness(options);
    const response = await state.post(body);
    assert.equal(response.status, 409, code);
    assert.equal(((await response.json()) as { code: string }).code, code);
    assert.equal(state.created.length, 0, code);
  }
});

test("a change already in flight on the proposal is named, not started twice", async () => {
  const busy = routeHarness({
    create: { ok: false, reason: "active", runId: "brn_9" },
  });
  const response = await busy.post(trimBody);
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    code: "run_active",
    error: "This proposal is already being changed.",
    runId: "brn_9",
  });
  assert.deepEqual(busy.starts, []);

  const conflict = routeHarness({
    create: { ok: false, reason: "request-conflict" },
  });
  const conflicted = await conflict.post(trimBody);
  assert.equal(conflicted.status, 409);
  assert.equal(
    ((await conflicted.json()) as { code: string }).code,
    "proposal_changed",
  );
});
