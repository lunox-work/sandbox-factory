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
  BountyGithubCommitsResponse,
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
import { recentReads } from "../src/jira/recent.js";
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
    textEditedAt: null,
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
          ref: input.ref,
          revision: input.revision,
          content: input.content,
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
  /**
   * Each repository's newest build, by id; `c2` on main by default, and
   * null for one never built.
   */
  snapshots?: Record<string, Snapshot | null>;
  /** Each repository's older builds, newest first, by id. */
  older?: Record<string, Snapshot[]>;
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

/** A build's snapshot id, named by its commit so a test can pick it. */
const snapshotId = (commitSha: string) => `rsn_${commitSha}`;

function harness(setup: Setup = {}) {
  let bounty = bountyOf(setup.bounty);
  const refreshed: unknown[] = [];
  const blobs: string[] = [];
  const contexts = memoryContexts(setup.contexts);
  // Changed in place by a test, as a finished build would move them.
  const snapshots: Record<string, Snapshot | null> = {
    ...setup.snapshots,
  };
  const older: Record<string, Snapshot[]> = { ...setup.older };
  const repos = [...(setup.repos ?? [repo])];
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
              list: () => Promise.resolve(repos),
            },
            snapshots: {
              built: (_org: string, repoId: string) => {
                const newest =
                  snapshots[repoId] === undefined
                    ? {
                        commitSha: "c2",
                        treeKey: `trees/${repoId}`,
                        ref: "refs/heads/main",
                      }
                    : snapshots[repoId];
                return Promise.resolve(
                  (newest === null
                    ? []
                    : [newest, ...(older[repoId] ?? [])].map((build) => ({
                        ...build,
                        id: snapshotId(build.commitSha),
                        repoId,
                        createdAt: stamp,
                      }))) as never,
                );
              },
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
  const request = (method: string, path: string, body?: unknown) =>
    app.request(`/api/v1/orgs/org_1/${path}`, {
      method,
      ...(body === undefined
        ? {}
        : {
            body: JSON.stringify(body),
            headers: { "content-type": "application/json" },
          }),
    });
  /** Picks a commit for each repository named, by its id. */
  const pin = (commits: Record<string, string> = { ghr_1: snapshotId("c2") }) =>
    request("PUT", "bounties/bty_7/context/github/commits", { commits });
  const context = async () =>
    (await (
      await request("GET", "bounties/bty_7/context")
    ).json()) as BountyContextResponse;
  return {
    request,
    pin,
    context,
    refreshed,
    blobs,
    snapshots,
    older,
    repos,
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
      stages: { scope: { context: unknown } };
    };
    context: BountyContextResponse;
  };
  assert.equal(body.changed, true);
  // The scope now holds it, as the steps after it will read.
  assert.deepEqual(body.bounty.stages.scope.context, {
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

  // Moved only by a comment: its fields and text are what the bounty holds.
  const commented = harness({
    bounty: {
      jira: jiraLink,
      title: "From Jira",
      description: "Jira's steps.",
    },
    contexts: [storedJira(2)],
    liveUpdated: "2026-10-07T09:00:00.000+0000",
  });
  assert.equal(
    (
      (await (
        await commented.request("GET", "bounties/bty_7/context")
      ).json()) as BountyContextResponse
    ).jira.state,
    "current",
  );
  // Its fields moved, its text did not.
  const pointed = harness({
    bounty: {
      jira: jiraLink,
      title: "From Jira",
      description: "Jira's steps.",
    },
    contexts: [
      storedJira(2, {
        contentHash: contextHash({
          source: "jira",
          content: jiraContext({ storyPoints: 3 }),
        }),
      }),
    ],
    liveUpdated: "2026-10-07T09:00:00.000+0000",
  });
  assert.equal(
    (
      (await (
        await pointed.request("GET", "bounties/bty_7/context")
      ).json()) as BountyContextResponse
    ).jira.state,
    "ahead",
  );

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

test("the issue is read once a minute, a pin's answer and a second look included", async () => {
  const reads = { client: 0, issue: 0, context: 0, spec: 0 };
  const counting = {
    issue: (id: string) => {
      reads.issue += 1;
      return Promise.resolve({
        id,
        key: "APP-1",
        updated: "2026-10-07T09:00:00.000+0000",
      });
    },
    issueContext: () => {
      reads.context += 1;
      return Promise.resolve(jiraContext());
    },
    issueSpec: () => {
      reads.spec += 1;
      return Promise.resolve({
        summary: "From Jira",
        descriptionText: "Jira's steps.",
        components: [],
        inputTruncated: false,
        updated: "2026-10-07T09:00:00.000+0000",
      });
    },
  };
  const state = harness({
    bounty: { jira: jiraLink },
    contexts: [storedJira(2)],
  });
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("user", { id: "user_1" } as never);
    c.set("member", { organizationId: "org_1", role: "member" });
    await next();
  });
  mountBountyContextRoutes(app, {
    ...state.options,
    clientFor: () => {
      reads.client += 1;
      return Promise.resolve({ ok: true, client: counting as never });
    },
  });
  const look = async () =>
    (
      (await (
        await app.request("/api/v1/orgs/org_1/bounties/bty_7/context")
      ).json()) as BountyContextResponse
    ).jira.state;
  assert.equal(await look(), "ahead");
  assert.equal(await look(), "ahead");
  const pinned = await app.request(
    "/api/v1/orgs/org_1/bounties/bty_7/context/github/commits",
    {
      method: "PUT",
      body: JSON.stringify({ commits: { ghr_1: snapshotId("c2") } }),
      headers: { "content-type": "application/json" },
    },
  );
  assert.equal(
    ((await pinned.json()) as { context: BountyContextResponse }).context.jira
      .state,
    "ahead",
  );
  assert.deepEqual(reads, { client: 1, issue: 1, context: 1, spec: 1 });
});

