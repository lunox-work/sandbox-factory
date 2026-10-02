import assert from "node:assert/strict";
import { test } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";

import {
  GithubInstallationUnavailable,
  GithubNotFound,
} from "@sandbox-factory/github";
import {
  repoSnapshotDetailDtoSchema,
  repoSnapshotDtoSchema,
  repoTreePageDtoSchema,
  storedTreeSchema,
} from "@sandbox-factory/shared";

import type { Auth } from "../src/auth.js";
import {
  DISCOVERY_PERMISSIONS,
  narrowingFor,
  REPOSITORY_READ_PERMISSIONS,
} from "../src/github/credential.js";
import { treePage } from "../src/github/routes.js";
import {
  GithubSnapshotter,
  storedEntries,
  treeKey,
} from "../src/github/snapshot.js";
import { createApp } from "../src/routes.js";
import {
  fakeGithub,
  installationTokens,
  memoryGithub,
  memoryObjects,
  memorySnapshots,
  NOW,
  SHA_A,
  SHA_B,
  SHA_C,
  seedConnection,
  seedRepo,
  widgetsTree,
  world,
  type GithubWorld,
} from "./github-fakes.js";

/**
 * Repository snapshots: one per head a source repository is seen at, read
 * with a token narrowed to that repository and to reads, and refused for a
 * repository that is gone.
 */

async function setup(
  overrides: Partial<GithubWorld> = {},
  options: { retain?: number; concurrency?: number } = {},
) {
  const state = world({
    trees: {
      ...widgetsTree(SHA_A),
      ...widgetsTree(SHA_B),
      ...widgetsTree(SHA_C),
    },
    languages: { "acme/widgets": { TypeScript: 200, JSON: 40 } },
    ...overrides,
  });
  const fetch = fakeGithub(state);
  const stores = memoryGithub();
  const snapshots = memorySnapshots(stores);
  const objects = memoryObjects();
  const errors: { code: string; detail: string | undefined }[] = [];
  const snapshotter = new GithubSnapshotter({
    repos: stores.repos,
    snapshots,
    objects,
    installations: installationTokens(fetch),
    fetch,
    ...options,
    onError: (code, detail) => errors.push({ code, detail }),
  });
  const connectionId = await seedConnection(stores, "org_1", "9");
  const repoId = await seedRepo(stores, "org_1", connectionId);
  const target = { organizationId: "org_1", repoId, installationId: "9" };
  return {
    state,
    fetch,
    stores,
    snapshots,
    objects,
    errors,
    snapshotter,
    repoId,
    target,
  };
}

test("a snapshot reads the head's tree with a token narrowed to the repository", async () => {
  const { snapshotter, snapshots, objects, fetch, target, repoId } =
    await setup();

  assert.equal(await snapshotter.snapshot(target), "created");

  // The mint asked for one repository and reads only.
  assert.deepEqual(fetch.mints, [
    {
      installationId: "9",
      repositoryIds: [1296269],
      permissions: { contents: "read", metadata: "read" },
    },
  ]);
  assert.ok(
    fetch.urls.includes(
      `GET https://api.github.com/repos/acme/widgets/git/trees/${SHA_A}?recursive=1`,
    ),
  );

  const [row] = [...snapshots.rows.values()];
  assert.equal(row?.commitSha, SHA_A);
  assert.equal(row?.ref, "refs/heads/main");
  assert.equal(row?.treeSha, `tree-${SHA_A.slice(0, 7)}`);
  assert.ok(row !== undefined);
  assert.ok(row.treeKey.startsWith(`trees/${repoId}/${SHA_A}/`));
  assert.ok(row.treeKey.endsWith(".json.gz"));
  assert.equal(row?.treeTruncated, false);
  assert.equal(row?.fileCount, 4);
  assert.equal(row?.totalBytes, 240);
  assert.deepEqual(row?.languages, { TypeScript: 200, JSON: 40 });
  assert.equal(row?.facts.testFiles, 1);
  assert.deepEqual(row?.facts.lockfiles, ["package-lock.json"]);

  // The stored list: files and the submodule, path order, no directories.
  const body = objects.objects.get(row.treeKey);
  assert.ok(body !== undefined);
  const stored = storedTreeSchema.parse(
    JSON.parse(gunzipSync(body).toString("utf8")),
  );
  assert.equal(stored.commitSha, SHA_A);
  assert.deepEqual(
    stored.entries.map(({ path, type, size }) => [path, type, size]),
    [
      ["package-lock.json", "blob", 40],
      ["src/index.test.ts", "blob", 80],
      ["src/index.ts", "blob", 120],
      ["vendor/lib", "commit", 0],
    ],
  );
});

