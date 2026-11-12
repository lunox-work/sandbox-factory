import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  BountyStore,
  GithubRepoSummary,
  NewBounty,
  StoredBounty,
} from "@sandbox-factory/db";
import { GithubApiError, GithubNotFound } from "@sandbox-factory/github";
import {
  bountyResponseSchema,
  type GithubIssueResponse,
} from "@sandbox-factory/shared";
import { Hono } from "hono";
import { BOUNTY_LIMITS } from "sandbox-factory";

import {
  mountBountyRoutes,
  type BountyRouteOptions,
} from "../src/bounties/routes.js";
import { issueDescription } from "../src/bounties/github-issue.js";

/**
 * Importing a bounty from a GitHub issue, with the GitHub client faked:
 * the repository must be connected, the issue read through it, the URL
 * kept as the source, and an issue imported twice answers one bounty.
 */

const stamp = "2026-11-12T00:00:00.000Z";
const URL_12 = "https://github.com/acme/app/issues/12";

function repo(overrides: Partial<GithubRepoSummary> = {}): GithubRepoSummary {
  return {
    id: "ghr_1",
    connectionId: "ghc_1",
    role: "source",
    externalId: "42",
    fullName: "Acme/App",
    defaultBranch: "main",
    isPrivate: true,
    sizeKb: 10,
    headSha: "abc",
    pushedAt: stamp,
    lastSyncedAt: stamp,
    syncStatus: "ok",
    syncError: null,
    stack: [],
    stackCommitSha: null,
    stackVersion: null,
    contextSnapshotId: null,
    createdAt: stamp,
    ...overrides,
  } as GithubRepoSummary;
}

function issue(
  overrides: Partial<GithubIssueResponse> = {},
): GithubIssueResponse {
  return {
    number: 12,
    title: "Retry failed payouts",
    body: "Payouts that fail are never retried.",
    html_url: URL_12,
    labels: ["bug", { name: "payments" }],
    ...overrides,
  };
}

