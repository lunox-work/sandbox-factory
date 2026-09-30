import assert from "node:assert/strict";
import { test } from "node:test";

import { boardSelectionSchema } from "@sandbox-factory/shared";

import { selectionJql, SKIP_LABEL } from "../src/selection-jql.js";

/** The defaults, which is what a board registered with no settings gets. */
const defaults = boardSelectionSchema.parse({});

function jql(overrides: Record<string, unknown> = {}, options = {}): string {
  return selectionJql(boardSelectionSchema.parse(overrides), {
    now: new Date("2026-09-21T00:00:00.000Z"),
    ...options,
  });
}

test("the order is stable, so two runs page the same tickets the same way", () => {
  // Every match is taken, so the order no longer decides which. It still has
  // to be total: several tickets created in the same minute is common after
  // an import, and an unstable order would repeat or skip one across pages.
  assert.match(jql(), /ORDER BY created ASC, key ASC$/);
});

test("epics and sub-tasks are excluded structurally", () => {
  // An epic is a container for work rather than work; a sub-task is priced
  // with its parent.
  assert.match(jql(), /issuetype not in \(Epic, subTaskIssueTypes\(\)\)/);
});

test("assigned tickets are candidates unless the board says otherwise", () => {
  // The categories that need an unowned ticket test for it themselves. A
  // blanket filter here would hide a ticket carried through four sprints,
  // which usually has an owner.
  assert.ok(!jql().includes("assignee is EMPTY"));
  assert.match(jql({ unassignedOnly: true }), /assignee is EMPTY/);
});

test("settings from before categories are not read", () => {
  // Boards registered then have these written into their rows. They must
  // not resurrect the old filter.
  const legacy = jql({ maxTickets: 10, excludeAssigned: true });
  assert.equal(legacy, jql());
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

test("finished work is excluded, and started work is not", () => {
  // The board endpoint returns everything on the board. "Not done" rather
  // than "to do": a ticket started and never finished is still open.
  assert.match(jql(), /statusCategory != Done/);
  assert.ok(!jql().includes('statusCategory = "To Do"'));
});

test("the defaults select every match and filter nothing extra", () => {
  assert.equal(defaults.ticketCap, undefined);
  assert.equal(defaults.unassignedOnly, false);
  assert.equal(defaults.minAgeDays, 0);
  assert.equal(defaults.maxAgeDays, undefined);
  assert.equal(defaults.minSpecChars, 0);
  assert.deepEqual(defaults.issueTypes, []);
  assert.deepEqual(defaults.categories, {});
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
