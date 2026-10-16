import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BOUNTY_LABEL,
  ApiTokenCredential,
  CONTEXT_FIELDS,
  createFieldListCache,
  JiraApiError,
  JiraClient,
  storyPointFields,
  toFieldDefinitions,
  toJiraContext,
} from "../src/index.js";

const credential = new ApiTokenCredential({
  siteUrl: "https://acme.atlassian.net",
  email: "user@acme.test",
  apiToken: "token-1",
});

function client(
  responses: { status?: number; body?: unknown }[],
  fieldCache?: ReturnType<typeof createFieldListCache>,
) {
  const urls: string[] = [];
  let index = 0;
  const fetch = (async (url: string | URL | Request) => {
    urls.push(String(url));
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return new Response(
      response?.body === undefined ? "" : JSON.stringify(response.body),
      { status: response?.status ?? 200 },
    );
  }) as typeof globalThis.fetch;
  return {
    urls,
    client: new JiraClient({
      credential,
      siteUrl: "https://acme.atlassian.net",
      fetch,
      sleep: () => Promise.resolve(),
      maxRetries: 0,
      ...(fieldCache === undefined ? {} : { fieldCache }),
    }),
  };
}

const issue = {
  id: "10001",
  key: "ACME-1",
  fields: {
    summary: "Not read here",
    issuetype: { name: "Story" },
    status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
    priority: { name: "High" },
    labels: ["billing"],
    components: [{ name: "Payments" }, { nope: true }],
    fixVersions: [{ name: "2.4" }],
    parent: { key: "ACME-0" },
    duedate: "2026-11-01",
    timeoriginalestimate: 7200,
    timeestimate: null,
    votes: { votes: 2 },
    watches: { watchCount: 4 },
    subtasks: [{}, {}],
    issuelinks: [
      {
        type: { name: "Blocks" },
        inwardIssue: {
          key: "ACME-9",
          fields: { status: { statusCategory: { key: "done" } } },
        },
      },
      { type: { name: "Relates" }, outwardIssue: { key: "ACME-7" } },
      { type: { name: "Broken" } },
    ],
    updated: "2026-10-06T10:00:00.000+0000",
    customfield_10016: 5,
  },
};

test("story points are found by the site's own field name, numbers only", () => {
  const fields = toFieldDefinitions([
    {
      id: "customfield_10016",
      name: "Story point estimate",
      schema: { type: "number" },
    },
    {
      id: "customfield_10026",
      name: "Story Points",
      schema: { type: "number" },
    },
    { id: "customfield_1", name: "Story Points", schema: { type: "string" } },
    { id: "customfield_2", name: "Story pointer" },
    { id: 3, name: "Not a field" },
    null,
  ]);
  assert.deepEqual(storyPointFields(fields), [
    "customfield_10016",
    "customfield_10026",
  ]);
  assert.deepEqual(toFieldDefinitions({ fields: [] }), []);
});

test("an issue's context is its classification, size and links, never a person", () => {
  const context = toJiraContext(issue, ["customfield_10016"]);
  assert.deepEqual(context, {
    key: "ACME-1",
    issueType: "Story",
    status: "In Progress",
    statusCategory: "indeterminate",
    priority: "High",
    labels: ["billing"],
    components: ["Payments"],
    fixVersions: ["2.4"],
    parentKey: "ACME-0",
    dueDate: "2026-11-01",
    storyPoints: 5,
    originalEstimateSeconds: 7200,
    remainingEstimateSeconds: null,
    votes: 2,
    watchers: 4,
    subtaskCount: 2,
    links: [
      { type: "Blocks", direction: "inward", key: "ACME-9", done: true },
      { type: "Relates", direction: "outward", key: "ACME-7", done: false },
    ],
    updated: "2026-10-06T10:00:00.000+0000",
  });
  assert.equal(CONTEXT_FIELDS.includes("assignee"), false);
  assert.equal(CONTEXT_FIELDS.includes("description"), false);
});

test("the label the write-back adds is not read as the team's", () => {
  const labelled = {
    ...issue,
    fields: { ...issue.fields, labels: ["billing", BOUNTY_LABEL] },
  };
  assert.deepEqual(toJiraContext(labelled).labels, ["billing"]);
});

test("a sparse issue's context leaves what it lacks empty", () => {
  assert.deepEqual(toJiraContext({ id: "1", key: "ACME-2" }), {
    key: "ACME-2",
    issueType: null,
    status: null,
    statusCategory: null,
    priority: null,
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
    updated: null,
  });
});

test("issueContext asks for the context fields and the site's story points", async () => {
  const { client: jira, urls } = client([
    {
      body: [
        {
          id: "customfield_10016",
          name: "Story point estimate",
          schema: { type: "number" },
        },
      ],
    },
    { body: issue },
  ]);
  const context = await jira.issueContext("ACME-1");
  assert.equal(context.storyPoints, 5);
  assert.match(urls[0] ?? "", /\/rest\/api\/3\/field$/);
  const fields = new URL(urls[1] ?? "").searchParams.get("fields")?.split(",");
  assert.ok(fields?.includes("customfield_10016"));
  assert.ok(fields?.includes("issuelinks"));
});

test("a field list that cannot be read costs only the story points", async () => {
  const { client: jira } = client([{ status: 403 }, { body: issue }]);
  const context = await jira.issueContext("ACME-1");
  assert.equal(context.storyPoints, null);
  assert.equal(context.priority, "High");
});

test("an issue that cannot be read is Jira's error", async () => {
  const { client: jira } = client([{ body: [] }, { status: 404 }]);
  await assert.rejects(jira.issueContext("ACME-404"), JiraApiError);
});

test("a cancelled read is not taken for a site with no story points", async () => {
  const controller = new AbortController();
  controller.abort();
  const { client: jira } = client([{ body: [] }]);
  await assert.rejects(jira.issueContext("ACME-1", controller.signal));
});

test("a site's field list is read once for its issues, until it is an hour old", async () => {
  let clock = 0;
  const cache = createFieldListCache({ now: () => clock });
  const pointField = {
    id: "customfield_10016",
    name: "Story Points",
    schema: { type: "number" },
  };
  const { client: jira, urls } = client(
    [
      { body: [pointField] },
      { body: issue },
      { body: issue },
      { body: [pointField] },
      { body: issue },
    ],
    cache,
  );
  await jira.issueContext("ACME-1");
  const second = await jira.issueContext("ACME-2");
  assert.equal(second.storyPoints, 5);
  assert.equal(
    urls.filter((url) => url.endsWith("/rest/api/3/field")).length,
    1,
  );
  clock = 60 * 60_000;
  await jira.issueContext("ACME-3");
  assert.equal(
    urls.filter((url) => url.endsWith("/rest/api/3/field")).length,
    2,
  );
});

test("a field list that could not be read is asked for again", async () => {
  const cache = createFieldListCache();
  const { client: jira, urls } = client(
    [{ status: 403 }, { body: issue }, { body: [] }, { body: issue }],
    cache,
  );
  await jira.issueContext("ACME-1");
  await jira.issueContext("ACME-2");
  assert.equal(
    urls.filter((url) => url.endsWith("/rest/api/3/field")).length,
    2,
  );
});

test("the cache keeps the newest sites", () => {
  const cache = createFieldListCache({ maxSites: 2 });
  cache.set("a", ["one"]);
  cache.set("b", []);
  cache.set("a", ["two"]);
  cache.set("c", []);
  assert.equal(cache.get("b"), undefined);
  assert.deepEqual(cache.get("a"), ["two"]);
  assert.deepEqual(cache.get("c"), []);
});
