import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  BountyProposalStore,
  BountyRunStore,
  JiraBoardStore,
  JiraIssueStore,
  StoredBountyRun,
} from "@sandbox-factory/db";
import type { JiraIssueSpec } from "@sandbox-factory/jira";
import type { JiraIssueDto } from "@sandbox-factory/shared";

import { BountyExecutor } from "../src/bounty/executor.js";
import { FakeSizer, SizerError } from "../src/sizing/sizer.js";

const rateCard = {
  currency: "USD",
  xsMinor: 100,
  sMinor: 100,
  mMinor: 200,
  lMinor: 300,
  xlMinor: 400,
  revision: 1,
};

function run(overrides: Partial<StoredBountyRun> = {}): StoredBountyRun {
  return {
    id: "brn_1",
    organizationId: "org_1",
    boardId: "jrb_1",
    kind: "backlog",
    sourceProposalId: null,
    sourceRevision: null,
    requestId: "28bb313f-252a-4a1d-b656-558a215b604b",
    status: "queued",
    selection: {
      maxTickets: 10,
      excludeAssigned: true,
      issueTypes: [],
      minAgeDays: 0,
      minSpecChars: 0,
    },
    rateCard,
    requestedModel: "requested-model",
    promptVersion: "jira-size-v1",
    outcomes: [],
    candidatesScanned: 0,
    skippedLive: 0,
    scanLimitReached: false,
    fatalErrorCode: null,
    startedAt: null,
    deadlineAt: null,
    finishedAt: null,
    createdAt: "2026-09-22T00:00:00.000Z",
    ...overrides,
  };
}

function issue(
  id: string,
  overrides: Partial<JiraIssueDto> = {},
): JiraIssueDto {
  return {
    id,
    key: `APP-${id}`,
    summary: `Issue ${id}`,
    status: "To Do",
    statusCategory: "new",
    assignee: null,
    priority: null,
    issueType: "Story",
    labels: [],
    projectKey: "APP",
    parentKey: null,
    created: "2026-01-01T00:00:00.000Z",
    updated: "2026-01-02T00:00:00.000Z",
    dueDate: null,
    url: null,
    ...overrides,
  };
}

function spec(
  id: string,
  overrides: Partial<JiraIssueSpec> = {},
): JiraIssueSpec {
  return {
    key: `APP-${id}`,
    summary: `Issue ${id}`,
    descriptionText: "Clear acceptance criteria.",
    issueType: "Story",
    updated: "2026-01-02T00:00:00.000Z",
    inputTruncated: false,
    specHash: "a".repeat(64),
    pricingSpecHash: id.padEnd(64, "a").slice(0, 64),
    ...overrides,
  };
}

