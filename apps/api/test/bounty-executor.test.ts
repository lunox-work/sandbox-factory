import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  BountyProposalStore,
  BountyRunStore,
  BountySpecStore,
  JiraBoardStore,
  JiraIssueStore,
  StoredBountyRun,
  StoredTicket,
  TicketStore,
} from "@sandbox-factory/db";
import { JiraApiError, type JiraIssueSpec } from "@sandbox-factory/jira";
import type {
  JiraIssueDto,
  JiraIssueSignalsDto,
} from "@sandbox-factory/shared";
import {
  ticketSpecHash,
  type BountySizingResult,
  type SpecDraft,
  type TicketContent,
} from "sandbox-factory";

import {
  BountyExecutor,
  type BountyExecutorOptions,
} from "../src/bounty/executor.js";
import {
  FakeCaller,
  SizerError,
  type SizingRequestOptions,
  type StructuredCall,
  type StructuredResult,
} from "../src/sizing/caller.js";

/** What the harness's tickets are drafted as, unless a test says otherwise. */
const draft: SpecDraft = {
  feature: "Issue behaviour",
  background: [],
  scenarios: [
    {
      id: "s1",
      kind: "happy",
      title: "The change works",
      steps: [{ keyword: "Then", text: "the acceptance criteria hold" }],
      origin: "draft",
      weight: "moderate",
      weightReason: "the ticket's core change",
    },
  ],
  openQuestions: [],
  assumptions: [],
};

function drafted(): StructuredResult<SpecDraft> {
  return {
    result: draft,
    actualModel: "drafting-model",
    usage: { inputTokens: 100, outputTokens: 40 },
  };
}

type Answer<T> = StructuredResult<T> | Error;

/**
 * A caller that sizes from a queue, which is what most tests here are
 * about, and drafts every ticket it is asked to unless given drafts of its
 * own.
 */
function sizing(
  sizes: Answer<BountySizingResult>[],
  drafts: Answer<SpecDraft>[] | (() => Answer<SpecDraft>) = drafted,
): FakeCaller {
  return new FakeCaller("fake", { size_bounty: sizes, draft_spec: drafts });
}

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
    ticketId: null,
    kind: "backlog",
    sourceProposalId: null,
    sourceRevision: null,
    respec: null,
    requestId: "28bb313f-252a-4a1d-b656-558a215b604b",
    status: "queued",
    selection: {
      unassignedOnly: false,
      issueTypes: [],
      minAgeDays: 0,
      minSpecChars: 0,
      categories: {},
    },
    rateCard,
    requestedModel: "requested-model",
    promptVersion: "jira-size-v1",
    planned: [],
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

/**
 * A candidate as the selection read returns it. The harness's tickets are
 * old, untouched and unowned, so with no sprint history each one is "left
 * behind" and a backlog run picks it.
 */
function signals(
  candidate: JiraIssueDto & Partial<JiraIssueSignalsDto>,
): JiraIssueSignalsDto {
  return {
    sprint: null,
    closedSprints: [],
    votes: null,
    watchers: null,
    links: [],
    releases: [],
    ...candidate,
  };
}

/**
 * A ticket as the store reads it. By default the one a board's issue "1"
 * was imported as, still following it.
 */
function ticket(overrides: Partial<StoredTicket> = {}): StoredTicket {
  return {
    id: "tkt_1",
    organizationId: "org_1",
    number: 1,
    key: "APP-1",
    title: "Issue 1",
    description: "Clear acceptance criteria.",
    issueType: "Story",
    priority: "Medium",
    labels: [],
    components: [],
    inputTruncated: false,
    origin: "jira",
    repoId: null,
    createdBy: null,
    revision: 1,
    jira: {
      issueId: "jri_1",
      boardId: "jrb_1",
      connectionId: "jrc_1",
      externalId: "1",
      key: "APP-1",
      siteUrl: "https://example.test",
      removedAt: null,
    },
    createdAt: "2026-09-22T00:00:00.000Z",
    updatedAt: "2026-09-22T00:00:00.000Z",
    ...overrides,
  };
}

/** A ticket written here: no Jira issue, no board. */
function handWritten(overrides: Partial<StoredTicket> = {}): StoredTicket {
  return ticket({
    id: "tkt_7",
    number: 7,
    key: "T-7",
    title: "Invitations are not sent",
    description: "Scheduling an interview sends the candidate one email.",
    issueType: "Bug",
    priority: null,
    origin: "manual",
    jira: null,
    ...overrides,
  });
}

/** The deadline the fake store sets once a plan is recorded. */
const PLAN_DEADLINE = "2026-09-22T00:30:00.000Z";

function spec(
  id: string,
  overrides: Partial<JiraIssueSpec> = {},
): JiraIssueSpec {
  return {
    key: `APP-${id}`,
    summary: `Issue ${id}`,
    descriptionText: "Clear acceptance criteria.",
    issueType: "Story",
    components: [],
    labels: [],
    priority: "Medium",
    updated: "2026-01-02T00:00:00.000Z",
    inputTruncated: false,
    specHash: "a".repeat(64),
    pricingSpecHash: id.padEnd(64, "a").slice(0, 64),
    ...overrides,
  };
}

