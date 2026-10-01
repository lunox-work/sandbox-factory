import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  BountyRunStore,
  JiraBoardStore,
  RateCardStore,
  StoredBountyRun,
  StoredBountyProposal,
  StoredRateCard,
} from "@sandbox-factory/db";

import { JiraApiError } from "@sandbox-factory/jira";
import type { JiraIssueDto } from "@sandbox-factory/shared";
import { DEFAULT_RATE_CARD, stepUp, type SpecDraft } from "sandbox-factory";

import type { Auth } from "../src/auth.js";
import type {
  BountyExecutor,
  RunClientResult,
} from "../src/bounty/executor.js";
import {
  sizeIfNeverSized,
  ticketSearchJql,
  type BountyRouteOptions,
} from "../src/bounty/routes.js";
import { createApp } from "../src/routes.js";

const requestId = "28bb313f-252a-4a1d-b656-558a215b604b";
const headers = { cookie: "session=1", "content-type": "application/json" };

const card: StoredRateCard = {
  organizationId: "org_1",
  currency: "USD",
  xsMinor: 100,
  sMinor: 100,
  mMinor: 200,
  lMinor: 300,
  xlMinor: 400,
  revision: 1,
  updatedAt: "2026-09-22T00:00:00.000Z",
};

const run: StoredBountyRun = {
  id: "brn_1",
  organizationId: "org_1",
  boardId: "jrb_1",
  kind: "backlog",
  sourceProposalId: null,
  sourceRevision: null,
  respec: null,
  requestId,
  status: "queued",
  selection: {
    unassignedOnly: false,
    issueTypes: [],
    minAgeDays: 0,
    minSpecChars: 0,
    categories: {},
  },
  rateCard: { ...card },
  requestedModel: "configured-model",
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
};

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

function harness(
  options: {
    role?: string;
    rateCard?: StoredRateCard | null;
    putResult?: Awaited<ReturnType<RateCardStore["put"]>>;
    createResult?: Awaited<ReturnType<BountyRunStore["create"]>>;
    previousRuns?: StoredBountyRun[];
    /** What the board's issue read answers, or throws. */
    boardIssues?: JiraIssueDto[] | Error;
    live?: Record<string, string>;
    clientReady?: boolean;
    sizing?: boolean;
  } = {},
) {
  const starts: string[] = [];
  const created: unknown[] = [];
  const jql: string[] = [];
  const client = {
    boardIssues: (_board: number, query: { jql: string }) => {
      jql.push(query.jql);
      const answer = options.boardIssues ?? [];
      return answer instanceof Error
        ? Promise.reject(answer)
        : Promise.resolve({ issues: answer, total: answer.length });
    },
  };
  const puts: unknown[] = [];
  const rateCards = {
    get: () =>
      Promise.resolve(options.rateCard === undefined ? card : options.rateCard),
    put: (
      _org: string,
      _user: string,
      values: unknown,
      expectedRevision: number,
    ) => {
      puts.push({ values, expectedRevision });
      return Promise.resolve(
        options.putResult ?? { ok: true as const, rateCard: card },
      );
    },
  } as RateCardStore;
  const runs = {
    create: (_org: string, input: unknown) => {
      created.push(input);
      return Promise.resolve(
        options.createResult ?? { ok: true as const, run, created: true },
      );
    },
    listForBoard: () => Promise.resolve(options.previousRuns ?? [run]),
    get: (_org: string, id: string) =>
      Promise.resolve(id === run.id ? run : null),
  } as unknown as BountyRunStore;
  const board = {
    id: "jrb_1",
    connectionId: "jrc_1",
    externalId: "42",
    name: "Board",
    boardType: "scrum",
    projectKey: "APP",
    selection: run.selection,
    createdAt: run.createdAt,
  };
  const boards = {
    get: (_org: string, id: string) =>
      Promise.resolve(id === board.id ? board : null),
    forRun: (_org: string, id: string) =>
      Promise.resolve(
        id === board.id
          ? {
              board,
              connectionId: board.connectionId,
              cloudId: "cloud_1",
              siteUrl: "https://example.atlassian.net",
            }
          : null,
      ),
  } as unknown as JiraBoardStore;
  const sizing = options.sizing ?? true;
  const bounty: BountyRouteOptions = {
    rateCards,
    runs,
    boards,
    proposals: {
      get: () => Promise.resolve(null),
      listForBoard: () => Promise.resolve([]),
      liveProposalIds: () =>
        Promise.resolve(new Map(Object.entries(options.live ?? {}))),
    } as never,
    specs: {} as never,
    issues: { get: () => Promise.resolve(null) } as never,
    ...(sizing
      ? {
          executor: {
            start: (_org: string, id: string) => {
              starts.push(id);
            },
          } as unknown as BountyExecutor,
          clientFor: () =>
            Promise.resolve(
              options.clientReady === false
                ? { ok: false as const, reason: "reconnect" as const }
                : { ok: true as const, client: client as never },
            ),
          requestedModel: "configured-model",
          promptVersion: "jira-size-v1",
        }
      : {}),
    supportedCurrencies: new Set(["USD", "JPY"]),
  };
  const app = createApp({
    corsOrigins: ["https://app.test"],
    auth: fakeAuth(),
    organizations: {
      roleOf: (_user: string, org: string) =>
        Promise.resolve(
          org === "org_1" ? (options.role ?? "owner") : undefined,
        ),
    } as never,
    bounty,
  });
  return { app, bounty, starts, puts, created, jql };
}

test("members may read a rate card but only admins may edit it", async () => {
  const member = harness({ role: "member" });
  const read = await member.app.request("/api/v1/orgs/org_1/rate-card", {
    headers,
  });
  assert.equal(read.status, 200);
  assert.deepEqual(await read.json(), { rateCard: card });

  const denied = await member.app.request("/api/v1/orgs/org_1/rate-card", {
    method: "PUT",
    headers,
    body: JSON.stringify({ ...card, expectedRevision: 1 }),
  });
  assert.equal(denied.status, 403);
  assert.equal(member.puts.length, 0);
});

