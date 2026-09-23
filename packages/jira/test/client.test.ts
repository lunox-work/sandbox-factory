import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ApiTokenCredential,
  DETAIL_FIELDS,
  ISSUE_FIELDS,
  JiraApiError,
  JiraClient,
  toBoardDto,
  toIssueDetailDto,
  toIssueDto,
  toSprintDto,
} from "../src/index.js";

/** A credential with no network behind it, for testing the client alone. */
const credential = new ApiTokenCredential({
  siteUrl: "https://acme.atlassian.net",
  email: "user@acme.test",
  apiToken: "token-1",
});

interface StubResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** Serves canned responses in order, recording the URLs requested. */
function stubFetch(responses: StubResponse[]): {
  fetch: typeof globalThis.fetch;
  urls: string[];
} {
  const urls: string[] = [];
  let index = 0;
  const fetch = (async (url: string | URL | Request) => {
    urls.push(String(url));
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return new Response(
      response?.body === undefined ? "" : JSON.stringify(response.body),
      { status: response?.status ?? 200, headers: response?.headers },
    );
  }) as typeof globalThis.fetch;
  return { fetch, urls };
}

function client(
  responses: StubResponse[],
  options: { maxRetries?: number } = {},
): { urls: string[]; client: JiraClient } {
  const { fetch, urls } = stubFetch(responses);
  return {
    urls,
    client: new JiraClient({
      credential,
      siteUrl: "https://acme.atlassian.net",
      fetch,
      // Retries must not really wait, or the suite takes seconds.
      sleep: () => Promise.resolve(),
      ...(options.maxRetries === undefined
        ? {}
        : { maxRetries: options.maxRetries }),
    }),
  };
}

const rawIssue = {
  id: "10001",
  key: "ACME-1",
  fields: {
    summary: "Ship the thing",
    status: {
      name: "In Progress",
      statusCategory: { key: "indeterminate", name: "In Progress" },
    },
    assignee: { displayName: "Ada Lovelace" },
    priority: { name: "High" },
    issuetype: { name: "Story" },
    labels: ["backend"],
    project: { key: "ACME", name: "Acme" },
    created: "2026-09-01T00:00:00.000Z",
    updated: "2026-09-10T00:00:00.000Z",
  },
};

test("boards follows pagination to the end", async () => {
  const full = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1,
    name: `Board ${index + 1}`,
    type: "scrum",
  }));
  const { client: jira, urls } = client([
    { body: { values: full, isLast: false } },
    {
      body: {
        values: [{ id: 101, name: "Board 101", type: "kanban" }],
        isLast: true,
      },
    },
  ]);

  const boards = await jira.boards();

  assert.equal(boards.length, 101);
  assert.equal(boards[100]?.type, "kanban");
  // The second request continues from where the first stopped.
  assert.match(urls[1] ?? "", /startAt=100/);
});

test("boards stops on a short page even without isLast", async () => {
  const { client: jira, urls } = client([
    { body: { values: [{ id: 1, name: "B" }] } },
  ]);

  assert.equal((await jira.boards()).length, 1);
  assert.equal(urls.length, 1);
});

test("boards can be filtered to a project", async () => {
  const { client: jira, urls } = client([{ body: { values: [] } }]);

  await jira.boards({ projectKeyOrId: "ACME" });

  assert.match(urls[0] ?? "", /projectKeyOrId=ACME/);
});

test("boardIssues reads the agile board endpoint and flattens the issues", async () => {
  const { client: jira, urls } = client([
    { body: { issues: [rawIssue], total: 1, startAt: 0, maxResults: 50 } },
  ]);

  const page = await jira.boardIssues(42);

  assert.equal(page.issues.length, 1);
  assert.equal(page.issues[0]?.key, "ACME-1");
  assert.equal(page.issues[0]?.statusCategory, "indeterminate");
  assert.equal(page.total, 1);
  // Everything read, so no cursor.
  assert.equal(page.nextStartAt, undefined);
  assert.match(urls[0] ?? "", /\/rest\/agile\/1\.0\/board\/42\/issue\?/);
  // Named fields, not Jira's default: the default drags in every custom field.
  assert.match(urls[0] ?? "", /fields=summary/);
});

