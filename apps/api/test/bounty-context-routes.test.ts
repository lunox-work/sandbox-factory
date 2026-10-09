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
  connectedRepositories,
  contextHash,
  heldContext,
  repositoriesRevision,
  WORKSPACE_REPOSITORIES,
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
  /** The workspace's repositories; `repo` alone by default. */
  repos?: GithubRepoSummary[];
  /** Each repository's newest snapshot, by id; `c2` on main by default. */
  snapshots?: Record<string, Snapshot | null>;
  tree?: StoredTree | null;
  reader?: null;
  /** Repositories, by id, whose connection cannot read them. */
  unreadable?: readonly string[];
  blobError?: Error;
}

interface Snapshot {
  commitSha: string;
  treeKey: string;
  ref: string;
}

function harness(setup: Setup = {}) {
  let bounty = bountyOf(setup.bounty);
  const refreshed: unknown[] = [];
  const blobs: string[] = [];
  const contexts = memoryContexts(setup.contexts);
  // Changed in place by a test, as a webhook's snapshot would move them.
  const snapshots: Record<string, Snapshot | null> = {
    ...setup.snapshots,
  };
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
    ...(setup.client === null
      ? {}
      : { clientFor: () => Promise.resolve(client) }),
    ...(setup.github === false
      ? {}
      : {
          githubContext: {
            repos: {
              list: () => Promise.resolve(setup.repos ?? [repo]),
            },
            snapshots: {
              current: (_org: string, repoId: string) =>
                Promise.resolve(
                  (snapshots[repoId] === undefined
                    ? {
                        commitSha: "c2",
                        treeKey: `trees/${repoId}`,
                        ref: "refs/heads/main",
                      }
                    : snapshots[repoId]) as never,
                ),
            },
            tree: () =>
              Promise.resolve(setup.tree === undefined ? tree : setup.tree),
            readerFor: (_org: string, { id }: { id: string }) =>
              Promise.resolve(
                setup.reader === null || setup.unreadable?.includes(id) === true
                  ? null
                  : {
                      blobText: (name: string, sha: string) => {
                        blobs.push(`${name}:${sha}`);
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
  const context = async () =>
    (await (
      await request("GET", "bounties/bty_7/context")
    ).json()) as BountyContextResponse;
  return {
    request,
    context,
    refreshed,
    blobs,
    snapshots,
    rows: contexts.rows,
    options,
  };
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
  const state = harness({ repos: [] });
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

const web: GithubRepoSummary = {
  ...repo,
  id: "ghr_2",
  externalId: "10",
  fullName: "acme/web",
  headSha: "w1",
};

test("a GitHub sync reads the documents at the repository's newest snapshot, title's words first", async () => {
  const state = harness();
  const before = await state.context();
  assert.equal(before.github.state, "unsynced");
  assert.equal(before.github.liveRevision, "acme/app@c2");
  // One repository is named, and found, as itself.
  assert.deepEqual(before.github.linked, {
    ref: "acme/app",
    url: "https://github.com/acme/app",
  });

  const response = await state.request(
    "POST",
    "bounties/bty_7/context/github/sync",
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as { context: BountyContextResponse };
  const latest = body.context.github.latest;
  assert.equal(body.context.github.state, "current");
  assert.equal(latest?.revision, "acme/app@c2");
  assert.equal(latest?.ref, "acme/app");
  assert.ok(latest?.source === "github");
  assert.ok("repositories" in latest.content);
  assert.deepEqual(latest.content.unread, []);
  const [app] = latest.content.repositories;
  assert.deepEqual(
    app?.documents.map(({ path }) => path),
    ["README.md", "docs/billing.md"],
  );
  assert.equal(app?.documents[1]?.text, "text of s2");
  assert.equal(app?.branch, "main");
  assert.equal(app?.commitSha, "c2");
  // Only the documents are read: never the code or the boilerplate.
  assert.deepEqual(state.blobs.sort(), ["acme/app:s1", "acme/app:s2"]);
  assert.equal(state.rows[0]?.refId, WORKSPACE_REPOSITORIES);
});

test("a GitHub sync reads every connected repository, and names the ones it could not", async () => {
  const state = harness({
    repos: [repo, web],
    snapshots: { ghr_2: null },
  });
  const before = await state.context();
  // Several are named by how many, with nowhere one page shows them all.
  assert.deepEqual(before.github.linked, {
    ref: "2 repositories",
    url: null,
  });
  assert.equal(before.github.liveRevision, "acme/app@c2");

  const response = await state.request(
    "POST",
    "bounties/bty_7/context/github/sync",
  );
  assert.equal(response.status, 200);
  const latest = ((await response.json()) as { context: BountyContextResponse })
    .context.github.latest;
  assert.ok(latest?.source === "github" && "repositories" in latest.content);
  assert.deepEqual(
    latest.content.repositories.map(({ fullName }) => fullName),
    ["acme/app"],
  );
  assert.deepEqual(latest.content.unread, ["acme/web"]);
  assert.equal(latest.ref, "acme/app");
  assert.deepEqual(state.blobs.sort(), ["acme/app:s1", "acme/app:s2"]);
});

test("a repository its connection cannot read is unread, and its sync is not ahead of itself", async () => {
  const state = harness({ repos: [repo, web], unreadable: ["ghr_2"] });
  const response = await state.request(
    "POST",
    "bounties/bty_7/context/github/sync",
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as { context: BountyContextResponse };
  const latest = body.context.github.latest;
  assert.ok(latest?.source === "github" && "repositories" in latest.content);
  assert.deepEqual(latest.content.unread, ["acme/web"]);
  // Where it stood counts, read or not, as the status measures it.
  assert.equal(latest.revision, "acme/app@c2\nacme/web@c2");
  assert.equal(body.context.github.state, "current");
  assert.equal((await state.context()).github.state, "current");

  // A new commit in it is still news.
  state.snapshots["ghr_2"] = {
    commitSha: "w2",
    treeKey: "trees/w",
    ref: "refs/heads/main",
  };
  assert.equal((await state.context()).github.state, "ahead");
});

test("a sync across repositories keeps each one's documents, and moves ahead with any of them", async () => {
  const state = harness({
    repos: [web, repo],
    snapshots: {
      ghr_2: { commitSha: "w1", treeKey: "trees/w", ref: "refs/heads/dev" },
    },
  });
  const response = await state.request(
    "POST",
    "bounties/bty_7/context/github/sync",
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as { context: BountyContextResponse };
  const latest = body.context.github.latest;
  assert.equal(body.context.github.state, "current");
  // Where each stood, in name order whichever order they were listed in.
  assert.equal(latest?.revision, "acme/app@c2\nacme/web@w1");
  assert.equal(latest?.ref, "2 repositories");
  assert.ok(latest?.source === "github" && "repositories" in latest.content);
  assert.deepEqual(
    latest.content.repositories.map(({ fullName, branch, documents }) => [
      fullName,
      branch,
      documents.map(({ path }) => path),
    ]),
    [
      ["acme/web", "dev", ["README.md", "docs/billing.md"]],
      ["acme/app", "main", ["README.md", "docs/billing.md"]],
    ],
  );
  assert.deepEqual(state.blobs.sort(), [
    "acme/app:s1",
    "acme/app:s2",
    "acme/web:s1",
    "acme/web:s2",
  ]);

  // One repository moves on: the sync is behind the workspace.
  state.snapshots.ghr_1 = {
    commitSha: "c3",
    treeKey: "trees/ghr_1",
    ref: "refs/heads/main",
  };
  const moved = await state.context();
  assert.equal(moved.github.state, "ahead");
  assert.equal(moved.github.liveRevision, "acme/app@c3\nacme/web@w1");

  // Synced again, it reads the same documents and keeps the same version.
  const again = (await (
    await state.request("POST", "bounties/bty_7/context/github/sync")
  ).json()) as { changed: boolean; context: BountyContextResponse };
  assert.equal(again.changed, false);
  assert.equal(again.context.github.state, "current");
  assert.equal(again.context.github.latest?.version, 1);
});

test("a version synced while a bounty named one repository is behind the workspace's, yet still held", async () => {
  const state = harness({ contexts: [storedGithub(1)] });
  const read = await state.context();
  assert.equal(read.github.state, "unsynced");
  assert.equal(read.github.latest?.version, 1);
  assert.ok(
    read.github.latest?.source === "github" &&
      !("repositories" in read.github.latest.content),
  );
  // Sizing still reads it until the workspace's is synced over it.
  const held = await heldContext(state.options, "org_1", bountyOf());
  assert.equal(held.github?.version, 1);

  assert.equal(
    (await state.request("POST", "bounties/bty_7/context/github/sync")).status,
    200,
  );
  const synced = await state.context();
  assert.equal(synced.github.state, "current");
  assert.equal(synced.github.latest?.version, 2);
});

test("a GitHub sync that cannot read says why", async () => {
  for (const [setup, status, code] of [
    [{ repos: [] }, 409, "no_repository"],
    [{ repos: [{ ...repo, syncStatus: "gone" }] }, 409, "no_repository"],
    [{ repos: [{ ...repo, role: "sandbox" }] }, 409, "no_repository"],
    [{ github: false }, 503, "unconfigured"],
    [{ snapshots: { ghr_1: null } }, 409, "no_snapshot"],
    [{ tree: null }, 409, "no_snapshot"],
    [{ reader: null }, 409, "no_snapshot"],
    [{ blobError: new GithubNotFound("gone") }, 409, "repository_gone"],
    [{ blobError: new Error("down") }, 502, "github_failed"],
  ] as const) {
    const state = harness(setup as Setup);
    const response = await state.request(
      "POST",
      "bounties/bty_7/context/github/sync",
    );
    assert.equal(response.status, status, code);
    assert.equal(((await response.json()) as { code: string }).code, code);
    assert.equal(state.rows.length, 0, code);
  }
});

test("the repositories' status says when they cannot be read", async () => {
  for (const [setup, state_, reason] of [
    [{ github: false }, "unavailable", "unconfigured"],
    [{ repos: [] }, "unlinked", null],
    // A repository GitHub no longer answers for is not the workspace's.
    [{ repos: [{ ...repo, syncStatus: "gone" }] }, "unlinked", null],
  ] as const) {
    const state = harness(setup as Setup);
    const read = await state.context();
    assert.equal(read.github.state, state_);
    assert.equal(read.github.reason, reason);
  }
  // None read yet: linked, with nowhere it stands.
  const unread = await harness({ snapshots: { ghr_1: null } }).context();
  assert.equal(unread.github.state, "unsynced");
  assert.equal(unread.github.liveRevision, null);
});

test("the workspace's repositories are its sources, and stand where each was read", async () => {
  const list: GithubRepoSummary[] = [
    repo,
    { ...web, syncStatus: "gone" },
    { ...repo, id: "ghr_3", fullName: "acme/box", role: "sandbox" },
    { ...web, id: "ghr_4", fullName: "acme/api" },
  ];
  assert.deepEqual(
    (
      await connectedRepositories(
        { list: () => Promise.resolve(list) },
        "org_1",
      )
    ).map(({ id }) => id),
    ["ghr_1", "ghr_4"],
  );
  assert.equal(
    repositoriesRevision([
      { fullName: "acme/web", commitSha: "w1" },
      { fullName: "acme/app", commitSha: "c2" },
    ]),
    "acme/app@c2\nacme/web@w1",
  );
  assert.equal(repositoriesRevision([]), "");
});

test("the GitHub context held is the latest, whatever it was synced from", async () => {
  const state = harness({
    contexts: [storedGithub(1, { refId: "ghr_gone" })],
  });
  assert.equal(
    (await heldContext(state.options, "org_1", bountyOf({ jira: jiraLink })))
      .github?.version,
    1,
  );
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
    documents: [
      { path: "README.md", bytes: 20, text: "Billing.", truncated: false },
    ],
    omitted: 0,
  };
  assert.equal(
    contextHash({ source: "github", content: github }),
    contextHash({
      source: "github",
      content: { ...github, commitSha: "c2", branch: "dev" },
    }),
  );
  // The one-repository shape says what the workspace's with it alone says,
  // and the repositories left unread say nothing.
  const workspace = { repositories: [github], unread: [] };
  assert.equal(
    contextHash({ source: "github", content: github }),
    contextHash({ source: "github", content: workspace }),
  );
  assert.equal(
    contextHash({ source: "github", content: workspace }),
    contextHash({
      source: "github",
      content: { ...workspace, unread: ["acme/web"] },
    }),
  );
  assert.notEqual(
    contextHash({ source: "github", content: workspace }),
    contextHash({
      source: "github",
      content: {
        repositories: [github, { ...github, fullName: "acme/web" }],
        unread: [],
      },
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