test("rate-card writes validate currency and save by expected revision", async () => {
  const state = harness();
  const bad = await state.app.request("/api/v1/orgs/org_1/rate-card", {
    method: "PUT",
    headers,
    body: JSON.stringify({ ...card, currency: "ZZZ", expectedRevision: 1 }),
  });
  assert.equal(bad.status, 400);
  const overLimit = await state.app.request("/api/v1/orgs/org_1/rate-card", {
    method: "PUT",
    headers,
    body: JSON.stringify({
      ...card,
      currency: "USD",
      xlMinor: 100001,
      expectedRevision: 1,
    }),
  });
  assert.equal(overLimit.status, 400);
  assert.equal(state.puts.length, 0);

  const saved = await state.app.request("/api/v1/orgs/org_1/rate-card", {
    method: "PUT",
    headers,
    body: JSON.stringify({ ...card, expectedRevision: 1 }),
  });
  assert.equal(saved.status, 200);
  assert.equal(state.puts.length, 1);
});

test("run creation requires sizing and a rate card, then starts after create", async () => {
  const unavailable = harness({ sizing: false });
  assert.equal(
    (
      await unavailable.app.request(
        "/api/v1/orgs/org_1/jira/boards/jrb_1/runs",
        { method: "POST", headers, body: JSON.stringify({ requestId }) },
      )
    ).status,
    503,
  );

  // A card nobody could save, because the row vanished between the read and
  // the write, is still refused rather than priced with nothing.
  const gone = harness({
    rateCard: null,
    putResult: { ok: false, current: null },
  });
  assert.equal(
    (
      await gone.app.request("/api/v1/orgs/org_1/jira/boards/jrb_1/runs", {
        method: "POST",
        headers,
        body: JSON.stringify({ requestId }),
      })
    ).status,
    409,
  );

  const ready = harness();
  const response = await ready.app.request(
    "/api/v1/orgs/org_1/jira/boards/jrb_1/runs",
    { method: "POST", headers, body: JSON.stringify({ requestId }) },
  );
  assert.equal(response.status, 202);
  assert.deepEqual(ready.starts, ["brn_1"]);
});

test("a first run saves the default rate card rather than refusing", async () => {
  // The editor shows the default to an organization that never saved one,
  // so that is the card it has. Sizing a new Jira site must not stop at
  // settings first.
  const state = harness({ rateCard: null });
  const response = await state.app.request(
    "/api/v1/orgs/org_1/jira/boards/jrb_1/runs",
    { method: "POST", headers, body: JSON.stringify({ requestId }) },
  );
  assert.equal(response.status, 202);
  assert.deepEqual(state.puts, [
    { values: DEFAULT_RATE_CARD, expectedRevision: 0 },
  ]);
  assert.deepEqual(state.starts, ["brn_1"]);
});

test("a default save that loses the race prices with the winner's card", async () => {
  const state = harness({
    rateCard: null,
    putResult: { ok: false, current: card },
  });
  const response = await state.app.request(
    "/api/v1/orgs/org_1/jira/boards/jrb_1/runs",
    { method: "POST", headers, body: JSON.stringify({ requestId }) },
  );
  assert.equal(response.status, 202);
});

test("a board is sized automatically once, and never again", async () => {
  const fresh = harness({ previousRuns: [] });
  const started = await sizeIfNeverSized(fresh.bounty, {
    organizationId: "org_1",
    boardId: "jrb_1",
    startedBy: "user_1",
  });
  assert.equal(started?.ok, true);
  assert.deepEqual(fresh.starts, ["brn_1"]);

  // Any earlier run counts, whatever it ended as: after the first, sizing
  // is something a person asks for.
  const sized = harness({ previousRuns: [{ ...run, status: "failed" }] });
  assert.equal(
    await sizeIfNeverSized(sized.bounty, {
      organizationId: "org_1",
      boardId: "jrb_1",
      startedBy: "user_1",
    }),
    null,
  );
  assert.deepEqual(sized.starts, []);
});

test("run reads are owner-scoped and report sizing capability", async () => {
  const state = harness();
  const list = await state.app.request(
    "/api/v1/orgs/org_1/jira/boards/jrb_1/runs",
    { headers },
  );
  assert.equal(list.status, 200);
  assert.equal(
    ((await list.json()) as { sizingAvailable: boolean }).sizingAvailable,
    true,
  );

  assert.equal(
    (
      await state.app.request("/api/v1/orgs/org_1/runs/brn_missing", {
        headers,
      })
    ).status,
    404,
  );
  assert.equal(
    (await state.app.request("/api/v1/orgs/org_2/runs/brn_1", { headers }))
      .status,
    404,
  );
});

function reviewProposal(
  overrides: Partial<StoredBountyProposal> = {},
): StoredBountyProposal {
  return {
    id: "bpr_1",
    organizationId: "org_1",
    runId: "brn_1",
    jiraIssueId: "jri_1",
    issueKey: "APP-1",
    specHash: "a".repeat(64),
    specHashVersion: 1,
    rateCard: run.rateCard,
    modelComplexity: "M",
    modelConfidence: "high",
    modelRationale: "A few files.",
    unsizedReason: null,
    inputTruncated: false,
    actualModel: "model",
    promptVersion: "jira-size-v1",
    complexity: "M",
    sizedBy: "model",
    resizedBy: null,
    resizedAt: null,
    amountMinor: 200,
    currency: "USD",
    status: "proposed",
    revision: 1,
    specRevision: null,
    step: null,
    decidedAt: null,
    decidedBy: null,
    decisionDeliveryPolicy: null,
    createdAt: run.createdAt,
    updatedAt: run.createdAt,
    ...overrides,
  };
}