test("boardIssues reports the next offset while issues remain", async () => {
  const { client: jira } = client([
    { body: { issues: [rawIssue], total: 10, startAt: 0, maxResults: 1 } },
  ]);

  const page = await jira.boardIssues(42, { maxResults: 1 });

  assert.equal(page.nextStartAt, 1);
});

test("boardIssues infers more pages when Jira reports no total", async () => {
  const { client: jira } = client([{ body: { issues: [rawIssue] } }]);

  // A full page with no total: assume there is more rather than truncate.
  const page = await jira.boardIssues(42, { maxResults: 1 });

  assert.equal(page.nextStartAt, 1);
  assert.equal(page.total, undefined);
});

test("boardIssues targets the sprint endpoint when given a sprint", async () => {
  const { client: jira, urls } = client([{ body: { issues: [] } }]);

  await jira.boardIssues(42, { sprintId: 7 });

  assert.match(urls[0] ?? "", /\/board\/42\/sprint\/7\/issue\?/);
});

test("boardIssues passes extra JQL through but drops an empty one", async () => {
  const { client: jira, urls } = client([{ body: { issues: [] } }]);
  await jira.boardIssues(42, { jql: "status != Done" });
  assert.match(urls[0] ?? "", /jql=status\+%21%3D\+Done/);

  const { client: bare, urls: bareUrls } = client([{ body: { issues: [] } }]);
  await bare.boardIssues(42, { jql: "" });
  assert.ok(!(bareUrls[0] ?? "").includes("jql="));
});

test("a page size over Jira's ceiling is capped", async () => {
  const { client: jira, urls } = client([{ body: { issues: [] } }]);

  await jira.boardIssues(42, { maxResults: 5000 });

  assert.match(urls[0] ?? "", /maxResults=100/);
});

test("backlogIssues reads the backlog endpoint", async () => {
  const { client: jira, urls } = client([{ body: { issues: [rawIssue] } }]);

  const page = await jira.backlogIssues(42, { startAt: 10 });

  assert.equal(page.issues.length, 1);
  assert.match(urls[0] ?? "", /\/board\/42\/backlog\?/);
  assert.match(urls[0] ?? "", /startAt=10/);
});

test("sprints maps the values and can filter by state", async () => {
  const { client: jira, urls } = client([
    {
      body: {
        values: [
          {
            id: 7,
            name: "Sprint 7",
            state: "active",
            startDate: "2026-09-01T00:00:00.000Z",
            endDate: "2026-09-14T00:00:00.000Z",
            goal: "Ship it",
          },
        ],
      },
    },
  ]);

  const sprints = await jira.sprints(42, { state: "active" });

  assert.equal(sprints.length, 1);
  assert.equal(sprints[0]?.name, "Sprint 7");
  assert.equal(sprints[0]?.goal, "Ship it");
  assert.match(urls[0] ?? "", /state=active/);
});

test("search uses the token-paginated JQL endpoint", async () => {
  const { client: jira, urls } = client([
    { body: { issues: [rawIssue], nextPageToken: "cursor-1" } },
  ]);

  const page = await jira.search("project = ACME");

  assert.equal(page.issues.length, 1);
  assert.equal(page.nextPageToken, "cursor-1");
  // `/search/jql`, not the removed offset-paginated `/search`.
  assert.match(urls[0] ?? "", /\/rest\/api\/3\/search\/jql\?/);
});

test("search continues from a cursor", async () => {
  const { client: jira, urls } = client([{ body: { issues: [] } }]);

  await jira.search("project = ACME", { nextPageToken: "cursor-1" });

  assert.match(urls[0] ?? "", /nextPageToken=cursor-1/);
});

test("issue reads one by key and builds a browse link", async () => {
  const { client: jira, urls } = client([{ body: rawIssue }]);

  const issue = await jira.issue("ACME-1");

  assert.equal(issue.key, "ACME-1");
  assert.equal(issue.url, "https://acme.atlassian.net/browse/ACME-1");
  assert.match(urls[0] ?? "", /\/rest\/api\/3\/issue\/ACME-1\?/);
});

test("an issue key is URL-encoded", async () => {
  const { client: jira, urls } = client([{ body: rawIssue }]);

  await jira.issue("ACME 1/2");

  assert.match(urls[0] ?? "", /issue\/ACME%201%2F2\?/);
});

