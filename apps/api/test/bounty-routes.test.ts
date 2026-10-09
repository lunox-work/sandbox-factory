import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  StoredBountyVersion,
  ListedBounty,
  StoredBountyProposal,
  StoredBountyRun,
  StoredBounty,
  BountyChange,
  BountyMutationResult,
} from "@sandbox-factory/db";
import { Hono } from "hono";
import { bountySpecHash } from "sandbox-factory";

import type { BountyExecutor } from "../src/pricing/executor.js";
import {
  mountPricingRoutes,
  type PricingRouteOptions,
} from "../src/pricing/routes.js";
import type { AuthVariables } from "../src/routes.js";
import {
  mountBountyRoutes,
  mountCallerBountyRoutes,
} from "../src/bounties/routes.js";

const stamp = "2026-10-03T00:00:00.000Z";
const NONE = { jira: null, github: null };
const requestId = "8f0b4a1e-9a77-4c35-9a52-3f0f5b2d3c11";

function written(overrides: Partial<StoredBounty> = {}): StoredBounty {
  return {
    id: "bty_7",
    organizationId: "org_1",
    title: "Invitations are not sent",
    description: "Scheduling an interview sends the candidate one email.",
    components: [],
    inputTruncated: false,
    origin: "manual",
    stack: [],
    categories: [],
    createdBy: "user_1",
    revision: 1,
    version: 1,
    approval: null,
    jira: null,
    sandbox: null,
    createdAt: stamp,
    updatedAt: stamp,
    ...overrides,
  };
}