test("snapshotting the same head again is a no-op that asks GitHub nothing", async () => {
  const { snapshotter, snapshots, fetch, target } = await setup();
  await snapshotter.snapshot(target);
  const calls = fetch.urls.length;

  assert.equal(await snapshotter.snapshot(target), "exists");
  assert.equal(fetch.urls.length, calls);
  assert.equal(snapshots.rows.size, 1);
});

test("a twin that wrote the row first leaves this one as exists", async () => {
  const { snapshotter, snapshots, objects, target } = await setup();
  // The webhook's and the sweep's jobs both pass the existence check.
  const original = snapshots.findByCommit;
  snapshots.findByCommit = () => Promise.resolve(null);
  const [first, second] = await Promise.all([
    snapshotter.snapshot(target),
    snapshotter.snapshot(target),
  ]);
  snapshots.findByCommit = original;

  assert.deepEqual([first, second].sort(), ["created", "exists"]);
  assert.equal(snapshots.rows.size, 1);
  assert.equal(objects.objects.size, 1);
  const winner = [...snapshots.rows.values()][0];
  assert.ok(winner !== undefined);
  assert.equal((await snapshotter.tree(winner.treeKey))?.commitSha, SHA_A);
});

test("a truncated tree is flagged and still snapshotted", async () => {
  const tree = widgetsTree(SHA_A);
  const entry = tree[`acme/widgets@${SHA_A}`];
  assert.ok(entry !== undefined);
  const { snapshotter, snapshots, target } = await setup({
    trees: { [`acme/widgets@${SHA_A}`]: { ...entry, truncated: true } },
  });

  assert.equal(await snapshotter.snapshot(target), "created");
  const [row] = [...snapshots.rows.values()];
  assert.equal(row?.treeTruncated, true);
  assert.equal(row?.facts.truncated, true);
  assert.equal(row?.fileCount, 4);
});

test("a gone repository is refused before GitHub is asked", async () => {
  const { snapshotter, stores, snapshots, fetch, target, repoId } =
    await setup();
  await stores.repos.markGone("org_1", [repoId]);

  assert.equal(await snapshotter.snapshot(target), "refused");
  assert.equal(fetch.urls.length, 0);
  assert.equal(snapshots.rows.size, 0);
});

test("another organization's repository, or none, is refused", async () => {
  const { snapshotter, target } = await setup();
  assert.equal(
    await snapshotter.snapshot({ ...target, organizationId: "org_2" }),
    "refused",
  );
  assert.equal(
    await snapshotter.snapshot({ ...target, repoId: "ghr_missing" }),
    "refused",
  );
});

test("a repository with no head yet has nothing to snapshot", async () => {
  const { snapshotter, stores, target, repoId } = await setup();
  const row = stores.repos.rows.get(repoId);
  assert.ok(row !== undefined);
  stores.repos.rows.set(repoId, { ...row, headSha: null });

  assert.equal(await snapshotter.snapshot(target), "no-head");
});

test("a repository gone by the time the row is written leaves no row", async () => {
  const { snapshotter, stores, snapshots, objects, target, repoId } =
    await setup();
  // Gone while the tree was on the wire.
  const original = snapshots.create;
  snapshots.create = async (organizationId, input) => {
    await stores.repos.markGone("org_1", [repoId]);
    return original(organizationId, input);
  };

  assert.equal(await snapshotter.snapshot(target), "refused");
  assert.equal(snapshots.rows.size, 0);
  assert.equal(objects.objects.size, 0);
});

test("a failed snapshot insert removes its attempt's object", async () => {
  const { snapshotter, snapshots, objects, target } = await setup();
  snapshots.create = () => Promise.reject(new Error("database unavailable"));
  await assert.rejects(snapshotter.snapshot(target), /database unavailable/);
  assert.equal(objects.objects.size, 0);
});

