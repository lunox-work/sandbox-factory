import assert from "node:assert/strict";
import { test } from "node:test";

import type { JiraBoardSummary, NewBountyContext } from "@sandbox-factory/db";
import type {
  JiraContextDto,
  JiraIssueSignalsDto,
} from "@sandbox-factory/shared";
import type { BountyContent, CategoryMatch } from "sandbox-factory";
import { Hono } from "hono";

import {
  IMPORT_LIMIT,
  importBoard,
  mountBountyImportRoutes,
  type BountyImportOptions,
} from "../src/bounties/import.js";
import type { RunClientResult } from "../src/pricing/executor.js";
import type { AuthVariables } from "../src/routes.js";

const NOW = new Date("2026-09-30T00:00:00Z");

/** A ticket no category picks: a week old, owned, in no sprint history. */
function issue(
  id: string,
  overrides: Partial<JiraIssueSignalsDto> = {},
): JiraIssueSignalsDto {
  return {
    id,
    key: `APP-${id}`,
    summary: `Issue ${id}`,
    status: "To Do",
    statusCategory: "new",
    assignee: "Ada Lovelace",
    priority: "High",
    issueType: "Story",
    labels: [],
    projectKey: "APP",
    parentKey: null,
    created: "2026-09-23T00:00:00.000Z",
    updated: "2026-09-23T00:00:00.000Z",
    dueDate: null,
    url: null,
    sprint: null,
    closedSprints: [],
    votes: null,
    watchers: null,
    links: [],
    releases: [],
    ...overrides,
  };
}

/** Open since mid-2025, untouched, unowned, never planned: left behind. */
function leftBehind(id: string): JiraIssueSignalsDto {
  return issue(id, {
    assignee: null,
    created: "2025-08-14T00:00:00.000Z",
    updated: "2025-09-01T00:00:00.000Z",
  });
}

function context(key: string): JiraContextDto {
  return {
    key,
    issueType: "Story",
    status: "To Do",
    statusCategory: "new",
    priority: "High",
    labels: [],
    components: [],
    fixVersions: [],
    parentKey: null,
    dueDate: null,
    storyPoints: null,
    originalEstimateSeconds: null,
    remainingEstimateSeconds: null,
    votes: null,
    watchers: null,
    subtaskCount: 0,
    links: [],
    updated: "2026-09-29T00:00:00.000+0000",
  };
}

const BOARD: JiraBoardSummary = {
  id: "jrb_1",
  connectionId: "jrc_1",
  externalId: "42",
  name: "Backlog",
  boardType: "scrum",
  projectKey: "APP",
  selection: {},
  pricing: {},
  createdAt: "2026-01-01T00:00:00.000Z",
};

interface Setup {
  /** What the board's scan reads, one page. */
  backlog?: JiraIssueSignalsDto[];
  /** Issues already imported, by Jira's id, and the bounty each is. */
  known?: Record<string, string>;
  /** Issues whose text Jira will not give. */
  unreadable?: string[];
  client?: RunClientResult;
}