function imported(overrides: Partial<StoredBounty> = {}): StoredBounty {
  return written({
    id: "bty_1",
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
  bounty: StoredBounty,
  overrides: Partial<StoredBountyProposal> = {},
): StoredBountyProposal {
  return {
    id: "bpr_1",
    organizationId: "org_1",
    runId: "brn_1",
    bountyId: bounty.id,
    issueKey: bounty.jira?.key ?? null,
    title: bounty.title,
    specHash: "a".repeat(64),
    specHashVersion: 2,
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
    version: 0,
    versionedAt: null,
    specRevision: null,
    step: null,
    rubric: null,
    repositories: [],
    contextVersions: { jira: null, github: null },
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
    bountyId: (input["bountyId"] as string | null) ?? null,
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
    progress: null,
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
    bounties?: StoredBounty[];
    live?: Record<string, StoredBountyProposal>;
    listed?: ListedBounty[];
    create?: StoredBounty;
    update?: BountyMutationResult;
    /** What approving or unapproving the scope answers. */
    decide?: BountyMutationResult;
    /** Each bounty's scope versions; absent, its text as version 1. */
    versions?: Record<string, StoredBountyVersion[]>;
    remove?: "removed" | "not-found" | "in-use";
    runCreate?: Record<string, unknown>;
    activeRun?: StoredBountyRun;
    sizing?: boolean;
    jira?: boolean;
    /** Whether the Jira site answers; absent, it needs reconnecting. */
    siteReady?: boolean;
    approved?: unknown[];
  } = {},
) {
  const held = new Map((options.bounties ?? []).map((t) => [t.id, t]));
  const calls: { method: string; args: unknown[] }[] = [];
  const created: Record<string, unknown>[] = [];
  const starts: string[] = [];
  const record =
    (method: string, answer: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return Promise.resolve(answer(...args));
    };
  const bounties = {
    get: record("get", (_org, id) => held.get(id as string) ?? null),
    list: record("list", () => options.listed ?? []),
    create: record("create", () => options.create ?? written()),
    update: record(
      "update",
      (_org, _id, _revision, change) =>
        options.update ?? {
          ok: true,
          bounty: written({
            ...(change as BountyChange),
            revision: 2,
          } as never),
        },
    ),
    approve: record(
      "approve-scope",
      (_org, id, revision, by) =>
        options.decide ?? {
          ok: true,
          bounty: written({
            id: id as string,
            revision: (revision as number) + 1,
            approval: {
              version: 1,
              approvedBy: by as string,
              approvedAt: stamp,
            },
          }),
        },
    ),
    unapprove: record(
      "unapprove-scope",
      (_org, id, revision) =>
        options.decide ?? {
          ok: true,
          bounty: written({
            id: id as string,
            revision: (revision as number) + 1,
          }),
        },
    ),
    remove: record("remove", () => options.remove ?? "removed"),
    refreshFromJira: record("refreshFromJira", () => false),
    // Read beside every read of a proposed bounty, so not recorded.
    versions: (_org: string, id: string) => {
      const bounty = held.get(id);
      return Promise.resolve(
        options.versions?.[id] ??
          (bounty === undefined
            ? null
            : [
                {
                  version: bounty.version,
                  title: bounty.title,
                  description: bounty.description,
                  createdBy: bounty.createdBy,
                  createdAt: bounty.createdAt,
                },
              ]),
      );
    },
  };
  const proposals = {
    get: (_org: string, id: string) =>
      Promise.resolve(
        Object.values(options.live ?? {}).find((p) => p.id === id) ?? null,
      ),
    liveForBounty: (_org: string, bountyId: string) =>
      Promise.resolve(options.live?.[bountyId]?.id ?? null),
    list: record("proposals.list", () => []),
    approve: record("approve", (...args) => {
      options.approved?.push(args);
      return { ok: true, proposal: { id: "bpr_1", status: "approved" } };
    }),
  };
  const pricing: PricingRouteOptions = {
    rateCards: { get: () => Promise.resolve(card) } as never,
    runs: {
      create: (_org: string, input: Record<string, unknown>) => {
        created.push(input);
        return Promise.resolve(
          options.runCreate ?? { ok: true, created: true, run: runOf(input) },
        );
      },
      activeForProposal: () => Promise.resolve(options.activeRun ?? null),
      activeForBounty: () => Promise.resolve(options.activeRun ?? null),
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
    bounties: bounties as never,
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
            Promise.resolve(
              options.siteReady === true
                ? { ok: true as const, client: {} as never }
                : { ok: false as const, reason: "reconnect" as const },
            ),
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
  mountPricingRoutes(app, pricing);
  mountBountyRoutes(app, pricing);
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

function listedOf(bounty: StoredBounty): ListedBounty {
  const {
    description: _d,
    components: _c,
    inputTruncated: _i,
    createdBy: _b,
    ...rest
  } = bounty;
  return { ...rest, proposal: null };
}

test("any member lists the organization's bounties, a page at a time", async () => {
  const page = Array.from({ length: 2 }, (_, i) =>
    listedOf(written({ id: `bty_${i}`, title: `Bounty ${i + 1}` })),
  );
  const state = harness({ role: "member", listed: page });
  const response = await state.request("GET", "bounties?limit=2");
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    bounties: Record<string, unknown>[];
    nextCursor: string | null;
  };
  assert.deepEqual(
    body.bounties.map(({ title }) => title),
    ["Bounty 1", "Bounty 2"],
  );
  // Named by its id and title: there is no count of the organization's.
  assert.equal("key" in (body.bounties[0] ?? {}), false);
  assert.equal("number" in (body.bounties[0] ?? {}), false);
  assert.equal(body.nextCursor, `${stamp}|bty_1`);

  const next = await state.request(
    "GET",
    `bounties?cursor=${encodeURIComponent(`${stamp}|bty_1`)}`,
  );
  assert.equal(next.status, 200);
  assert.deepEqual(state.calls.at(-1)?.args[1], {
    limit: 25,
    cursor: { createdAt: stamp, id: "bty_1" },
  });
  assert.equal(
    ((await next.json()) as { nextCursor: unknown }).nextCursor,
    null,
  );
  assert.equal(
    (await state.request("GET", "bounties?cursor=nope")).status,
    400,
  );
  assert.equal(
    (await state.request("GET", "bounties?cursor=x|bty_1")).status,
    400,
  );
});

test("the caller's bounties list across their own organizations only", async () => {
  const asked: string[] = [];
  const pages: unknown[] = [];
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("user", { id: "user_1" } as never);
    await next();
  });
  mountCallerBountyRoutes(app, {
    organizationsOf: (userId) => {
      asked.push(userId);
      return Promise.resolve(["org_1", "org_2"]);
    },
    bounties: {
      listAcross: (organizationIds, page) => {
        pages.push({ organizationIds, ...page });
        return Promise.resolve([
          listedOf(written({ id: "bty_9", organizationId: "org_2" })),
          listedOf(written()),
        ]);
      },
      categoryCounts: () =>
        Promise.resolve({ total: 0, uncategorized: 0, categories: {} }),
    },
  });

  const response = await app.request("/api/v1/me/bounties?limit=2");
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    bounties: { id: string; organizationId: string }[];
    nextCursor: string | null;
  };
  assert.deepEqual(
    body.bounties.map(({ id, organizationId }) => [id, organizationId]),
    [
      ["bty_9", "org_2"],
      ["bty_7", "org_1"],
    ],
  );
  assert.equal(body.nextCursor, `${stamp}|bty_7`);
  assert.deepEqual(asked, ["user_1"]);
  assert.deepEqual(pages, [{ organizationIds: ["org_1", "org_2"], limit: 2 }]);

  await app.request(
    `/api/v1/me/bounties?cursor=${encodeURIComponent(`${stamp}|bty_7`)}`,
  );
  assert.deepEqual(pages.at(-1), {
    organizationIds: ["org_1", "org_2"],
    limit: 25,
    cursor: { createdAt: stamp, id: "bty_7" },
  });
  assert.equal(
    (await app.request("/api/v1/me/bounties?cursor=nope")).status,
    400,
  );
});

test("the caller's bounties narrow to a category, to none, and to a board", async () => {
  const pages: unknown[] = [];
  const counted: unknown[] = [];
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("user", { id: "user_1" } as never);
    await next();
  });
  mountCallerBountyRoutes(app, {
    organizationsOf: () => Promise.resolve(["org_1"]),
    bounties: {
      listAcross: (_organizationIds, page) => {
        pages.push(page);
        return Promise.resolve([
          listedOf(
            imported({
              categories: [
                {
                  id: "left-behind",
                  label: "Left behind",
                  reason: "Open 412 days",
                },
              ],
            }),
          ),
        ]);
      },
      categoryCounts: (organizationIds, filter) => {
        counted.push({ organizationIds, ...filter });
        return Promise.resolve({
          total: 3,
          uncategorized: 1,
          categories: { "left-behind": 2 },
        });
      },
    },
  });

  const listed = (await (
    await app.request("/api/v1/me/bounties?category=left-behind&board=jrb_1")
  ).json()) as { bounties: { categories: { id: string }[] }[] };
  assert.deepEqual(pages.at(-1), {
    limit: 25,
    category: "left-behind",
    boardId: "jrb_1",
  });
  assert.deepEqual(
    listed.bounties[0]?.categories.map(({ id }) => id),
    ["left-behind"],
  );

  await app.request("/api/v1/me/bounties?category=uncategorized");
  assert.deepEqual(pages.at(-1), { limit: 25, uncategorized: true });
  await app.request("/api/v1/me/bounties?source=lunox");
  assert.deepEqual(pages.at(-1), { limit: 25, unlinked: true });
  assert.equal(
    (await app.request("/api/v1/me/bounties?source=github")).status,
    400,
  );
  assert.equal(
    (await app.request("/api/v1/me/bounties?category=Not%20One")).status,
    400,
  );
  // How far they have got: the last step done.
  await app.request("/api/v1/me/bounties?status=priced");
  assert.deepEqual(pages.at(-1), { limit: 25, status: "priced" });
  assert.equal(
    (await app.request("/api/v1/me/bounties?status=approved")).status,
    400,
  );

  const counts = (await (
    await app.request("/api/v1/me/bounty-categories?board=jrb_1")
  ).json()) as {
    total: number;
    uncategorized: number;
    categories: { id: string; count: number }[];
  };
  assert.deepEqual(counted, [{ organizationIds: ["org_1"], boardId: "jrb_1" }]);
  // Counted within a status as the list is narrowed to it.
  await app.request("/api/v1/me/bounty-categories?status=live");
  assert.deepEqual(counted.at(-1), {
    organizationIds: ["org_1"],
    status: "live",
  });
  assert.equal(counts.total, 3);
  assert.equal(counts.uncategorized, 1);
  // Every category, in the registry's order, with a zero for the empty.
  assert.equal(counts.categories.length, 6);
  assert.deepEqual(counts.categories.map(({ id, count }) => [id, count])[0], [
    "left-behind",
    2,
  ]);
  assert.ok(counts.categories.slice(1).every(({ count }) => count === 0));
});