test("recent reads are kept a minute, the newest first when full", () => {
  let clock = 0;
  const recent = recentReads<number>({ now: () => clock, max: 2 });
  recent.set("a", 1);
  recent.set("b", 2);
  recent.set("a", 3);
  recent.set("c", 4);
  assert.equal(recent.get("b"), undefined);
  assert.equal(recent.get("a"), 3);
  clock = 60_000;
  assert.equal(recent.get("c"), undefined);
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

test("picking a commit reads the documents there, title's words first", async () => {
  const state = harness();
  const before = await state.context();
  assert.equal(before.github.state, "unsynced");
  assert.equal(before.github.liveRevision, "acme/app@c2");
  // One repository is named, and found, as itself.
  assert.deepEqual(before.github.linked, {
    ref: "acme/app",
    url: "https://github.com/acme/app",
  });

  const response = await state.pin();
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

test("a commit whose build kept its documents is read from storage, and GitHub only for the rest", async () => {
  const stored = (state: ReturnType<typeof harness>) => {
    const asked: string[] = [];
    Object.assign(state.options.githubContext ?? {}, {
      documentsFor: (_org: string, snapshot: string) => {
        asked.push(snapshot);
        return Promise.resolve({
          schemaVersion: 1,
          toolVersion: "documents@1",
          sourceSnapshotId: snapshot,
          sourceCommitSha: "c2",
          documents: [
            {
              path: "README.md",
              bytes: 40_000,
              text: "Stored readme.",
              truncated: true,
            },
          ],
          omitted: 0,
        });
      },
    });
    return asked;
  };
  const state = harness();
  const asked = stored(state);
  assert.equal((await state.pin()).status, 200);
  assert.deepEqual(asked, [snapshotId("c2")]);
  const latest = (await state.context()).github.latest;
  assert.ok(latest?.source === "github" && "repositories" in latest.content);
  const [app] = latest.content.repositories;
  // Kept whole here, yet cut by the build that kept it.
  assert.deepEqual(app?.documents[0], {
    path: "README.md",
    bytes: 40_000,
    text: "Stored readme.",
    truncated: true,
  });
  assert.equal(app?.documents[1]?.text, "text of s2");
  assert.deepEqual(state.blobs, ["acme/app:s2"]);

  // With no reader, what storage kept is still read; the rest is not.
  const offline = harness({ reader: null });
  stored(offline);
  assert.equal((await offline.pin()).status, 200);
  const read = (await offline.context()).github.latest;
  assert.ok(read?.source === "github" && "repositories" in read.content);
  assert.deepEqual(
    read.content.repositories[0]?.documents.map(({ path }) => path),
    ["README.md"],
  );
  assert.deepEqual(offline.blobs, []);
});

test("an approved scope's context is held: no sync, no commit picked, still read", async () => {
  const state = harness({
    bounty: {
      jira: jiraLink,
      approval: { version: 1, approvedBy: "user_1", approvedAt: stamp },
    },
  });
  const sync = await state.request("POST", "bounties/bty_7/context/jira/sync");
  assert.equal(sync.status, 409);
  assert.equal(
    ((await sync.json()) as { code: string }).code,
    "scope_approved",
  );
  const pin = await state.pin();
  assert.equal(pin.status, 409);
  assert.equal(state.rows.length, 0);
  assert.equal(state.refreshed.length, 0);
  assert.equal((await state.context()).jira.state, "unsynced");
});

test("GitHub is pinned, not synced", async () => {
  const state = harness();
  assert.equal(
    (await state.request("POST", "bounties/bty_7/context/github/sync")).status,
    404,
  );
  assert.equal(state.rows.length, 0);
});

test("a repository not picked is read at its newest build, and one never built is unread", async () => {
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

  const response = await state.pin();
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

test("a repository its connection cannot read is unread, and is held where it was picked", async () => {
  const state = harness({ repos: [repo, web], unreadable: ["ghr_2"] });
  const response = await state.pin();
  assert.equal(response.status, 200);
  const body = (await response.json()) as { context: BountyContextResponse };
  const latest = body.context.github.latest;
  assert.ok(latest?.source === "github" && "repositories" in latest.content);
  assert.deepEqual(latest.content.unread, ["acme/web"]);
  // Where it was picked counts, read or not, as the status measures it.
  assert.equal(latest.revision, "acme/app@c2\nacme/web@c2");
  assert.equal(body.context.github.state, "current");

  // A newer build is offered, not followed: the scope is not behind it.
  state.snapshots["ghr_2"] = {
    commitSha: "w2",
    treeKey: "trees/w",
    ref: "refs/heads/main",
  };
  const read = await state.context();
  assert.equal(read.github.state, "current");
  assert.equal(read.github.liveRevision, "acme/app@c2\nacme/web@w2");
});

test("each repository is held at its own commit, and moving one back leaves the others", async () => {
  const state = harness({
    repos: [web, repo],
    snapshots: {
      ghr_1: {
        commitSha: "c3",
        treeKey: "trees/ghr_1",
        ref: "refs/heads/main",
      },
      ghr_2: { commitSha: "w1", treeKey: "trees/w", ref: "refs/heads/dev" },
    },
    older: {
      ghr_1: [
        { commitSha: "c2", treeKey: "trees/old", ref: "refs/heads/main" },
      ],
    },
  });
  // An older commit than the newest build.
  const response = await state.pin({ ghr_1: snapshotId("c2") });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { context: BountyContextResponse };
  const latest = body.context.github.latest;
  assert.equal(body.context.github.state, "current");
  // Where each stands, in name order whichever order they were listed in.
  assert.equal(latest?.revision, "acme/app@c2\nacme/web@w1");
  assert.equal(latest?.ref, "2 repositories");
  assert.ok(latest?.source === "github" && "repositories" in latest.content);
  assert.deepEqual(
    latest.content.repositories.map(({ fullName, branch, commitSha }) => [
      fullName,
      branch,
      commitSha,
    ]),
    [
      ["acme/web", "dev", "w1"],
      ["acme/app", "main", "c2"],
    ],
  );

  // The picker lists each one's builds, and where the scope holds it.
  const commits = (await (
    await state.request("GET", "bounties/bty_7/context/github/commits")
  ).json()) as BountyGithubCommitsResponse;
  assert.deepEqual(
    commits.repositories.map(({ repoId, held, commits }) => [
      repoId,
      held,
      commits.map(({ snapshotId: id, branch }) => `${id}:${branch}`),
    ]),
    [
      ["ghr_2", "w1", ["rsn_w1:dev"]],
      ["ghr_1", "c2", ["rsn_c3:main", "rsn_c2:main"]],
    ],
  );

  // A newer build of the other, then the first moved forward alone: the
  // other stays where it is held, not at its newest build.
  state.older.ghr_2 = [
    { commitSha: "w1", treeKey: "trees/w", ref: "refs/heads/dev" },
  ];
  state.snapshots.ghr_2 = {
    commitSha: "w2",
    treeKey: "trees/w",
    ref: "refs/heads/dev",
  };
  const again = (await (
    await state.pin({ ghr_1: snapshotId("c3") })
  ).json()) as { changed: boolean; context: BountyContextResponse };
  assert.equal(
    again.context.github.latest?.revision,
    "acme/app@c3\nacme/web@w1",
  );
  // The same documents: the same version, read at the commits picked,
  // which its content names too, not the commit it was first read at.
  assert.equal(again.changed, false);
  assert.equal(again.context.github.latest?.version, 1);
  assert.equal(again.context.github.state, "current");
  const moved = again.context.github.latest;
  assert.ok(moved?.source === "github" && "repositories" in moved.content);
  assert.deepEqual(
    moved.content.repositories.map(({ fullName, commitSha }) => [
      fullName,
      commitSha,
    ]),
    [
      ["acme/web", "w1"],
      ["acme/app", "c3"],
    ],
  );
});

test("a repository connected and built since the scope read them is ahead", async () => {
  const state = harness();
  assert.equal((await state.pin()).status, 200);
  assert.equal((await state.context()).github.state, "current");
  // Connected, never built: nothing to read it at yet.
  state.repos.push(web);
  state.snapshots.ghr_2 = null;
  assert.equal((await state.context()).github.state, "current");
  // Built: the scope does not read it.
  state.snapshots.ghr_2 = {
    commitSha: "w1",
    treeKey: "trees/w",
    ref: "refs/heads/main",
  };
  assert.equal((await state.context()).github.state, "ahead");
  assert.equal((await state.pin()).status, 200);
  assert.equal((await state.context()).github.state, "current");
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
  // Sizing still reads it until the workspace's is picked over it.
  const held = await heldContext(state.options, "org_1", bountyOf());
  assert.equal(held.github?.version, 1);

  assert.equal((await state.pin()).status, 200);
  const synced = await state.context();
  assert.equal(synced.github.state, "current");
  assert.equal(synced.github.latest?.version, 2);
});

test("a pick that cannot be read says why", async () => {
  for (const [setup, status, code, commits] of [
    [{ repos: [] }, 409, "no_repository"],
    [{ repos: [{ ...repo, syncStatus: "gone" }] }, 409, "no_repository"],
    [{ repos: [{ ...repo, role: "sandbox" }] }, 409, "no_repository"],
    [{ github: false }, 503, "unconfigured"],
    [{}, 404, "repository_not_found", { ghr_9: snapshotId("c2") }],
    // Only a built commit can be picked.
    [{}, 409, "not_built", { ghr_1: snapshotId("c9") }],
    [{ snapshots: { ghr_1: null } }, 409, "not_built"],
    [
      { repos: [repo, web], snapshots: { ghr_1: null, ghr_2: null } },
      409,
      "not_built",
      { ghr_1: snapshotId("c2") },
    ],
    [{ tree: null }, 409, "unreadable"],
    [{ reader: null }, 409, "unreadable"],
    [{ blobError: new GithubNotFound("gone") }, 409, "repository_gone"],
    [{ blobError: new Error("down") }, 502, "github_failed"],
  ] as const) {
    const state = harness(setup as Setup);
    const response = await state.pin(commits);
    assert.equal(response.status, status, code);
    assert.equal(((await response.json()) as { code: string }).code, code);
    assert.equal(state.rows.length, 0, code);
  }
  // A pick names at least one repository.
  for (const body of [{}, { commits: {} }, null]) {
    const response = await harness().request(
      "PUT",
      "bounties/bty_7/context/github/commits",
      body,
    );
    assert.equal(response.status, 400);
  }
});

test("the built commits are listed only where GitHub is set up, for a bounty that is there", async () => {
  assert.equal(
    (
      await harness({ github: false }).request(
        "GET",
        "bounties/bty_7/context/github/commits",
      )
    ).status,
    503,
  );
  assert.equal(
    (
      await harness().request(
        "GET",
        "bounties/bty_other/context/github/commits",
      )
    ).status,
    404,
  );
  // Never picked: held nowhere.
  const listed = (await (
    await harness().request("GET", "bounties/bty_7/context/github/commits")
  ).json()) as BountyGithubCommitsResponse;
  assert.deepEqual(listed.repositories[0]?.held, null);
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
  // None built yet: linked, with nowhere it stands.
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
