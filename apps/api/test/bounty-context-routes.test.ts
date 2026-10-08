import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  BountyContextStore,
  GithubRepoSummary,
  LatestBountyContext,
  NewBountyContext,
  StoredBounty,
  StoredBountyContext,
} from "@sandbox-factory/db";
import { GithubNotFound } from "@sandbox-factory/github";
import { JiraApiError } from "@sandbox-factory/jira";
import type {
  BountyContextResponse,
  JiraContextDto,
  StoredTree,
} from "@sandbox-factory/shared";
import { Hono } from "hono";

import {
  mountBountyContextRoutes,
  type BountyContextOptions,
} from "../src/bounties/context.js";
import {
  contextHash,
  contextRepoId,
  heldContext,
} from "../src/bounties/held-context.js";
import type { RunClientResult } from "../src/pricing/executor.js";
import type { AuthVariables } from "../src/routes.js";

const stamp = "2026-10-07T00:00:00.000Z";

function bountyOf(overrides: Partial<StoredBounty> = {}): StoredBounty {
  return {
    id: "bty_7",
    organizationId: "org_1",
    title: "Retry failed billing webhooks",
    description: "Written here.",
    components: [],
    inputTruncated: false,
    origin: "manual",
    repoId: null,
    stack: [],
    categories: [],
    createdBy: "user_1",
    revision: 1,
    version: 1,
    approval: null,
    jira: null,
    sandbox: null,
    createdAt: stamp,
    updatedAt: stamp,
    ...overrides,
  };
}

const jiraLink = {
  issueId: "jri_1",
  boardId: "jrb_1",
  connectionId: "jrc_1",
  externalId: "100",
  key: "APP-1",
  siteUrl: "https://acme.atlassian.net",
  removedAt: null,
};

function jiraContext(overrides: Partial<JiraContextDto> = {}): JiraContextDto {
  return {
    key: "APP-1",
    issueType: "Story",
    status: "To Do",
    statusCategory: "new",
    priority: "High",
    labels: [],
    components: [],
    fixVersions: [],
    parentKey: null,
    dueDate: null,
    storyPoints: 5,
    originalEstimateSeconds: null,
    remainingEstimateSeconds: null,
    votes: null,
    watchers: null,
    subtaskCount: 0,
    links: [],
    updated: "2026-10-06T00:00:00.000+0000",
    ...overrides,
  };
}

const repo: GithubRepoSummary = {
  id: "ghr_1",
  connectionId: "ghc_1",
  role: "source",
  externalId: "9",
  fullName: "acme/app",
  defaultBranch: "main",
  isPrivate: true,
  sizeKb: null,
  headSha: "c2",
  pushedAt: null,
  lastSyncedAt: null,
  syncStatus: "ok",
  syncError: null,
  stack: null,
  stackCommitSha: null,
  stackVersion: null,
  contextSnapshotId: null,
  createdAt: stamp,
};

const tree: StoredTree = {
  version: 1,
  commitSha: "c2",
  treeSha: "t",
  truncated: false,
  entries: [
    { path: "README.md", type: "blob", mode: "100644", sha: "s1", size: 20 },
    {
      path: "docs/billing.md",
      type: "blob",
      mode: "100644",
      sha: "s2",
      size: 30,
    },
    { path: "CHANGELOG.md", type: "blob", mode: "100644", sha: "s3", size: 9 },
    { path: "src/index.ts", type: "blob", mode: "100644", sha: "s4", size: 9 },
  ],
};

/** A context store that keeps what it is given, as Postgres would. */
function memoryContexts(initial: StoredBountyContext[] = []) {
  const rows = [...initial];
  const store: BountyContextStore = {
    latest: (_org, bountyId) => {
      if (bountyId !== "bty_7") return Promise.resolve(null);
      const newest = (source: "jira" | "github") =>
        rows
          .filter((row) => row.source === source)
          .sort((a, b) => b.version - a.version)[0] ?? null;
      return Promise.resolve({
        jira: newest("jira"),
        github: newest("github"),
      } as LatestBountyContext);
    },
    record: (_org, bountyId, input: NewBountyContext, syncedBy) => {
      if (bountyId !== "bty_7")
        return Promise.resolve({ ok: false, reason: "not-found" });
      const latest = rows
        .filter((row) => row.source === input.source)
        .sort((a, b) => b.version - a.version)[0];
      if (
        latest !== undefined &&
        latest.refId === input.refId &&
        latest.contentHash === input.contentHash
      ) {
        const updated = {
          ...latest,
          revision: input.revision,
          checkedAt: stamp,
        } as StoredBountyContext;
        rows[rows.indexOf(latest)] = updated;
        return Promise.resolve({ ok: true, context: updated, changed: false });
      }
      const created = {
        ...input,
        version: (latest?.version ?? 0) + 1,
        syncedBy,
        createdAt: stamp,
        checkedAt: stamp,
      } as StoredBountyContext;
      rows.push(created);
      return Promise.resolve({ ok: true, context: created, changed: true });
    },
  };
  return { store, rows };
}

