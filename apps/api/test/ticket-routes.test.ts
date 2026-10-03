import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  ListedTicket,
  StoredBountyProposal,
  StoredBountyRun,
  StoredTicket,
  TicketChange,
  TicketMutationResult,
} from "@sandbox-factory/db";
import { Hono } from "hono";
import { ticketSpecHash } from "sandbox-factory";

import type { BountyExecutor } from "../src/bounty/executor.js";
import {
  mountBountyRoutes,
  type BountyRouteOptions,
} from "../src/bounty/routes.js";
import type { AuthVariables } from "../src/routes.js";
import { mountTicketRoutes } from "../src/tickets/routes.js";

const stamp = "2026-10-03T00:00:00.000Z";
const requestId = "8f0b4a1e-9a77-4c35-9a52-3f0f5b2d3c11";

function written(overrides: Partial<StoredTicket> = {}): StoredTicket {
  return {
    id: "tkt_7",
    organizationId: "org_1",
    number: 7,
    key: "T-7",
    title: "Invitations are not sent",
    description: "Scheduling an interview sends the candidate one email.",
    issueType: "Bug",
    priority: null,
    labels: ["email"],
    components: [],
    inputTruncated: false,
    origin: "manual",
    repoId: null,
    createdBy: "user_1",
    revision: 1,
    jira: null,
    createdAt: stamp,
    updatedAt: stamp,
    ...overrides,
  };
}

function imported(overrides: Partial<StoredTicket> = {}): StoredTicket {
  return written({
    id: "tkt_1",
    number: 1,
    key: "APP-1",
    origin: "jira",
    jira: {
      issueId: "jri_1",
      boardId: "jrb_1",
      connectionId: "jrc_1",
      externalId: "100",
      key: "APP-1",
      siteUrl: "https://acme.atlassian.net",
      removedAt: null,
    },
    ...overrides,
  });
}

function proposalOf(
  ticket: StoredTicket,
  overrides: Partial<StoredBountyProposal> = {},
): StoredBountyProposal {
  return {
    id: "bpr_1",
    organizationId: "org_1",
    runId: "brn_1",
    ticketId: ticket.id,
    issueKey: ticket.key,
    title: ticket.title,
    specHash: "a".repeat(64),
    specHashVersion: 1,
    rateCard: {
      currency: "USD",
      xsMinor: 100,
      sMinor: 100,
      mMinor: 200,
      lMinor: 300,
      xlMinor: 400,
      revision: 1,
    },
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
    repoSnapshotId: null,
    decidedAt: null,
    decidedBy: null,
    decisionDeliveryPolicy: null,
    createdAt: stamp,
    updatedAt: stamp,
    ...overrides,
  };
}

function runOf(input: Record<string, unknown>): StoredBountyRun {
  return {
    id: "brn_new",
    organizationId: "org_1",
    boardId: (input["boardId"] as string | null) ?? null,
    ticketId: (input["ticketId"] as string | null) ?? null,
    kind: input["kind"] as StoredBountyRun["kind"],
    sourceProposalId: null,
    sourceRevision: null,
    respec: null,
    requestId,
    status: "queued",
    selection: input["selection"] as StoredBountyRun["selection"],
    rateCard: input["rateCard"] as StoredBountyRun["rateCard"],
    requestedModel: "model",
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
    createdAt: stamp,
  };
}

const card = {
  organizationId: "org_1",
  currency: "USD",
  xsMinor: 100,
  sMinor: 100,
  mMinor: 200,
  lMinor: 300,
  xlMinor: 400,
  revision: 1,
  updatedAt: stamp,
};

