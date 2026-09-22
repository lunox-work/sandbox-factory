import assert from "node:assert/strict";
import { test } from "node:test";

import {
  accessibleResourceSchema,
  boardSelectionSchema,
  jiraBoardPageResponseSchema,
  jiraBoardSummarySchema,
  jiraBoardResponseSchema,
  jiraIssueDtoSchema,
  jiraIssuePageResponseSchema,
  jiraIssueResponseSchema,
  jiraSiteDtoSchema,
  jiraSprintPageResponseSchema,
  jiraStatusCategorySchema,
  registerBoardSchema,
  tokenResponseSchema,
  updateBoardSchema,
} from "../src/index.js";

/*
 * The response schemas exist to be forgiving, so most of what is worth testing
 * is what they let through rather than what they reject. Each case below is a
 * payload a real Jira site can send, and a strict schema would turn each one
 * into a failed board rather than a rendered one.
 */

test("an issue parses with nothing but the two fields Jira guarantees", () => {
  // Every other field is screen-configurable and a project admin can remove it.
  const parsed = jiraIssueResponseSchema.parse({ id: "1", key: "ACME-1" });

  assert.equal(parsed.id, "1");
  assert.equal(parsed.fields, undefined);
});

test("an issue keeps unknown fields rather than failing on them", () => {
  // Jira adds fields continuously; an unknown one must never be an error.
  const parsed = jiraIssueResponseSchema.parse({
    id: "1",
    key: "ACME-1",
    somethingNew: true,
  });

  assert.equal(parsed.id, "1");
});

test("a null assignee, priority and parent are all accepted", () => {
  // Jira sends explicit nulls for these, not absences.
  const parsed = jiraIssueResponseSchema.parse({
    id: "1",
    key: "ACME-1",
    fields: { assignee: null, priority: null, parent: null, duedate: null },
  });

  assert.equal(parsed.fields?.assignee, null);
});

test("an issue page with no issues parses as empty", () => {
  // An empty board is not an error, and `issues` is absent rather than [].
  assert.deepEqual(jiraIssuePageResponseSchema.parse({}).issues, []);
});

test("an issue page carries either cursor, since the two APIs differ", () => {
  const agile = jiraIssuePageResponseSchema.parse({ issues: [], total: 12 });
  assert.equal(agile.total, 12);
  assert.equal(agile.nextPageToken, undefined);

  const platform = jiraIssuePageResponseSchema.parse({
    issues: [],
    nextPageToken: "cursor-1",
  });
  assert.equal(platform.nextPageToken, "cursor-1");
  // `/search/jql` reports no total at all.
  assert.equal(platform.total, undefined);
});

test("a board parses without a location", () => {
  // A board built from a filter spanning projects has no single project.
  const parsed = jiraBoardResponseSchema.parse({ id: 1, name: "Board" });

  assert.equal(parsed.location, undefined);
});

test("a board page parses without isLast", () => {
  // Some instances omit it, which is why the client also stops on a short page.
  const parsed = jiraBoardPageResponseSchema.parse({
    values: [{ id: 1, name: "Board" }],
  });

  assert.equal(parsed.isLast, undefined);
  assert.equal(parsed.values.length, 1);
});

test("a sprint page with no values parses as empty", () => {
  assert.deepEqual(jiraSprintPageResponseSchema.parse({}).values, []);
});

test("a token response without a refresh token is valid", () => {
  // The `offline_access` trap: Atlassian omits it silently rather than failing.
  const parsed = tokenResponseSchema.parse({
    access_token: "a",
    expires_in: 3600,
  });

  assert.equal(parsed.refresh_token, undefined);
  assert.equal(parsed.scope, undefined);
});

test("a token response without an access token is refused", () => {
  // The one field that cannot be defaulted: there is no request without it.
  assert.equal(
    tokenResponseSchema.safeParse({ expires_in: 3600 }).success,
    false,
  );
});

test("an accessible resource defaults its scopes", () => {
  // `scopes` decides whether a site is a Jira site; an absent list means none.
  const parsed = accessibleResourceSchema.parse({
    id: "cloud-1",
    url: "https://acme.atlassian.net",
    name: "Acme",
  });

  assert.deepEqual(parsed.scopes, []);
});

test("unknown is a status category we produce, not one Jira sends", () => {
  // The client maps anything unrecognised to it rather than guessing `new`.
  assert.equal(jiraStatusCategorySchema.parse("unknown"), "unknown");
  assert.equal(jiraStatusCategorySchema.safeParse("To Do").success, false);
});