test("a lost insert response cannot delete a committed snapshot's tree", async () => {
  const { snapshotter, snapshots, objects, target, repoId } = await setup();
  const create = snapshots.create;
  snapshots.create = async (organizationId, input) => {
    await create(organizationId, input);
    throw new Error("commit response lost");
  };
  await assert.rejects(snapshotter.snapshot(target), /commit response lost/);
  const row = await snapshots.findByCommit("org_1", repoId, SHA_A);
  assert.ok(row !== null);
  assert.equal(objects.objects.size, 1);
  assert.equal((await snapshotter.tree(row.treeKey))?.commitSha, SHA_A);
});

test("an uncertain insert keeps its object when the database cannot check it", async () => {
  const { snapshotter, snapshots, objects, target } = await setup();
  let reads = 0;
  snapshots.findByCommit = async () => {
    reads += 1;
    if (reads > 1) throw new Error("database unavailable");
    return null;
  };
  snapshots.create = () => Promise.reject(new Error("commit response lost"));
  await assert.rejects(snapshotter.snapshot(target), /commit response lost/);
  assert.equal(objects.objects.size, 1);
});

test("moving the head does not change a snapshot; the new head gets its own", async () => {
  const { snapshotter, stores, snapshots, target, repoId } = await setup();
  await snapshotter.snapshot(target);
  await stores.repos.setHead("org_1", repoId, {
    headSha: SHA_B,
    pushedAt: "2026-10-01T00:00:00.000Z",
  });

  assert.equal(await snapshotter.snapshot(target), "created");
  const commits = [...snapshots.rows.values()].map(
    ({ commitSha }) => commitSha,
  );
  assert.deepEqual(commits, [SHA_A, SHA_B]);
  assert.equal((await snapshots.current("org_1", repoId))?.commitSha, SHA_B);
});

test("a denied installation creates no snapshot and no object", async () => {
  const { snapshotter, snapshots, objects, target } = await setup({
    uninstalled: [9],
  });

  await assert.rejects(
    snapshotter.snapshot(target),
    GithubInstallationUnavailable,
  );
  assert.equal(snapshots.rows.size, 0);
  assert.equal(objects.objects.size, 0);
});

test("a repository the installation no longer covers is not found", async () => {
  const { snapshotter, snapshots, target } = await setup({
    outsideInstallation: [1296269],
  });

  await assert.rejects(snapshotter.snapshot(target), GithubNotFound);
  assert.equal(snapshots.rows.size, 0);
});

test("older unreferenced snapshots are pruned with their trees", async () => {
  const { snapshotter, stores, snapshots, objects, target, repoId } =
    await setup({}, { retain: 1 });
  await snapshotter.snapshot(target);
  const [first] = [...snapshots.rows.values()];
  assert.ok(first !== undefined);
  await stores.repos.setHead("org_1", repoId, {
    headSha: SHA_B,
    pushedAt: "2026-10-01T00:00:00.000Z",
  });

  await snapshotter.snapshot(target);

  assert.deepEqual(
    [...snapshots.rows.values()].map(({ commitSha }) => commitSha),
    [SHA_B],
  );
  assert.deepEqual(objects.removed, [first.treeKey]);
});

test("a delayed prune cannot remove another worker's recreated tree", async () => {
  const { snapshotter, stores, snapshots, objects, fetch, target, repoId } =
    await setup({}, { retain: 1 });
  await snapshotter.snapshot(target);
  const original = await snapshots.findByCommit("org_1", repoId, SHA_A);
  assert.ok(original !== null);

  let release = () => {};
  let reached = () => {};
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  const deleting = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const remove = objects.remove;
  objects.remove = async (key) => {
    if (key === original.treeKey) {
      reached();
      await paused;
    }
    await remove(key);
  };
  await stores.repos.setHead("org_1", repoId, {
    headSha: SHA_B,
    pushedAt: "2026-10-01T00:00:00.000Z",
  });
  const pruning = snapshotter.snapshot(target);
  await deleting;

  const other = new GithubSnapshotter({
    repos: stores.repos,
    snapshots,
    objects,
    installations: installationTokens(fetch),
    fetch,
    retain: 1,
  });
  await stores.repos.setHead("org_1", repoId, {
    headSha: SHA_A,
    pushedAt: "2026-10-01T00:00:01.000Z",
  });
  try {
    assert.equal(await other.snapshot(target), "created");
  } finally {
    release();
    await pruning;
  }
  const recreated = await snapshots.findByCommit("org_1", repoId, SHA_A);
  assert.ok(recreated !== null);
  assert.notEqual(recreated.treeKey, original.treeKey);
  assert.equal((await other.tree(recreated.treeKey))?.commitSha, SHA_A);
  assert.equal(await other.snapshot(target), "exists");
});

