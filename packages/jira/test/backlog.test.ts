import assert from "node:assert/strict";
import { test } from "node:test";

import { boardSelectionSchema } from "@sandbox-factory/shared";

import { backlogJql, backlogSource, SKIP_LABEL } from "../src/backlog.js";

/** The defaults, which is what a board registered with no settings gets. */
const defaults = boardSelectionSchema.parse({});

function jql(overrides: Record<string, unknown> = {}, options = {}): string {
  return backlogJql(boardSelectionSchema.parse(overrides), {
    now: new Date("2026-09-21T00:00:00.000Z"),
    ...options,
  });
}

test("the ordering is oldest first, which is the whole point", () => {
  assert.match(jql(), /ORDER BY created ASC/);
});

test("ties break on key, so two runs read the same tickets", () => {
  // Several tickets created in the same minute is common after an import, and
  // an unstable order would make "the next ten" arbitrary.
  assert.match(jql(), /ORDER BY created ASC, key ASC/);
});

test("epics and sub-tasks are excluded structurally", () => {
  // An epic is a container for work rather than work; a sub-task is priced
  // with its parent.
  assert.match(jql(), /issuetype not in \(Epic, subTaskIssueTypes\(\)\)/);
});

test("assigned tickets are skipped by default", () => {
  // A bounty on a ticket someone already owns is a conflict.
  assert.match(jql(), /assignee is EMPTY/);
  assert.ok(!jql({ excludeAssigned: false }).includes("assignee is EMPTY"));
});

test("the opt-out label excludes a ticket that carries it among others", () => {
  // `not in`, not `!=`: a ticket labelled both `bounty-skip` and `backend`
  // must still be excluded.
  const query = jql();
  assert.match(query, /labels not in \("bounty-skip"\)/);
  // And a ticket with no labels at all is still eligible.
  assert.match(query, /labels is EMPTY OR/);
  assert.equal(SKIP_LABEL, "bounty-skip");
});

test("an issue-type filter is applied when one is set", () => {
  assert.match(
    jql({ issueTypes: ["Story", "Bug"] }),
    /issuetype in \("Story", "Bug"\)/,
  );
});

test("no issue-type filter is added when the list is empty", () => {
  // Empty means "anything that is not an epic or a sub-task", which the
  // structural exclusion already covers.
  assert.ok(!jql().includes("issuetype in ("));
});

test("an issue type containing a quote cannot escape the literal", () => {
  // The injection boundary: `issueTypes` arrives from a request body. Without
  // escaping, this would close the string and the rest would parse as JQL.
  const query = jql({
    issueTypes: ['Story" OR project = "SECRET'],
  });

  // The quote is escaped, so the whole thing stays one literal.
  assert.match(query, /issuetype in \("Story\\" OR project = \\"SECRET"\)/);
  // And the injected clause is not a clause.
  assert.ok(!/ OR project = "SECRET"/.test(query.replace(/\\"/g, "")));
});

test("a backslash in an issue type is escaped before the quotes", () => {
  // Escaping quotes first would leave `\"` looking like an escaped quote.
  assert.match(jql({ issueTypes: ["back\\slash"] }), /"back\\\\slash"/);
});

test("age bounds become dates JQL understands", () => {
  const query = jql(
    { minAgeDays: 30, maxAgeDays: 365 },
    { now: new Date("2026-09-21T00:00:00.000Z") },
  );

  // 30 days before 2026-09-21.
  assert.match(query, /created <= "2026\/08\/22"/);
  // 365 days before.
  assert.match(query, /created >= "2025\/09\/21"/);
});

test("no age clause is added when neither bound is set", () => {
  assert.ok(!jql().includes("created <="));
  assert.ok(!jql().includes("created >="));
});

test("a project key is quoted and applied", () => {
  assert.match(jql({}, { projectKey: "ACME" }), /project = "ACME"/);
  assert.ok(!jql({}, { projectKey: "" }).includes("project ="));
});

test("the backlog endpoint is not told to exclude Done", () => {
  // It returns incomplete issues by definition, and restating that would be a
  // claim that could drift from what Jira means by it.
  assert.ok(!jql().includes("statusCategory"));
});

test("reading board issues instead does filter to To Do", () => {
  // `/board/{id}/issue` returns everything on the board, including Done.
  assert.match(jql({}, { source: "board-issues" }), /statusCategory = "To Do"/);
});

test("a Kanban board is read through board issues, not the backlog", () => {
  // A plain Kanban board has no backlog endpoint: its first column is the
  // backlog.
  assert.equal(backlogSource("kanban"), "board-issues");
  assert.equal(backlogSource("KANBAN"), "board-issues");
});

test("scrum and unknown board types use the backlog endpoint", () => {
  // Guessing the other way would silently read sprint-assigned tickets as
  // though they were backlog.
  assert.equal(backlogSource("scrum"), "backlog");
  assert.equal(backlogSource("unknown"), "backlog");
  assert.equal(backlogSource(""), "backlog");
});

test("the defaults are the ones the plan specifies", () => {
  assert.equal(defaults.maxTickets, 10);
  assert.equal(defaults.excludeAssigned, true);
  assert.equal(defaults.minAgeDays, 0);
  assert.equal(defaults.maxAgeDays, undefined);
  assert.equal(defaults.minSpecChars, 0);
  assert.deepEqual(defaults.issueTypes, []);
});

test("maxTickets is capped, so one run cannot spend without limit", () => {
  // It is the ceiling on what a run costs in model calls.
  assert.equal(
    boardSelectionSchema.safeParse({ maxTickets: 500 }).success,
    false,
  );
  assert.equal(
    boardSelectionSchema.safeParse({ maxTickets: 0 }).success,
    false,
  );
  assert.equal(boardSelectionSchema.parse({ maxTickets: 50 }).maxTickets, 50);
});

test("every clause is joined with AND", () => {
  // A stray OR would widen the selection rather than narrow it, which is the
  // dangerous direction: it would price tickets nobody asked about.
  const query = jql({ issueTypes: ["Story"], minAgeDays: 1 });
  const [filter = ""] = query.split(" ORDER BY");

  // The only OR is the parenthesised label check.
  const withoutLabels = filter.replace(/\(labels[^)]*\)/, "");
  assert.ok(!withoutLabels.includes(" OR "));
});
