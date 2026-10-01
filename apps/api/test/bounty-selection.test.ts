import assert from "node:assert/strict";
import { test } from "node:test";

import type { JiraBoardSummary } from "@sandbox-factory/db";
import type {
  JiraIssueSignalsDto,
  JiraIssueSignalsPageDto,
} from "@sandbox-factory/shared";

import {
  InvalidBoardIdError,
  selectBacklog,
  type BacklogPageReader,
} from "../src/bounty/selection.js";

const NOW = new Date("2026-09-30T00:00:00Z");

/**
 * A ticket no category picks: a week old, owned, important, in no sprint
 * history. Each test turns on the one signal it is about.
 */
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

/** Open since mid-2025, untouched, unowned, never planned. */
function leftBehind(id: string): JiraIssueSignalsDto {
  return issue(id, {
    assignee: null,
    created: "2025-08-14T00:00:00.000Z",
    updated: "2025-09-01T00:00:00.000Z",
  });
}

/** Carried through four sprints, and still someone's. */
function carried(id: string): JiraIssueSignalsDto {
  return issue(id, {
    sprint: { name: "Sprint 9", state: "active" },
    closedSprints: [5, 6, 7, 8].map((sprint) => ({
      name: `Sprint ${sprint}`,
      startDate: `2026-0${sprint - 2}-09T09:00:00.000Z`,
      endDate: `2026-0${sprint - 2}-23T09:00:00.000Z`,
    })),
  });
}

function board(overrides: Partial<JiraBoardSummary> = {}): JiraBoardSummary {
  return {
    id: "jrb_1",
    connectionId: "jrc_1",
    externalId: "42",
    name: "Backlog",
    boardType: "scrum",
    projectKey: "APP",
    selection: {},
    pricing: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

type Call = { jql: string; startAt: number; maxResults: number };

function reader(
  pages: JiraIssueSignalsPageDto[],
): BacklogPageReader & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    boardIssueSignals: (_boardId, options) => {
      calls.push(options);
      return Promise.resolve(pages.shift() ?? { issues: [] });
    },
  };
}

function select(
  client: BacklogPageReader,
  overrides: Partial<Parameters<typeof selectBacklog>[0]> = {},
) {
  return selectBacklog({
    organizationId: "org_1",
    board: board(),
    client,
    now: NOW,
    ...overrides,
  });
}

test("every ticket that fits a category is selected, with no count limit", async () => {
  // The old rule took the ten oldest. Twenty-five fit here, across two
  // pages, and all twenty-five are taken.
  const first = Array.from({ length: 100 }, (_, index) =>
    index < 15 ? leftBehind(String(index)) : issue(String(index)),
  );
  const second = Array.from({ length: 10 }, (_, index) =>
    leftBehind(String(100 + index)),
  );
  const client = reader([
    { issues: first, total: 110 },
    { issues: second, total: 110 },
  ]);

  const result = await select(client);

  assert.equal(result.issues.length, 25);
  assert.equal(result.unmatched, 85);
  assert.equal(result.candidatesScanned, 110);
  assert.equal(result.scanLimitReached, false);
  assert.equal(result.ticketCapReached, false);
  assert.equal(result.total, 110);
  assert.deepEqual(
    client.calls.map(({ startAt }) => startAt),
    [0, 100],
  );
});

test("a ticket that fits no category is not selected, however old", async () => {
  // Age alone used to be the whole rule. An old ticket that is owned and in
  // a sprint is somebody's work, not an opening.
  const owned = issue("1", {
    created: "2024-01-01T00:00:00.000Z",
    updated: "2024-01-01T00:00:00.000Z",
    sprint: { name: "Sprint 9", state: "active" },
  });
  const result = await select(reader([{ issues: [owned], total: 1 }]));

  assert.deepEqual(result.issues, []);
  assert.equal(result.unmatched, 1);
});