function reviewHarness(
  hash = "a".repeat(64),
  overrides: Partial<StoredBountyProposal> = {},
) {
  let current = reviewProposal(overrides);
  let specReads = 0;
  const proposals = {
    get: () => Promise.resolve(current),
    listForBoard: () =>
      Promise.resolve([{ ...current, sizedTitle: "Title when sized" }]),
    approve: () => {
      current = { ...current, status: "approved", revision: 2 };
      return Promise.resolve({ ok: true, proposal: current });
    },
    withdraw: () => {
      current = { ...current, status: "proposed", revision: 2 };
      return Promise.resolve({ ok: true, proposal: current });
    },
    remove: () => {
      const removed = current;
      return Promise.resolve({ ok: true, proposal: removed });
    },
    resize: (
      _o: string,
      _p: string,
      _r: number,
      _u: string,
      complexity: StoredBountyProposal["complexity"],
      amountMinor: number,
      _currency: string,
      step: StoredBountyProposal["step"] = null,
    ) => {
      current = {
        ...current,
        complexity,
        amountMinor,
        step,
        sizedBy: "reviewer",
        revision: 2,
      };
      return Promise.resolve({ ok: true, proposal: current });
    },
  } as unknown as import("@sandbox-factory/db").BountyProposalStore;
  const board = { id: "jrb_1", connectionId: "jrc_1" };
  const app = createApp({
    corsOrigins: ["https://app.test"],
    auth: fakeAuth(),
    organizations: { roleOf: () => Promise.resolve("owner") } as never,
    bounty: {
      rateCards: { get: () => Promise.resolve(card) } as never,
      runs: {} as never,
      proposals,
      specs: {} as never,
      issues: {
        get: () =>
          Promise.resolve({ id: "jri_1", boardId: "jrb_1", externalId: "100" }),
      } as never,
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
        Promise.resolve({
          ok: true,
          client: {
            issueSpec: () => {
              specReads += 1;
              return Promise.resolve({
                key: "APP-1",
                summary: "Live",
                descriptionText: "Current spec",
                issueType: "Story",
                inputTruncated: false,
                pricingSpecHash: hash,
              });
            },
          } as never,
        }),
    },
  });
  return { app, current: () => current, specReads: () => specReads };
}

test("the proposal list is stored rows alone and never waits on Jira", async () => {
  const state = reviewHarness();
  const response = await state.app.request(
    "/api/v1/orgs/org_1/proposals?boardId=jrb_1&status=proposed",
    { headers },
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    proposals: Array<Record<string, unknown>>;
  };
  // Everything a row prices from is stored...
  assert.equal(body.proposals[0]?.id, "bpr_1");
  assert.equal(body.proposals[0]?.complexity, "M");
  assert.equal(body.proposals[0]?.amountMinor, 200);
  // ...down to the title the ticket had when it was sized...
  assert.equal(body.proposals[0]?.sizedTitle, "Title when sized");
  // ...and nothing live is waited for: the title streams in separately, and
  // freshness belongs to the open proposal's detail.
  assert.equal(body.proposals[0]?.liveTitle, undefined);
  assert.equal(body.proposals[0]?.freshness, undefined);
  assert.equal(body.proposals[0]?.descriptionText, undefined);
  assert.equal(state.specReads(), 0);
});

/* A proposal's spec: the revision its size goes with, and its history. */

const storedSpec = {
  id: "bsp_2",
  organizationId: "org_1",
  proposalId: "bpr_1",
  revision: 2,
  specHash: "a".repeat(64),
  specHashVersion: 1,
  draft: {
    feature: "CSV export",
    background: [],
    scenarios: [
      {
        id: "s1",
        kind: "happy" as const,
        title: "The filtered table is exported",
        steps: [{ keyword: "Then" as const, text: "a CSV file is downloaded" }],
        origin: "draft" as const,
      },
    ],
    openQuestions: ["Is there a row limit?"],
    assumptions: [],
  },
  origin: "draft" as const,
  instruction: null,
  createdBy: null,
  runId: "brn_1",
  actualModel: "drafting-model",
  promptVersion: "draft-v1",
  createdAt: "2026-09-30T00:00:00.000Z",
};

/** A proposal pointing at `specRevision`, over a spec store that records. */
function specHarness(
  options: {
    specRevision?: number | null;
    role?: string;
    found?: boolean;
  } = {},
) {
  const reads: unknown[][] = [];
  const proposal = reviewProposal({
    specRevision: options.specRevision === undefined ? 2 : options.specRevision,
  });
  const app = createApp({
    corsOrigins: ["https://app.test"],
    auth: fakeAuth(),
    organizations: {
      roleOf: () => Promise.resolve(options.role ?? "member"),
    } as never,
    bounty: {
      rateCards: {} as never,
      runs: {} as never,
      boards: {} as never,
      issues: {} as never,
      proposals: {
        get: (organizationId: string, id: string) =>
          Promise.resolve(
            organizationId === "org_1" && id === "bpr_1" ? proposal : null,
          ),
      } as never,
      specs: {
        get: (...args: unknown[]) => {
          reads.push(args);
          return Promise.resolve(
            options.found === false
              ? null
              : { ...storedSpec, revision: args[2] as number },
          );
        },
        listRevisions: (...args: unknown[]) => {
          reads.push(args);
          return Promise.resolve([
            {
              revision: 2,
              origin: "draft" as const,
              scenarioCount: 1,
              openQuestionCount: 1,
              createdBy: null,
              createdAt: "2026-09-30T01:00:00.000Z",
            },
            {
              revision: 1,
              origin: "draft" as const,
              scenarioCount: 4,
              openQuestionCount: 0,
              createdBy: null,
              createdAt: "2026-09-30T00:00:00.000Z",
            },
          ]);
        },
      } as never,
    },
  });
  return { app, reads };
}

