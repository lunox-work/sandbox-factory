import assert from "node:assert/strict";
import { test } from "node:test";

import type { JiraBoardSummary } from "@sandbox-factory/db";
import type { JiraIssueDto, JiraIssuePageDto } from "@sandbox-factory/shared";

import {
  InvalidBoardIdError,
  selectBacklog,
  type BacklogPageReader,
} from "../src/bounty/selection.js";

function issue(id: string): JiraIssueDto {
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
  };
}

function board(overrides: Partial<JiraBoardSummary> = {}): JiraBoardSummary {
  return {
    id: "jrb_1",
    connectionId: "jrc_1",
    externalId: "42",
    name: "Backlog",
    boardType: "scrum",
    projectKey: "APP",
    selection: {
      maxTickets: 3,
      excludeAssigned: true,
      issueTypes: [],
      minAgeDays: 0,
      minSpecChars: 0,
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function reader(
  pages: JiraIssuePageDto[],
): BacklogPageReader & { calls: { startAt: number; maxResults: number }[] } {
  const calls: { startAt: number; maxResults: number }[] = [];
  const read = (
    _boardId: number,
    options: { startAt: number; maxResults: number },
  ) => {
    calls.push(options);
    return Promise.resolve(pages.shift() ?? { issues: [] });
  };
  return { calls, backlogIssues: read, boardIssues: read };
}

test("selects across pages when the first page is all live", async () => {
  const first = Array.from({ length: 100 }, (_, index) => issue(String(index)));
  const second = [issue("100"), issue("101"), issue("102")];
  const client = reader([
    { issues: first, total: 103 },
    { issues: second, total: 103 },
  ]);
  const proposals = {
    liveExternalIds: (_org: string, _board: string, ids: readonly string[]) =>
      Promise.resolve(new Set(ids.filter((id) => Number(id) < 100))),
  };

  const result = await selectBacklog({
    organizationId: "org_1",
    board: board(),
    client,
    proposals,
    now: new Date("2026-09-22T00:00:00Z"),
  });

  assert.deepEqual(
    result.issues.map(({ id }) => id),
    ["100", "101", "102"],
  );
  assert.equal(result.skippedLive, 100);
  assert.equal(result.candidatesScanned, 103);
  assert.deepEqual(
    client.calls.map(({ startAt }) => startAt),
    [0, 100],
  );
});

test("deduplicates repeated candidates and stops on an empty page", async () => {
  const client = reader([
    { issues: [issue("1"), issue("1")], total: 9 },
    { issues: [] },
  ]);
  const result = await selectBacklog({
    organizationId: "org_1",
    board: board({ selection: { ...board().selection, maxTickets: 2 } }),
    client,
  });

  assert.deepEqual(
    result.issues.map(({ id }) => id),
    ["1"],
  );
  assert.equal(result.candidatesScanned, 2);
  assert.equal(result.scanLimitReached, false);
});

test("reports the scan cap without claiming exhaustion", async () => {
  const client = reader([{ issues: [issue("1"), issue("2")], total: 10 }]);
  const result = await selectBacklog({
    organizationId: "org_1",
    board: board(),
    client,
    proposals: {
      liveExternalIds: (_org, _board, ids) => Promise.resolve(new Set(ids)),
    },
    scanLimit: 2,
  });

  assert.equal(result.scanLimitReached, true);
  assert.equal(result.issues.length, 0);
  assert.equal(client.calls[0]?.maxResults, 2);
});

test("a short page stops even when Jira omits total", async () => {
  const client = reader([{ issues: [issue("1")] }]);
  const result = await selectBacklog({
    organizationId: "org_1",
    board: board(),
    client,
  });

  assert.equal(result.issues.length, 1);
  assert.equal(client.calls.length, 1);
});

test("Kanban uses board issues and invalid board ids fail explicitly", async () => {
  let boardReads = 0;
  const client: BacklogPageReader = {
    backlogIssues: () => {
      throw new Error("wrong source");
    },
    boardIssues: () => {
      boardReads += 1;
      return Promise.resolve({ issues: [] });
    },
  };
  const selected = await selectBacklog({
    organizationId: "org_1",
    board: board({ boardType: "kanban" }),
    client,
  });
  assert.equal(selected.source, "board-issues");
  assert.equal(boardReads, 1);

  await assert.rejects(
    selectBacklog({
      organizationId: "org_1",
      board: board({ externalId: "not-a-number" }),
      client,
    }),
    InvalidBoardIdError,
  );
});