interface Setup {
  bounty?: Partial<StoredBounty>;
  contexts?: StoredBountyContext[];
  client?: RunClientResult | null;
  /** The issue's `updated`, as a status read finds it. */
  liveUpdated?: string | null;
  issueError?: Error;
  contextError?: Error;
  github?: false;
  repo?: GithubRepoSummary | null;
  snapshot?: { commitSha: string; treeKey: string; ref: string } | null;
  tree?: StoredTree | null;
  reader?: null;
  blobError?: Error;
  boardRepoId?: string | null;
}

function harness(setup: Setup = {}) {
  let bounty = bountyOf(setup.bounty);
  const refreshed: unknown[] = [];
  const blobs: string[] = [];
  const contexts = memoryContexts(setup.contexts);
  const client: RunClientResult = setup.client ?? {
    ok: true,
    client: {
      issue: (id: string) =>
        setup.issueError === undefined
          ? Promise.resolve({
              id,
              key: "APP-1",
              updated:
                setup.liveUpdated === undefined
                  ? "2026-10-06T00:00:00.000+0000"
                  : setup.liveUpdated,
            })
          : Promise.reject(setup.issueError),
      issueContext: () =>
        setup.contextError === undefined
          ? Promise.resolve(jiraContext())
          : Promise.reject(setup.contextError),
      issueSpec: () =>
        Promise.resolve({
          summary: "From Jira",
          descriptionText: "Jira's steps.",
          components: [],
          inputTruncated: false,
          updated: "2026-10-06T00:00:00.000+0000",
        }),
    } as never,
  };
  const options: BountyContextOptions = {
    bounties: {
      get: (_org: string, id: string) =>
        Promise.resolve(id === bounty.id ? bounty : null),
      refreshFromJira: (_org: string, _id: string, content: unknown) => {
        refreshed.push(content);
        bounty = {
          ...bounty,
          title: "From Jira",
          revision: bounty.revision + 1,
        };
        return Promise.resolve(true);
      },
    } as never,
    proposals: {
      liveForBounty: () => Promise.resolve(null),
      get: () => Promise.resolve(null),
    },
    contexts: contexts.store,
    boards: {
      forRun: () =>
        Promise.resolve({
          board: { sourceRepoId: setup.boardRepoId ?? null },
        } as never),
    },
    ...(setup.client === null
      ? {}
      : { clientFor: () => Promise.resolve(client) }),
    ...(setup.github === false
      ? {}
      : {
          githubContext: {
            repos: {
              get: () =>
                Promise.resolve(setup.repo === undefined ? repo : setup.repo),
            },
            snapshots: {
              current: () =>
                Promise.resolve(
                  (setup.snapshot === undefined
                    ? {
                        commitSha: "c2",
                        treeKey: "trees/x",
                        ref: "refs/heads/main",
                      }
                    : setup.snapshot) as never,
                ),
            },
            tree: () =>
              Promise.resolve(setup.tree === undefined ? tree : setup.tree),
            readerFor: () =>
              Promise.resolve(
                setup.reader === null
                  ? null
                  : {
                      blobText: (_name: string, sha: string) => {
                        blobs.push(sha);
                        return setup.blobError === undefined
                          ? Promise.resolve(`text of ${sha}`)
                          : Promise.reject(setup.blobError);
                      },
                    },
              ),
          },
        }),
  };
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("user", { id: "user_1" } as never);
    c.set("member", { organizationId: "org_1", role: "member" });
    await next();
  });
  mountBountyContextRoutes(app, options);
  const request = (method: string, path: string) =>
    app.request(`/api/v1/orgs/org_1/${path}`, { method });
  return { request, refreshed, blobs, rows: contexts.rows, options };
}