const specPath = "/api/v1/orgs/org_1/proposals/bpr_1/spec";

test("the spec read answers with the revision the proposal points at", async () => {
  // Any member may read it, as any member may read the proposal.
  const state = specHarness();
  const response = await state.app.request(specPath, { headers });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { spec: storedSpec });
  // Owner first, then the proposal, then the revision it points at.
  assert.deepEqual(state.reads, [["org_1", "bpr_1", 2]]);
});

test("a proposal with no spec answers null without asking the store", async () => {
  // One sized before specs existed, or from a ticket nothing was drafted
  // from: an answer, not a miss.
  const state = specHarness({ specRevision: null });
  const response = await state.app.request(specPath, { headers });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { spec: null });
  assert.deepEqual(state.reads, []);
});

test("a pointer to a revision that is not there still answers null", async () => {
  const state = specHarness({ found: false });
  const response = await state.app.request(specPath, { headers });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { spec: null });
});

test("an earlier revision is read by number, and a missing one is a 404", async () => {
  const state = specHarness();
  const earlier = await state.app.request(`${specPath}?revision=1`, {
    headers,
  });
  assert.equal(earlier.status, 200);
  assert.equal(
    ((await earlier.json()) as { spec: { revision: number } }).spec.revision,
    1,
  );
  assert.deepEqual(state.reads, [["org_1", "bpr_1", 1]]);

  // Readable by number even when the proposal points at none.
  const unpointed = specHarness({ specRevision: null });
  assert.equal(
    (await unpointed.app.request(`${specPath}?revision=1`, { headers })).status,
    200,
  );

  const missing = specHarness({ found: false });
  assert.equal(
    (await missing.app.request(`${specPath}?revision=9`, { headers })).status,
    404,
  );
});

test("a revision that is not a positive whole number is refused", async () => {
  const state = specHarness();
  for (const revision of ["0", "-1", "1.5", "abc", "1e3", "9999999999"]) {
    const response = await state.app.request(
      `${specPath}?revision=${revision}`,
      { headers },
    );
    assert.equal(response.status, 400, revision);
  }
  assert.deepEqual(state.reads, []);
  // An empty value is no value: the pointer is used.
  assert.equal(
    (await state.app.request(`${specPath}?revision=`, { headers })).status,
    200,
  );
});

test("a spec's revisions are listed newest first, marking the current one", async () => {
  const state = specHarness();
  const response = await state.app.request(`${specPath}/revisions`, {
    headers,
  });

  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    revisions: { revision: number; current: boolean; scenarioCount: number }[];
  };
  assert.deepEqual(
    body.revisions.map(({ revision, current, scenarioCount }) => ({
      revision,
      current,
      scenarioCount,
    })),
    [
      { revision: 2, current: true, scenarioCount: 1 },
      { revision: 1, current: false, scenarioCount: 4 },
    ],
  );
  assert.deepEqual(state.reads, [["org_1", "bpr_1"]]);

  // With no pointer, no revision is the current one.
  const unpointed = specHarness({ specRevision: null });
  const listed = (await (
    await unpointed.app.request(`${specPath}/revisions`, { headers })
  ).json()) as { revisions: { current: boolean }[] };
  assert.ok(listed.revisions.every(({ current }) => !current));
});

test("another proposal's spec is a 404, and the store is never asked", async () => {
  const state = specHarness();
  for (const path of [
    "/api/v1/orgs/org_1/proposals/bpr_other/spec",
    "/api/v1/orgs/org_1/proposals/bpr_other/spec/revisions",
  ]) {
    assert.equal((await state.app.request(path, { headers })).status, 404);
  }
  assert.deepEqual(state.reads, []);
});

/* The category view above the list: counts, and the list by category. */

/** A harness whose proposal store records what the routes ask of it. */
function categoryHarness(
  counts: {
    total: number;
    uncategorized?: number;
    counts: Record<string, number>;
  },
  role = "owner",
) {
  const state = harness({ role });
  const listed: unknown[] = [];
  Object.assign(state.bounty.proposals, {
    categoryCounts: () => Promise.resolve({ uncategorized: 0, ...counts }),
    listForBoard: (_org: string, _board: string, options: unknown) => {
      listed.push(options);
      return Promise.resolve([]);
    },
  });
  return { ...state, listed };
}

const categoriesPath =
  "/api/v1/orgs/org_1/jira/boards/jrb_1/proposal-categories";

test("a board's proposals are counted into the six categories, in order", async () => {
  const state = categoryHarness({
    total: 12,
    uncategorized: 2,
    counts: {
      "paper-cuts": 4,
      "left-behind": 7,
      // Stored with a run before the category was retired: not one of the
      // six any more, so it is not offered as a view.
      "a-retired-category": 3,
    },
  });
  const response = await state.app.request(categoriesPath, { headers });

  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    total: number;
    uncategorized: number;
    categories: { id: string; label: string; why: string; count: number }[];
  };
  assert.equal(body.total, 12);
  // The ones in no category are counted beside the six, not among them.
  assert.equal(body.uncategorized, 2);
  // Registry order, every category present, zeros included.
  assert.deepEqual(
    body.categories.map(({ id, count }) => [id, count]),
    [
      ["left-behind", 7],
      ["always-next-sprint", 0],
      ["quietly-wanted", 0],
      ["holding-others-up", 0],
      ["paper-cuts", 4],
      ["deadline-exposed", 0],
    ],
  );
  // The page names no category itself: label and why-text come with it.
  assert.equal(body.categories[0]?.label, "Left behind");
  assert.match(body.categories[0]?.why ?? "", /roadmap/);
});