test("a listed Jira bounty links to its issue", async () => {
  const state = harness({ listed: [listedOf(imported())] });
  const body = (await (await state.request("GET", "bounties")).json()) as {
    bounties: { jira: { url: string } }[];
  };
  assert.equal(
    body.bounties[0]?.jira.url,
    "https://acme.atlassian.net/browse/APP-1",
  );
});

test("a listed bounty's proposal names the repositories its sizing touches", async () => {
  const repositories = [
    { repoId: "ghr_1", snapshotId: "rsn_1" },
    { repoId: "ghr_2", snapshotId: "rsn_2" },
  ];
  const state = harness({
    listed: [
      {
        ...listedOf(written()),
        proposal: {
          id: "bpr_1",
          status: "proposed",
          complexity: "M",
          repositories,
          amountMinor: 200,
          currency: "USD",
        },
      },
    ],
  });
  const body = (await (await state.request("GET", "bounties")).json()) as {
    bounties: { proposal: { repositories: unknown } | null }[];
  };
  assert.deepEqual(body.bounties[0]?.proposal?.repositories, repositories);
});

test("any member writes a bounty; only its title is needed", async () => {
  const state = harness({ role: "member" });
  const response = await state.request("POST", "bounties", {
    title: "Invitations are not sent",
  });
  assert.equal(response.status, 201);
  const body = (await response.json()) as {
    bounty: { origin: string; proposal: unknown; jira: unknown };
  };
  assert.equal(body.bounty.origin, "manual");
  assert.equal(body.bounty.jira, null);
  assert.equal(body.bounty.proposal, null);
  assert.deepEqual(state.calls[0]?.args, [
    "org_1",
    "user_1",
    {
      title: "Invitations are not sent",
      description: "",
      stack: [],
    },
  ]);
});