function harness(options: {
  candidates?: (JiraIssueDto & Partial<JiraIssueSignalsDto>)[];
  specs?: Record<string, JiraIssueSpec | Error>;
  caller?: FakeCaller;
  createStatus?: "created" | "duplicate" | "lost-lease" | "not-found";
  writebackOperationId?: string;
  runOverrides?: Partial<StoredBountyRun>;
  planHeld?: boolean;
  issueError?: Error;
  /** The plan of the run a re-priced proposal came from. */
  originPlanned?: StoredBountyRun["planned"];
  /** The board's pricing settings, as stored. */
  pricing?: unknown;
  /** How many sub-tasks a run's one ticket has when read again. */
  pickedSubtasks?: number;
  /** Keeping Jira's text on the ticket fails with this. */
  refreshError?: Error;
  /** The repository the board names, if any. */
  sourceRepoId?: string | null;
  /** The tickets the store holds, by id; a board's imports are added. */
  tickets?: StoredTicket[];
  /** What the Jira client answers for a run's client; absent, a client. */
  clientResult?: { ok: false; reason: "not-found" | "reconnect" };
  /** The import answers no pointer, as for a board not the organization's. */
  importFails?: boolean;
  /** What the outline read answers; absent, the executor has no reader. */
  outlineFor?: BountyExecutorOptions["outlineFor"];
  onBackgroundError?: BountyExecutorOptions["onBackgroundError"];
  onProposalDrafted?: BountyExecutorOptions["onProposalDrafted"];
}) {
  const current = run(options.runOverrides);
  const plans: unknown[] = [];
  const outcomes: unknown[] = [];
  const finishes: { status: string; details: unknown }[] = [];
  const proposalInputs: unknown[] = [];
  const removed: string[] = [];
  const refreshed: { ticketId: string; content: TicketContent }[] = [];
  const imported: TicketContent[] = [];
  const startedWritebacks: string[] = [];
  const runs = {
    get: (_org: string, id: string) =>
      Promise.resolve(
        id === "brn_origin"
          ? options.originPlanned === undefined
            ? null
            : run({ id: "brn_origin", planned: options.originPlanned })
          : current,
      ),
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
    recordPlan: (
      _org: string,
      _id: string,
      _lease: string,
      plan: StoredBountyRun["planned"],
    ) => {
      plans.push(plan);
      // As the store does: the run back, with the deadline its plan set.
      return Promise.resolve(
        (options.planHeld ?? true)
          ? run({
              ...options.runOverrides,
              status: "running",
              planned: plan,
              startedAt: "2026-09-22T00:00:00.000Z",
              deadlineAt: PLAN_DEADLINE,
            })
          : null,
      );
    },
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
    pricing: options.pricing,
    sourceRepoId: options.sourceRepoId ?? null,
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
  const held = new Map(
    (options.tickets ?? [ticket()]).map((stored) => [stored.id, stored]),
  );
  let pointer = 0;
  const issues = {
    upsert: (
      _org: string,
      _board: string,
      input: { externalId: string },
      content: TicketContent,
    ) => {
      if (options.importFails) return Promise.resolve(null);
      pointer += 1;
      imported.push(content);
      const ticketId = `tkt_${pointer}`;
      held.set(
        ticketId,
        ticket({
          id: ticketId,
          number: pointer,
          key: `APP-${input.externalId}`,
          ...content,
          jira: {
            ...ticket().jira!,
            issueId: `jri_${pointer}`,
            externalId: input.externalId,
            key: `APP-${input.externalId}`,
          },
        }),
      );
      return Promise.resolve({
        id: `jri_${pointer}`,
        boardId: "jrb_1",
        ticketId,
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
    markRemovedByExternal: (_org: string, _board: string, id: string) => {
      removed.push(id);
      return Promise.resolve(true);
    },
  } as unknown as JiraIssueStore;
  const tickets = {
    get: (_org: string, id: string) => Promise.resolve(held.get(id) ?? null),
    refreshFromJira: (
      _org: string,
      ticketId: string,
      content: TicketContent,
    ) => {
      if (options.refreshError !== undefined) {
        return Promise.reject(options.refreshError);
      }
      refreshed.push({ ticketId, content });
      return Promise.resolve(true);
    },
  } as unknown as TicketStore;
  const proposals = {
    get: () =>
      Promise.resolve({
        id: "bpr_source",
        runId: "brn_origin",
        ticketId: options.tickets?.[0]?.id ?? "tkt_1",
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
              proposal: {
                id: `bpr_${proposalInputs.length}`,
                specRevision: "spec" in input ? 1 : null,
              },
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
        proposal: { id: source, specRevision: "spec" in input ? 2 : null },
        ...(options.writebackOperationId === undefined
          ? {}
          : { writebackOperationId: options.writebackOperationId }),
      });
    },
  } as unknown as BountyProposalStore;
  const candidates = (options.candidates ?? [issue("1")]).map(signals);
  const client = {
    boardIssueSignals: () =>
      Promise.resolve({ issues: candidates, total: candidates.length }),
    boardIssues: () => Promise.resolve({ issues: [], total: 0 }),
    issue: (id: string) =>
      options.issueError === undefined
        ? Promise.resolve(
            issue(id, {
              summary: `Fresh ${id}`,
              subtaskCount: options.pickedSubtasks ?? 0,
            }),
          )
        : Promise.reject(options.issueError),
    issueSpec: (id: string) => {
      const answer = options.specs?.[id] ?? spec(id);
      return answer instanceof Error
        ? Promise.reject(answer)
        : Promise.resolve(answer);
    },
  };
  const caller =
    options.caller ??
    sizing([
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
    tickets,
    // No run here changes a spec: a respec run has its own tests.
    specs: {} as BountySpecStore,
    caller,
    clientFor: () =>
      Promise.resolve(options.clientResult ?? { ok: true, client }),
    ...(options.outlineFor === undefined
      ? {}
      : { outlineFor: options.outlineFor }),
    ...(options.onBackgroundError === undefined
      ? {}
      : { onBackgroundError: options.onBackgroundError }),
    ...(options.onProposalDrafted === undefined
      ? {}
      : { onProposalDrafted: options.onProposalDrafted }),
    now: () => new Date("2026-09-22T00:00:00.000Z"),
    leaseToken: () => "lease_1",
    onWritebackCreated: (_organizationId, operationId) => {
      startedWritebacks.push(operationId);
    },
  });
  return {
    executor,
    plans,
    outcomes,
    finishes,
    proposalInputs,
    removed,
    refreshed,
    imported,
    startedWritebacks,
    caller,
  };
}

test("a run records what it will size before sizing any of it", async () => {
  // A page opened mid-run lists these, so what is still to come shows as
  // well as what is done.
  const state = harness({});
  await state.executor.execute("org_1", "brn_1");

  assert.equal(state.plans.length, 1);
  const [plan] = state.plans as { issueKey: string; summary: string }[][];
  assert.ok(plan !== undefined && plan.length > 0);
  assert.equal(plan.length, state.outcomes.length);
  assert.ok(plan.every(({ issueKey }) => issueKey.length > 0));
});

test("a backlog run plans each ticket with the reason it was picked", async () => {
  // The reason is stored with the plan, which is where a proposal's row
  // later reads it from.
  const state = harness({
    candidates: [
      issue("1"),
      // Owned and recent: fits no category, so the run does not take it.
      issue("2", {
        assignee: "Ada Lovelace",
        created: "2026-09-20T00:00:00.000Z",
        updated: "2026-09-20T00:00:00.000Z",
      }),
    ],
  });
  await state.executor.execute("org_1", "brn_1");

  assert.deepEqual(state.plans, [
    [
      {
        externalIssueId: "1",
        issueKey: "APP-1",
        summary: "Issue 1",
        categories: [
          {
            id: "left-behind",
            label: "Left behind",
            reason: "Open 264 days, never in a sprint, unassigned",
          },
        ],
      },
    ],
  ]);
  assert.equal(state.caller.inputsFor("size_bounty").length, 1);
  assert.deepEqual(state.finishes[0]?.details, {
    candidatesScanned: 2,
    skippedLive: 0,
    scanLimitReached: false,
  });
});

test("a run sizes every ticket that fits, however many", async () => {
  // There is no count to stop at: sixty fit, sixty are sized.
  const many = Array.from({ length: 60 }, (_, index) => issue(String(index)));
  const state = harness({
    candidates: many,
    caller: sizing(
      many.map(() => ({
        result: {
          complexity: "S" as const,
          confidence: "high" as const,
          rationale: "Small.",
        },
        actualModel: "actual-model",
        usage: { inputTokens: 1, outputTokens: 1 },
      })),
    ),
  });
  await state.executor.execute("org_1", "brn_1");

  assert.equal((state.plans[0] as unknown[]).length, 60);
  assert.equal(state.outcomes.length, 60);
  assert.equal(state.finishes[0]?.status, "succeeded");
});

test("tickets are sized against the deadline the plan set, not the claim's", async () => {
  // Recording the plan moves the deadline out by its size. Sizing against
  // the one the run was claimed with would cut a long run short.
  class RecordingCaller extends FakeCaller {
    readonly deadlines: (Date | undefined)[] = [];
    override call<I, O>(
      tool: StructuredCall<I, O>,
      input: I,
      options?: SizingRequestOptions,
    ) {
      this.deadlines.push(options?.deadlineAt);
      return super.call(tool, input);
    }
  }
  const recording = new RecordingCaller("fake", {
    draft_spec: [drafted()],
    size_bounty: [
      {
        result: { complexity: "S", confidence: "high", rationale: "Small." },
        actualModel: "actual-model",
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ],
  });
  const state = harness({ caller: recording });
  await state.executor.execute("org_1", "brn_1");

  // The draft and the size, both.
  assert.deepEqual(
    recording.deadlines.map((deadline) => deadline?.toISOString()),
    [PLAN_DEADLINE, PLAN_DEADLINE],
  );
});

test("a run that lost its lease before planning sizes nothing", async () => {
  const state = harness({ planHeld: false });
  await state.executor.execute("org_1", "brn_1");

  assert.equal(state.caller.inputsFor("size_bounty").length, 0);
  assert.equal(state.outcomes.length, 0);
  assert.equal(state.finishes.length, 0);
});

test("an issue run sizes the one ticket it names, read fresh from Jira", async () => {
  const state = harness({
    runOverrides: {
      kind: "issue",
      planned: [{ externalIssueId: "7", issueKey: "APP-7", summary: "Old" }],
    },
  });
  await state.executor.execute("org_1", "brn_1");

  assert.equal(state.finishes[0]?.status, "succeeded");
  assert.equal(state.caller.inputsFor("size_bounty").length, 1);
  // Picked by a person, so there is no category to give as the reason.
  assert.deepEqual(state.plans, [
    [
      {
        externalIssueId: "7",
        issueKey: "APP-7",
        summary: "Fresh 7",
        categories: [],
      },
    ],
  ]);
  assert.equal(
    (state.outcomes[0] as { proposalId?: string }).proposalId,
    "bpr_1",
  );
});

test("an issue run whose ticket was split into sub-tasks since it was picked sizes nothing", async () => {
  const state = harness({
    runOverrides: {
      kind: "issue",
      planned: [{ externalIssueId: "7", issueKey: "APP-7", summary: "Old" }],
    },
    pickedSubtasks: 2,
  });
  await state.executor.execute("org_1", "brn_1");

  assert.deepEqual(state.finishes, [
    { status: "failed", details: { fatalErrorCode: "issue_has_subtasks" } },
  ]);
  assert.equal(state.caller.calls.length, 0);
  assert.equal(state.proposalInputs.length, 0);
});

test("an issue run without a ticket, or whose ticket is gone, fails", async () => {
  const empty = harness({ runOverrides: { kind: "issue", planned: [] } });
  await empty.executor.execute("org_1", "brn_1");
  assert.deepEqual(empty.finishes, [
    { status: "failed", details: { fatalErrorCode: "issue_unavailable" } },
  ]);

  const gone = harness({
    runOverrides: {
      kind: "issue",
      planned: [{ externalIssueId: "7", issueKey: "APP-7", summary: "Old" }],
    },
    issueError: new JiraApiError(404, "gone"),
  });
  await gone.executor.execute("org_1", "brn_1");
  assert.equal(gone.finishes[0]?.status, "failed");
  assert.equal(gone.caller.calls.length, 0);
});

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
      ticketId: "tkt_1",
      proposalId: "bpr_1",
      status: "proposed",
      // The model that sized it; the spec records its own.
      actualModel: "actual-model",
      // The draft's tokens and the size's, together.
      inputTokens: 110,
      outputTokens: 45,
    },
  ]);
});