test("stored counts cannot smuggle in a key the registry does not have", async () => {
  const counts = JSON.parse(
    '{"__proto__": 9, "constructor": 9, "left-behind": 1}',
  ) as Record<string, number>;
  const state = categoryHarness({ total: 1, counts });
  const body = (await (
    await state.app.request(categoriesPath, { headers })
  ).json()) as { categories: { id: string; count: number }[] };

  assert.deepEqual(
    body.categories.filter(({ count }) => count > 0),
    [
      {
        id: "left-behind",
        label: "Left behind",
        why: "The team has shown it won't reach this, so outsourcing takes nothing off the roadmap.",
        count: 1,
      },
    ],
  );
});

test("any member may read the categories, and another board is a 404", async () => {
  const member = categoryHarness({ total: 0, counts: {} }, "member");
  assert.equal(
    (await member.app.request(categoriesPath, { headers })).status,
    200,
  );
  assert.equal(
    (
      await member.app.request(
        "/api/v1/orgs/org_1/jira/boards/jrb_other/proposal-categories",
        { headers },
      )
    ).status,
    404,
  );
});

test("the list can be narrowed to one category", async () => {
  const state = categoryHarness({ total: 0, counts: {} });
  const list = (query: string) =>
    state.app.request(`/api/v1/orgs/org_1/proposals?boardId=jrb_1${query}`, {
      headers,
    });

  assert.equal((await list("&category=paper-cuts&limit=50")).status, 200);
  assert.deepEqual(state.listed.at(-1), { limit: 50, category: "paper-cuts" });

  // No category, or an empty one, is the whole board.
  await list("");
  assert.deepEqual(state.listed.at(-1), { limit: 25 });
  await list("&category=");
  assert.deepEqual(state.listed.at(-1), { limit: 25 });

  // An id no category has is a category with nothing in it, not an error:
  // that is what a retired one looks like to a link that still names it.
  assert.equal((await list("&category=retired-last-month")).status, 200);
  assert.deepEqual(state.listed.at(-1), {
    limit: 25,
    category: "retired-last-month",
  });
});

test("the list can be narrowed to the tickets in no category", async () => {
  const state = categoryHarness({ total: 0, counts: {} });
  const response = await state.app.request(
    "/api/v1/orgs/org_1/proposals?boardId=jrb_1&category=uncategorized&limit=50",
    { headers },
  );

  assert.equal(response.status, 200);
  // Asked of the store as its own question, not as a category by that name:
  // no plan ever records one.
  assert.deepEqual(state.listed.at(-1), { limit: 50, uncategorized: true });
});

test("a malformed category is refused before the store is asked", async () => {
  const state = categoryHarness({ total: 0, counts: {} });
  for (const category of [
    "Paper Cuts",
    "paper_cuts",
    "-paper",
    "paper--cuts",
    `x"}] or true --`,
    "a".repeat(65),
  ]) {
    const response = await state.app.request(
      `/api/v1/orgs/org_1/proposals?boardId=jrb_1&category=${encodeURIComponent(category)}`,
      { headers },
    );
    assert.equal(response.status, 400, category);
  }
  assert.deepEqual(state.listed, []);
});

test("proposal detail returns the proposal and validates its board deep link", async () => {
  const state = reviewHarness();
  const response = await state.app.request(
    "/api/v1/orgs/org_1/proposals/bpr_1?boardId=jrb_1",
    { headers },
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    proposal: StoredBountyProposal;
    freshness: { freshness: string; liveTitle: string };
    history?: unknown;
  };
  assert.equal(body.proposal.id, "bpr_1");
  assert.equal(body.freshness.freshness, "current");
  assert.equal(body.freshness.liveTitle, "Live");
  // One proposal per ticket now: there is no history to return.
  assert.equal(body.history, undefined);

  const wrongBoard = await state.app.request(
    "/api/v1/orgs/org_1/proposals/bpr_1?boardId=jrb_other",
    { headers },
  );
  assert.equal(wrongBoard.status, 404);
});

test("approval rechecks Jira; resize, unapprove and remove do not", async () => {
  const approve = reviewHarness();
  const approved = await approve.app.request(
    "/api/v1/orgs/org_1/proposals/bpr_1/approve",
    { method: "POST", headers, body: JSON.stringify({ expectedRevision: 1 }) },
  );
  assert.equal(approved.status, 200);
  assert.equal(approve.specReads(), 1);

  const resize = reviewHarness();
  const resized = await resize.app.request(
    "/api/v1/orgs/org_1/proposals/bpr_1/resize",
    {
      method: "POST",
      headers,
      body: JSON.stringify({ expectedRevision: 1, complexity: "L" }),
    },
  );
  assert.equal(resized.status, 200);
  assert.equal(resize.current().amountMinor, 300);
  assert.equal(resize.specReads(), 0);

  const unapprove = reviewHarness();
  const unapproved = await unapprove.app.request(
    "/api/v1/orgs/org_1/proposals/bpr_1/unapprove",
    { method: "POST", headers, body: JSON.stringify({ expectedRevision: 1 }) },
  );
  assert.equal(unapproved.status, 200);
  assert.equal(unapprove.current().status, "proposed");
  assert.equal(unapprove.specReads(), 0);

  const remove = reviewHarness();
  const removed = await remove.app.request(
    "/api/v1/orgs/org_1/proposals/bpr_1/remove",
    { method: "POST", headers, body: JSON.stringify({ expectedRevision: 1 }) },
  );
  assert.equal(removed.status, 200);
  assert.equal(remove.specReads(), 0);

  // The retired route is gone rather than aliased.
  const rejected = await reviewHarness().app.request(
    "/api/v1/orgs/org_1/proposals/bpr_1/reject",
    { method: "POST", headers, body: JSON.stringify({ expectedRevision: 1 }) },
  );
  assert.equal(rejected.status, 404);
});

