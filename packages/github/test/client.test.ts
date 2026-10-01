import assert from "node:assert/strict";
import { test } from "node:test";

import {
  errorFor,
  GithubApiError,
  GithubAuthError,
  GithubClient,
  GithubNetworkError,
  GithubNotFound,
  GithubRateLimited,
  REQUEST_TIMEOUT_MS,
} from "../src/index.js";
import { fakeFetch, json, type Recorded } from "./helpers.js";

const NOW = Date.parse("2026-10-01T00:00:00.000Z");

function clientWith(
  handler: (request: Recorded) => Response,
  options: { maxPages?: number; apiUrl?: string } = {},
) {
  const fetch = fakeFetch(handler);
  const client = new GithubClient({
    token: () => Promise.resolve("ghs_token"),
    fetch,
    now: () => NOW,
    ...options,
  });
  return { client, fetch };
}

const installation = (id: number, login: string) => ({
  id,
  account: { login, type: "Organization" },
  repository_selection: "all",
  permissions: { contents: "read", metadata: "read" },
});

test("every request carries the pinned headers and the provider's token", async () => {
  const { client, fetch } = clientWith(() => json({ login: "dana", id: 1 }));

  const user = await client.user();

  assert.equal(user.login, "dana");
  const headers = fetch.calls[0]?.headers ?? {};
  assert.equal(headers["authorization"], "Bearer ghs_token");
  assert.equal(headers["accept"], "application/vnd.github+json");
  assert.equal(headers["x-github-api-version"], "2022-11-28");
  assert.equal(headers["user-agent"], "sandbox-factory");
});

test("installations are read across every page the Link header names", async () => {
  const { client, fetch } = clientWith((request) =>
    request.url.endsWith("page=2")
      ? json({ total_count: 2, installations: [installation(2, "beta")] })
      : json(
          { total_count: 2, installations: [installation(1, "acme")] },
          200,
          {
            link: '<https://api.github.com/user/installations?per_page=100&page=2>; rel="next", <https://api.github.com/user/installations?per_page=100&page=2>; rel="last"',
          },
        ),
  );

  const installations = await client.userInstallations();

  assert.deepEqual(
    installations.map((entry) => entry.account?.login),
    ["acme", "beta"],
  );
  assert.deepEqual(
    fetch.calls.map((call) => call.url),
    [
      "https://api.github.com/user/installations?per_page=100",
      "https://api.github.com/user/installations?per_page=100&page=2",
    ],
  );
});

test("a next link to another host is not followed, so the token stays home", async () => {
  const { client, fetch } = clientWith(() =>
    json({ installations: [installation(1, "acme")] }, 200, {
      link: '<https://evil.example.test/steal?page=2>; rel="next"',
    }),
  );

  await client.userInstallations();

  assert.equal(fetch.calls.length, 1);
});

test("pages on an Enterprise host keep its API path once", async () => {
  // The link already carries /api/v3; prefixing the API URL again would ask
  // for /api/v3/api/v3/... and read page two as a 404.
  const { client, fetch } = clientWith(
    (request) =>
      request.url.endsWith("page=2")
        ? json({ installations: [installation(2, "beta")] })
        : json({ installations: [installation(1, "acme")] }, 200, {
            link: '<https://ghe.example.test/api/v3/user/installations?per_page=100&page=2>; rel="next"',
          }),
    { apiUrl: "https://ghe.example.test/api/v3/" },
  );

  const installations = await client.userInstallations();

  assert.equal(installations.length, 2);
  assert.deepEqual(
    fetch.calls.map((call) => call.url),
    [
      "https://ghe.example.test/api/v3/user/installations?per_page=100",
      "https://ghe.example.test/api/v3/user/installations?per_page=100&page=2",
    ],
  );
});