test("a run drafts the spec first and stores it with the proposal", async () => {
  const state = harness({
    specs: {
      "1": spec("1", { components: ["Reports"], labels: ["export"] }),
    },
  });
  await state.executor.execute("org_1", "brn_1");

  // The spec before the size, each from the same read of the ticket. The
  // draft also reads what Jira says the ticket touches; the size is asked
  // exactly as it was before there were specs.
  assert.deepEqual(state.caller.calls, [
    {
      tool: "draft_spec",
      input: {
        summary: "Issue 1",
        descriptionText: "Clear acceptance criteria.",
        issueType: "Story",
        components: ["Reports"],
        labels: ["export"],
      },
    },
    {
      tool: "size_bounty",
      input: {
        summary: "Issue 1",
        descriptionText: "Clear acceptance criteria.",
        issueType: "Story",
      },
    },
  ]);
  // One write carries both, hashed from the same ticket.
  const written = state.proposalInputs[0] as {
    specHash: string;
    specHashVersion: number;
    spec: unknown;
  };
  assert.deepEqual(written.spec, {
    specHash: written.specHash,
    specHashVersion: written.specHashVersion,
    draft,
    origin: "draft",
    actualModel: "drafting-model",
    promptVersion: "draft-v3",
  });
});

test("a board with a source repository drafts beside its outline and records the snapshot", async () => {
  const asked: string[] = [];
  const state = harness({
    sourceRepoId: "ghr_1",
    outlineFor: (_organizationId, repoId) => {
      asked.push(repoId);
      return Promise.resolve({ snapshotId: "rsn_1", text: "- src: 3 files" });
    },
    candidates: [issue("1"), issue("2")],
  });
  await state.executor.execute("org_1", "brn_1");

  // Read once for the run, however many tickets it sizes.
  assert.deepEqual(asked, ["ghr_1"]);
  const drafts = state.caller.calls.filter(
    ({ tool }) => tool === "draft_spec",
  ) as { input: { repositoryOutline?: string } }[];
  assert.equal(drafts.length, 2);
  for (const call of drafts) {
    assert.equal(call.input.repositoryOutline, "- src: 3 files");
  }
  // The size is asked exactly as before: it is never shown the outline.
  for (const call of state.caller.calls.filter(
    ({ tool }) => tool === "size_bounty",
  )) {
    assert.equal("repositoryOutline" in (call.input as object), false);
  }
  for (const input of state.proposalInputs) {
    assert.equal(
      (input as { repoSnapshotId: unknown }).repoSnapshotId,
      "rsn_1",
    );
  }
});