test("a snapshot a proposal references is kept however old", async () => {
  const { snapshotter, stores, snapshots, objects, target, repoId } =
    await setup({}, { retain: 1 });
  await snapshotter.snapshot(target);
  const [first] = [...snapshots.rows.values()];
  assert.ok(first !== undefined);
  snapshots.referenced.add(first.id);
  let middleKey = "";
  for (const headSha of [SHA_B, SHA_C]) {
    await stores.repos.setHead("org_1", repoId, {
      headSha,
      pushedAt: "2026-10-01T00:00:00.000Z",
    });
    await snapshotter.snapshot(target);
    if (headSha === SHA_B) {
      middleKey =
        (await snapshots.findByCommit("org_1", repoId, SHA_B))?.treeKey ?? "";
    }
  }

  // B is past the one unreferenced snapshot kept; A is referenced.
  assert.deepEqual(
    [...snapshots.rows.values()].map(({ commitSha }) => commitSha),
    [SHA_A, SHA_C],
  );
  assert.deepEqual(objects.removed, [middleKey]);
});

test("the snapshot just taken is never pruned, whatever retain says", async () => {
  const { snapshotter, snapshots, target } = await setup({}, { retain: 0 });
  assert.equal(await snapshotter.snapshot(target), "created");
  assert.equal(snapshots.rows.size, 1);
});

test("a prune or a removal that fails is reported, not thrown", async () => {
  const { snapshotter, stores, snapshots, objects, errors, target, repoId } =
    await setup({}, { retain: 1 });
  await snapshotter.snapshot(target);
  objects.failRemove = true;
  await stores.repos.setHead("org_1", repoId, {
    headSha: SHA_B,
    pushedAt: "2026-10-01T00:00:00.000Z",
  });
  assert.equal(await snapshotter.snapshot(target), "created");
  assert.equal(errors[0]?.code, "github_snapshot_remove_failed");

  snapshots.prune = () => Promise.reject(new Error("database down"));
  await snapshotter.removeObjects([]);
  const second = await setup();
  second.snapshots.prune = () => Promise.reject(new Error("database down"));
  assert.equal(await second.snapshotter.snapshot(second.target), "created");
  assert.equal(second.errors[0]?.code, "github_snapshot_prune_failed");
  assert.match(second.errors[0]?.detail ?? "", /database down/);
});

test("a stored tree reads back, and a missing or foreign object is null", async () => {
  const { snapshotter, objects, snapshots, target, repoId } = await setup();
  await snapshotter.snapshot(target);
  const row = await snapshots.findByCommit("org_1", repoId, SHA_A);
  assert.ok(row !== null);

  const tree = await snapshotter.tree(row.treeKey);
  assert.equal(tree?.entries.length, 4);
  assert.equal(await snapshotter.tree("trees/none.json.gz"), null);

  objects.objects.set("trees/plain.json.gz", new TextEncoder().encode("{}"));
  assert.equal(await snapshotter.tree("trees/plain.json.gz"), null);
  objects.objects.set(
    "trees/other.json.gz",
    gzipSync(JSON.stringify({ version: 99 })),
  );
  assert.equal(await snapshotter.tree("trees/other.json.gz"), null);
});

test("scheduled snapshots run in the background and coalesce per repository", async () => {
  const { snapshotter, snapshots, fetch, target } = await setup();

  snapshotter.schedule(target);
  snapshotter.schedule(target);
  snapshotter.schedule(target);
  await snapshotter.idle();

  assert.equal(snapshots.rows.size, 1);
  // One run took it; the queued repeat found it taken.
  assert.equal(
    fetch.urls.filter((url) => url.includes("/git/trees/")).length,
    1,
  );
  await snapshotter.idle();
});