/*
 * The DTO schemas describe what we produce, so these are strict: a null that
 * should be a string is our bug, not Jira's.
 */

test("an issue DTO requires every field to be resolved", () => {
  const complete = {
    id: "1",
    key: "ACME-1",
    summary: "Ship it",
    status: "To Do",
    statusCategory: "new",
    assignee: null,
    priority: null,
    issueType: "Task",
    labels: [],
    projectKey: "ACME",
    parentKey: null,
    created: "2026-09-01T00:00:00.000Z",
    updated: "2026-09-02T00:00:00.000Z",
    dueDate: null,
    url: null,
  };

  assert.deepEqual(jiraIssueDtoSchema.parse(complete), complete);
  // Absent is not the same as null here: we always resolve it one way or other.
  const { assignee: _absent, ...missing } = complete;
  assert.equal(jiraIssueDtoSchema.safeParse(missing).success, false);
});

test("a site DTO carries the cloudId every REST call embeds", () => {
  const parsed = jiraSiteDtoSchema.parse({
    cloudId: "cloud-1",
    url: "https://acme.atlassian.net",
    name: "Acme",
    scopes: ["read:jira-work", "write:jira-work"],
  });

  assert.equal(parsed.cloudId, "cloud-1");
  assert.deepEqual(parsed.scopes, ["read:jira-work", "write:jira-work"]);
});

/* The board selection settings, which decide which tickets a run prices. */

test("board selection defaults to the plan's values", () => {
  const selection = boardSelectionSchema.parse({});

  assert.equal(selection.maxTickets, 10);
  assert.equal(selection.excludeAssigned, true);
  assert.equal(selection.minSpecChars, 0);
  assert.equal(selection.maxAgeDays, undefined);
});

test("maxTickets is bounded at both ends", () => {
  // It is the ceiling on what one run costs in model calls, so an unbounded
  // value is a spending decision made by whoever edits a board.
  assert.equal(
    boardSelectionSchema.safeParse({ maxTickets: 0 }).success,
    false,
  );
  assert.equal(
    boardSelectionSchema.safeParse({ maxTickets: 51 }).success,
    false,
  );
  assert.equal(
    boardSelectionSchema.safeParse({ maxTickets: 1.5 }).success,
    false,
  );
});

test("age bounds refuse nonsense", () => {
  assert.equal(
    boardSelectionSchema.safeParse({ minAgeDays: -1 }).success,
    false,
  );
  // 0 would mean "older than today", which is every ticket and no ticket.
  assert.equal(
    boardSelectionSchema.safeParse({ maxAgeDays: 0 }).success,
    false,
  );
});

test("registering a board needs a connection and a board id", () => {
  assert.equal(
    registerBoardSchema.safeParse({ connectionId: "jrc_1", externalId: "42" })
      .success,
    true,
  );
  assert.equal(
    registerBoardSchema.safeParse({ connectionId: "", externalId: "42" })
      .success,
    false,
  );
  assert.equal(
    registerBoardSchema.safeParse({ connectionId: "jrc_1" }).success,
    false,
  );
});

test("an update is a selection, and an empty body is refused", () => {
  // An empty body almost always means the caller sent the wrong shape. A
  // write-back flag is not a board setting any more: whether approvals post
  // back is the site's grant, asked for when the site is connected.
  assert.equal(
    updateBoardSchema.safeParse({ selection: { maxTickets: 5 } }).success,
    true,
  );
  assert.equal(
    updateBoardSchema.safeParse({ writebackEnabled: true }).success,
    false,
  );
  assert.equal(updateBoardSchema.safeParse({}).success, false);
});

test("a partial selection update does not reimpose the defaults", () => {
  // Editing `maxTickets` alone must not silently reset `excludeAssigned`.
  const parsed = updateBoardSchema.parse({ selection: { maxTickets: 5 } });

  assert.equal(parsed.selection?.maxTickets, 5);
  assert.equal(parsed.selection?.excludeAssigned, undefined);
});

test("a board summary carries the settings, not the tickets", () => {
  const summary = jiraBoardSummarySchema.parse({
    id: "jrb_1",
    connectionId: "jrc_1",
    externalId: "42",
    name: "Acme board",
    boardType: "scrum",
    projectKey: "ACME",
    selection: {},
    createdAt: "2026-09-21T00:00:00.000Z",
  });

  assert.equal(summary.selection.maxTickets, 10);
  assert.equal("writebackEnabled" in summary, false);
});