test("a next link on the same host but outside the API path is not followed", async () => {
  const { client, fetch } = clientWith(
    () =>
      json({ installations: [installation(1, "acme")] }, 200, {
        link: '<https://ghe.example.test/elsewhere?page=2>; rel="next"',
      }),
    { apiUrl: "https://ghe.example.test/api/v3" },
  );

  await client.userInstallations();

  assert.equal(fetch.calls.length, 1);
});

test("pagination stops at the page cap", async () => {
  const { client, fetch } = clientWith(
    () =>
      json({ installations: [installation(1, "acme")] }, 200, {
        link: '<https://api.github.com/user/installations?page=n>; rel="prev", <https://api.github.com/user/installations?page=n>; rel="next"',
      }),
    { maxPages: 3 },
  );

  const installations = await client.userInstallations();

  assert.equal(installations.length, 3);
  assert.equal(fetch.calls.length, 3);
});

test("an installation's repositories come with its selection", async () => {
  const { client } = clientWith(() =>
    json({
      total_count: 1,
      repository_selection: "selected",
      repositories: [
        {
          id: 1,
          full_name: "acme/widgets",
          private: true,
          default_branch: "main",
        },
      ],
    }),
  );

  const result = await client.installationRepositories();

  assert.equal(result.repositorySelection, "selected");
  assert.equal(result.repositories[0]?.full_name, "acme/widgets");
});

test("a repository is read by its numeric id, which survives renames", async () => {
  const { client, fetch } = clientWith(() =>
    json({ id: 1296269, full_name: "acme/widgets", default_branch: "main" }),
  );

  const repo = await client.repository("1296269");

  assert.equal(repo.full_name, "acme/widgets");
  assert.equal(
    fetch.calls[0]?.url,
    "https://api.github.com/repositories/1296269",
  );
});

test("a branch head is read from its ref, with the ETag kept", async () => {
  const sha = "a".repeat(40);
  const { client, fetch } = clientWith(() =>
    json(
      { ref: "refs/heads/release/1.0", object: { sha, type: "commit" } },
      200,
      { etag: 'W/"abc"' },
    ),
  );

  const head = await client.branchHead("acme/widgets", "release/1.0");

  assert.deepEqual(head, { status: "modified", sha, etag: 'W/"abc"' });
  // A slash in a branch name is a path separator in the ref, not encoded.
  assert.equal(
    fetch.calls[0]?.url,
    "https://api.github.com/repos/acme/widgets/git/ref/heads/release/1.0",
  );
  assert.equal(fetch.calls[0]?.headers["if-none-match"], undefined);
});

test("a known ETag is sent, and a 304 means nothing moved", async () => {
  const { client, fetch } = clientWith(
    () => new Response(null, { status: 304 }),
  );

  const head = await client.branchHead("acme/widgets", "main", 'W/"abc"');

  assert.deepEqual(head, { status: "not-modified" });
  assert.equal(fetch.calls[0]?.headers["if-none-match"], 'W/"abc"');
});

test("an empty repository is reported as such, not as an error", async () => {
  const { client } = clientWith(() =>
    json({ message: "Git Repository is empty." }, 409),
  );

  assert.deepEqual(await client.branchHead("acme/empty", "main", null), {
    status: "empty",
  });
});

test("a missing branch is GithubNotFound", async () => {
  const { client } = clientWith(() => json({ message: "Not Found" }, 404));

  await assert.rejects(
    client.branchHead("acme/widgets", "gone"),
    GithubNotFound,
  );
});

test("the repositories a person can reach in an installation are counted", async () => {
  const { client, fetch } = clientWith((request) =>
    request.url.includes("/user/installations/9/")
      ? json({ total_count: 3, repositories: [] })
      : json({ total_count: 5, repositories: [] }),
  );

  assert.equal(await client.userInstallationRepositoryCount("9"), 3);
  assert.equal(await client.installationRepositoryCount(), 5);
  assert.deepEqual(
    fetch.calls.map((call) => call.url),
    [
      "https://api.github.com/user/installations/9/repositories?per_page=1",
      "https://api.github.com/installation/repositories?per_page=1",
    ],
  );
});