test("a bounty's stack is stored under the catalog's names, each once", async () => {
  const state = harness({ create: written({ title: "Stored as written" }) });
  const response = await state.request("POST", "bounties", {
    title: "Invitations are not sent",
    stack: ["postgres", "PostgreSQL", " Our mailer "],
  });
  assert.equal(response.status, 201);
  // What the store kept is what answers, not what was sent.
  assert.equal(
    ((await response.json()) as { bounty: { title: string } }).bounty.title,
    "Stored as written",
  );
  assert.deepEqual((state.calls[0]?.args[2] as { stack: string[] }).stack, [
    "PostgreSQL",
    "Our mailer",
  ]);
  const tooMany = await state.request("POST", "bounties", {
    title: "t",
    stack: Array.from({ length: 31 }, (_, i) => `Tool ${i}`),
  });
  assert.equal(tooMany.status, 400);
});

test("a bounty that cannot be stored is refused with why", async () => {
  const state = harness();
  const invalid = await state.request("POST", "bounties", { title: "" });
  assert.equal(invalid.status, 400);
  assert.equal(
    ((await invalid.json()) as { code: string }).code,
    "invalid_bounty",
  );
  assert.equal(
    (await state.request("POST", "bounties", "not json")).status,
    400,
  );
  // A bounty names no repository: its work may touch any of the
  // workspace's, so one named is a field the body does not have.
  const naming = await state.request("POST", "bounties", {
    title: "t",
    repoId: "ghr_1",
  });
  assert.equal(naming.status, 400);
  assert.equal(
    ((await naming.json()) as { code: string }).code,
    "invalid_bounty",
  );
  const renaming = await state.request("PATCH", "bounties/bty_7", {
    expectedRevision: 1,
    repoId: "ghr_1",
  });
  assert.equal(renaming.status, 400);
  assert.equal(state.calls.filter(({ method }) => method !== "get").length, 0);
});