test("each selected ticket carries why it was picked", async () => {
  const blocker = issue("3", {
    assignee: null,
    links: [
      {
        type: "Blocks",
        direction: "outward",
        key: "APP-8",
        statusCategory: "new",
      },
      {
        type: "Blocks",
        direction: "outward",
        key: "APP-9",
        statusCategory: "new",
      },
    ],
  });
  const result = await select(
    reader([{ issues: [leftBehind("1"), carried("2"), blocker], total: 3 }]),
  );

  assert.deepEqual(
    result.issues.map(({ key, categories }) => [key, categories]),
    [
      [
        "APP-1",
        [
          {
            id: "left-behind",
            label: "Left behind",
            reason: "Open 412 days, never in a sprint, unassigned",
          },
        ],
      ],
      [
        "APP-2",
        [
          {
            id: "always-next-sprint",
            label: "Always next sprint",
            reason: "Carried over 4 sprints since March",
          },
        ],
      ],
      [
        "APP-3",
        [
          {
            id: "holding-others-up",
            label: "Holding others up",
            reason: "Blocks 2 open tickets, unassigned",
          },
        ],
      ],
    ],
  );
  // The ticket itself is passed through whole, for the run to size.
  assert.equal(result.issues[0]?.summary, "Issue 1");
});

test("matches are counted per category, and a ticket can count twice", async () => {
  // Left behind *and* a paper cut: an old, unowned, low-priority bug.
  const both = issue("1", {
    assignee: null,
    issueType: "Bug",
    priority: "Low",
    created: "2025-08-14T00:00:00.000Z",
    updated: "2025-09-01T00:00:00.000Z",
  });
  const result = await select(
    reader([{ issues: [both, carried("2"), issue("3")], total: 3 }]),
  );

  assert.deepEqual(result.matched, {
    "left-behind": 1,
    "always-next-sprint": 1,
    "quietly-wanted": 0,
    "holding-others-up": 0,
    "paper-cuts": 1,
    "deadline-exposed": 0,
  });
  assert.equal(result.unmatched, 1);
  assert.deepEqual(
    result.issues[0]?.categories.map(({ id }) => id),
    ["left-behind", "paper-cuts"],
  );
});

test("a board's category settings decide what fits", async () => {
  const young = issue("1", {
    assignee: null,
    created: "2026-08-01T00:00:00.000Z",
    updated: "2026-08-01T00:00:00.000Z",
  });
  const pages = () => reader([{ issues: [young, carried("2")], total: 2 }]);

  // By default a two-month-old ticket is not left behind.
  assert.deepEqual(
    (await select(pages())).issues.map(({ id }) => id),
    ["2"],
  );

  const tuned = await select(pages(), {
    board: board({
      selection: {
        categories: {
          "left-behind": { thresholds: { minAgeDays: 30, minQuietDays: 30 } },
          "always-next-sprint": { enabled: false },
        },
      },
    }),
  });
  assert.deepEqual(
    tuned.issues.map(({ id }) => id),
    ["1"],
  );
  // The preview reports the settings as they were applied.
  const resolved = Object.fromEntries(
    tuned.categories.map((category) => [category.id, category]),
  );
  assert.deepEqual(resolved["left-behind"]?.thresholds, {
    minAgeDays: 30,
    minQuietDays: 30,
  });
  assert.equal(resolved["always-next-sprint"]?.enabled, false);
  assert.equal(resolved["paper-cuts"]?.enabled, true);
  // A category that is off is not counted at all.
  assert.equal("always-next-sprint" in tuned.matched, false);
});

test("tickets with a live proposal are left out, and only fitting ones are asked about", async () => {
  const asked: string[][] = [];
  const result = await select(
    reader([
      {
        issues: [leftBehind("1"), issue("2"), leftBehind("3")],
        total: 3,
      },
    ]),
    {
      proposals: {
        liveExternalIds: (_org, _board, ids) => {
          asked.push([...ids]);
          return Promise.resolve(new Set(["1"]));
        },
      },
    },
  );

  assert.deepEqual(
    result.issues.map(({ id }) => id),
    ["3"],
  );
  assert.equal(result.skippedLive, 1);
  // Ticket 2 fits nothing, so whether it has a proposal is not a question.
  assert.deepEqual(asked, [["1", "3"]]);
  // The board still has two left-behind tickets, proposed or not.
  assert.equal(result.matched["left-behind"], 2);
});

test("a page with nothing fitting asks the proposal store nothing", async () => {
  let asked = 0;
  await select(reader([{ issues: [issue("1")], total: 1 }]), {
    proposals: {
      liveExternalIds: () => {
        asked += 1;
        return Promise.resolve(new Set<string>());
      },
    },
  });
  assert.equal(asked, 0);
});