test("a count GitHub did not give is an error, never a zero", async () => {
  const { client } = clientWith(() => json({ repositories: [] }));

  await assert.rejects(
    client.installationRepositoryCount(),
    (error: Error) =>
      error instanceof GithubApiError && /no count/.test(error.message),
  );
});

test("a request GitHub never answers is a network error, and is bounded", async () => {
  const fetch = fakeFetch(() => {
    throw new TypeError("fetch failed");
  });
  const client = new GithubClient({
    token: () => Promise.resolve("ghs_token"),
    fetch,
  });

  await assert.rejects(client.repository("1"), (error: Error) => {
    assert.ok(error instanceof GithubNetworkError);
    assert.equal((error as GithubNetworkError).status, 0);
    assert.equal(error.message, "Could not reach GitHub.");
    return true;
  });
  assert.ok(fetch.calls[0]?.signal instanceof AbortSignal);
});

test("a request that times out says so", async () => {
  const client = new GithubClient({
    token: () => Promise.resolve("ghs_token"),
    fetch: () => Promise.reject(new DOMException("timed out", "TimeoutError")),
  });

  await assert.rejects(
    client.repository("1"),
    new RegExp(`within ${REQUEST_TIMEOUT_MS / 1000} seconds`),
  );
});

test("statuses map to the errors a caller can act on", async () => {
  const cases: [Response, new (...args: never[]) => Error][] = [
    [json({}, 401), GithubAuthError],
    [json({}, 403), GithubAuthError],
    [json({}, 404), GithubNotFound],
    [json({}, 500), GithubApiError],
    [
      json({}, 403, {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "1759276800",
      }),
      GithubRateLimited,
    ],
    [json({}, 403, { "retry-after": "30" }), GithubRateLimited],
    [json({}, 429), GithubRateLimited],
    // A secondary limit may say so only in its body.
    [
      json({ message: "You have exceeded a secondary rate limit." }, 403),
      GithubRateLimited,
    ],
    [
      json({ message: "Resource not accessible by integration" }, 403),
      GithubAuthError,
    ],
    [new Response("<html>bad gateway</html>", { status: 502 }), GithubApiError],
  ];
  for (const [response, type] of cases) {
    const { client } = clientWith(() => response.clone());
    await assert.rejects(client.repository("1"), type);
  }
});

test("a rate limit says when to come back", () => {
  const primary = errorFor(
    json({}, 403, {
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": "1759276800",
    }),
    "repository",
    () => NOW,
  );
  const secondary = errorFor(
    json({}, 429, { "retry-after": "30" }),
    "repository",
    () => NOW,
  );
  const unspecified = errorFor(json({}, 429), "repository", () => NOW);

  assert.ok(primary instanceof GithubRateLimited);
  assert.equal(primary.resetAt.toISOString(), "2025-10-01T00:00:00.000Z");
  assert.ok(secondary instanceof GithubRateLimited);
  assert.equal(secondary.resetAt.getTime(), NOW + 30_000);
  assert.ok(unspecified instanceof GithubRateLimited);
  assert.equal(unspecified.resetAt.getTime(), NOW + 60_000);
});

test("the last rate-limit headers seen are surfaced", async () => {
  const { client } = clientWith(() =>
    json({ id: 1, full_name: "acme/widgets" }, 200, {
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": "4999",
      "x-ratelimit-reset": "1759276800",
    }),
  );

  assert.equal(client.rateLimit, undefined);
  await client.repository("1");

  assert.deepEqual(client.rateLimit, {
    limit: 5000,
    remaining: 4999,
    resetAt: new Date(1_759_276_800_000),
  });
});

test("a body of the wrong shape is an error rather than a half-read object", async () => {
  const { client } = clientWith(() => json({ id: "one" }));

  await assert.rejects(client.repository("1"), GithubApiError);
});