test("a bounty reads with its live proposal, or 404", async () => {
  const bounty = written();
  const state = harness({
    bounties: [bounty],
    live: {
      bty_7: proposalOf(bounty, {
        status: "approved",
        repositories: [{ repoId: "ghr_1", snapshotId: "rsn_1" }],
      }),
    },
  });
  const response = await state.request("GET", "bounties/bty_7");
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    bounty: { description: string; proposal: { id: string; status: string } };
  };
  assert.equal(body.bounty.description, bounty.description);
  // With the repositories its sizing said the work touches.
  assert.deepEqual(body.bounty.proposal, {
    id: "bpr_1",
    status: "approved",
    complexity: "M",
    repositories: [{ repoId: "ghr_1", snapshotId: "rsn_1" }],
    amountMinor: 200,
    currency: "USD",
  });
  assert.equal((await state.request("GET", "bounties/bty_x")).status, 404);
});

test("a bounty reads with each step's version, and the one before it each was built on", async () => {
  const old = { title: "Invitations are not sent", description: "Old steps" };
  const bounty = written({
    version: 3,
    sandbox: {
      id: "sbx_1",
      status: "published",
      currentVersionId: "sbv_2",
      expiresAt: null,
      sourceRepoId: null,
      build: {
        versionId: "sbv_2",
        version: 2,
        priceVersion: 1,
        context: { jira: null, github: null },
      },
    },
  });
  const version = (
    n: number,
    text: { title: string; description: string },
  ) => ({
    version: n,
    ...text,
    createdBy: "user_1",
    createdAt: stamp,
  });
  const state = harness({
    bounties: [bounty],
    // Sized from version 2's words, which version 1 also said.
    live: {
      bty_7: proposalOf(bounty, {
        status: "approved",
        version: 2,
        specHash: await bountySpecHash(old.title, old.description),
      }),
    },
    versions: {
      bty_7: [version(3, bounty), version(2, old), version(1, old)],
    },
  });
  const response = await state.request("GET", "bounties/bty_7");
  assert.equal(response.status, 200);
  const body = (await response.json()) as { bounty: { stages: unknown } };
  // With no context store, the scope holds none and nothing is behind.
  assert.deepEqual(body.bounty.stages, {
    scope: { version: 3, context: NONE },
    price: { version: 2, scopeVersion: 2, context: NONE },
    sandbox: { version: 2, priceVersion: 1, context: NONE },
  });

  // A proposal hashed by an older function matches no version; a bounty
  // with no proposal or sandbox has neither step.
  const legacy = harness({
    bounties: [written()],
    live: {
      bty_7: proposalOf(written(), { specHashVersion: 1 }),
    },
  });
  const read = (await (
    await legacy.request("GET", "bounties/bty_7")
  ).json()) as { bounty: { stages: unknown } };
  assert.deepEqual(read.bounty.stages, {
    scope: { version: 1, context: NONE },
    price: { version: 0, scopeVersion: null, context: NONE },
    sandbox: null,
  });
  const bare = harness({ bounties: [written()] });
  const none = (await (await bare.request("GET", "bounties/bty_7")).json()) as {
    bounty: { stages: unknown };
  };
  assert.deepEqual(none.bounty.stages, {
    scope: { version: 1, context: NONE },
    price: null,
    sandbox: null,
  });
});