test("scheduled jobs that fail are reported with a fixed code", async () => {
  const cases: [Partial<GithubWorld>, string][] = [
    [{ uninstalled: [9] }, "github_snapshot_refused"],
    [{ outsideInstallation: [1296269] }, "github_snapshot_not_found"],
    [{ limitedInstallations: [9] }, "github_snapshot_rate_limited"],
    [{ treeStatus: 500 }, "github_snapshot_failed"],
  ];
  for (const [overrides, code] of cases) {
    const { snapshotter, errors, target } = await setup(overrides);
    snapshotter.schedule(target);
    await snapshotter.idle();
    assert.equal(errors[0]?.code, code, code);
  }
});

test("at most the configured number run at once, and the rest wait", async () => {
  const { snapshotter, stores, snapshots, target } = await setup(
    {},
    { concurrency: 1 },
  );
  const connectionId = [...stores.connections.rows.keys()][0] ?? "";
  const second = await seedRepo(stores, "org_1", connectionId, {
    externalId: "77",
    fullName: "acme/widgets",
  });
  // A second repository at the same name and head, so the fake answers it.
  snapshotter.schedule(target);
  snapshotter.schedule({ ...target, repoId: second });
  await snapshotter.idle();

  assert.equal(snapshots.rows.size, 2);
});

test("a stopped snapshotter takes no more work and waits for what runs", async () => {
  const { snapshotter, snapshots, target } = await setup();
  snapshotter.schedule(target);
  await snapshotter.stop();
  assert.equal(snapshots.rows.size, 1);

  snapshotter.schedule(target);
  await snapshotter.idle();
  assert.equal(snapshots.rows.size, 1);
});

test("stored entries keep files and submodules, sizes made safe", () => {
  assert.deepEqual(
    storedEntries([
      { path: "b.ts", mode: "100644", type: "blob", sha: "1", size: 3 },
      { path: "a", mode: "040000", type: "tree", sha: "2" },
      { path: "a/x.ts", mode: "100644", type: "blob", sha: "3" },
      { path: "a/y.ts", mode: "100644", type: "blob", sha: "4", size: -1 },
      { path: "m", mode: "160000", type: "commit", sha: "5", size: 9 },
    ]).map(({ path, size }) => [path, size]),
    [
      ["a/x.ts", 0],
      ["a/y.ts", 0],
      ["b.ts", 3],
      ["m", 0],
    ],
  );
});

test("scopes narrow discovery to metadata and a repository to its id", () => {
  assert.deepEqual(narrowingFor({ kind: "discovery" }), {
    permissions: DISCOVERY_PERMISSIONS,
  });
  assert.deepEqual(narrowingFor({ kind: "repository", repositoryId: "42" }), {
    repositoryIds: [42],
    permissions: REPOSITORY_READ_PERMISSIONS,
  });
  // Neither asks for a write, whatever the installation holds.
  for (const permissions of [
    DISCOVERY_PERMISSIONS,
    REPOSITORY_READ_PERMISSIONS,
  ]) {
    assert.ok(Object.values(permissions).every((level) => level === "read"));
  }
  assert.throws(() =>
    narrowingFor({ kind: "repository", repositoryId: "not-a-number" }),
  );
});

test("a tree page filters by directory and resumes after its cursor", () => {
  const entries = ["a.ts", "src/a.ts", "src/b.ts", "src/c/d.ts", "srcx.ts"].map(
    (path) => ({
      path,
      type: "blob" as const,
      mode: "100644",
      sha: "s",
      size: 1,
    }),
  );

  const first = treePage(entries, false, { prefix: "/src/", limit: 2 });
  assert.deepEqual(
    first.entries.map(({ path }) => path),
    ["src/a.ts", "src/b.ts"],
  );
  assert.equal(first.nextCursor, "src/b.ts");

  const second = treePage(entries, true, {
    prefix: "src",
    cursor: first.nextCursor ?? "",
    limit: 2,
  });
  assert.deepEqual(
    second.entries.map(({ path }) => path),
    ["src/c/d.ts"],
  );
  assert.equal(second.nextCursor, null);
  assert.equal(second.truncated, true);

  assert.equal(treePage(entries, false, { limit: 10 }).entries.length, 5);
});