test("no repository, no snapshot yet, or no reader: drafts as before", async () => {
  for (const options of [
    { sourceRepoId: null, outlineFor: () => Promise.reject(new Error("no")) },
    { sourceRepoId: "ghr_1", outlineFor: () => Promise.resolve(null) },
    { sourceRepoId: "ghr_1" },
  ]) {
    const state = harness(options);
    await state.executor.execute("org_1", "brn_1");
    const draft = state.caller.calls.find(({ tool }) => tool === "draft_spec");
    assert.equal("repositoryOutline" in (draft?.input as object), false);
    assert.equal(
      (state.proposalInputs[0] as { repoSnapshotId: unknown }).repoSnapshotId,
      null,
    );
  }
});

test("an outline that cannot be read is reported and the run drafts without it", async () => {
  const reported: string[] = [];
  const state = harness({
    sourceRepoId: "ghr_1",
    outlineFor: () => Promise.reject(new Error("database down")),
    onBackgroundError: (code) => void reported.push(code),
  });
  await state.executor.execute("org_1", "brn_1");

  assert.deepEqual(reported, ["bounty_outline_unavailable"]);
  assert.equal(state.finishes[0]?.status, "succeeded");
});

test("a proposal whose draft failed records no snapshot, outline or not", async () => {
  const state = harness({
    sourceRepoId: "ghr_1",
    outlineFor: () => Promise.resolve({ snapshotId: "rsn_1", text: "outline" }),
    caller: sizing(
      [
        {
          result: { complexity: "M", confidence: "high", rationale: "Some." },
          actualModel: "actual-model",
          usage: { inputTokens: 1, outputTokens: 1 },
        },
      ],
      [new SizerError("sizing_invalid_output", false)],
    ),
  });
  await state.executor.execute("org_1", "brn_1");

  assert.equal(
    (state.proposalInputs[0] as { repoSnapshotId: unknown }).repoSnapshotId,
    null,
  );
});

test("each spec drafted beside a snapshot asks for its complexity profile", async () => {
  const asked: unknown[] = [];
  const state = harness({
    sourceRepoId: "ghr_1",
    outlineFor: () => Promise.resolve({ snapshotId: "rsn_1", text: "outline" }),
    candidates: [issue("1"), issue("2")],
    specs: { "2": spec("2", { issueType: "Bug", priority: null }) },
    onProposalDrafted: (organizationId, input) =>
      void asked.push({ organizationId, ...input }),
  });
  await state.executor.execute("org_1", "brn_1");

  assert.deepEqual(asked, [
    {
      organizationId: "org_1",
      proposalId: "bpr_1",
      specRevision: 1,
      specHash: spec("1").pricingSpecHash,
      snapshotId: "rsn_1",
      ticket: { issueType: "Story", priority: "Medium" },
    },
    {
      organizationId: "org_1",
      proposalId: "bpr_2",
      specRevision: 1,
      specHash: spec("2").pricingSpecHash,
      snapshotId: "rsn_1",
      ticket: { issueType: "Bug", priority: null },
    },
  ]);
});

test("a re-price drafted beside a snapshot profiles its new spec revision", async () => {
  const asked: { proposalId: string; specRevision: number }[] = [];
  const state = harness({
    candidates: [],
    runOverrides: {
      kind: "reprice",
      sourceProposalId: "bpr_9",
      sourceRevision: 1,
    },
    sourceRepoId: "ghr_1",
    outlineFor: () => Promise.resolve({ snapshotId: "rsn_2", text: "outline" }),
    onProposalDrafted: (_organizationId, input) => void asked.push(input),
  });
  await state.executor.execute("org_1", "brn_1");
  assert.deepEqual(
    asked.map(({ proposalId, specRevision }) => ({ proposalId, specRevision })),
    [{ proposalId: "bpr_9", specRevision: 2 }],
  );
});

test("no profile is asked for without a snapshot, or without a spec", async () => {
  const noOutline: unknown[] = [];
  await harness({
    sourceRepoId: "ghr_1",
    outlineFor: () => Promise.resolve(null),
    onProposalDrafted: (_organizationId, input) => void noOutline.push(input),
  }).executor.execute("org_1", "brn_1");
  assert.deepEqual(noOutline, []);

  const noSpec: unknown[] = [];
  await harness({
    sourceRepoId: "ghr_1",
    outlineFor: () => Promise.resolve({ snapshotId: "rsn_1", text: "outline" }),
    caller: sizing(
      [
        {
          result: { complexity: "M", confidence: "high", rationale: "Some." },
          actualModel: "actual-model",
          usage: { inputTokens: 1, outputTokens: 1 },
        },
      ],
      [new SizerError("sizing_invalid_output", false)],
    ),
    onProposalDrafted: (_organizationId, input) => void noSpec.push(input),
  }).executor.execute("org_1", "brn_1");
  assert.deepEqual(noSpec, []);
});