test("a bounty's scope versions are listed, or 404", async () => {
  const state = harness({ role: "member", bounties: [written()] });
  const response = await state.request("GET", "bounties/bty_7/versions");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    versions: [
      {
        version: 1,
        title: "Invitations are not sent",
        description: "Scheduling an interview sends the candidate one email.",
        createdBy: "user_1",
        createdAt: stamp,
      },
    ],
  });
  assert.equal(
    (await state.request("GET", "bounties/bty_x/versions")).status,
    404,
  );
});

test("a change is saved against the revision the editor saw", async () => {
  const state = harness({ role: "member", bounties: [written()] });
  const response = await state.request("PATCH", "bounties/bty_7", {
    expectedRevision: 1,
    title: "Invitations go out twice",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(state.calls[0]?.args, [
    "org_1",
    "bty_7",
    1,
    { title: "Invitations go out twice" },
    // Who wrote the scope's next version.
    "user_1",
  ]);
  assert.equal(
    (await state.request("PATCH", "bounties/bty_7", { expectedRevision: 1 }))
      .status,
    400,
  );
});

test("a refused change says why", async () => {
  const cases: [BountyMutationResult, number, string | undefined][] = [
    [{ ok: false, reason: "not-found" }, 404, undefined],
    [{ ok: false, reason: "jira-owned" }, 409, "jira_owned"],
    [
      { ok: false, reason: "changed", current: written({ revision: 3 }) },
      409,
      "bounty_changed",
    ],
    [{ ok: false, reason: "changed" }, 409, "bounty_changed"],
  ];
  for (const [update, status, code] of cases) {
    const state = harness({ update });
    const response = await state.request("PATCH", "bounties/bty_7", {
      expectedRevision: 1,
      title: "t",
    });
    assert.equal(response.status, status, String(code));
    const body = (await response.json()) as {
      code?: string;
      bounty?: { revision: number };
    };
    assert.equal(body.code, code);
    if (update.ok === false && update.current !== undefined) {
      assert.equal(body.bounty?.revision, 3);
    }
  }
});

test("only an owner or admin deletes a bounty, and only an unused one", async () => {
  assert.equal(
    (await harness({ role: "member" }).request("DELETE", "bounties/bty_7"))
      .status,
    403,
  );
  assert.equal(
    (await harness().request("DELETE", "bounties/bty_7")).status,
    204,
  );
  assert.equal(
    (await harness({ remove: "not-found" }).request("DELETE", "bounties/bty_7"))
      .status,
    404,
  );
  const inUse = await harness({ remove: "in-use" }).request(
    "DELETE",
    "bounties/bty_7",
  );
  assert.equal(inUse.status, 409);
  assert.equal(
    ((await inUse.json()) as { code: string }).code,
    "bounty_in_use",
  );
});

test("proposing a bounty written here starts a bounty run, with no board", async () => {
  const state = harness({ bounties: [written()] });
  const response = await state.request("POST", "bounties/bty_7/propose", {
    requestId,
  });
  assert.equal(response.status, 202);
  assert.deepEqual(state.starts, ["brn_new"]);
  const input = state.created[0] as Record<string, unknown>;
  assert.equal(input["kind"], "bounty");
  assert.equal(input["boardId"], null);
  assert.equal(input["bountyId"], "bty_7");
  assert.deepEqual(input["planned"], [
    {
      externalIssueId: "bty_7",
      // Written here: no Jira key to name it by.
      issueKey: null,
      summary: "Invitations are not sent",
      bountyId: "bty_7",
      categories: [],
    },
  ]);
  // The defaults, for a bounty no board's settings cover.
  assert.equal(
    (input["selection"] as { minSpecChars: number }).minSpecChars,
    0,
  );
});

test("proposing a Jira bounty sizes it with its board's settings", async () => {
  const state = harness({ bounties: [imported()], siteReady: true });
  const response = await state.request("POST", "bounties/bty_1/propose", {
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

test("a bounty with a live proposal gets that proposal, not a run", async () => {
  const bounty = written();
  const state = harness({
    bounties: [bounty],
    live: { bty_7: proposalOf(bounty) },
  });
  const response = await state.request("POST", "bounties/bty_7/propose", {
    requestId,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { proposalId: "bpr_1" });
  assert.deepEqual(state.created, []);
});

test("proposing is refused when it could not start", async () => {
  const cases: [Parameters<typeof harness>[0], number, string | undefined][] = [
    [{ role: "member", bounties: [written()] }, 403, undefined],
    [{ bounties: [] }, 404, undefined],
    [{ sizing: false, bounties: [written()] }, 503, "sizing_unavailable"],
    // A Jira bounty with no Jira configured cannot be read to size, nor
    // one whose site needs reconnecting: said now, not by a failed run.
    [{ jira: false, bounties: [imported({ id: "bty_7" })] }, 409, "reconnect"],
    [{ bounties: [imported({ id: "bty_7" })] }, 409, "reconnect"],
    [
      {
        bounties: [written()],
        runCreate: { ok: false, reason: "active", runId: "brn_9" },
      },
      409,
      "run_active",
    ],
    [
      {
        bounties: [written()],
        runCreate: { ok: false, reason: "request-conflict" },
      },
      409,
      "request_conflict",
    ],
    [
      { bounties: [written()], runCreate: { ok: false, reason: "not-found" } },
      404,
      undefined,
    ],
  ];
  for (const [options, status, code] of cases) {
    const response = await harness(options).request(
      "POST",
      "bounties/bty_7/propose",
      { requestId },
    );
    assert.equal(response.status, status, String(code));
    assert.equal(((await response.json()) as { code?: string }).code, code);
  }
  assert.equal(
    (
      await harness({ bounties: [written()] }).request(
        "POST",
        "bounties/bty_7/propose",
        { requestId: "x" },
      )
    ).status,
    400,
  );
});

test("a bounty written here is proposed when Jira is not configured at all", async () => {
  // Nothing here needs Jira: the deployment has none.
  const state = harness({ jira: false, bounties: [written()] });
  const response = await state.request("POST", "bounties/bty_7/propose", {
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

test("a bounty written here is reviewed and approved with no Jira", async () => {
  const bounty = written();
  const priced = await bountySpecHash(bounty.title, bounty.description);
  const proposal = proposalOf(bounty, { specHash: priced });
  const approved: unknown[] = [];
  const state = harness({
    jira: false,
    bounties: [bounty],
    live: { bty_7: proposal },
    approved,
  });
  const detail = await state.request("GET", "proposals/bpr_1");
  assert.equal(detail.status, 200);
  const body = (await detail.json()) as {
    freshness: { freshness: string; liveUrl?: string };
    liveSpec: { url: null; key: string | null };
  };
  assert.equal(body.freshness.freshness, "current");
  assert.equal(body.freshness.liveUrl, undefined);
  assert.equal(body.liveSpec.key, null);
  // Nothing is rewriting it.
  assert.equal((body as { activeRun?: unknown }).activeRun, null);
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

test("an approval a published sandbox stands on is re-priced, the sandbox left as it is", async () => {
  const bounty = written({
    sandbox: {
      id: "sbx_1",
      status: "published",
      currentVersionId: "sbv_1",
      expiresAt: null,
      sourceRepoId: null,
      build: {
        versionId: "sbv_1",
        version: 1,
        priceVersion: 1,
        context: { jira: null, github: null },
      },
    },
  });
  const state = harness({
    bounties: [bounty],
    live: { bty_7: proposalOf(bounty, { status: "approved" }) },
  });
  const response = await state.request("POST", "proposals/bpr_1/reprice", {
    expectedRevision: 1,
    requestId,
  });
  // Nothing locks the bounty to its sandbox: the sandbox keeps the bounty
  // version it was built on, and reads as behind once another is approved.
  assert.equal(response.status, 202);
});

test("a bounty written here is re-priced with no board", async () => {
  const bounty = written();
  const state = harness({
    bounties: [bounty],
    live: { bty_7: proposalOf(bounty) },
  });
  const response = await state.request("POST", "proposals/bpr_1/reprice", {
    expectedRevision: 1,
    requestId,
  });
  assert.equal(response.status, 202);
  const input = state.created[0] as Record<string, unknown>;
  assert.equal(input["kind"], "reprice");
  assert.equal(input["boardId"], null);
  assert.equal(input["bountyId"], "bty_7");
});

test("a proposal's page names the re-price in flight on it", async () => {
  const bounty = written();
  const run = runOf({ bountyId: "bty_7", kind: "reprice" });
  const state = harness({
    jira: false,
    bounties: [bounty],
    live: { bty_7: proposalOf(bounty) },
    activeRun: run,
  });
  const detail = await state.request("GET", "proposals/bpr_1");
  assert.equal(detail.status, 200);
  const body = (await detail.json()) as { activeRun: { id: string } | null };
  assert.equal(body.activeRun?.id, run.id);
});

test("a bounty's page reads the sizing in flight on it, and only its own", async () => {
  const run = runOf({ bountyId: "bty_7", kind: "bounty" });
  const state = harness({ bounties: [written()], activeRun: run });
  const sizing = await state.request("GET", "bounties/bty_7/sizing");
  assert.equal(sizing.status, 200);
  assert.equal(
    ((await sizing.json()) as { run: { id: string } }).run.id,
    run.id,
  );
  assert.equal(
    (await state.request("GET", "bounties/bty_missing/sizing")).status,
    404,
  );
  const idle = harness({ bounties: [written()] });
  const none = await idle.request("GET", "bounties/bty_7/sizing");
  assert.deepEqual(await none.json(), { run: null });
});

test("a re-price refused for a run in the way names that run", async () => {
  const bounty = written();
  const state = harness({
    bounties: [bounty],
    live: { bty_7: proposalOf(bounty) },
    runCreate: { ok: false, reason: "active", runId: "brn_9" },
  });
  const response = await state.request("POST", "proposals/bpr_1/reprice", {
    expectedRevision: 1,
    requestId,
  });
  assert.equal(response.status, 409);
  const body = (await response.json()) as { code: string; runId: string };
  assert.equal(body.code, "run_active");
  assert.equal(body.runId, "brn_9");
});

test("an owner or admin approves the scope, and takes that back", async () => {
  const state = harness({ bounties: [written()] });
  const approved = await state.request("POST", "bounties/bty_7/approve", {
    expectedRevision: 1,
  });
  assert.equal(approved.status, 200);
  const body = (await approved.json()) as {
    bounty: { approval: { version: number; approvedBy: string } | null };
  };
  assert.equal(body.bounty.approval?.version, 1);
  assert.deepEqual(state.calls.at(-1), {
    method: "approve-scope",
    args: ["org_1", "bty_7", 1, "user_1"],
  });

  const unapproved = await state.request("POST", "bounties/bty_7/unapprove", {
    expectedRevision: 2,
  });
  assert.equal(unapproved.status, 200);
  assert.equal(
    ((await unapproved.json()) as { bounty: { approval: unknown } }).bounty
      .approval,
    null,
  );
  assert.deepEqual(state.calls.at(-1)?.args, ["org_1", "bty_7", 2]);

  // A decision names the revision it was made against.
  assert.equal(
    (await state.request("POST", "bounties/bty_7/approve", {})).status,
    400,
  );
  // A member edits a bounty, but does not approve one.
  const member = harness({ role: "member", bounties: [written()] });
  assert.equal(
    (
      await member.request("POST", "bounties/bty_7/approve", {
        expectedRevision: 1,
      })
    ).status,
    403,
  );
});

test("an approved scope is not changed until it is unapproved", async () => {
  const approved = written({
    approval: { version: 1, approvedBy: "user_1", approvedAt: stamp },
  });
  const state = harness({
    bounties: [approved],
    update: { ok: false, reason: "scope-approved", current: approved },
  });
  const response = await state.request("PATCH", "bounties/bty_7", {
    expectedRevision: 1,
    title: "Other",
  });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    code: "scope_approved",
    error: "The scope is approved. Unapprove it before changing it.",
  });
});