function storedJira(
  version: number,
  overrides: Partial<StoredBountyContext> = {},
): StoredBountyContext {
  const content = jiraContext();
  return {
    source: "jira",
    version,
    ref: "APP-1",
    refId: "100",
    revision: "2026-10-06T00:00:00.000+0000",
    contentHash: contextHash({ source: "jira", content }),
    syncedBy: "user_1",
    createdAt: stamp,
    checkedAt: stamp,
    content,
    ...overrides,
  } as StoredBountyContext;
}

function storedGithub(
  version: number,
  overrides: Partial<StoredBountyContext> = {},
): StoredBountyContext {
  return {
    source: "github",
    version,
    ref: "acme/app",
    refId: "ghr_1",
    revision: "c1",
    contentHash: "old",
    syncedBy: "user_1",
    createdAt: stamp,
    checkedAt: stamp,
    content: {
      fullName: "acme/app",
      branch: "main",
      commitSha: "c1",
      documents: [],
      omitted: 0,
    },
    ...overrides,
  } as StoredBountyContext;
}

test("a bounty with no sources has nothing to sync", async () => {
  const state = harness();
  const response = await state.request("GET", "bounties/bty_7/context");
  assert.equal(response.status, 200);
  const body = (await response.json()) as BountyContextResponse;
  assert.equal(body.jira.state, "unlinked");
  assert.equal(body.github.state, "unlinked");
  assert.equal(
    (await state.request("GET", "bounties/bty_other/context")).status,
    404,
  );
});

test("a linked source never synced says so, and syncing Jira takes its fields and its text", async () => {
  const state = harness({ bounty: { jira: jiraLink } });
  const before = (await (
    await state.request("GET", "bounties/bty_7/context")
  ).json()) as BountyContextResponse;
  assert.equal(before.jira.state, "unsynced");
  assert.deepEqual(before.jira.linked, {
    ref: "APP-1",
    url: "https://acme.atlassian.net/browse/APP-1",
  });

  const response = await state.request(
    "POST",
    "bounties/bty_7/context/jira/sync",
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    changed: boolean;
    bounty: {
      title: string;
      stages: { overview: { context: unknown } };
    };
    context: BountyContextResponse;
  };
  assert.equal(body.changed, true);
  // The overview now holds it, as the steps after it will read.
  assert.deepEqual(body.bounty.stages.overview.context, {
    jira: 1,
    github: null,
  });
  // Its text follows the issue, as a run's read does.
  assert.equal(body.bounty.title, "From Jira");
  assert.equal(state.refreshed.length, 1);
  assert.equal(body.context.jira.state, "current");
  assert.equal(body.context.jira.latest?.version, 1);
  assert.equal(
    body.context.jira.latest?.source === "jira" &&
      body.context.jira.latest.content.storyPoints,
    5,
  );
  assert.equal(state.rows[0]?.syncedBy, "user_1");

  // Again with nothing new: the same version, checked again.
  const again = (await (
    await state.request("POST", "bounties/bty_7/context/jira/sync")
  ).json()) as { changed: boolean; context: BountyContextResponse };
  assert.equal(again.changed, false);
  assert.equal(again.context.jira.latest?.version, 1);
});

test("an issue changed since its sync is ahead, and an issue that cannot be read is unavailable", async () => {
  const ahead = harness({
    bounty: { jira: jiraLink },
    contexts: [storedJira(2)],
    liveUpdated: "2026-10-07T09:00:00.000+0000",
  });
  const body = (await (
    await ahead.request("GET", "bounties/bty_7/context")
  ).json()) as BountyContextResponse;
  assert.equal(body.jira.state, "ahead");
  assert.equal(body.jira.liveRevision, "2026-10-07T09:00:00.000+0000");

  const current = harness({
    bounty: { jira: jiraLink },
    contexts: [storedJira(2)],
    liveUpdated: null,
  });
  assert.equal(
    (
      (await (
        await current.request("GET", "bounties/bty_7/context")
      ).json()) as BountyContextResponse
    ).jira.state,
    "current",
  );

  for (const [error, reason] of [
    [new JiraApiError(401, "no"), "reconnect"],
    [new JiraApiError(404, "gone"), "issue_gone"],
    [new JiraApiError(500, "down"), "jira_failed"],
  ] as const) {
    const failing = harness({
      bounty: { jira: jiraLink },
      contexts: [storedJira(1)],
      issueError: error,
    });
    const read = (await (
      await failing.request("GET", "bounties/bty_7/context")
    ).json()) as BountyContextResponse;
    assert.equal(read.jira.state, "unavailable");
    assert.equal(read.jira.reason, reason);
  }

  const unconfigured = harness({
    bounty: { jira: jiraLink },
    contexts: [storedJira(1)],
    client: null,
  });
  assert.equal(
    (
      (await (
        await unconfigured.request("GET", "bounties/bty_7/context")
      ).json()) as BountyContextResponse
    ).jira.reason,
    "reconnect",
  );
  const reconnecting = harness({
    bounty: { jira: jiraLink },
    contexts: [storedJira(1)],
    client: { ok: false, reason: "reconnect" },
  });
  assert.equal(
    (
      (await (
        await reconnecting.request("GET", "bounties/bty_7/context")
      ).json()) as BountyContextResponse
    ).jira.reason,
    "reconnect",
  );
  const missing = harness({
    bounty: { jira: jiraLink },
    contexts: [storedJira(1)],
    client: { ok: false, reason: "not-found" },
  });
  assert.equal(
    (
      (await (
        await missing.request("GET", "bounties/bty_7/context")
      ).json()) as BountyContextResponse
    ).jira.reason,
    "jira_unavailable",
  );
});