test("a Jira spec change blocks approval with a stable stale code", async () => {
  const state = reviewHarness("b".repeat(64));
  const response = await state.app.request(
    "/api/v1/orgs/org_1/proposals/bpr_1/approve",
    { method: "POST", headers, body: JSON.stringify({ expectedRevision: 1 }) },
  );
  assert.equal(response.status, 409);
  assert.equal(
    ((await response.json()) as { code: string }).code,
    "proposal_stale",
  );
  assert.equal(state.current().status, "proposed");
});

test("reviewers can resize a proposal to XS using its snapshot", async () => {
  const state = reviewHarness();
  const response = await state.app.request(
    "/api/v1/orgs/org_1/proposals/bpr_1/resize",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 1, complexity: "XS" }),
    },
  );
  assert.equal(response.status, 200);
  assert.equal(state.current().complexity, "XS");
  assert.equal(state.current().amountMinor, card.xsMinor);
});

test("a resize sets the base and the step stays on top", async () => {
  // A spec that grew a heavy scenario after it was sized at M.
  const sized: SpecDraft = {
    feature: "Export",
    background: [],
    scenarios: [
      {
        id: "s1",
        kind: "happy",
        title: "Exported",
        steps: [{ keyword: "Then", text: "a file is downloaded" }],
        origin: "draft",
        weight: "moderate",
      },
    ],
    openQuestions: [],
    assumptions: [],
  };
  const grown: SpecDraft = {
    ...sized,
    scenarios: [
      ...sized.scenarios,
      {
        id: "s2",
        kind: "recovery",
        title: "Retried",
        steps: [{ keyword: "Then", text: "the export runs again" }],
        origin: "expansion",
        weight: "heavy",
      },
    ],
  };
  const step = stepUp("M", sized, grown);
  assert.ok(step !== null);
  const state = reviewHarness(undefined, {
    complexity: "M+",
    amountMinor: 250,
    step,
  });
  const response = await state.app.request(
    "/api/v1/orgs/org_1/proposals/bpr_1/resize",
    {
      method: "POST",
      headers,
      body: JSON.stringify({ expectedRevision: 1, complexity: "S" }),
    },
  );
  assert.equal(response.status, 200);
  // The reviewer said S; the heavy scenario still counts, so S+, priced
  // between S and M on the proposal's own card.
  assert.equal(state.current().complexity, "S+");
  assert.equal(state.current().amountMinor, 150);
  assert.equal(state.current().step?.base, "S");
  assert.equal(state.current().step?.addedPoints, 4);
});

test("a resize refuses a half size: those are only where a step lands", async () => {
  const state = reviewHarness();
  const response = await state.app.request(
    "/api/v1/orgs/org_1/proposals/bpr_1/resize",
    {
      method: "POST",
      headers,
      body: JSON.stringify({ expectedRevision: 1, complexity: "S+" }),
    },
  );
  assert.equal(response.status, 400);
  assert.equal(state.current().complexity, "M");
});

function ticket(id: string, summary = `Ticket ${id}`): JiraIssueDto {
  return {
    id,
    key: `APP-${id}`,
    summary,
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
  };
}

test("ticket search looks a key up as a key and anything else as text", () => {
  assert.equal(ticketSearchJql(" app-12 "), 'key = "APP-12"');
  assert.equal(ticketSearchJql("add login"), 'text ~ "add login*"');
  // JQL's reserved characters would make Jira refuse the query outright.
  assert.equal(ticketSearchJql('fix "auth" (v2)*'), 'text ~ "fix auth v2*"');
  assert.equal(ticketSearchJql("  "), null);
  assert.equal(ticketSearchJql("*?"), null);
});

