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
import { DEFAULT_RATE_CARD } from "sandbox-factory";

import type { Auth } from "../src/auth.js";
import type { BountyExecutor } from "../src/bounty/executor.js";
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
  assert.deepEqual(input?.planned, [
    { externalIssueId: "7", issueKey: "APP-7", summary: "Add login" },
  ]);
  // Read through the board, so a ticket from elsewhere cannot be sized here.
  assert.deepEqual(state.jql, ["issue = 7"]);
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