test("an issue gone from Jira, or a context from another issue, is not the bounty's now", async () => {
  const gone = harness({
    bounty: { jira: { ...jiraLink, removedAt: stamp } },
    contexts: [storedJira(1)],
  });
  const read = (await (
    await gone.request("GET", "bounties/bty_7/context")
  ).json()) as BountyContextResponse;
  assert.equal(read.jira.state, "unavailable");
  assert.equal(read.jira.reason, "issue_gone");
  assert.equal(
    (await gone.request("POST", "bounties/bty_7/context/jira/sync")).status,
    409,
  );

  const relinked = harness({
    bounty: { jira: jiraLink },
    contexts: [storedJira(1, { refId: "99", ref: "APP-0" })],
  });
  const other = (await (
    await relinked.request("GET", "bounties/bty_7/context")
  ).json()) as BountyContextResponse;
  assert.equal(other.jira.state, "unsynced");
  assert.equal(other.jira.latest?.ref, "APP-0");
  // Nor is it held: sizing is never shown another issue's fields.
  assert.deepEqual(
    await heldContext(relinked.options, "org_1", bountyOf({ jira: jiraLink })),
    { jira: null, github: null },
  );
});

test("a Jira sync Jira refuses says why", async () => {
  for (const [setup, status, code] of [
    [{ client: null }, 409, "reconnect"],
    [{ client: { ok: false, reason: "reconnect" } }, 409, "reconnect"],
    [{ client: { ok: false, reason: "not-found" } }, 404, "not_found"],
    [{ contextError: new JiraApiError(404, "gone") }, 404, "issue_not_found"],
    [{ contextError: new JiraApiError(401, "no") }, 409, "reconnect"],
    [{ contextError: new JiraApiError(500, "down") }, 502, "jira_failed"],
  ] as const) {
    const state = harness({ bounty: { jira: jiraLink }, ...(setup as Setup) });
    const response = await state.request(
      "POST",
      "bounties/bty_7/context/jira/sync",
    );
    assert.equal(response.status, status, code);
    assert.equal(((await response.json()) as { code: string }).code, code);
  }
  const state = harness();
  assert.equal(
    (await state.request("POST", "bounties/bty_7/context/slack/sync")).status,
    404,
  );
  assert.equal(
    (await state.request("POST", "bounties/bty_other/context/jira/sync"))
      .status,
    404,
  );
});