/* ---- routes --------------------------------------------------------------- */

const dana = { id: "user_1", email: "dana@example.test", name: "Dana" };

function fakeAuth(): Auth {
  return {
    api: {
      getSession: () =>
        Promise.resolve({ user: dana, session: { id: "session_1" } }),
    },
    handler: () => Promise.resolve(new Response(null, { status: 404 })),
  } as unknown as Auth;
}

async function appWith(options: { snapshots?: boolean; role?: string } = {}) {
  const setUp = await setup();
  const app = createApp({
    corsOrigins: ["https://app.test"],
    auth: fakeAuth(),
    organizations: {
      roleOf: (_userId: string, organizationId: string) =>
        Promise.resolve(
          organizationId === "org_1" ? (options.role ?? "member") : undefined,
        ),
    } as never,
    github: {
      ...setUp.stores,
      installations: installationTokens(setUp.fetch),
      ...(options.snapshots === false
        ? {}
        : {
            snapshots: {
              store: setUp.snapshots,
              snapshotter: setUp.snapshotter,
            },
          }),
      appSlug: "sandbox-factory",
      clientId: "Iv1.app",
      clientSecret: "app-secret",
      webhookSecret: "webhook-secret",
      secret: "0123456789abcdef0123456789abcdef",
      apiUrl: "https://platform.test",
      appUrl: "https://platform.test",
      fetch: setUp.fetch,
      now: () => NOW,
    },
  });
  const get = (path: string) =>
    app.request(`/api/v1/orgs/org_1/github${path}`, {
      headers: { cookie: "session=1" },
    });
  return { ...setUp, app, get };
}

test("a member lists a repository's snapshots and reads one with its facts", async () => {
  const { snapshotter, target, repoId, get } = await appWith();
  await snapshotter.snapshot(target);

  const listed = await get(`/repositories/${repoId}/snapshots`);
  assert.equal(listed.status, 200);
  const { snapshots } = (await listed.json()) as { snapshots: unknown[] };
  assert.equal(snapshots.length, 1);
  const snapshot = repoSnapshotDtoSchema.parse(snapshots[0]);
  // The bucket key stays on the server.
  assert.equal("treeKey" in (snapshots[0] as object), false);

  const one = await get(`/snapshots/${snapshot.id}`);
  assert.equal(one.status, 200);
  const detail = repoSnapshotDetailDtoSchema.parse(
    ((await one.json()) as { snapshot: unknown }).snapshot,
  );
  assert.equal(detail.repoFullName, "acme/widgets");
  assert.equal(detail.facts.fileCount, 4);
});

test("a snapshot's tree is paged from the bucket", async () => {
  const { snapshotter, target, repoId, get } = await appWith();
  await snapshotter.snapshot(target);
  const { snapshots } = (await (
    await get(`/repositories/${repoId}/snapshots`)
  ).json()) as { snapshots: { id: string }[] };
  const id = snapshots[0]?.id ?? "";

  const page = await get(`/snapshots/${id}/tree?prefix=src&limit=1`);
  assert.equal(page.status, 200);
  const parsed = repoTreePageDtoSchema.parse(await page.json());
  assert.deepEqual(
    parsed.entries.map(({ path }) => path),
    ["src/index.test.ts"],
  );
  assert.equal(parsed.nextCursor, "src/index.test.ts");

  const next = repoTreePageDtoSchema.parse(
    await (
      await get(
        `/snapshots/${id}/tree?prefix=src&limit=1&cursor=${encodeURIComponent(parsed.nextCursor ?? "")}`,
      )
    ).json(),
  );
  assert.deepEqual(
    next.entries.map(({ path }) => path),
    ["src/index.ts"],
  );

  assert.equal((await get(`/snapshots/${id}/tree?limit=0`)).status, 400);
});

test("a tree whose object is gone is a 502 the page can explain", async () => {
  const { snapshotter, objects, target, repoId, get } = await appWith();
  await snapshotter.snapshot(target);
  objects.objects.clear();
  const { snapshots } = (await (
    await get(`/repositories/${repoId}/snapshots`)
  ).json()) as { snapshots: { id: string }[] };

  const response = await get(`/snapshots/${snapshots[0]?.id ?? ""}/tree`);
  assert.equal(response.status, 502);
  assert.equal(
    ((await response.json()) as { code: string }).code,
    "tree_unavailable",
  );
});