function harness(setup: Setup = {}) {
  const backlog = setup.backlog ?? [];
  const known = new Map(Object.entries(setup.known ?? {}));
  const upserted: { externalId: string; content: BountyContent }[] = [];
  const recorded: { bountyId: string; input: NewBountyContext; by: unknown }[] =
    [];
  const categorized: { bountyId: string; categories: string[] }[] = [];
  const signalQueries: string[] = [];
  const client: RunClientResult = setup.client ?? {
    ok: true,
    client: {
      boardIssueSignals: (_board: number, options: { jql: string }) => {
        signalQueries.push(options.jql);
        const single = /^issue = (\d+)$/.exec(options.jql);
        return Promise.resolve({
          issues:
            single === null
              ? backlog
              : backlog.filter(({ id }) => id === single[1]),
        });
      },
      issueSpec: (id: string) =>
        setup.unreadable?.includes(id) === true
          ? Promise.reject(new Error("unreadable"))
          : Promise.resolve({
              summary: `From Jira ${id}`,
              descriptionText: "Jira's steps.",
              components: [],
              inputTruncated: false,
              updated: "2026-09-29T00:00:00.000+0000",
            }),
      issueContext: (id: string) => Promise.resolve(context(`APP-${id}`)),
    } as never,
  };
  const options: BountyImportOptions = {
    boards: {
      forRun: (_org, boardId) =>
        Promise.resolve(
          boardId === BOARD.id
            ? {
                board: BOARD,
                connectionId: "jrc_1",
                cloudId: "cloud",
                siteUrl: "https://acme.atlassian.net",
              }
            : null,
        ),
    },
    issues: {
      upsert: (_org, boardId, input, content) => {
        upserted.push({ externalId: input.externalId, content });
        const bountyId =
          known.get(input.externalId) ?? `bty_${input.externalId}`;
        known.set(input.externalId, bountyId);
        return Promise.resolve({
          id: `jri_${input.externalId}`,
          boardId,
          bountyId,
          externalId: input.externalId,
          key: input.key,
          removedAt: null,
        });
      },
      bountiesFor: (_org, _board, ids) =>
        Promise.resolve(
          new Map(
            ids.flatMap((id) => {
              const bountyId = known.get(id);
              return bountyId === undefined ? [] : [[id, bountyId]];
            }),
          ),
        ),
    },
    bounties: {
      categorize: (_org, bountyId, categories: readonly CategoryMatch[]) => {
        categorized.push({
          bountyId,
          categories: categories.map(({ id }) => id),
        });
        return Promise.resolve(true);
      },
    },
    contexts: {
      record: (_org, bountyId, input, by) => {
        recorded.push({ bountyId, input, by });
        return Promise.resolve({ ok: false, reason: "not-found" } as never);
      },
    },
    clientFor: () => Promise.resolve(client),
    now: () => NOW,
  };
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("user", { id: "user_1" } as never);
    c.set("member", { organizationId: "org_1", role: "member" } as never);
    await next();
  });
  mountBountyImportRoutes(app, options);
  const post = (path: string, body?: unknown) =>
    app.request(`/api/v1/orgs/org_1/jira/boards/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return {
    options,
    post,
    upserted,
    recorded,
    categorized,
    signalQueries,
  };
}

test("a board's scan is imported as bounties with their scope, context and categories, and nothing sized", async () => {
  const state = harness({
    backlog: [leftBehind("1"), issue("2"), leftBehind("3")],
    known: { "3": "bty_old" },
  });

  // Any member may: it reads Jira, and calls no model.
  const response = await state.post("jrb_1/import");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    created: 1,
    refreshed: 1,
    failed: 0,
  });

  // Only what the scan put in a category: issue 2 fits none.
  assert.deepEqual(
    state.upserted.map(({ externalId, content }) => [
      externalId,
      content.title,
    ]),
    [
      ["1", "From Jira 1"],
      ["3", "From Jira 3"],
    ],
  );
  // Its Jira fields, as the scope's next context version, synced by no one.
  assert.deepEqual(
    state.recorded.map(({ bountyId, input, by }) => [
      bountyId,
      input.source,
      input.ref,
      by,
    ]),
    [
      ["bty_1", "jira", "APP-1", null],
      ["bty_old", "jira", "APP-3", null],
    ],
  );
  assert.deepEqual(state.categorized, [
    { bountyId: "bty_1", categories: ["left-behind"] },
    { bountyId: "bty_old", categories: ["left-behind"] },
  ]);
});

test("a scan that falls back to the oldest tickets imports none of them", async () => {
  // Nothing fits a category, so the scan suggests the oldest: not a category.
  const state = harness({ backlog: [issue("1"), issue("2")] });
  const result = await importBoard(state.options, "org_1", "jrb_1");
  assert.deepEqual(result, { ok: true, created: 0, refreshed: 0, failed: 0 });
  assert.equal(state.upserted.length, 0);
});

test("an issue Jira will not give is counted, and the rest still imported", async () => {
  const state = harness({
    backlog: [leftBehind("1"), leftBehind("2")],
    unreadable: ["1"],
  });
  const result = await importBoard(state.options, "org_1", "jrb_1");
  assert.deepEqual(result, { ok: true, created: 1, refreshed: 0, failed: 1 });
});

test("an import takes at most its limit", async () => {
  const many = Array.from({ length: IMPORT_LIMIT + 5 }, (_, index) =>
    leftBehind(String(index + 1)),
  );
  const state = harness({ backlog: many });
  const result = await importBoard(state.options, "org_1", "jrb_1");
  assert.equal(result.ok && result.created, IMPORT_LIMIT);
});

test("one issue is imported alone, classified as the scan would, and named", async () => {
  const state = harness({ backlog: [leftBehind("7"), issue("8")] });

  const fits = await state.post("jrb_1/import", { issueId: "7" });
  assert.equal(fits.status, 200);
  assert.deepEqual(await fits.json(), {
    created: 1,
    refreshed: 0,
    failed: 0,
    bountyId: "bty_7",
  });
  assert.deepEqual(state.signalQueries, ["issue = 7"]);

  // One that fits no category is still a bounty, in none.
  const none = await state.post("jrb_1/import", { issueId: "8" });
  assert.equal(none.status, 200);
  assert.deepEqual(state.categorized, [
    { bountyId: "bty_7", categories: ["left-behind"] },
    { bountyId: "bty_8", categories: [] },
  ]);
});

test("an issue not on the board, or split into sub-tasks, is not imported", async () => {
  const state = harness({
    backlog: [issue("9", { subtaskCount: 2 })],
  });
  const missing = await state.post("jrb_1/import", { issueId: "5" });
  assert.equal(missing.status, 404);
  assert.equal(
    ((await missing.json()) as { code: string }).code,
    "issue_not_found",
  );
  const parent = await state.post("jrb_1/import", { issueId: "9" });
  assert.equal(parent.status, 409);
  assert.equal(
    ((await parent.json()) as { code: string }).code,
    "has_subtasks",
  );
  assert.equal(state.upserted.length, 0);
});

test("an unknown board is 404, a connection to reconnect is 409, and a bad body 400", async () => {
  assert.equal((await harness().post("jrb_9/import")).status, 404);
  const stale = harness({ client: { ok: false, reason: "reconnect" } });
  const reconnect = await stale.post("jrb_1/import");
  assert.equal(reconnect.status, 409);
  assert.equal(
    ((await reconnect.json()) as { code: string }).code,
    "reconnect",
  );
  assert.equal(
    (await harness().post("jrb_1/import", { issueId: "APP-1" })).status,
    400,
  );
});