test("searching a board leaves out tickets already on the platform", async () => {
  const state = harness({
    role: "member",
    boardIssues: [ticket("7"), ticket("8"), ticket("9")],
    live: { "8": "bpr_8" },
  });
  const response = await state.app.request(
    "/api/v1/orgs/org_1/jira/boards/jrb_1/search?q=login",
    { headers },
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as { issues: { key: string }[] };
  assert.deepEqual(
    body.issues.map(({ key }) => key),
    ["APP-7", "APP-9"],
  );
  assert.deepEqual(state.jql, ['text ~ "login*"']);
});

test("a search still fills its list when many candidates are proposed", async () => {
  // Jira is asked for more than are shown, so the ones dropped for being
  // proposed are replaced rather than leaving the list short.
  const candidates = Array.from({ length: 30 }, (_, n) => ticket(String(n)));
  const live = Object.fromEntries(
    candidates.slice(0, 15).map(({ id }) => [id, `bpr_${id}`]),
  );
  const state = harness({ boardIssues: candidates, live });
  const body = (await (
    await state.app.request(
      "/api/v1/orgs/org_1/jira/boards/jrb_1/search?q=login",
      { headers },
    )
  ).json()) as { issues: { id: string }[] };
  assert.equal(body.issues.length, 10);
  assert.equal(body.issues[0]?.id, "15");
});

test("an empty search asks Jira nothing", async () => {
  const state = harness();
  const response = await state.app.request(
    "/api/v1/orgs/org_1/jira/boards/jrb_1/search?q=",
    { headers },
  );
  assert.deepEqual(await response.json(), { issues: [] });
  assert.deepEqual(state.jql, []);
});

test("search failures are told apart", async () => {
  const search = (state: ReturnType<typeof harness>, board = "jrb_1") =>
    state.app.request(
      `/api/v1/orgs/org_1/jira/boards/${board}/search?q=APP-9`,
      {
        headers,
      },
    );

  // A key that does not exist is Jira's 400, and simply no results.
  const missingKey = await search(
    harness({ boardIssues: new JiraApiError(400, "no such issue") }),
  );
  assert.deepEqual(await missingKey.json(), { issues: [] });

  assert.equal(
    (await search(harness({ boardIssues: new JiraApiError(401, "expired") })))
      .status,
    409,
  );
  assert.equal(
    (await search(harness({ boardIssues: new JiraApiError(500, "down") })))
      .status,
    502,
  );
  assert.equal((await search(harness({ clientReady: false }))).status, 409);
  assert.equal((await search(harness({ sizing: false }))).status, 503);
  assert.equal((await search(harness(), "jrb_other")).status, 404);
});

test("adding a ticket starts a one-ticket run for it", async () => {
  const state = harness({ boardIssues: [ticket("7", "Add login")] });
  const response = await state.app.request(
    "/api/v1/orgs/org_1/jira/boards/jrb_1/issues",
    {
      method: "POST",
      headers,
      body: JSON.stringify({ requestId, issueId: "7" }),
    },
  );
  assert.equal(response.status, 202);
  assert.deepEqual(state.starts, ["brn_1"]);
  const [input] = state.created as { kind: string; planned: unknown }[];
  assert.equal(input?.kind, "issue");
  // A person picked it, so no category is given as the reason.
  assert.deepEqual(input?.planned, [
    {
      externalIssueId: "7",
      issueKey: "APP-7",
      summary: "Add login",
      categories: [],
    },
  ]);
  // Read through the board, so a ticket from elsewhere cannot be sized here.
  assert.deepEqual(state.jql, ["issue = 7"]);
});

test("a ticket split into sub-tasks is listed but cannot be added", async () => {
  const parent = { ...ticket("7", "Rework billing"), subtaskCount: 3 };
  const search = harness({ boardIssues: [parent, ticket("8")] });
  const listed = (await (
    await search.app.request(
      "/api/v1/orgs/org_1/jira/boards/jrb_1/search?q=billing",
      { headers },
    )
  ).json()) as { issues: { key: string; subtaskCount: number }[] };
  // Found, so a person learns why it is not offered, with its count.
  assert.deepEqual(
    listed.issues.map(({ key, subtaskCount }) => [key, subtaskCount]),
    [
      ["APP-7", 3],
      ["APP-8", 0],
    ],
  );

  const add = harness({ boardIssues: [parent] });
  const response = await add.app.request(
    "/api/v1/orgs/org_1/jira/boards/jrb_1/issues",
    {
      method: "POST",
      headers,
      body: JSON.stringify({ requestId, issueId: "7" }),
    },
  );
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    code: "has_subtasks",
    error: "APP-7 is split into sub-tasks. Size its sub-tasks instead.",
  });
  assert.deepEqual(add.starts, []);
  assert.deepEqual(add.created, []);
});