function harness(
  options: {
    role?: string;
    tickets?: StoredTicket[];
    live?: Record<string, StoredBountyProposal>;
    listed?: ListedTicket[];
    create?:
      | { ok: true; ticket: StoredTicket }
      | { ok: false; reason: "repo-not-found" };
    update?: TicketMutationResult;
    remove?: "removed" | "not-found" | "in-use";
    runCreate?: Record<string, unknown>;
    sizing?: boolean;
    jira?: boolean;
    approved?: unknown[];
  } = {},
) {
  const held = new Map((options.tickets ?? []).map((t) => [t.id, t]));
  const calls: { method: string; args: unknown[] }[] = [];
  const created: Record<string, unknown>[] = [];
  const starts: string[] = [];
  const record =
    (method: string, answer: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return Promise.resolve(answer(...args));
    };
  const tickets = {
    get: record("get", (_org, id) => held.get(id as string) ?? null),
    list: record("list", () => options.listed ?? []),
    create: record(
      "create",
      () => options.create ?? { ok: true, ticket: written() },
    ),
    update: record(
      "update",
      (_org, _id, _revision, change) =>
        options.update ?? {
          ok: true,
          ticket: written({
            ...(change as TicketChange),
            revision: 2,
          } as never),
        },
    ),
    remove: record("remove", () => options.remove ?? "removed"),
    refreshFromJira: record("refreshFromJira", () => false),
  };
  const proposals = {
    get: (_org: string, id: string) =>
      Promise.resolve(
        Object.values(options.live ?? {}).find((p) => p.id === id) ?? null,
      ),
    liveForTicket: (_org: string, ticketId: string) =>
      Promise.resolve(options.live?.[ticketId]?.id ?? null),
    list: record("proposals.list", () => []),
    approve: record("approve", (...args) => {
      options.approved?.push(args);
      return { ok: true, proposal: { id: "bpr_1", status: "approved" } };
    }),
  };
  const bounty: BountyRouteOptions = {
    rateCards: { get: () => Promise.resolve(card) } as never,
    runs: {
      create: (_org: string, input: Record<string, unknown>) => {
        created.push(input);
        return Promise.resolve(
          options.runCreate ?? { ok: true, created: true, run: runOf(input) },
        );
      },
    } as never,
    boards: {
      get: (_org: string, id: string) =>
        Promise.resolve(
          id === "jrb_1"
            ? { id: "jrb_1", selection: { minSpecChars: 30 }, pricing: {} }
            : null,
        ),
      forRun: () =>
        Promise.resolve({
          board: { id: "jrb_1" },
          connectionId: "jrc_1",
          siteUrl: "https://acme.atlassian.net",
        }),
    } as never,
    proposals: proposals as never,
    specs: {} as never,
    issues: { markRemoved: () => Promise.resolve(true) } as never,
    tickets: tickets as never,
    ...((options.sizing ?? true)
      ? {
          executor: {
            start: (_org: string, id: string) => void starts.push(id),
          } as unknown as BountyExecutor,
          requestedModel: "model",
          promptVersion: "jira-size-v1",
        }
      : {}),
    ...((options.jira ?? true)
      ? {
          clientFor: () =>
            Promise.resolve({
              ok: false as const,
              reason: "reconnect" as const,
            }),
        }
      : {}),
  };
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("user", { id: "user_1" } as never);
    c.set("member", {
      organizationId: "org_1",
      role: options.role ?? "owner",
    });
    await next();
  });
  mountBountyRoutes(app, bounty);
  mountTicketRoutes(app, bounty);
  const request = (method: string, path: string, body?: unknown) =>
    app.request(`/api/v1/orgs/org_1/${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined
        ? {}
        : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
  return { request, calls, created, starts };
}

function listedOf(ticket: StoredTicket): ListedTicket {
  const {
    description: _d,
    components: _c,
    inputTruncated: _i,
    createdBy: _b,
    ...rest
  } = ticket;
  return { ...rest, proposal: null };
}

test("any member lists the organization's tickets, a page at a time", async () => {
  const page = Array.from({ length: 2 }, (_, i) =>
    listedOf(written({ id: `tkt_${i}`, number: i + 1, key: `T-${i + 1}` })),
  );
  const state = harness({ role: "member", listed: page });
  const response = await state.request("GET", "tickets?limit=2");
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    tickets: { key: string; jira: unknown }[];
    nextCursor: string | null;
  };
  assert.deepEqual(
    body.tickets.map(({ key }) => key),
    ["T-1", "T-2"],
  );
  assert.equal(body.nextCursor, `${stamp}|tkt_1`);

  const next = await state.request(
    "GET",
    `tickets?cursor=${encodeURIComponent(`${stamp}|tkt_1`)}`,
  );
  assert.equal(next.status, 200);
  assert.deepEqual(state.calls.at(-1)?.args[1], {
    limit: 25,
    cursor: { createdAt: stamp, id: "tkt_1" },
  });
  assert.equal(
    ((await next.json()) as { nextCursor: unknown }).nextCursor,
    null,
  );
  assert.equal((await state.request("GET", "tickets?cursor=nope")).status, 400);
  assert.equal(
    (await state.request("GET", "tickets?cursor=x|tkt_1")).status,
    400,
  );
});

test("a listed Jira ticket links to its issue", async () => {
  const state = harness({ listed: [listedOf(imported())] });
  const body = (await (await state.request("GET", "tickets")).json()) as {
    tickets: { jira: { url: string } }[];
  };
  assert.equal(
    body.tickets[0]?.jira.url,
    "https://acme.atlassian.net/browse/APP-1",
  );
});

test("any member writes a ticket; only its title is needed", async () => {
  const state = harness({ role: "member" });
  const response = await state.request("POST", "tickets", {
    title: "Invitations are not sent",
  });
  assert.equal(response.status, 201);
  const body = (await response.json()) as {
    ticket: { key: string; origin: string; proposal: unknown };
  };
  assert.equal(body.ticket.key, "T-7");
  assert.equal(body.ticket.origin, "manual");
  assert.equal(body.ticket.proposal, null);
  assert.deepEqual(state.calls[0]?.args, [
    "org_1",
    "user_1",
    {
      title: "Invitations are not sent",
      description: "",
      issueType: "Task",
      priority: null,
      labels: [],
      repoId: null,
    },
  ]);
});

test("a ticket that cannot be stored is refused with why", async () => {
  const state = harness({
    create: { ok: false, reason: "repo-not-found" },
  });
  const invalid = await state.request("POST", "tickets", { title: "" });
  assert.equal(invalid.status, 400);
  assert.equal(
    ((await invalid.json()) as { code: string }).code,
    "invalid_ticket",
  );
  assert.equal(
    (await state.request("POST", "tickets", "not json")).status,
    400,
  );
  const foreignRepo = await state.request("POST", "tickets", {
    title: "t",
    repoId: "ghr_other",
  });
  assert.equal(foreignRepo.status, 404);
  assert.equal(
    ((await foreignRepo.json()) as { code: string }).code,
    "repo_not_found",
  );
});

test("a ticket reads with its live proposal, or 404", async () => {
  const ticket = written();
  const state = harness({
    tickets: [ticket],
    live: { tkt_7: proposalOf(ticket, { status: "approved" }) },
  });
  const response = await state.request("GET", "tickets/tkt_7");
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    ticket: { description: string; proposal: { id: string; status: string } };
  };
  assert.equal(body.ticket.description, ticket.description);
  assert.deepEqual(body.ticket.proposal, {
    id: "bpr_1",
    status: "approved",
    complexity: "M",
    amountMinor: 200,
    currency: "USD",
  });
  assert.equal((await state.request("GET", "tickets/tkt_x")).status, 404);
});

test("a change is saved against the revision the editor saw", async () => {
  const state = harness({ role: "member", tickets: [written()] });
  const response = await state.request("PATCH", "tickets/tkt_7", {
    expectedRevision: 1,
    title: "Invitations go out twice",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(state.calls[0]?.args, [
    "org_1",
    "tkt_7",
    1,
    { title: "Invitations go out twice" },
  ]);
  assert.equal(
    (await state.request("PATCH", "tickets/tkt_7", { expectedRevision: 1 }))
      .status,
    400,
  );
});

test("a refused change says why", async () => {
  const cases: [TicketMutationResult, number, string | undefined][] = [
    [{ ok: false, reason: "not-found" }, 404, undefined],
    [{ ok: false, reason: "repo-not-found" }, 404, "repo_not_found"],
    [{ ok: false, reason: "jira-owned" }, 409, "jira_owned"],
    [
      { ok: false, reason: "changed", current: written({ revision: 3 }) },
      409,
      "ticket_changed",
    ],
    [{ ok: false, reason: "changed" }, 409, "ticket_changed"],
  ];
  for (const [update, status, code] of cases) {
    const state = harness({ update });
    const response = await state.request("PATCH", "tickets/tkt_7", {
      expectedRevision: 1,
      title: "t",
    });
    assert.equal(response.status, status, String(code));
    const body = (await response.json()) as {
      code?: string;
      ticket?: { revision: number };
    };
    assert.equal(body.code, code);
    if (update.ok === false && update.current !== undefined) {
      assert.equal(body.ticket?.revision, 3);
    }
  }
});

test("only an owner or admin deletes a ticket, and only an unused one", async () => {
  assert.equal(
    (await harness({ role: "member" }).request("DELETE", "tickets/tkt_7"))
      .status,
    403,
  );
  assert.equal(
    (await harness().request("DELETE", "tickets/tkt_7")).status,
    204,
  );
  assert.equal(
    (await harness({ remove: "not-found" }).request("DELETE", "tickets/tkt_7"))
      .status,
    404,
  );
  const inUse = await harness({ remove: "in-use" }).request(
    "DELETE",
    "tickets/tkt_7",
  );
  assert.equal(inUse.status, 409);
  assert.equal(
    ((await inUse.json()) as { code: string }).code,
    "ticket_in_use",
  );
});

test("proposing a ticket written here starts a ticket run, with no board", async () => {
  const state = harness({ tickets: [written()] });
  const response = await state.request("POST", "tickets/tkt_7/propose", {
    requestId,
  });
  assert.equal(response.status, 202);
  assert.deepEqual(state.starts, ["brn_new"]);
  const input = state.created[0] as Record<string, unknown>;
  assert.equal(input["kind"], "ticket");
  assert.equal(input["boardId"], null);
  assert.equal(input["ticketId"], "tkt_7");
  assert.deepEqual(input["planned"], [
    {
      externalIssueId: "tkt_7",
      issueKey: "T-7",
      summary: "Invitations are not sent",
      ticketId: "tkt_7",
      categories: [],
    },
  ]);
  // The defaults, for a ticket no board's settings cover.
  assert.equal(
    (input["selection"] as { minSpecChars: number }).minSpecChars,
    0,
  );
});

test("proposing a Jira ticket sizes it with its board's settings", async () => {
  const state = harness({ tickets: [imported()] });
  const response = await state.request("POST", "tickets/tkt_1/propose", {
    requestId,
  });
  assert.equal(response.status, 202);
  const input = state.created[0] as Record<string, unknown>;
  assert.equal(input["boardId"], "jrb_1");
  assert.equal(
    (input["planned"] as { externalIssueId: string }[])[0]?.externalIssueId,
    "100",
  );
  assert.equal(
    (input["selection"] as { minSpecChars: number }).minSpecChars,
    30,
  );
});

test("a ticket with a live proposal gets that proposal, not a run", async () => {
  const ticket = written();
  const state = harness({
    tickets: [ticket],
    live: { tkt_7: proposalOf(ticket) },
  });
  const response = await state.request("POST", "tickets/tkt_7/propose", {
    requestId,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { proposalId: "bpr_1" });
  assert.deepEqual(state.created, []);
});

test("proposing is refused when it could not start", async () => {
  const cases: [Parameters<typeof harness>[0], number, string | undefined][] = [
    [{ role: "member", tickets: [written()] }, 403, undefined],
    [{ tickets: [] }, 404, undefined],
    [{ sizing: false, tickets: [written()] }, 503, "sizing_unavailable"],
    // A Jira ticket with no Jira configured cannot be read to size.
    [{ jira: false, tickets: [imported({ id: "tkt_7" })] }, 409, "reconnect"],
    [
      {
        tickets: [written()],
        runCreate: { ok: false, reason: "active", runId: "brn_9" },
      },
      409,
      "run_active",
    ],
    [
      {
        tickets: [written()],
        runCreate: { ok: false, reason: "request-conflict" },
      },
      409,
      "request_conflict",
    ],
    [
      { tickets: [written()], runCreate: { ok: false, reason: "not-found" } },
      404,
      undefined,
    ],
  ];
  for (const [options, status, code] of cases) {
    const response = await harness(options).request(
      "POST",
      "tickets/tkt_7/propose",
      { requestId },
    );
    assert.equal(response.status, status, String(code));
    assert.equal(((await response.json()) as { code?: string }).code, code);
  }
  assert.equal(
    (
      await harness({ tickets: [written()] }).request(
        "POST",
        "tickets/tkt_7/propose",
        { requestId: "x" },
      )
    ).status,
    400,
  );
});

test("a ticket written here proposes again once Jira is not configured at all", async () => {
  // Nothing here needs Jira: the deployment has none.
  const state = harness({ jira: false, tickets: [written()] });
  const response = await state.request("POST", "tickets/tkt_7/propose", {
    requestId,
  });
  assert.equal(response.status, 202);
});

test("the organization's proposals list from every source, and count by category", async () => {
  const state = harness();
  assert.equal((await state.request("GET", "proposals")).status, 200);
  assert.deepEqual(state.calls.at(-1)?.args, ["org_1", { limit: 25 }]);
  assert.equal(
    (await state.request("GET", "proposals?boardId=jrb_missing")).status,
    404,
  );
});

test("a ticket written here is reviewed and approved with no Jira", async () => {
  const ticket = written();
  const priced = await ticketSpecHash(
    ticket.title,
    ticket.description,
    ticket.issueType,
  );
  const proposal = proposalOf(ticket, { specHash: priced });
  const approved: unknown[] = [];
  const state = harness({
    jira: false,
    tickets: [ticket],
    live: { tkt_7: proposal },
    approved,
  });
  const detail = await state.request("GET", "proposals/bpr_1");
  assert.equal(detail.status, 200);
  const body = (await detail.json()) as {
    freshness: { freshness: string; liveUrl?: string };
    liveSpec: { url: null; key: string };
  };
  assert.equal(body.freshness.freshness, "current");
  assert.equal(body.freshness.liveUrl, undefined);
  assert.equal(body.liveSpec.key, "T-7");
  // Not on a board, so not on this one.
  assert.equal(
    (await state.request("GET", "proposals/bpr_1?boardId=jrb_1")).status,
    404,
  );

  const response = await state.request("POST", "proposals/bpr_1/approve", {
    expectedRevision: 1,
  });
  assert.equal(response.status, 200);
  // Recorded here only: there is no Jira issue to post it to.
  assert.equal((approved[0] as unknown[])[4], "off");
});

test("a ticket written here is re-priced with no board", async () => {
  const ticket = written();
  const state = harness({
    tickets: [ticket],
    live: { tkt_7: proposalOf(ticket) },
  });
  const response = await state.request("POST", "proposals/bpr_1/reprice", {
    expectedRevision: 1,
    requestId,
  });
  assert.equal(response.status, 202);
  const input = state.created[0] as Record<string, unknown>;
  assert.equal(input["kind"], "reprice");
  assert.equal(input["boardId"], null);
  assert.equal(input["ticketId"], "tkt_7");
});
