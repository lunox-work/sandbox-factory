import assert from "node:assert/strict";
import { test } from "node:test";

import { CATEGORIES } from "sandbox-factory";

import {
  accessibleResourceSchema,
  boardPricingSchema,
  boardSelectionSchema,
  boardSelectionUpdateSchema,
  jiraBoardPageResponseSchema,
  jiraBoardSummarySchema,
  jiraBoardResponseSchema,
  jiraIssueDtoSchema,
  jiraIssuePageResponseSchema,
  jiraIssueResponseSchema,
  jiraIssueSignalsDtoSchema,
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

test("board selection defaults to every match, with nothing filtered", () => {
  const selection = boardSelectionSchema.parse({});

  // No count limit: a run takes every ticket that fits a category.
  assert.equal(selection.ticketCap, undefined);
  assert.equal(selection.unassignedOnly, false);
  assert.equal(selection.minSpecChars, 0);
  assert.equal(selection.maxAgeDays, undefined);
  assert.deepEqual(selection.categories, {});
});

test("settings from before categories are dropped, not honoured", () => {
  // Registration stored resolved defaults, so older boards hold these two.
  // Reading them would leave every such board capped at ten tickets.
  const selection = boardSelectionSchema.parse({
    maxTickets: 10,
    excludeAssigned: true,
    minAgeDays: 7,
  });

  assert.equal("maxTickets" in selection, false);
  assert.equal("excludeAssigned" in selection, false);
  assert.equal(selection.ticketCap, undefined);
  assert.equal(selection.unassignedOnly, false);
  assert.equal(selection.minAgeDays, 7);
});

test("ticketCap is optional, and bounded when it is set", () => {
  assert.equal(boardSelectionSchema.parse({ ticketCap: 25 }).ticketCap, 25);
  for (const ticketCap of [0, 5_001, 1.5]) {
    assert.equal(boardSelectionSchema.safeParse({ ticketCap }).success, false);
  }
});

test("every category and threshold in the registry can be set", () => {
  // The schema is generated from the registry, so adding a category there
  // is all it takes for a board to be able to tune it.
  for (const category of CATEGORIES) {
    const thresholds = Object.fromEntries(
      Object.keys(category.defaults).map((name) => [name, 7]),
    );
    const parsed = boardSelectionSchema.parse({
      categories: { [category.id]: { enabled: false, thresholds } },
    });
    assert.deepEqual(parsed.categories[category.id], {
      enabled: false,
      thresholds,
    });
  }
});

test("stored category settings survive a category being renamed or retired", () => {
  // A board tuned last month must still load after the registry changes.
  const parsed = boardSelectionSchema.parse({
    categories: {
      "a-retired-category": { enabled: false },
      "left-behind": {
        enabled: true,
        thresholds: { minAgeDays: 30, aRetiredThreshold: 5, minQuietDays: -4 },
      },
    },
  });

  assert.deepEqual(Object.keys(parsed.categories), ["left-behind"]);
  // As it is stored: JSON, where an unusable threshold is simply absent.
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.categories)), {
    "left-behind": { enabled: true, thresholds: { minAgeDays: 30 } },
  });
});

test("an update refuses a category or threshold that does not exist", () => {
  // Dropping it silently would look like it had been saved.
  const update = (categories: unknown) =>
    boardSelectionUpdateSchema.safeParse({ categories }).success;

  assert.equal(
    update({ "left-behind": { thresholds: { minAgeDays: 30 } } }),
    true,
  );
  assert.equal(update({ "left-behind": { enabled: false } }), true);
  // Null clears an override back to the registry's default.
  assert.equal(
    update({ "left-behind": { thresholds: { minAgeDays: null } } }),
    true,
  );
  assert.equal(update({ "no-such-category": { enabled: false } }), false);
  assert.equal(
    update({ "left-behind": { thresholds: { minAge: 30 } } }),
    false,
  );
  assert.equal(
    update({ "left-behind": { thresholds: { minAgeDays: -1 } } }),
    false,
  );
  assert.equal(
    update({ "left-behind": { thresholds: { minAgeDays: 1.5 } } }),
    false,
  );
  assert.equal(update({ "left-behind": { colour: "red" } }), false);
});

test("an update can remove the ticket cap", () => {
  assert.equal(
    boardSelectionUpdateSchema.parse({ ticketCap: null }).ticketCap,
    null,
  );
  assert.equal(
    boardSelectionUpdateSchema.safeParse({ ticketCap: 0 }).success,
    false,
  );
});