test("adding a ticket that already has a proposal opens that one instead", async () => {
  const state = harness({
    boardIssues: [ticket("7")],
    live: { "7": "bpr_7" },
  });
  const response = await state.app.request(
    "/api/v1/orgs/org_1/jira/boards/jrb_1/issues",
    {
      method: "POST",
      headers,
      body: JSON.stringify({ requestId, issueId: "7" }),
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { proposalId: "bpr_7" });
  assert.deepEqual(state.starts, []);
});

test("adding a ticket is refused when it cannot be sized", async () => {
  const add = (state: ReturnType<typeof harness>, body: unknown) =>
    state.app.request("/api/v1/orgs/org_1/jira/boards/jrb_1/issues", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  const valid = { requestId, issueId: "7" };

  assert.equal((await add(harness({ role: "member" }), valid)).status, 403);
  assert.equal(
    (await add(harness(), { requestId, issueId: "APP-7" })).status,
    400,
  );
  // Not on this board.
  assert.equal((await add(harness(), valid)).status, 404);
  assert.equal(
    (
      await add(
        harness({ boardIssues: new JiraApiError(400, "no such issue") }),
        valid,
      )
    ).status,
    404,
  );
  assert.equal(
    (await add(harness({ boardIssues: new JiraApiError(500, "down") }), valid))
      .status,
    502,
  );
  assert.equal((await add(harness({ sizing: false }), valid)).status, 503);
  assert.equal((await add(harness({ clientReady: false }), valid)).status, 409);
  assert.equal(
    (
      await add(
        harness({
          boardIssues: [ticket("7")],
          createResult: { ok: false, reason: "request-conflict" },
        }),
        valid,
      )
    ).status,
    409,
  );
});

/*
  The titles stream. Eight proposals on the board, bpr_1..bpr_8, each on a
  ticket whose external id is its number times a hundred.
*/
const titlesPath = "/api/v1/orgs/org_1/jira/boards/jrb_1/proposal-titles";

function titlesHarness(
  options: {
    issue?: (externalId: string) => Promise<JiraIssueDto>;
    ready?: RunClientResult;
    jira?: false;
  } = {},
) {
  const reads: string[] = [];
  const removed: string[] = [];
  let clients = 0;
  const targets = new Map(
    [1, 2, 3, 4, 5, 6, 7, 8].map((n) => [
      `bpr_${n}`,
      { jiraIssueId: `jri_${n}`, externalId: `${n}00` },
    ]),
  );
  const issue =
    options.issue ??
    ((externalId: string) =>
      Promise.resolve(ticket(externalId, `Title ${externalId}`)));
  const board = { id: "jrb_1", connectionId: "jrc_1" };
  const app = createApp({
    corsOrigins: ["https://app.test"],
    auth: fakeAuth(),
    organizations: { roleOf: () => Promise.resolve("member") } as never,
    bounty: {
      rateCards: {} as never,
      runs: {} as never,
      specs: {} as never,
      proposals: {
        issuesForProposals: (
          _organizationId: string,
          _boardId: string,
          ids: readonly string[],
        ) =>
          Promise.resolve(
            new Map([...targets].filter(([id]) => ids.includes(id))),
          ),
      } as never,
      issues: {
        markRemoved: (_organizationId: string, issueId: string) => {
          removed.push(issueId);
          return Promise.resolve(true);
        },
      } as never,
      boards: {
        get: (_organizationId: string, boardId: string) =>
          Promise.resolve(boardId === "jrb_1" ? board : null),
      } as never,
      ...(options.jira === false
        ? {}
        : {
            clientFor: () => {
              clients += 1;
              return Promise.resolve(
                options.ready ?? {
                  ok: true as const,
                  client: {
                    issue: (externalId: string) => {
                      reads.push(externalId);
                      return issue(externalId);
                    },
                  } as never,
                },
              );
            },
          }),
    },
  });
  return { app, reads, removed, clients: () => clients };
}

async function titleLines(response: Response) {
  return (await response.text())
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("titles stream a line per proposal, in the order Jira answers", async () => {
  // The first ticket is held until the second has answered, so a response
  // that waited for every read would list them in the order asked.
  let releaseFirst = () => {};
  const firstHeld = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const state = titlesHarness({
    issue: async (externalId) => {
      if (externalId === "100") await firstHeld;
      else releaseFirst();
      return ticket(externalId, `Title ${externalId}`);
    },
  });
  const response = await state.app.request(`${titlesPath}?ids=bpr_1,bpr_2`, {
    headers,
  });
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^application\/x-ndjson/,
  );
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await titleLines(response), [
    { id: "bpr_2", key: "APP-200", title: "Title 200" },
    { id: "bpr_1", key: "APP-100", title: "Title 100" },
  ]);
  // One client for the board, not one per row.
  assert.equal(state.clients(), 1);
});

test("titles answer not_found for proposals not on the board, unread", async () => {
  const state = titlesHarness();
  const mixed = await state.app.request(`${titlesPath}?ids=bpr_1,bpr_x,bpr_1`, {
    headers,
  });
  // Asked twice, answered once.
  assert.deepEqual(
    (await titleLines(mixed)).sort((a, b) =>
      String(a.id).localeCompare(String(b.id)),
    ),
    [
      { id: "bpr_1", key: "APP-100", title: "Title 100" },
      { id: "bpr_x", code: "not_found" },
    ],
  );
  assert.deepEqual(state.reads, ["100"]);

  // Nothing on the board at all: no client is even built.
  const none = await state.app.request(`${titlesPath}?ids=bpr_x`, {
    headers,
  });
  assert.deepEqual(await titleLines(none), [
    { id: "bpr_x", code: "not_found" },
  ]);
  assert.equal(state.clients(), 1);
});

test("a title Jira cannot give says why, and a deleted ticket is marked", async () => {
  const failures: Record<string, Error> = {
    "100": new JiraApiError(404, "gone"),
    "200": new JiraApiError(403, "forbidden"),
    "300": new JiraApiError(401, "unauthorized"),
    "400": new Error("socket hang up"),
  };
  const state = titlesHarness({
    issue: (externalId) =>
      Promise.reject(failures[externalId] ?? new Error("unexpected")),
  });
  const response = await state.app.request(
    `${titlesPath}?ids=bpr_1,bpr_2,bpr_3,bpr_4`,
    { headers },
  );
  const byId = Object.fromEntries(
    (await titleLines(response)).map((line) => [line.id, line.code]),
  );
  assert.deepEqual(byId, {
    bpr_1: "missing",
    bpr_2: "scope",
    bpr_3: "reconnect",
    bpr_4: "unavailable",
  });
  assert.deepEqual(state.removed, ["jri_1"]);
});

test("an unusable connection answers every row without reading Jira", async () => {
  for (const [options, code] of [
    [{ ready: { ok: false, reason: "reconnect" } }, "reconnect"],
    [{ ready: { ok: false, reason: "not-found" } }, "unavailable"],
    [{ jira: false }, "reconnect"],
  ] as const) {
    const state = titlesHarness(options);
    const response = await state.app.request(`${titlesPath}?ids=bpr_1,bpr_2`, {
      headers,
    });
    assert.deepEqual(
      (await titleLines(response)).map((line) => line.code),
      [code, code],
    );
    assert.deepEqual(state.reads, []);
  }
});

test("titles refuse no ids, too many ids and another board", async () => {
  const state = titlesHarness();
  for (const query of ["", "?ids=", "?ids=,,"]) {
    assert.equal(
      (await state.app.request(`${titlesPath}${query}`, { headers })).status,
      400,
    );
  }
  const tooMany = Array.from({ length: 51 }, (_, n) => `bpr_${n}`).join(",");
  assert.equal(
    (await state.app.request(`${titlesPath}?ids=${tooMany}`, { headers }))
      .status,
    400,
  );
  assert.equal(
    (
      await state.app.request(
        "/api/v1/orgs/org_1/jira/boards/jrb_other/proposal-titles?ids=bpr_1",
        { headers },
      )
    ).status,
    404,
  );
  assert.equal(state.clients(), 0);
});

test("a cancelled titles stream starts no further Jira reads", async () => {
  const held: Array<() => void> = [];
  const state = titlesHarness({
    issue: (externalId) =>
      new Promise((resolve) => {
        held.push(() => resolve(ticket(externalId)));
      }),
  });
  const response = await state.app.request(
    `${titlesPath}?ids=bpr_1,bpr_2,bpr_3,bpr_4,bpr_5,bpr_6,bpr_7,bpr_8`,
    { headers },
  );
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  // Five reads start at once; the other three wait for a free slot.
  for (let tries = 0; state.reads.length < 5 && tries < 50; tries += 1) {
    await settle();
  }
  assert.equal(state.reads.length, 5);

  // The browser goes away while all five are still out.
  await response.body?.cancel();
  for (const release of held) release();
  for (let tries = 0; tries < 10; tries += 1) await settle();
  assert.equal(state.reads.length, 5);
});