test("a sized ticket is written with a step of zero, priced at its own size", async () => {
  const state = harness({});
  await state.executor.execute("org_1", "brn_1");

  const written = state.proposalInputs[0] as {
    amountMinor: number;
    step: Record<string, unknown> | null;
  };
  // A fresh draft has added nothing: the step is there to be moved later.
  assert.deepEqual(written.step, {
    base: "M",
    complexity: "M",
    steps: 0,
    addedPoints: 0,
    added: [],
    nextStepIn: 4,
    settings: {
      pointsPerStep: 4,
      weightPoints: { light: 1, moderate: 2, heavy: 4 },
    },
    stepVersion: "step-v1",
  });
  assert.equal(written.amountMinor, 200);
});

test("the step is counted with the board's own pricing settings", async () => {
  const state = harness({
    pricing: { step: { pointsPerStep: 6, weightPoints: { heavy: 9 } } },
  });
  await state.executor.execute("org_1", "brn_1");

  const { step } = state.proposalInputs[0] as {
    step: { nextStepIn: number; settings: unknown };
  };
  assert.equal(step.nextStepIn, 6);
  assert.deepEqual(step.settings, {
    pointsPerStep: 6,
    weightPoints: { light: 1, moderate: 2, heavy: 9 },
  });

  // Settings it cannot read are the defaults, not a failed run.
  const garbled = harness({ pricing: "not settings" });
  await garbled.executor.execute("org_1", "brn_1");
  assert.equal(garbled.finishes[0]?.status, "succeeded");
});