test("another organization's repository or snapshot is a 404", async () => {
  const { snapshotter, stores, target, get } = await appWith();
  await snapshotter.snapshot(target);
  const otherConnection = await seedConnection(stores, "org_2", "10", "beta");
  const otherRepo = await seedRepo(stores, "org_2", otherConnection, {
    externalId: "55",
  });

  assert.equal((await get(`/repositories/${otherRepo}/snapshots`)).status, 404);
  assert.equal((await get(`/snapshots/rsn_missing`)).status, 404);
  assert.equal((await get(`/snapshots/rsn_missing/tree`)).status, 404);
});

test("without object storage the snapshot routes say so with a 503", async () => {
  const { repoId, get } = await appWith({ snapshots: false });
  for (const path of [
    `/repositories/${repoId}/snapshots`,
    "/snapshots/rsn_1",
    "/snapshots/rsn_1/tree",
  ]) {
    const response = await get(path);
    assert.equal(response.status, 503);
    assert.equal(
      ((await response.json()) as { code: string }).code,
      "unconfigured",
    );
  }
});

test("removing a repository removes its snapshots' trees", async () => {
  const { app, snapshotter, objects, snapshots, target, repoId } =
    await appWith({
      role: "owner",
    });
  await snapshotter.snapshot(target);

  const response = await app.request(
    `/api/v1/orgs/org_1/github/repositories/${repoId}`,
    { method: "DELETE", headers: { cookie: "session=1" } },
  );
  assert.equal(response.status, 204);
  const keys = [...snapshots.rows.values()].map(({ treeKey }) => treeKey);
  assert.deepEqual(objects.removed, keys);
});

test("disconnecting GitHub removes the trees of every repository in that connection", async () => {
  const { app, snapshotter, objects, snapshots, stores, target } =
    await appWith({
      role: "owner",
    });
  const connectionId = [...stores.connections.rows.keys()][0] ?? "";
  const second = await seedRepo(stores, "org_1", connectionId, {
    externalId: "77",
  });
  await snapshotter.snapshot(target);
  await snapshotter.snapshot({ ...target, repoId: second });
  const keys = [...snapshots.rows.values()].map(({ treeKey }) => treeKey);
  const response = await app.request(
    `/api/v1/orgs/org_1/github/connections/${connectionId}`,
    { method: "DELETE", headers: { cookie: "session=1" } },
  );
  assert.equal(response.status, 204);
  assert.deepEqual(objects.removed.sort(), keys.sort());
  assert.equal(objects.objects.size, 0);
});

test("registering a repository schedules its first snapshot", async () => {
  const { app, snapshotter, snapshots, fetch } = await appWith({
    role: "owner",
  });
  // A second repository, registered through the route.
  const connectionId =
    [
      ...(
        (await (
          await app.request("/api/v1/orgs/org_1/github/connections", {
            headers: { cookie: "session=1" },
          })
        ).json()) as { connections: { id: string }[] }
      ).connections,
    ][0]?.id ?? "";
  const before = snapshots.rows.size;

  const response = await app.request(
    `/api/v1/orgs/org_1/github/connections/${connectionId}/repositories`,
    {
      method: "POST",
      headers: { cookie: "session=1", "content-type": "application/json" },
      body: JSON.stringify({ externalId: "1296269", role: "source" }),
    },
  );
  assert.equal(response.status, 201);
  await snapshotter.idle();

  assert.equal(snapshots.rows.size, before + 1);
  // Listing is discovery, installation-wide and metadata only; the head
  // and the tree are read with the repository's own token.
  assert.deepEqual(fetch.mints[0], {
    installationId: "9",
    permissions: { metadata: "read" },
  });
  assert.ok(
    fetch.mints
      .slice(1)
      .every(
        (mint) =>
          mint.repositoryIds?.length === 1 &&
          mint.repositoryIds[0] === 1296269 &&
          mint.permissions?.["contents"] === "read",
      ),
  );
});

test("tree keys distinguish snapshot attempts at the same commit", () => {
  assert.equal(
    treeKey("repo", "sha", "attempt"),
    "trees/repo/sha/attempt.json.gz",
  );
});
