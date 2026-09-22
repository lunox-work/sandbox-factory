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

import type { Auth } from "../src/auth.js";
import type { BountyExecutor } from "../src/bounty/executor.js";
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
  requestId,
  status: "queued",
  selection: {
    maxTickets: 10,
    excludeAssigned: true,
    issueTypes: [],
    minAgeDays: 0,
    minSpecChars: 0,
  },
  rateCard: { ...card },
  requestedModel: "configured-model",
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
    createResult?: Awaited<ReturnType<BountyRunStore["create"]>>;
    sizing?: boolean;
  } = {},
) {
  const starts: string[] = [];
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
      return Promise.resolve({ ok: true as const, rateCard: card });
    },
  } as RateCardStore;
  const runs = {
    create: () =>
      Promise.resolve(
        options.createResult ?? { ok: true as const, run, created: true },
      ),
    listForBoard: () => Promise.resolve([run]),
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
  const app = createApp({
    corsOrigins: ["https://app.test"],
    auth: fakeAuth(),
    organizations: {
      roleOf: (_user: string, org: string) =>
        Promise.resolve(
          org === "org_1" ? (options.role ?? "owner") : undefined,
        ),
    } as never,
    bounty: {
      rateCards,
      runs,
      boards,
      proposals: {
        get: () => Promise.resolve(null),
        listForBoard: () => Promise.resolve([]),
      } as never,
      issues: { get: () => Promise.resolve(null) } as never,
      ...(sizing
        ? {
            executor: {
              start: (_org: string, id: string) => {
                starts.push(id);
              },
            } as unknown as BountyExecutor,
            clientFor: () => Promise.resolve({ ok: true, client: {} as never }),
            requestedModel: "configured-model",
            promptVersion: "jira-size-v1",
          }
        : {}),
      supportedCurrencies: new Set(["USD", "JPY"]),
    },
  });
  return { app, starts, puts };
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

  const missing = harness({ rateCard: null });
  assert.equal(
    (
      await missing.app.request("/api/v1/orgs/org_1/jira/boards/jrb_1/runs", {
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
    decidedAt: null,
    decidedBy: null,
    decisionDeliveryPolicy: null,
    createdAt: run.createdAt,
    updatedAt: run.createdAt,
    ...overrides,
  };
}

function reviewHarness(hash = "a".repeat(64)) {
  let current = reviewProposal();
  let specReads = 0;
  const proposals = {
    get: () => Promise.resolve(current),
    listForBoard: () => Promise.resolve([current]),
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
      complexity: "XS" | "S" | "M" | "L" | "XL",
      amountMinor: number,
    ) => {
      current = {
        ...current,
        complexity,
        amountMinor,
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

test("proposal reads enrich live freshness without returning list descriptions", async () => {
  const state = reviewHarness();
  const response = await state.app.request(
    "/api/v1/orgs/org_1/proposals?boardId=jrb_1&status=proposed",
    { headers },
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    proposals: Array<{
      freshness: string;
      liveTitle: string;
      descriptionText?: string;
    }>;
  };
  assert.equal(body.proposals[0]?.freshness, "current");
  assert.equal(body.proposals[0]?.liveTitle, "Live");
  assert.equal(body.proposals[0]?.descriptionText, undefined);
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
    history?: unknown;
  };
  assert.equal(body.proposal.id, "bpr_1");
  // One proposal per ticket now: there is no history to return.
  assert.equal(body.history, undefined);

  const wrongBoard = await state.app.request(
    "/api/v1/orgs/org_1/proposals/bpr_1?boardId=jrb_other",
    { headers },
  );
  assert.equal(wrongBoard.status, 404);
});

test("approval and resize recheck Jira while unapprove and remove do not", async () => {
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
  assert.equal(resize.specReads(), 1);

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