test("the signals DTO carries counts, dates and names, and no ticket text", () => {
  const parsed = jiraIssueSignalsDtoSchema.parse({
    id: "1",
    key: "ACME-1",
    summary: "Ship the thing",
    status: "To Do",
    statusCategory: "new",
    assignee: null,
    priority: "Low",
    issueType: "Bug",
    labels: [],
    projectKey: "ACME",
    parentKey: null,
    created: "2026-01-01T00:00:00.000Z",
    updated: "2026-01-02T00:00:00.000Z",
    dueDate: null,
    url: null,
    sprint: null,
    closedSprints: [{ name: "Sprint 7", startDate: null, endDate: null }],
    votes: 2,
    watchers: null,
    links: [
      {
        type: "Blocks",
        direction: "outward",
        key: "ACME-2",
        statusCategory: "new",
      },
    ],
    releases: [{ name: "2.1", releaseDate: "2026-10-10", released: false }],
  });

  assert.equal(parsed.closedSprints.length, 1);
  assert.equal("description" in jiraIssueSignalsDtoSchema.shape, false);
  assert.equal("comments" in jiraIssueSignalsDtoSchema.shape, false);
});

test("an issue's signal fields parse, and an odd one falls back to absent", () => {
  const parsed = jiraIssueResponseSchema.parse({
    id: "1",
    key: "ACME-1",
    fields: {
      sprint: null,
      closedSprints: [{ id: 7, name: "Sprint 7", state: "closed" }],
      votes: "four",
      watches: { watchCount: 9 },
      issuelinks: [
        { type: { name: "Blocks" }, outwardIssue: { key: "ACME-2" } },
      ],
      fixVersions: [{ name: "2.1", releaseDate: "2026-10-10" }],
    },
  });

  assert.equal(parsed.fields?.sprint, null);
  assert.equal(parsed.fields?.closedSprints?.[0]?.name, "Sprint 7");
  assert.equal(parsed.fields?.votes, undefined);
  assert.equal(parsed.fields?.watches?.watchCount, 9);
  assert.equal(parsed.fields?.issuelinks?.[0]?.outwardIssue?.key, "ACME-2");
  assert.equal(parsed.fields?.fixVersions?.[0]?.name, "2.1");
});

test("a stored null on a clearable setting reads as absent", () => {
  // Clearing a bound once stored the null itself. Such a row must still load.
  const selection = boardSelectionSchema.parse({
    ticketCap: null,
    maxAgeDays: null,
  });

  assert.equal(selection.ticketCap, undefined);
  assert.equal(selection.maxAgeDays, undefined);
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
    updateBoardSchema.safeParse({ selection: { ticketCap: 5 } }).success,
    true,
  );
  assert.equal(
    updateBoardSchema.safeParse({ writebackEnabled: true }).success,
    false,
  );
  assert.equal(updateBoardSchema.safeParse({}).success, false);
});

test("a partial selection update does not reimpose the defaults", () => {
  // Editing `ticketCap` alone must not silently reset `unassignedOnly`.
  const parsed = updateBoardSchema.parse({ selection: { ticketCap: 5 } });

  assert.equal(parsed.selection?.ticketCap, 5);
  assert.equal(parsed.selection?.unassignedOnly, undefined);
  assert.equal(parsed.selection?.categories, undefined);
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

  assert.equal(summary.selection.ticketCap, undefined);
  assert.equal("writebackEnabled" in summary, false);
  // A summary from before board pricing reads as every default.
  assert.deepEqual(summary.pricing, { step: {} });
});

test("an update may set pricing alone, and pricing updates are strict", () => {
  const parsed = updateBoardSchema.parse({
    pricing: { step: { pointsPerStep: 6, weightPoints: { heavy: null } } },
  });
  assert.equal(parsed.selection, undefined);
  assert.deepEqual(parsed.pricing, {
    step: { pointsPerStep: 6, weightPoints: { heavy: null } },
  });
  for (const step of [
    { pointsPerStep: 0 },
    { pointsPerStep: 1.5 },
    { pointsPerSteps: 4 },
    { weightPoints: { huge: 9 } },
    { weightPoints: { light: -1 } },
  ]) {
    assert.equal(
      updateBoardSchema.safeParse({ pricing: { step } }).success,
      false,
      JSON.stringify(step),
    );
  }
});

test("stored pricing drops what it cannot read rather than failing the board", () => {
  assert.deepEqual(boardPricingSchema.parse({}), { step: {} });
  const { step } = boardPricingSchema.parse({
    step: {
      pointsPerStep: 0,
      weightPoints: { light: 3, retired: 2, heavy: "lots" },
    },
  });
  assert.equal(step.pointsPerStep, undefined);
  assert.equal(step.weightPoints?.["light"], 3);
  assert.equal(step.weightPoints?.["heavy"], undefined);
  assert.equal(
    step.weightPoints !== undefined && "retired" in step.weightPoints,
    false,
  );
  assert.equal(
    boardPricingSchema.parse({ step: { weightPoints: "heavy" } }).step
      .weightPoints,
    undefined,
  );
  assert.deepEqual(boardPricingSchema.parse({ step: 7 }), { step: {} });
});