test("a GitHub sync reads the documents at the newest snapshot, title's words first", async () => {
  const state = harness({ bounty: { repoId: "ghr_1" } });
  const before = (await (
    await state.request("GET", "bounties/bty_7/context")
  ).json()) as BountyContextResponse;
  assert.equal(before.github.state, "unsynced");
  assert.equal(before.github.liveRevision, "c2");

  const response = await state.request(
    "POST",
    "bounties/bty_7/context/github/sync",
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as { context: BountyContextResponse };
  const latest = body.context.github.latest;
  assert.equal(body.context.github.state, "current");
  assert.equal(latest?.revision, "c2");
  assert.ok(latest?.source === "github");
  assert.deepEqual(
    latest.content.documents.map(({ path }) => path),
    ["README.md", "docs/billing.md"],
  );
  assert.equal(latest.content.documents[1]?.text, "text of s2");
  assert.equal(latest.content.branch, "main");
  // Only the documents are read: never the code or the boilerplate.
  assert.deepEqual(state.blobs.sort(), ["s1", "s2"]);
});

test("a repository with a newer snapshot than its sync is ahead", async () => {
  const state = harness({
    bounty: { repoId: "ghr_1" },
    contexts: [storedGithub(1)],
  });
  const read = (await (
    await state.request("GET", "bounties/bty_7/context")
  ).json()) as BountyContextResponse;
  assert.equal(read.github.state, "ahead");
  assert.equal(read.github.linked?.url, "https://github.com/acme/app");
});

test("a Jira bounty with no repository of its own syncs its board's", async () => {
  const state = harness({ bounty: { jira: jiraLink }, boardRepoId: "ghr_1" });
  assert.equal(
    await contextRepoId(
      state.options.boards,
      "org_1",
      bountyOf({ jira: jiraLink }),
    ),
    "ghr_1",
  );
  assert.equal(
    (await state.request("POST", "bounties/bty_7/context/github/sync")).status,
    200,
  );
  const held = await heldContext(
    state.options,
    "org_1",
    bountyOf({ jira: jiraLink }),
  );
  assert.equal(held.github?.version, 1);
});

test("a GitHub sync that cannot read says why", async () => {
  for (const [setup, status, code] of [
    [{}, 409, "no_repository"],
    [{ bounty: { repoId: "ghr_1" }, github: false }, 503, "unconfigured"],
    [{ bounty: { repoId: "ghr_1" }, repo: null }, 404, "not_found"],
    [
      { bounty: { repoId: "ghr_1" }, repo: { ...repo, syncStatus: "gone" } },
      409,
      "repository_gone",
    ],
    [{ bounty: { repoId: "ghr_1" }, snapshot: null }, 409, "no_snapshot"],
    [{ bounty: { repoId: "ghr_1" }, tree: null }, 502, "tree_unavailable"],
    [
      { bounty: { repoId: "ghr_1" }, reader: null },
      409,
      "connection_unhealthy",
    ],
    [
      { bounty: { repoId: "ghr_1" }, blobError: new GithubNotFound("gone") },
      409,
      "repository_gone",
    ],
    [
      { bounty: { repoId: "ghr_1" }, blobError: new Error("down") },
      502,
      "github_failed",
    ],
  ] as const) {
    const state = harness(setup as Setup);
    const response = await state.request(
      "POST",
      "bounties/bty_7/context/github/sync",
    );
    assert.equal(response.status, status, code);
    assert.equal(((await response.json()) as { code: string }).code, code);
  }
});

test("a repository's status says when it cannot be read", async () => {
  for (const [setup, state_, reason] of [
    [
      { bounty: { repoId: "ghr_1" }, github: false },
      "unavailable",
      "unconfigured",
    ],
    [{ bounty: { repoId: "ghr_1" }, repo: null }, "unlinked", null],
    [
      { bounty: { repoId: "ghr_1" }, repo: { ...repo, syncStatus: "gone" } },
      "unavailable",
      "repository_gone",
    ],
  ] as const) {
    const state = harness(setup as Setup);
    const read = (await (
      await state.request("GET", "bounties/bty_7/context")
    ).json()) as BountyContextResponse;
    assert.equal(read.github.state, state_);
    assert.equal(read.github.reason, reason);
  }
});

test("what a sync compares is what the source says, not where it was read", () => {
  const content = jiraContext();
  assert.equal(
    contextHash({ source: "jira", content }),
    contextHash({
      source: "jira",
      content: { ...content, updated: "2027-01-01T00:00:00.000+0000" },
    }),
  );
  assert.notEqual(
    contextHash({ source: "jira", content }),
    contextHash({ source: "jira", content: { ...content, priority: "Low" } }),
  );
  const github = {
    fullName: "acme/app",
    branch: "main",
    commitSha: "c1",
    documents: [],
    omitted: 0,
  };
  assert.equal(
    contextHash({ source: "github", content: github }),
    contextHash({
      source: "github",
      content: { ...github, commitSha: "c2", branch: "dev" },
    }),
  );
});

test("a bounty whose contexts cannot be found holds none", async () => {
  const state = harness();
  assert.deepEqual(
    await heldContext(state.options, "org_1", bountyOf({ id: "bty_other" })),
    { jira: null, github: null },
  );
});