test("without a site URL an issue carries no browse link", async () => {
  const { fetch } = stubFetch([{ body: rawIssue }]);
  const jira = new JiraClient({ credential, fetch });

  assert.equal((await jira.issue("ACME-1")).url, null);
});

test("Jira's own error messages are surfaced", async () => {
  const { client: jira } = client([
    { status: 400, body: { errorMessages: ["The JQL is invalid."] } },
  ]);

  const error = await jira
    .search("nonsense !!")
    .catch((caught: unknown) => caught);

  assert.ok(error instanceof JiraApiError);
  assert.equal(error.status, 400);
  assert.equal(error.message, "The JQL is invalid.");
  assert.deepEqual(error.errors, ["The JQL is invalid."]);
});

test("the gateway's own error message is surfaced", async () => {
  // `api.atlassian.com` sits in front of Jira and reports its own refusals as
  // `{ code, message }` rather than Jira's `errorMessages` list. Reading only
  // the list leaves every gateway rejection wearing the generic 401 text —
  // and discards "scope does not match", which is the only thing separating an
  // app that was never granted a scope from a grant the user revoked.
  const { client: jira } = client([
    {
      status: 401,
      body: { code: 401, message: "Unauthorized; scope does not match" },
    },
  ]);

  const error = await jira.boards().catch((caught: unknown) => caught);

  assert.ok(error instanceof JiraApiError);
  assert.equal(error.message, "Unauthorized; scope does not match");
});

test("Jira's own messages win over the gateway's summary", async () => {
  // Both shapes at once: the specific list is the more useful of the two.
  const { client: jira } = client([
    {
      status: 400,
      body: { errorMessages: ["The JQL is invalid."], message: "Bad Request" },
    },
  ]);

  const error = await jira
    .search("nonsense")
    .catch((caught: unknown) => caught);

  assert.ok(error instanceof JiraApiError);
  assert.equal(error.message, "The JQL is invalid.");
});

test("a 404 is not reported as deleted", async () => {
  const { client: jira } = client([{ status: 404, body: {} }]);

  const error = await jira.issue("ACME-9").catch((caught: unknown) => caught);

  assert.ok(error instanceof JiraApiError);
  assert.equal(error.isNotFound, true);
  // Jira conflates "gone" with "not visible" so board ids cannot be enumerated.
  assert.match(error.message, /not visible/);
});

test("401 and 403 are distinguishable, and 403 hints at scopes", async () => {
  const { client: unauthorized } = client([{ status: 401, body: {} }]);
  const first = await unauthorized.boards().catch((caught: unknown) => caught);
  assert.ok(first instanceof JiraApiError);
  assert.equal(first.isUnauthorized, true);
  assert.match(first.message, /Reconnect/);

  const { client: forbidden } = client([{ status: 403, body: {} }]);
  const second = await forbidden.boards().catch((caught: unknown) => caught);
  assert.ok(second instanceof JiraApiError);
  assert.equal(second.isForbidden, true);
  assert.match(second.message, /scope/);
});

test("a non-JSON error body falls back to the status description", async () => {
  const { fetch } = stubFetch([]);
  const jira = new JiraClient({
    credential,
    fetch: (async () =>
      new Response("<html>502</html>", {
        status: 503,
      })) as typeof globalThis.fetch,
    maxRetries: 0,
    sleep: () => Promise.resolve(),
  });
  void fetch;

  const error = await jira.boards().catch((caught: unknown) => caught);

  assert.ok(error instanceof JiraApiError);
  assert.match(error.message, /HTTP 503/);
});

test("a 429 is retried and then succeeds", async () => {
  const { client: jira, urls } = client([
    { status: 429, headers: { "retry-after": "0" } },
    { body: { values: [{ id: 1, name: "Board" }] } },
  ]);

  const boards = await jira.boards();

  assert.equal(boards.length, 1);
  assert.equal(urls.length, 2);
});

test("a 5xx is retried up to the limit and then reported", async () => {
  const { client: jira, urls } = client([{ status: 500, body: {} }], {
    maxRetries: 2,
  });

  const error = await jira.boards().catch((caught: unknown) => caught);

  assert.ok(error instanceof JiraApiError);
  // The first attempt plus two retries.
  assert.equal(urls.length, 3);
});