test("a ticket cap, when a board sets one, stops the selection there", async () => {
  const capped = board({ selection: { ticketCap: 2 } });
  const many = Array.from({ length: 100 }, (_, index) =>
    leftBehind(String(index)),
  );
  const client = reader([
    { issues: many, total: 300 },
    { issues: many, total: 300 },
  ]);

  const result = await select(client, { board: capped });

  assert.deepEqual(
    result.issues.map(({ id }) => id),
    ["0", "1"],
  );
  assert.equal(result.ticketCapReached, true);
  // Reading on past the cap would cost Jira calls for tickets it drops.
  assert.equal(client.calls.length, 1);

  // Met exactly, on the board's last page: nothing was turned away.
  const exact = await select(
    reader([{ issues: [leftBehind("1"), leftBehind("2")], total: 2 }]),
    { board: capped },
  );
  assert.equal(exact.issues.length, 2);
  assert.equal(exact.ticketCapReached, false);

  // Met on the last page with one over: that one was turned away.
  const over = await select(
    reader([
      { issues: [leftBehind("1"), leftBehind("2"), leftBehind("3")], total: 3 },
    ]),
    { board: capped },
  );
  assert.equal(over.issues.length, 2);
  assert.equal(over.ticketCapReached, true);
});

test("settings from before categories do not cap a board at ten", async () => {
  // Boards registered then have these stored. They must be inert.
  const legacy = board({
    selection: { maxTickets: 10, excludeAssigned: true } as never,
  });
  const many = Array.from({ length: 30 }, (_, index) => carried(String(index)));
  const client = reader([{ issues: many, total: 30 }]);

  const result = await select(client, { board: legacy });

  assert.equal(result.issues.length, 30);
  assert.equal(result.selection.ticketCap, undefined);
  assert.ok(!client.calls[0]?.jql.includes("assignee is EMPTY"));
});

test("deduplicates repeated candidates and stops on an empty page", async () => {
  const client = reader([
    { issues: [leftBehind("1"), leftBehind("1")], total: 9 },
    { issues: [] },
  ]);
  const result = await select(client);

  assert.deepEqual(
    result.issues.map(({ id }) => id),
    ["1"],
  );
  assert.equal(result.matched["left-behind"], 1);
  assert.equal(result.candidatesScanned, 2);
  assert.equal(result.scanLimitReached, false);
});

test("reports the scan ceiling without claiming the board was read", async () => {
  const client = reader([
    { issues: [leftBehind("1"), leftBehind("2")], total: 10 },
  ]);
  const result = await select(client, { scanLimit: 2 });

  assert.equal(result.scanLimitReached, true);
  assert.equal(result.issues.length, 2);
  assert.equal(client.calls[0]?.maxResults, 2);

  // A ceiling that lands exactly on the end of the board was not a limit.
  const whole = await select(
    reader([{ issues: [leftBehind("1"), leftBehind("2")], total: 2 }]),
    { scanLimit: 2 },
  );
  assert.equal(whole.scanLimitReached, false);
});

test("a short page stops even when Jira omits total", async () => {
  const client = reader([{ issues: [leftBehind("1")] }]);
  const result = await select(client);

  assert.equal(result.issues.length, 1);
  assert.equal(result.total, undefined);
  assert.equal(client.calls.length, 1);
});

test("the query is the board's, from one clock, and an unusable id fails", async () => {
  const client = reader([{ issues: [] }]);
  const result = await select(client, {
    board: board({
      projectKey: null,
      selection: { minAgeDays: 30, unassignedOnly: true },
    }),
  });

  assert.equal(client.calls[0]?.jql, result.jql);
  assert.match(result.jql, /statusCategory != Done/);
  assert.match(result.jql, /assignee is EMPTY/);
  // Thirty days before the run's own clock, not the wall clock.
  assert.match(result.jql, /created <= "2026\/08\/31"/);
  assert.ok(!result.jql.includes("project ="));

  await assert.rejects(
    select(client, { board: board({ externalId: "not-a-number" }) }),
    InvalidBoardIdError,
  );
});

test("without a clock it uses the wall clock", async () => {
  const result = await selectBacklog({
    organizationId: "org_1",
    board: board(),
    client: reader([{ issues: [leftBehind("1")], total: 1 }]),
  });
  assert.equal(result.issues.length, 1);
});