function setup(
  options: {
    repos?: GithubRepoSummary[];
    read?: () => Promise<GithubIssueResponse>;
    reconnect?: boolean;
    unconfigured?: boolean;
    raceOnCreate?: boolean;
  } = {},
) {
  const made: Array<{ input: NewBounty; bounty: StoredBounty }> = [];
  const reads: Array<{ fullName: string; number: number }> = [];
  const bounties = {
    create: (organizationId: string, createdBy: string, input: NewBounty) => {
      const bounty: StoredBounty = {
        id: `bty_${made.length + 1}`,
        organizationId,
        title: input.title,
        description: input.description,
        components: [],
        inputTruncated: input.inputTruncated ?? false,
        origin: input.source?.origin ?? "manual",
        sourceUrl: input.source?.url ?? null,
        stack: [...input.stack],
        categories: [],
        createdBy,
        revision: 1,
        version: 1,
        approval: null,
        jira: null,
        textEditedAt: null,
        sandbox: null,
        createdAt: stamp,
        updatedAt: stamp,
      };
      if (options.raceOnCreate === true) {
        made.push({ input, bounty });
        return Promise.reject(new Error("duplicate key"));
      }
      made.push({ input, bounty });
      return Promise.resolve(bounty);
    },
    findBySource: (organizationId: string, url: string) =>
      Promise.resolve(
        made.find(
          ({ bounty }) =>
            bounty.organizationId === organizationId &&
            bounty.sourceUrl === url,
        )?.bounty ?? null,
      ),
    versions: () => Promise.resolve([]),
  } as unknown as BountyStore;
  const routeOptions: BountyRouteOptions = {
    bounties,
    proposals: {
      get: () => Promise.resolve(null),
      liveForBounty: () => Promise.resolve(null),
    },
    ...(options.unconfigured === true
      ? {}
      : {
          githubIssues: {
            repos: {
              list: () => Promise.resolve(options.repos ?? [repo()]),
            },
            issuesFor: () =>
              Promise.resolve(
                options.reconnect === true
                  ? null
                  : {
                      issue: (fullName: string, number: number) => {
                        reads.push({ fullName, number });
                        return (
                          options.read ?? (() => Promise.resolve(issue()))
                        )();
                      },
                    },
              ),
          },
        }),
  };
  const app = new Hono<{
    Variables: {
      user: { id: string };
      member: { organizationId: string; role: string };
    };
  }>();
  app.use("/api/v1/orgs/:orgId/*", async (c, next) => {
    c.set("user", { id: "user_1" });
    c.set("member", { organizationId: c.req.param("orgId"), role: "owner" });
    await next();
  });
  mountBountyRoutes(app, routeOptions);
  const post = (body: unknown, org = "org_1") =>
    app.request(`/api/v1/orgs/${org}/bounties`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { post, made, reads };
}

test("an issue on a connected repository becomes a bounty that keeps its URL", async () => {
  const { post, made, reads } = setup();
  const res = await post({
    source: { githubIssue: "https://github.com/acme/app/issues/12" },
    stack: ["PostgreSQL"],
  });
  assert.equal(res.status, 201);
  const { bounty } = bountyResponseSchema.parse(await res.json());
  assert.equal(bounty.origin, "github");
  assert.equal(bounty.title, "Retry failed payouts");
  // The repository's own name, whatever case the URL was typed in.
  assert.equal(bounty.sourceUrl, "https://github.com/Acme/App/issues/12");
  assert.equal(
    bounty.description,
    "Payouts that fail are never retried.\n\nGitHub labels: bug, payments",
  );
  assert.deepEqual(reads, [{ fullName: "Acme/App", number: 12 }]);
  assert.deepEqual(made[0]?.input.stack, ["PostgreSQL"]);
});

test("an issue imported again answers its bounty, without reading GitHub", async () => {
  const { post, made, reads } = setup();
  await post({ source: { githubIssue: URL_12 } });
  const again = await post({ source: { githubIssue: `${URL_12}/` } });
  assert.equal(again.status, 200);
  assert.equal(
    bountyResponseSchema.parse(await again.json()).bounty.id,
    made[0]?.bounty.id,
  );
  assert.equal(made.length, 1);
  assert.equal(reads.length, 1);
});

test("a repository the workspace did not connect is repository_not_connected", async () => {
  for (const repos of [[], [repo({ fullName: "acme/other" })]]) {
    const { post, reads } = setup({ repos });
    const res = await post({ source: { githubIssue: URL_12 } });
    assert.equal(res.status, 422);
    assert.equal(
      ((await res.json()) as { code: string }).code,
      "repository_not_connected",
    );
    assert.equal(reads.length, 0);
  }
  // A repository GitHub says is gone is not connected either.
  const gone = setup({ repos: [repo({ syncStatus: "gone" })] });
  assert.equal(
    (await gone.post({ source: { githubIssue: URL_12 } })).status,
    422,
  );
});

test("a missing issue or a pull request is issue_not_found", async () => {
  const missing = setup({
    read: () => Promise.reject(new GithubNotFound("Not Found")),
  });
  const res = await missing.post({ source: { githubIssue: URL_12 } });
  assert.equal(res.status, 404);
  assert.equal(
    ((await res.json()) as { code: string }).code,
    "issue_not_found",
  );
  const pull = setup({
    read: () => Promise.resolve(issue({ pull_request: { url: "x" } })),
  });
  const refused = await pull.post({ source: { githubIssue: URL_12 } });
  assert.equal(refused.status, 404);
  assert.match(
    ((await refused.json()) as { error: string }).error,
    /pull request/,
  );
  assert.equal(pull.made.length, 0);
});

test("GitHub failing, a connection to reconnect, or no GitHub here, is said", async () => {
  const failing = setup({
    read: () => Promise.reject(new GithubApiError(500, "boom")),
  });
  const failed = await failing.post({ source: { githubIssue: URL_12 } });
  assert.equal(failed.status, 502);
  assert.equal(
    ((await failed.json()) as { code: string }).code,
    "github_unavailable",
  );
  const lapsed = setup({ reconnect: true });
  const reconnect = await lapsed.post({ source: { githubIssue: URL_12 } });
  assert.equal(reconnect.status, 409);
  const off = setup({ unconfigured: true });
  const unconfigured = await off.post({ source: { githubIssue: URL_12 } });
  assert.equal(unconfigured.status, 503);
});

test("a malformed import is refused; the text body is unchanged", async () => {
  const { post } = setup();
  for (const body of [
    { source: { githubIssue: "https://github.com/acme/app/pull/12" } },
    { source: {} },
    { source: { githubIssue: URL_12 }, title: "both" },
  ]) {
    const res = await post(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(
      ((await res.json()) as { code: string }).code,
      "invalid_bounty",
    );
  }
  const written = await post({ title: "Fix login" });
  assert.equal(written.status, 201);
  assert.equal(
    bountyResponseSchema.parse(await written.json()).bounty.sourceUrl,
    null,
  );
});

test("an import raced by another answers the one that won", async () => {
  const { post } = setup({ raceOnCreate: true });
  const res = await post({ source: { githubIssue: URL_12 } });
  assert.equal(res.status, 200);
});

test("an issue's text is cut to the bounty's limit, and says so", () => {
  const long = issueDescription(
    issue({ body: "x".repeat(BOUNTY_LIMITS.description + 10), labels: [] }),
  );
  assert.equal(long.truncated, true);
  assert.equal(long.description.length, BOUNTY_LIMITS.description);
  assert.match(long.description, /\[truncated\]$/);
  const empty = issueDescription(issue({ body: null, labels: [] }));
  assert.deepEqual(empty, { description: "", truncated: false });
  const surrogate = issueDescription(
    issue({
      body: `${"x".repeat(BOUNTY_LIMITS.description - "\n\n[truncated]".length - 1)}😀tail`,
      labels: [],
    }),
  );
  assert.doesNotMatch(surrogate.description, /\uD83D\n/);
});