test("a rate limit that exhausts its retries is flagged as such", async () => {
  const { client: jira } = client(
    [{ status: 429, headers: { "retry-after": "0" } }],
    {
      maxRetries: 0,
    },
  );

  const error = await jira.boards().catch((caught: unknown) => caught);

  assert.ok(error instanceof JiraApiError);
  assert.equal(error.isRateLimited, true);
});

test("an unreadable Retry-After does not stop the retry", async () => {
  const { client: jira, urls } = client([
    { status: 429, headers: { "retry-after": "soon" } },
    { body: { values: [] } },
  ]);

  await jira.boards();

  assert.equal(urls.length, 2);
});

test("a 400 is not retried", async () => {
  const { client: jira, urls } = client([{ status: 400, body: {} }]);

  await jira.boards().catch(() => undefined);

  assert.equal(urls.length, 1);
});

test("mapping fills in what a sparse Jira instance omits", () => {
  // A board with no screen configuration: every optional field absent.
  const issue = toIssueDto({ id: "1", key: "ACME-2" });

  assert.equal(issue.summary, "(no summary)");
  assert.equal(issue.status, "Unknown");
  assert.equal(issue.statusCategory, "unknown");
  assert.equal(issue.assignee, null);
  assert.equal(issue.issueType, "Task");
  assert.deepEqual(issue.labels, []);
  assert.equal(issue.url, null);
});

test("an unrecognised status category is never guessed at", () => {
  const issue = toIssueDto({
    id: "1",
    key: "ACME-3",
    fields: { status: { name: "Blocked", statusCategory: { key: "To Do" } } },
  });

  // Filing it as `new` would silently misreport whether the task is outstanding.
  assert.equal(issue.statusCategory, "unknown");
});

test("status categories are normalised case-insensitively", () => {
  const issue = toIssueDto({
    id: "1",
    key: "ACME-4",
    fields: { status: { statusCategory: { key: "DONE" } } },
  });

  assert.equal(issue.statusCategory, "done");
});

test("a board falls back to displayName when there is no project name", () => {
  const board = toBoardDto({
    id: 1,
    name: "Board",
    location: { displayName: "Acme (ACME)" },
  });

  assert.equal(board.projectName, "Acme (ACME)");
  assert.equal(board.projectKey, null);
  assert.equal(board.type, "unknown");
});

test("a sprint with no state or dates still maps", () => {
  const sprint = toSprintDto({ id: 1, name: "Sprint 1" });

  assert.equal(sprint.state, "unknown");
  assert.equal(sprint.startDate, null);
  assert.equal(sprint.goal, null);
});

test("a trailing slash on the site URL does not double up in a browse link", () => {
  const issue = toIssueDto(rawIssue, {
    siteUrl: "https://acme.atlassian.net/",
  });

  assert.equal(issue.url, "https://acme.atlassian.net/browse/ACME-1");
});

test("issueSpec reads the description and hashes what it read", async () => {
  const { client: jira, urls } = client([
    {
      body: {
        id: "10001",
        key: "ACME-1",
        fields: {
          summary: "Add export",
          description: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "Adds CSV." }],
              },
            ],
          },
          issuetype: { name: "Story" },
          updated: "2026-09-20T00:00:00.000Z",
        },
      },
    },
  ]);

  const spec = await jira.issueSpec("ACME-1");

  assert.equal(spec.summary, "Add export");
  assert.equal(spec.descriptionText, "Adds CSV.");
  assert.equal(spec.issueType, "Story");
  assert.match(spec.specHash, /^[0-9a-f]{64}$/);
  // The one call that asks Jira for `description`.
  assert.match(urls[0] ?? "", /fields=summary%2Cdescription/);
});

test("the list reads never ask Jira for a description", async () => {
  // The guarantee behind storing no ticket text: a board or backlog read
  // cannot pull it even by accident, so only `issueSpec` ever sees it.
  const { client: jira, urls } = client([
    { body: { issues: [] } },
    { body: { issues: [] } },
    { body: { values: [] } },
  ]);

  await jira.boardIssues(42);
  await jira.backlogIssues(42);
  await jira.search("project = ACME");

  for (const url of urls) {
    assert.ok(!url.includes("description"), `${url} requested a description`);
  }
});