test("there is no step without a base or without weights to count", async () => {
  const sized = {
    result: {
      complexity: "S" as const,
      confidence: "high" as const,
      rationale: "Small.",
    },
    actualModel: "actual-model",
    usage: { inputTokens: 1, outputTokens: 1 },
  };
  const unsized = harness({
    caller: sizing([
      {
        result: {
          complexity: "unsized",
          confidence: "low",
          rationale: "Too vague.",
          unsizedReason: "missing requirements",
        },
        actualModel: "actual-model",
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ]),
  });
  const failedDraft = harness({
    caller: sizing([sized], [new Error("private")]),
  });
  // A draft with no weights, as a provider that ignored the schema might
  // still somehow produce: no step, rather than a step of nothing.
  const weightless = harness({
    caller: sizing([sized], () => ({
      ...drafted(),
      result: {
        ...draft,
        scenarios: draft.scenarios.map(
          ({ weight: _weight, weightReason: _reason, ...scenario }) => scenario,
        ),
      },
    })),
  });
  for (const state of [unsized, failedDraft, weightless]) {
    await state.executor.execute("org_1", "brn_1");
    const written = state.proposalInputs[0] as {
      step: unknown;
      amountMinor: number | null;
    };
    assert.equal(written.step, null);
  }
  assert.equal(
    (failedDraft.proposalInputs[0] as { amountMinor: number }).amountMinor,
    100,
  );
});

test("a draft that fails costs the ticket its spec, not its proposal", async () => {
  for (const failure of [
    new Error("private provider detail"),
    new SizerError("sizing_invalid_output", false),
    new SizerError("sizing_timeout", false),
  ]) {
    const state = harness({
      caller: sizing(
        [
          {
            result: {
              complexity: "S",
              confidence: "high",
              rationale: "Small.",
            },
            actualModel: "actual-model",
            usage: { inputTokens: 2, outputTokens: 2 },
          },
        ],
        [failure],
      ),
    });
    await state.executor.execute("org_1", "brn_1");

    // Proposed and priced as ever, and the run is not a failure for it.
    assert.equal(state.finishes[0]?.status, "succeeded");
    assert.equal("spec" in (state.proposalInputs[0] as object), false);
    assert.equal(
      (state.proposalInputs[0] as { amountMinor: number }).amountMinor,
      100,
    );
    assert.deepEqual(state.outcomes, [
      {
        externalIssueId: "1",
        issueKey: "APP-1",
        ticketId: "tkt_1",
        proposalId: "bpr_1",
        status: "proposed",
        code: "spec_failed",
        actualModel: "actual-model",
        inputTokens: 2,
        outputTokens: 2,
      },
    ]);
  }
});

test("a ticket that fails both calls is a sizing failure", async () => {
  const state = harness({
    caller: sizing([new Error("private")], [new Error("private")]),
  });
  await state.executor.execute("org_1", "brn_1");

  assert.equal("spec" in (state.proposalInputs[0] as object), false);
  assert.deepEqual(
    state.outcomes.map((value) => {
      const { status, code, inputTokens } = value as Record<string, unknown>;
      return { status, code, inputTokens };
    }),
    [{ status: "failed", code: "sizing_failed", inputTokens: undefined }],
  );
});

test("a draft that stops the run stops it before the size is asked for", async () => {
  for (const [failure, fatalErrorCode] of [
    [new SizerError("sizing_configuration", true), "sizing_configuration"],
    [new SizerError("sizing_cancelled", false), "worker_lost"],
  ] as const) {
    const state = harness({ caller: sizing([], [failure]) });
    await state.executor.execute("org_1", "brn_1");

    assert.equal(state.finishes[0]?.status, "failed");
    assert.equal(
      (state.finishes[0]?.details as { fatalErrorCode: string }).fatalErrorCode,
      fatalErrorCode,
    );
    assert.deepEqual(state.caller.inputsFor("size_bounty"), []);
    assert.equal(state.proposalInputs.length, 0);
    assert.deepEqual(state.outcomes, []);
  }
});

test("a size cancelled under the run ends it as a lost worker", async () => {
  const state = harness({
    caller: sizing([new SizerError("sizing_cancelled", false)]),
  });
  await state.executor.execute("org_1", "brn_1");

  assert.equal(
    (state.finishes[0]?.details as { fatalErrorCode: string }).fatalErrorCode,
    "worker_lost",
  );
  assert.equal(state.proposalInputs.length, 0);
});

test("short and truncated specs become unsized without model calls", async () => {
  const caller = sizing([]);
  const state = harness({
    candidates: [issue("1"), issue("2")],
    specs: {
      "1": spec("1", { summary: "x", descriptionText: "" }),
      "2": spec("2", { inputTruncated: true }),
    },
    runOverrides: {
      selection: { ...run().selection, minSpecChars: 20 },
    },
    caller,
  });
  await state.executor.execute("org_1", "brn_1");

  // Neither a size nor a draft: there is nothing safe to draft from.
  assert.equal(caller.calls.length, 0);
  assert.deepEqual(
    state.proposalInputs.map(
      (value) =>
        (value as { sizing: { unsizedReason?: string } }).sizing.unsizedReason,
    ),
    ["insufficient_spec", "spec_too_large"],
  );
  assert.ok(
    state.proposalInputs.every((value) => !("spec" in (value as object))),
  );
  // No call, so no tokens to report.
  assert.ok(
    state.outcomes.every((value) => !("inputTokens" in (value as object))),
  );
  assert.deepEqual(
    state.outcomes.map((value) => (value as { status: string }).status),
    ["unsized", "unsized"],
  );
});

test("one technical sizing failure creates an unsized draft and a partial run", async () => {
  const caller = sizing([
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
    caller,
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
    caller: sizing([new SizerError("sizing_configuration", true)]),
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
    caller: sizing([
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
  // Picked for what they block, which needs no date. A ticket whose dates
  // cannot be read has no age, so it is never picked for being old.
  const links = [
    {
      type: "Blocks",
      direction: "outward" as const,
      key: "APP-9",
      statusCategory: "new" as const,
    },
  ];
  const state = harness({
    candidates: [
      { ...issue("1", { created: null }), links },
      { ...issue("2", { updated: "bad" }), links },
    ],
    caller: sizing([]),
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
  const caller = sizing([]);
  const state = harness({ candidates: [], caller });
  await state.executor.execute("org_1", "brn_1");

  assert.equal(state.finishes[0]?.status, "succeeded");
  assert.equal(caller.calls.length, 0);
});

test("re-price sizes only its source issue and updates it in place", async () => {
  const state = harness({
    candidates: [],
    writebackOperationId: "bwo_withdrawn",
    runOverrides: {
      kind: "reprice",
      sourceProposalId: "bpr_source",
      sourceRevision: 1,
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
  // Drafted again, from the ticket as it is now.
  assert.deepEqual(
    (state.proposalInputs[0] as { spec: { draft: unknown } }).spec.draft,
    draft,
  );
});

test("a re-price that cannot draft leaves the proposal as it was", async () => {
  // All or nothing: a new size with no spec would clear the pointer to a
  // spec that may still be right.
  const state = harness({
    candidates: [],
    runOverrides: {
      kind: "reprice",
      sourceProposalId: "bpr_source",
      sourceRevision: 1,
    },
    caller: sizing(
      [
        {
          result: { complexity: "S", confidence: "high", rationale: "Small." },
          actualModel: "actual-model",
          usage: { inputTokens: 2, outputTokens: 2 },
        },
      ],
      [new SizerError("sizing_provider", false)],
    ),
  });
  await state.executor.execute("org_1", "brn_1");

  assert.equal(state.proposalInputs.length, 0);
  assert.equal(state.finishes[0]?.status, "failed");
  assert.deepEqual(state.outcomes, [
    {
      externalIssueId: "1",
      issueKey: "APP-1",
      ticketId: "tkt_1",
      status: "failed",
      code: "spec_failed",
    },
  ]);
});

test("a re-price that cannot size leaves the proposal as it was", async () => {
  const state = harness({
    candidates: [],
    runOverrides: {
      kind: "reprice",
      sourceProposalId: "bpr_source",
      sourceRevision: 1,
    },
    caller: sizing([new SizerError("sizing_provider", false)]),
  });
  await state.executor.execute("org_1", "brn_1");

  assert.equal(state.proposalInputs.length, 0);
  assert.equal((state.outcomes[0] as { code: string }).code, "sizing_failed");
});

test("a re-price of a ticket now too large to draft from carries no spec", async () => {
  // No draft is asked for, so the proposal store clears the pointer.
  const state = harness({
    candidates: [],
    specs: { "1": spec("1", { inputTruncated: true }) },
    runOverrides: {
      kind: "reprice",
      sourceProposalId: "bpr_source",
      sourceRevision: 1,
    },
  });
  await state.executor.execute("org_1", "brn_1");

  assert.equal(state.caller.calls.length, 0);
  assert.equal(state.proposalInputs.length, 1);
  assert.equal("spec" in (state.proposalInputs[0] as object), false);
});

test("a re-priced proposal keeps the reason its ticket was picked for", async () => {
  // A re-price moves the proposal onto the re-price run, and a proposal's
  // reasons are read from its run's plan. Without carrying them over,
  // "Re-analyze" would take the ticket out of its category.
  const categories = [
    {
      id: "holding-others-up",
      label: "Holding others up",
      reason: "Blocks 3 open tickets, unassigned",
    },
  ];
  const reprice = {
    kind: "reprice" as const,
    sourceProposalId: "bpr_source",
    sourceRevision: 1,
  };
  const state = harness({
    candidates: [],
    runOverrides: reprice,
    originPlanned: [
      { externalIssueId: "9", issueKey: "APP-9", summary: "Another" },
      { externalIssueId: "1", issueKey: "APP-1", summary: "Old", categories },
    ],
  });
  await state.executor.execute("org_1", "brn_1");

  assert.equal(state.finishes[0]?.status, "succeeded");
  assert.deepEqual(
    (state.plans[0] as { categories: unknown }[]).map(
      (planned) => planned.categories,
    ),
    [categories],
  );

  // The run it came from is gone, or never planned the ticket, or planned
  // it before categories existed: no reason to carry, and no failure.
  for (const originPlanned of [
    undefined,
    [],
    [{ externalIssueId: "1", issueKey: "APP-1", summary: "Old" }],
  ]) {
    const bare = harness({
      candidates: [],
      runOverrides: reprice,
      ...(originPlanned === undefined ? {} : { originPlanned }),
    });
    await bare.executor.execute("org_1", "brn_1");
    assert.equal(bare.finishes[0]?.status, "succeeded");
    assert.deepEqual(
      (bare.plans[0] as { categories: unknown }[])[0]?.categories,
      [],
    );
  }
});

test("XS model sizing uses the distinct XS snapshot price", async () => {
  const state = harness({
    runOverrides: { rateCard: { ...rateCard, xsMinor: 50 } },
    caller: sizing([
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

/** A `ticket` run: one of the organization's tickets, sized on its own. */
function ticketRun(ticketId: string) {
  return { kind: "ticket" as const, boardId: null, ticketId };
}

test("a ticket written here is sized with no Jira at all", async () => {
  const state = harness({
    tickets: [handWritten()],
    runOverrides: ticketRun("tkt_7"),
    // Jira could not be reached, and nothing asks it.
    clientResult: { ok: false, reason: "reconnect" },
  });
  await state.executor.execute("org_1", "brn_1");

  assert.equal(state.finishes[0]?.status, "succeeded");
  assert.deepEqual(state.plans, [
    [
      {
        externalIssueId: "tkt_7",
        issueKey: "T-7",
        summary: "Invitations are not sent",
        ticketId: "tkt_7",
        categories: [],
      },
    ],
  ]);
  assert.deepEqual(state.caller.calls[0], {
    tool: "draft_spec",
    input: {
      summary: "Invitations are not sent",
      descriptionText: "Scheduling an interview sends the candidate one email.",
      issueType: "Bug",
      components: [],
      labels: [],
    },
  });
  const written = state.proposalInputs[0] as {
    ticketId: string;
    specHash: string;
    specHashVersion: number;
  };
  assert.equal(written.ticketId, "tkt_7");
  // Fingerprinted from the ticket as stored, as a Jira ticket is from Jira.
  assert.equal(
    written.specHash,
    await ticketSpecHash(
      "Invitations are not sent",
      "Scheduling an interview sends the candidate one email.",
      "Bug",
    ),
  );
  assert.equal(written.specHashVersion, 1);
  assert.deepEqual(state.outcomes[0], {
    externalIssueId: "tkt_7",
    issueKey: "T-7",
    ticketId: "tkt_7",
    proposalId: "bpr_1",
    status: "proposed",
    actualModel: "actual-model",
    inputTokens: 110,
    outputTokens: 45,
  });
  assert.deepEqual(state.refreshed, []);
});

test("a ticket is drafted beside its own repository", async () => {
  const read: string[] = [];
  const drafted: unknown[] = [];
  const state = harness({
    tickets: [handWritten({ repoId: "ghr_9" })],
    runOverrides: ticketRun("tkt_7"),
    outlineFor: (_org, repoId) => {
      read.push(repoId);
      return Promise.resolve({ snapshotId: "rsn_9", text: "src/ (4 files)" });
    },
    onProposalDrafted: (_org, input) => void drafted.push(input),
  });
  await state.executor.execute("org_1", "brn_1");

  assert.deepEqual(read, ["ghr_9"]);
  const draft = state.caller.calls.find(({ tool }) => tool === "draft_spec");
  assert.equal(
    (draft?.input as { repositoryOutline?: string }).repositoryOutline,
    "src/ (4 files)",
  );
  assert.equal(
    (state.proposalInputs[0] as { repoSnapshotId: unknown }).repoSnapshotId,
    "rsn_9",
  );
  assert.deepEqual((drafted[0] as { ticket: unknown }).ticket, {
    issueType: "Bug",
    priority: null,
  });
});

test("a ticket's repository comes before its board's", async () => {
  const read: string[] = [];
  const state = harness({
    tickets: [ticket({ repoId: "ghr_own" })],
    runOverrides: ticketRun("tkt_1"),
    sourceRepoId: "ghr_board",
    outlineFor: (_org, repoId) => {
      read.push(repoId);
      return Promise.resolve(null);
    },
  });
  await state.executor.execute("org_1", "brn_1");
  assert.deepEqual(read, ["ghr_own"]);
});

test("a ticket following its Jira issue is read from Jira, and takes what it says", async () => {
  const fresh = spec("1", {
    summary: "Invitations go out twice",
    descriptionText: "Retries send a second email.",
    components: ["Mailer"],
  });
  const state = harness({
    tickets: [ticket()],
    runOverrides: ticketRun("tkt_1"),
    specs: { "1": fresh },
  });
  await state.executor.execute("org_1", "brn_1");

  assert.equal(state.finishes[0]?.status, "succeeded");
  assert.deepEqual(state.refreshed, [
    {
      ticketId: "tkt_1",
      content: {
        title: "Invitations go out twice",
        description: "Retries send a second email.",
        issueType: "Story",
        priority: "Medium",
        labels: [],
        components: ["Mailer"],
        inputTruncated: false,
      },
    },
  ]);
  assert.equal(
    (state.caller.calls[0]?.input as { summary: string }).summary,
    "Invitations go out twice",
  );
  // Planned under Jira's id, as a board's run plans it.
  assert.equal(
    (state.plans[0] as { externalIssueId: string }[])[0]?.externalIssueId,
    "1",
  );
});

test("a ticket whose Jira issue has gone keeps its text and is sized from it", async () => {
  const state = harness({
    tickets: [ticket()],
    runOverrides: ticketRun("tkt_1"),
    specs: { "1": new JiraApiError(404, "gone") },
  });
  await state.executor.execute("org_1", "brn_1");

  assert.deepEqual(state.removed, ["jri_1"]);
  assert.equal(state.finishes[0]?.status, "succeeded");
  assert.equal(
    (state.caller.calls[0]?.input as { descriptionText: string })
      .descriptionText,
    "Clear acceptance criteria.",
  );
});

test("a ticket already known to be gone from Jira is not read again", async () => {
  const gone = ticket({
    jira: { ...ticket().jira!, removedAt: "2026-09-30T00:00:00.000Z" },
  });
  const state = harness({
    tickets: [gone],
    runOverrides: ticketRun("tkt_1"),
    clientResult: { ok: false, reason: "reconnect" },
  });
  await state.executor.execute("org_1", "brn_1");
  assert.equal(state.finishes[0]?.status, "succeeded");
  assert.deepEqual(state.refreshed, []);
});

test("a ticket following Jira is not sized while its site needs reconnecting", async () => {
  const state = harness({
    tickets: [ticket()],
    runOverrides: ticketRun("tkt_1"),
    clientResult: { ok: false, reason: "reconnect" },
  });
  await state.executor.execute("org_1", "brn_1");
  assert.deepEqual(state.finishes, [
    { status: "failed", details: { fatalErrorCode: "reconnect" } },
  ]);
  assert.equal(state.caller.calls.length, 0);
});

test("Jira refusing a ticket's read stops the run; failing it fails the ticket", async () => {
  const refused = harness({
    tickets: [ticket()],
    runOverrides: ticketRun("tkt_1"),
    specs: { "1": new JiraApiError(401, "expired") },
  });
  await refused.executor.execute("org_1", "brn_1");
  assert.equal(
    (refused.finishes[0]?.details as { fatalErrorCode: string }).fatalErrorCode,
    "reconnect",
  );

  const broken = harness({
    tickets: [ticket()],
    runOverrides: ticketRun("tkt_1"),
    specs: { "1": new JiraApiError(500, "down") },
  });
  await broken.executor.execute("org_1", "brn_1");
  assert.deepEqual(broken.outcomes, [
    {
      externalIssueId: "1",
      issueKey: "APP-1",
      ticketId: "tkt_1",
      status: "failed",
      code: "jira_failed",
    },
  ]);
  assert.equal(broken.finishes[0]?.status, "failed");
});

test("a ticket split into sub-tasks since it was imported sizes nothing", async () => {
  const state = harness({
    tickets: [ticket()],
    runOverrides: ticketRun("tkt_1"),
    pickedSubtasks: 2,
  });
  await state.executor.execute("org_1", "brn_1");
  assert.deepEqual(state.finishes, [
    { status: "failed", details: { fatalErrorCode: "issue_has_subtasks" } },
  ]);
  assert.equal(state.caller.calls.length, 0);
  assert.equal(state.proposalInputs.length, 0);

  // A sub-task read that fails is left to the text's own read.
  const unread = harness({
    tickets: [ticket()],
    runOverrides: ticketRun("tkt_1"),
    issueError: new JiraApiError(500, "down"),
  });
  await unread.executor.execute("org_1", "brn_1");
  assert.equal(unread.finishes[0]?.status, "succeeded");
});

test("a copy of Jira's text that cannot be kept is not a Jira failure", async () => {
  const errors: string[] = [];
  const state = harness({
    tickets: [ticket()],
    runOverrides: ticketRun("tkt_1"),
    refreshError: new Error("database down"),
    onBackgroundError: (code) => void errors.push(code),
  });
  await state.executor.execute("org_1", "brn_1");
  assert.equal(state.finishes[0]?.status, "succeeded");
  assert.equal(state.proposalInputs.length, 1);
  assert.deepEqual(errors, ["bounty_ticket_refresh_failed"]);
});

test("a ticket that is gone ends its run", async () => {
  const state = harness({
    tickets: [],
    runOverrides: ticketRun("tkt_missing"),
  });
  await state.executor.execute("org_1", "brn_1");
  assert.deepEqual(state.finishes, [
    { status: "failed", details: { fatalErrorCode: "ticket_unavailable" } },
  ]);
  assert.deepEqual(state.plans, []);
});

test("a re-price of a ticket written here needs no Jira", async () => {
  const state = harness({
    tickets: [handWritten()],
    candidates: [],
    runOverrides: {
      kind: "reprice",
      boardId: null,
      ticketId: "tkt_7",
      sourceProposalId: "bpr_source",
      sourceRevision: 1,
    },
    clientResult: { ok: false, reason: "reconnect" },
  });
  await state.executor.execute("org_1", "brn_1");
  assert.equal(state.finishes[0]?.status, "succeeded");
  assert.equal(
    (state.outcomes[0] as { proposalId: string }).proposalId,
    "bpr_source",
  );
});

test("a board's issue is imported with what Jira says about it", async () => {
  const state = harness({
    specs: {
      "1": spec("1", { components: ["Reports"], labels: ["export"] }),
    },
  });
  await state.executor.execute("org_1", "brn_1");
  assert.deepEqual(state.imported, [
    {
      title: "Issue 1",
      description: "Clear acceptance criteria.",
      issueType: "Story",
      priority: "Medium",
      labels: ["export"],
      components: ["Reports"],
      inputTruncated: false,
    },
  ]);
  assert.equal(
    (state.proposalInputs[0] as { ticketId: string }).ticketId,
    "tkt_1",
  );
});

test("a board's issue Jira no longer has is marked and not sized", async () => {
  const state = harness({ specs: { "1": new JiraApiError(404, "gone") } });
  await state.executor.execute("org_1", "brn_1");
  assert.deepEqual(state.removed, ["1"]);
  assert.deepEqual(state.imported, []);
  assert.deepEqual(state.outcomes, [
    {
      externalIssueId: "1",
      issueKey: "APP-1",
      status: "failed",
      code: "issue_unavailable",
    },
  ]);
});

test("a board's run with no board fails before reading anything", async () => {
  const state = harness({ runOverrides: { boardId: null } });
  await state.executor.execute("org_1", "brn_1");
  assert.deepEqual(state.finishes, [
    { status: "failed", details: { fatalErrorCode: "board_unavailable" } },
  ]);
});

test("a board's issue Jira fails to read fails alone; one it refuses stops the run", async () => {
  const broken = harness({ specs: { "1": new JiraApiError(500, "down") } });
  await broken.executor.execute("org_1", "brn_1");
  assert.deepEqual(broken.outcomes, [
    {
      externalIssueId: "1",
      issueKey: "APP-1",
      status: "failed",
      code: "jira_failed",
    },
  ]);

  const refused = harness({ specs: { "1": new JiraApiError(403, "no") } });
  await refused.executor.execute("org_1", "brn_1");
  assert.deepEqual(refused.outcomes, []);
  assert.equal(
    (refused.finishes[0]?.details as { fatalErrorCode: string }).fatalErrorCode,
    "scope",
  );
});

test("a board's issue that could not be imported is not sized", async () => {
  const state = harness({ importFails: true });
  await state.executor.execute("org_1", "brn_1");
  assert.deepEqual(state.outcomes, [
    {
      externalIssueId: "1",
      issueKey: "APP-1",
      status: "failed",
      code: "issue_pointer",
    },
  ]);
  assert.deepEqual(state.proposalInputs, []);
});