function harness(options: {
  candidates?: JiraIssueDto[];
  specs?: Record<string, JiraIssueSpec | Error>;
  sizer?: FakeSizer;
  createStatus?: "created" | "duplicate" | "lost-lease" | "not-found";
  writebackOperationId?: string;
  runOverrides?: Partial<StoredBountyRun>;
}) {
  const current = run(options.runOverrides);
  const outcomes: unknown[] = [];
  const finishes: { status: string; details: unknown }[] = [];
  const proposalInputs: unknown[] = [];
  const removed: string[] = [];
  const startedWritebacks: string[] = [];
  const runs = {
    get: () => Promise.resolve(current),
    claim: () =>
      Promise.resolve(
        run({
          ...options.runOverrides,
          status: "running",
          startedAt: "2026-09-22T00:00:00.000Z",
          deadlineAt: "2026-09-22T00:10:00.000Z",
        }),
      ),
    heartbeat: () => Promise.resolve(true),
    recordOutcome: (
      _org: string,
      _id: string,
      _lease: string,
      outcome: unknown,
    ) => {
      outcomes.push(outcome);
      return Promise.resolve(true);
    },
    finish: (
      _org: string,
      _id: string,
      _lease: string,
      status: string,
      details: unknown,
    ) => {
      finishes.push({ status, details });
      return Promise.resolve(
        run({ status: status as StoredBountyRun["status"] }),
      );
    },
  } as unknown as BountyRunStore;
  const board = {
    id: "jrb_1",
    connectionId: "jrc_1",
    externalId: "42",
    name: "Backlog",
    boardType: "scrum",
    projectKey: "APP",
    selection: current.selection,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const boards = {
    forRun: () =>
      Promise.resolve({
        board,
        connectionId: "jrc_1",
        cloudId: "cloud_1",
        siteUrl: "https://example.test",
      }),
  } as unknown as JiraBoardStore;
  let pointer = 0;
  const issues = {
    get: () =>
      Promise.resolve({
        id: "jri_1",
        boardId: "jrb_1",
        externalId: "1",
        key: "APP-1",
        statusCategory: "new",
        remoteCreatedAt: "2026-01-01T00:00:00.000Z",
        remoteUpdatedAt: "2026-01-02T00:00:00.000Z",
        removedAt: null,
      }),
    upsert: (_org: string, _board: string, input: { externalId: string }) => {
      pointer += 1;
      return Promise.resolve({
        id: `jri_${pointer}`,
        boardId: "jrb_1",
        externalId: input.externalId,
        key: `APP-${input.externalId}`,
        statusCategory: "new",
        remoteCreatedAt: "2026-01-01T00:00:00.000Z",
        remoteUpdatedAt: "2026-01-02T00:00:00.000Z",
        removedAt: null,
      });
    },
    markRemoved: (_org: string, id: string) => {
      removed.push(id);
      return Promise.resolve(true);
    },
  } as unknown as JiraIssueStore;
  const proposals = {
    get: () =>
      Promise.resolve({
        id: "bpr_source",
        jiraIssueId: "jri_1",
        revision: options.runOverrides?.sourceRevision ?? 1,
      }),
    liveExternalIds: () => Promise.resolve(new Set<string>()),
    createForLease: (
      _org: string,
      _lease: string,
      input: Record<string, unknown>,
    ) => {
      proposalInputs.push(input);
      const status = options.createStatus ?? "created";
      return Promise.resolve(
        status === "created"
          ? {
              status,
              proposal: { id: `bpr_${proposalInputs.length}` },
            }
          : { status },
      );
    },
    repriceForLease: (
      _org: string,
      _lease: string,
      source: string,
      _revision: number,
      input: Record<string, unknown>,
    ) => {
      proposalInputs.push(input);
      return Promise.resolve({
        status: "repriced" as const,
        proposal: { id: source },
        ...(options.writebackOperationId === undefined
          ? {}
          : { writebackOperationId: options.writebackOperationId }),
      });
    },
  } as unknown as BountyProposalStore;
  const candidates = options.candidates ?? [issue("1")];
  const client = {
    backlogIssues: () =>
      Promise.resolve({ issues: candidates, total: candidates.length }),
    boardIssues: () => Promise.resolve({ issues: [], total: 0 }),
    issueSpec: (id: string) => {
      const answer = options.specs?.[id] ?? spec(id);
      return answer instanceof Error
        ? Promise.reject(answer)
        : Promise.resolve(answer);
    },
  };
  const sizer =
    options.sizer ??
    new FakeSizer("fake", "jira-size-v1", [
      {
        result: {
          complexity: "M",
          confidence: "high",
          rationale: "A few related files.",
        },
        actualModel: "actual-model",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    ]);
  const executor = new BountyExecutor({
    boards,
    runs,
    proposals,
    issues,
    sizer,
    clientFor: () => Promise.resolve({ ok: true, client }),
    now: () => new Date("2026-09-22T00:00:00.000Z"),
    leaseToken: () => "lease_1",
    onWritebackCreated: (_organizationId, operationId) => {
      startedWritebacks.push(operationId);
    },
  });
  return {
    executor,
    outcomes,
    finishes,
    proposalInputs,
    removed,
    startedWritebacks,
    sizer,
  };
}

test("a run persists sized drafts with snapshot pricing and usage", async () => {
  const state = harness({});
  await state.executor.execute("org_1", "brn_1");

  assert.equal(state.finishes[0]?.status, "succeeded");
  assert.equal(state.proposalInputs.length, 1);
  assert.equal(
    (state.proposalInputs[0] as { amountMinor: number }).amountMinor,
    200,
  );
  assert.equal(
    (state.proposalInputs[0] as { actualModel: string }).actualModel,
    "actual-model",
  );
  assert.deepEqual(state.outcomes, [
    {
      externalIssueId: "1",
      issueKey: "APP-1",
      jiraIssueId: "jri_1",
      proposalId: "bpr_1",
      status: "proposed",
      actualModel: "actual-model",
      inputTokens: 10,
      outputTokens: 5,
    },
  ]);
});

test("short and truncated specs become unsized without model calls", async () => {
  const sizer = new FakeSizer("fake", "jira-size-v1", []);
  const state = harness({
    candidates: [issue("1"), issue("2")],
    specs: {
      "1": spec("1", { summary: "x", descriptionText: "" }),
      "2": spec("2", { inputTruncated: true }),
    },
    runOverrides: {
      selection: { ...run().selection, minSpecChars: 20 },
    },
    sizer,
  });
  await state.executor.execute("org_1", "brn_1");

  assert.equal(sizer.calls.length, 0);
  assert.deepEqual(
    state.proposalInputs.map(
      (value) =>
        (value as { sizing: { unsizedReason?: string } }).sizing.unsizedReason,
    ),
    ["insufficient_spec", "spec_too_large"],
  );
  assert.deepEqual(
    state.outcomes.map((value) => (value as { status: string }).status),
    ["unsized", "unsized"],
  );
});

test("one technical sizing failure creates an unsized draft and a partial run", async () => {
  const sizer = new FakeSizer("fake", "jira-size-v1", [
    new Error("private provider detail"),
    {
      result: {
        complexity: "S",
        confidence: "high",
        rationale: "Localized.",
      },
      actualModel: "actual-model",
      usage: { inputTokens: 2, outputTokens: 2 },
    },
  ]);
  const state = harness({
    candidates: [issue("1"), issue("2")],
    sizer,
  });
  await state.executor.execute("org_1", "brn_1");

  assert.equal(state.finishes[0]?.status, "partial");
  assert.deepEqual(
    state.outcomes.map((value) => (value as { status: string }).status),
    ["failed", "proposed"],
  );
  assert.equal(
    (
      state.proposalInputs[0] as {
        sizing: { unsizedReason: string };
      }
    ).sizing.unsizedReason,
    "sizing_failed",
  );
});

test("provider configuration failure is fatal and creates no draft", async () => {
  const state = harness({
    sizer: new FakeSizer("fake", "jira-size-v1", [
      new SizerError("sizing_configuration", true),
    ]),
  });
  await state.executor.execute("org_1", "brn_1");

  assert.equal(state.finishes[0]?.status, "failed");
  assert.deepEqual(state.finishes[0]?.details, {
    fatalErrorCode: "sizing_configuration",
    candidatesScanned: 1,
    skippedLive: 0,
    scanLimitReached: false,
  });
  assert.equal(state.proposalInputs.length, 0);
});

test("the first fatal code survives the cancellation it triggers", async () => {
  // Three workers start together. The first provider answer is a
  // configuration stop; the abort it triggers cancels the other two mid-call,
  // and the real sizers report that as `sizing_cancelled`. The recorded cause
  // must stay the configuration stop, not the `worker_lost` from the cascade.
  const state = harness({
    candidates: [issue("1"), issue("2"), issue("3")],
    sizer: new FakeSizer("fake", "jira-size-v1", [
      new SizerError("sizing_configuration", true),
      new SizerError("sizing_cancelled", false),
      new SizerError("sizing_cancelled", false),
    ]),
  });
  await state.executor.execute("org_1", "brn_1");

  assert.equal(state.finishes[0]?.status, "failed");
  assert.equal(
    (state.finishes[0]?.details as { fatalErrorCode: string }).fatalErrorCode,
    "sizing_configuration",
  );
  assert.equal(state.proposalInputs.length, 0);
});

test("invalid Jira dates fail one ticket without inventing timestamps", async () => {
  const state = harness({
    candidates: [issue("1", { created: null }), issue("2", { updated: "bad" })],
    sizer: new FakeSizer("fake", "jira-size-v1", []),
  });
  await state.executor.execute("org_1", "brn_1");

  assert.equal(state.finishes[0]?.status, "failed");
  assert.deepEqual(
    state.outcomes.map((value) => (value as { code: string }).code),
    ["invalid_issue_dates", "invalid_issue_dates"],
  );
  assert.equal(state.proposalInputs.length, 0);
});

test("a lost lease fences the proposal and fails the run", async () => {
  const state = harness({ createStatus: "lost-lease" });
  await state.executor.execute("org_1", "brn_1");

  assert.equal(state.finishes[0]?.status, "failed");
  assert.equal(
    (state.finishes[0]?.details as { fatalErrorCode: string }).fatalErrorCode,
    "worker_lost",
  );
  assert.deepEqual(state.outcomes, []);
});

test("an empty backlog succeeds without model calls", async () => {
  const sizer = new FakeSizer("fake", "jira-size-v1", []);
  const state = harness({ candidates: [], sizer });
  await state.executor.execute("org_1", "brn_1");

  assert.equal(state.finishes[0]?.status, "succeeded");
  assert.equal(sizer.calls.length, 0);
});

test("re-price sizes only its source issue and updates it in place", async () => {
  const state = harness({
    candidates: [],
    writebackOperationId: "bwo_withdrawn",
    runOverrides: {
      kind: "reprice",
      sourceProposalId: "bpr_source",
      sourceRevision: 1,
      selection: { ...run().selection, maxTickets: 1 },
    },
  });
  await state.executor.execute("org_1", "brn_1");
  assert.equal(state.finishes[0]?.status, "succeeded");
  assert.equal(state.proposalInputs.length, 1);
  // The outcome names the source proposal: the same row, sized again.
  assert.equal(
    (state.outcomes[0] as { proposalId: string }).proposalId,
    "bpr_source",
  );
  assert.deepEqual(state.startedWritebacks, ["bwo_withdrawn"]);
});

test("XS model sizing uses the distinct XS snapshot price", async () => {
  const state = harness({
    runOverrides: { rateCard: { ...rateCard, xsMinor: 50 } },
    sizer: new FakeSizer("fake", "jira-size-v2", [
      {
        result: {
          complexity: "XS",
          confidence: "high",
          rationale: "One label correction.",
        },
        actualModel: "actual-model",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    ]),
  });
  await state.executor.execute("org_1", "brn_1");
  assert.equal(state.finishes[0]?.status, "succeeded");
  assert.equal(
    (state.proposalInputs[0] as { amountMinor: number }).amountMinor,
    50,
  );
});