/* The detail read: the second of the two calls that see ticket text. */

test("DETAIL_FIELDS asks for the description; ISSUE_FIELDS still does not", () => {
  // The guarantee the package makes: a board or backlog read cannot pull a
  // client's ticket contents, however many fields the detail call grows.
  assert.ok(DETAIL_FIELDS.includes("description"));
  assert.ok(!ISSUE_FIELDS.includes("description"));
  // And the detail read is a superset, so the two cannot describe a ticket
  // differently.
  for (const field of ISSUE_FIELDS) {
    assert.ok(DETAIL_FIELDS.includes(field), `missing ${field}`);
  }
});

test("toIssueDetailDto resolves the fields Jira nests", () => {
  const detail = toIssueDetailDto(
    {
      id: "1",
      key: "ACME-1",
      fields: {
        summary: "Add export",
        status: { name: "To Do", statusCategory: { key: "new" } },
        issuetype: { name: "Story" },
        description: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Adds CSV." }],
            },
          ],
        },
        reporter: { displayName: "Dana" },
        creator: { displayName: "Sam" },
        resolution: { name: "Done" },
        components: [{ name: "api" }, { name: "web" }],
        fixVersions: [{ name: "1.2" }],
        timeoriginalestimate: 7200,
        votes: { votes: 4 },
        watches: { watchCount: 2 },
      },
    } as never,
    { siteUrl: "https://acme.atlassian.net" },
  );

  assert.equal(detail.descriptionText, "Adds CSV.");
  assert.equal(detail.reporter, "Dana");
  assert.equal(detail.creator, "Sam");
  assert.equal(detail.resolution, "Done");
  assert.deepEqual(detail.components, ["api", "web"]);
  assert.deepEqual(detail.fixVersions, ["1.2"]);
  assert.equal(detail.originalEstimateSeconds, 7200);
  assert.equal(detail.votes, 4);
  assert.equal(detail.watchers, 2);
  // Shared fields come from `toIssueDto`, so the two cannot disagree.
  assert.equal(detail.summary, "Add export");
  assert.equal(detail.url, "https://acme.atlassian.net/browse/ACME-1");
});

test("a ticket missing every optional field still maps", () => {
  // Jira's fields are screen-configurable; a site can omit almost all of them.
  const detail = toIssueDetailDto({
    id: "1",
    key: "ACME-2",
    fields: { summary: "Bare" },
  } as never);

  assert.equal(detail.descriptionText, "");
  assert.equal(detail.reporter, null);
  assert.equal(detail.resolution, null);
  assert.deepEqual(detail.components, []);
  assert.equal(detail.originalEstimateSeconds, null);
  assert.equal(detail.votes, null);
});

test("comments paginate for explicit write recovery", async () => {
  const { client: jira, urls } = client([
    { body: { comments: [{ id: "1", body: { type: "doc" } }], total: 2 } },
    { body: { comments: [{ id: "2", body: { type: "doc" } }], total: 2 } },
  ]);
  const comments = await jira.comments("ACME-1");
  assert.deepEqual(
    comments.map(({ id }) => id),
    ["1", "2"],
  );
  assert.equal(new URL(urls[1] ?? "").searchParams.get("startAt"), "1");
});

test("issueSpec hands its signal to fetch and stops retrying once it aborts", async () => {
  const controller = new AbortController();
  const signals: (AbortSignal | null | undefined)[] = [];
  const jira = new JiraClient({
    credential,
    fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
      signals.push(init?.signal);
      return new Response("{}", { status: 503 });
    }) as typeof globalThis.fetch,
    maxRetries: 2,
    // The lease is lost while the client waits to retry.
    sleep: () => {
      controller.abort();
      return Promise.resolve();
    },
  });

  const error = await jira
    .issueSpec("ACME-1", controller.signal)
    .catch((caught: unknown) => caught);

  assert.equal(signals.length, 1);
  assert.equal(signals[0], controller.signal);
  assert.ok(error instanceof Error && error.name === "AbortError");
});
