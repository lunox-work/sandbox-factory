import assert from "node:assert/strict";
import { test } from "node:test";

import {
  GithubReconciler,
  RECONCILE_INTERVAL_MS,
  RECONCILE_STALE_MS,
} from "../src/github/reconcile.js";
import {
  fakeGithub,
  installationTokens,
  memoryGithub,
  NOW,
  SHA_A,
  SHA_B,
  seedConnection,
  seedRepo,
  world,
  type GithubWorld,
} from "./github-fakes.js";

/**
 * The reconcile sweep. Seeded rows were last read at NOW, so the sweep runs
 * as if fifteen minutes and a second have passed, which makes them all due.
 */

const LATER = new Date(NOW + RECONCILE_STALE_MS + 1000);

/** A sweep that read, failed and probed nothing out of the ordinary. */
const quiet = { rateLimited: false, appRefused: false, recovered: 0 };

/** A second installation with a repository of its own, both real. */
function twoInstallations(overrides: Partial<GithubWorld> = {}) {
  return world({
    installations: [
      { id: 9, login: "acme" },
      { id: 10, login: "beta" },
    ],
    repositories: [
      {
        id: 1296269,
        full_name: "acme/widgets",
        default_branch: "main",
        pushed_at: "2026-10-01T00:00:00Z",
      },
      {
        id: 2,
        full_name: "beta/gadgets",
        default_branch: "main",
        pushed_at: "2026-10-01T00:00:00Z",
      },
      {
        id: 3,
        full_name: "acme/other",
        default_branch: "main",
        pushed_at: "2026-10-01T00:00:00Z",
      },
    ],
    heads: {
      "acme/widgets@main": SHA_B,
      "beta/gadgets@main": SHA_B,
      "acme/other@main": SHA_B,
    },
    ...overrides,
  });
}

async function setup(state: GithubWorld = world()) {
  const stores = memoryGithub();
  const connectionId = await seedConnection(stores, "org_1", "9");
  const repoId = await seedRepo(stores, "org_1", connectionId);
  const fetch = fakeGithub(state);
  const errors: string[] = [];
  const reconciler = new GithubReconciler({
    repos: stores.repos,
    connections: stores.connections,
    installations: installationTokens(fetch),
    fetch,
    now: () => LATER,
    onError: (code) => errors.push(code),
  });
  return { stores, connectionId, repoId, fetch, errors, reconciler, state };
}

test("a moved head is recorded with its new ETag", async () => {
  const { stores, repoId, reconciler, fetch } = await setup();

  const result = await reconciler.sweep();

  assert.deepEqual(result, { read: 1, failed: 0, ...quiet });
  const repo = await stores.repos.get("org_1", repoId);
  assert.equal(repo?.headSha, SHA_B);
  assert.equal(stores.repos.rows.get(repoId)?.headEtag, 'W/"b"');
  // The last ETag went out as If-None-Match; the repository by numeric id.
  assert.ok(fetch.urls.some((url) => url.endsWith("/repositories/1296269")));
});

test("a 304 leaves the head and counts as read", async () => {
  const { stores, repoId, reconciler } = await setup(
    world({ freshEtags: ['W/"a"'] }),
  );

  const result = await reconciler.sweep();

  assert.equal(result.read, 1);
  assert.equal((await stores.repos.get("org_1", repoId))?.headSha, SHA_A);
});

test("a repository read recently is not due", async () => {
  const stores = memoryGithub();
  const connectionId = await seedConnection(stores, "org_1", "9");
  await seedRepo(stores, "org_1", connectionId);
  const fetch = fakeGithub(world());
  const reconciler = new GithubReconciler({
    repos: stores.repos,
    connections: stores.connections,
    installations: installationTokens(fetch),
    fetch,
    now: () => new Date(NOW + 60_000),
  });

  assert.deepEqual(await reconciler.sweep(), { read: 0, failed: 0, ...quiet });
  assert.equal(fetch.urls.length, 0);
});

test("a repository GitHub no longer has goes gone", async () => {
  const { stores, repoId, reconciler } = await setup(
    world({ deletedRepos: [1296269] }),
  );

  await reconciler.sweep();

  assert.equal((await stores.repos.get("org_1", repoId))?.syncStatus, "gone");
});

test("a rate-limited installation is skipped, and the others are still read", async () => {
  // Limits are per installation: one busy client must not freeze everyone.
  const { stores, connectionId, reconciler, errors, fetch } = await setup(
    twoInstallations({ limitedInstallations: [9] }),
  );
  await seedRepo(stores, "org_1", connectionId, {
    externalId: "3",
    fullName: "acme/other",
  });
  const beta = await seedConnection(stores, "org_2", "10", "beta");
  const betaRepo = await seedRepo(stores, "org_2", beta, {
    externalId: "2",
    fullName: "beta/gadgets",
  });

  const result = await reconciler.sweep();

  assert.deepEqual(result, { read: 1, failed: 1, ...quiet, rateLimited: true });
  assert.deepEqual(errors, ["github_reconcile_rate_limited"]);
  assert.equal((await stores.repos.get("org_2", betaRepo))?.headSha, SHA_B);
  // Installation 9's second repository was not tried after the refusal.
  assert.ok(!fetch.urls.some((url) => url.endsWith("/repositories/3")));
});

test("an App credential GitHub refuses stops the sweep and flags nothing", async () => {
  // A deleted key or a wrong App id: every installation would answer 401,
  // and none of them is at fault.
  const { stores, connectionId, reconciler, errors } = await setup(
    world({ appRefused: true }),
  );

  const result = await reconciler.sweep();

  assert.equal(result.appRefused, true);
  assert.equal(
    (await stores.connections.get("org_1", connectionId))?.healthy,
    true,
  );
  assert.deepEqual(errors, ["github_reconcile_app_refused"]);
});

test("an installation GitHub will not mint for is flagged, and its other repositories skipped", async () => {
  const { stores, connectionId, reconciler, fetch } = await setup(
    world({ uninstalled: [9] }),
  );
  await seedRepo(stores, "org_1", connectionId, {
    externalId: "2",
    fullName: "acme/other",
  });

  const result = await reconciler.sweep();

  assert.equal(result.failed, 1);
  const connection = await stores.connections.get("org_1", connectionId);
  assert.equal(connection?.healthy, false);
  // One refused mint, then the probe, which finds it uninstalled: final, so
  // its repositories go `gone` as the `deleted` webhook would leave them.
  assert.equal(fetch.urls.length, 2);
  assert.match(fetch.urls[1] ?? "", /^GET .*\/app\/installations\/9$/);
  assert.equal(connection?.uninstalledAt, LATER.toISOString());
  assert.ok(
    [...stores.repos.rows.values()].every((row) => row.syncStatus === "gone"),
  );
  // And the next sweep does not reach for it at all.
  assert.deepEqual(await reconciler.sweep(), { read: 0, failed: 0, ...quiet });
  assert.equal(fetch.urls.length, 2);
});

test("a flagged connection GitHub reports live again is cleared", async () => {
  // A lost `unsuspend`, or a refusal that has passed: no reconnect needed.
  const { stores, connectionId, reconciler } = await setup();
  await stores.connections.update("org_1", connectionId, {
    healthy: false,
    suspendedAt: "2026-09-30T00:00:00.000Z",
  });

  const result = await reconciler.sweep();

  assert.equal(result.recovered, 1);
  const connection = await stores.connections.get("org_1", connectionId);
  assert.equal(connection?.healthy, true);
  assert.equal(connection?.suspendedAt, null);
});

test("a flagged connection still suspended stays flagged, its suspension kept", async () => {
  const { stores, connectionId, reconciler } = await setup(
    world({ suspendedIds: [9] }),
  );
  await stores.connections.update("org_1", connectionId, { healthy: false });

  const result = await reconciler.sweep();

  assert.equal(result.recovered, 0);
  const connection = await stores.connections.get("org_1", connectionId);
  assert.equal(connection?.healthy, false);
  assert.equal(connection?.suspendedAt, "2026-09-30T00:00:00Z");
  assert.equal(connection?.uninstalledAt, null);
});

test("a probe refused, limited or failing is reported and changes nothing", async () => {
  for (const [state, code] of [
    [world({ appRefused: true }), "github_reconcile_app_refused"],
    [world({ probeStatus: 500 }), "github_reconcile_probe_failed"],
  ] as const) {
    const { stores, connectionId, reconciler, errors } = await setup(state);
    // Already read, so only the probe speaks to GitHub.
    stores.repos.rows.clear();
    await stores.connections.update("org_1", connectionId, { healthy: false });

    const result = await reconciler.sweep();

    assert.equal(result.recovered, 0);
    assert.equal(result.appRefused, code === "github_reconcile_app_refused");
    assert.deepEqual(errors, [code]);
    assert.equal(
      (await stores.connections.get("org_1", connectionId))?.healthy,
      false,
    );
  }

  // The JWT's limit is the App's: one limited probe ends the probing.
  const { stores, reconciler, fetch } = await setup(
    world({ probeStatus: 429 }),
  );
  stores.repos.rows.clear();
  for (const id of ["20", "21"]) {
    const flagged = await seedConnection(stores, "org_1", id);
    await stores.connections.update("org_1", flagged, { healthy: false });
  }
  await reconciler.sweep();
  assert.equal(
    fetch.urls.filter((url) => /\/app\/installations\/\d+$/.test(url)).length,
    1,
  );
});

test("a write that fails is reported and does not end the batch", async () => {
  const { stores, connectionId, reconciler, errors } = await setup(
    twoInstallations({ restStatus: 500 }),
  );
  await seedRepo(stores, "org_1", connectionId, {
    externalId: "3",
    fullName: "acme/other",
  });
  let attempts = 0;
  stores.repos.markSyncError = () => {
    attempts += 1;
    return Promise.reject(new Error("connection reset"));
  };

  const result = await reconciler.sweep();

  assert.equal(result.failed, 2);
  assert.equal(attempts, 2);
  assert.deepEqual(errors, [
    "github_reconcile_write_failed",
    "github_reconcile_write_failed",
  ]);
});

test("a failure is logged as its name and message, never the error itself", async () => {
  const { reconciler, stores } = await setup(world({ restStatus: 500 }));
  stores.repos.markSyncError = () =>
    Promise.reject(new Error("connection reset"));
  const details: (string | undefined)[] = [];
  const logged = new GithubReconciler({
    repos: stores.repos,
    connections: stores.connections,
    installations: installationTokens(fakeGithub(world({ restStatus: 500 }))),
    fetch: fakeGithub(world({ restStatus: 500 })),
    now: () => LATER,
    onError: (_code, detail) => details.push(detail),
  });

  await logged.sweep();

  assert.deepEqual(details, ["Error: connection reset"]);
  assert.ok(reconciler instanceof GithubReconciler);
});

test("any other failure is recorded on the row as one line of ours", async () => {
  const { stores, repoId, reconciler } = await setup(
    world({ restStatus: 500 }),
  );

  const result = await reconciler.sweep();

  assert.equal(result.failed, 1);
  const repo = await stores.repos.get("org_1", repoId);
  assert.equal(repo?.syncStatus, "error");
  assert.match(repo?.syncError ?? "", /GitHub answered 500/);
});

test("a failure that is not GitHub's is recorded too, without its message", async () => {
  const { stores, repoId, reconciler } = await setup();
  stores.repos.recordSync = () =>
    Promise.reject(new Error("secret/path/in/repo.ts"));

  await reconciler.sweep();

  const repo = await stores.repos.get("org_1", repoId);
  assert.equal(repo?.syncError, "Could not read the repository from GitHub.");
});

test("start sweeps at once and then on an interval; stop clears it", async () => {
  const { reconciler, errors } = await setup();
  let scheduled: { fn: () => void; ms: number } | undefined;
  let cleared = 0;
  const timed = new GithubReconciler({
    repos: {
      ...memoryGithub().repos,
      dueForSync: () => Promise.reject(new Error("database down")),
    },
    connections: memoryGithub().connections,
    installations: installationTokens(fakeGithub(world())),
    setInterval: ((fn: () => void, ms: number) => {
      scheduled = { fn, ms };
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval,
    clearInterval: (() => {
      cleared += 1;
    }) as typeof clearInterval,
    onError: (code) => errors.push(code),
  });

  timed.start();
  timed.start(); // idempotent
  await new Promise((resolve) => setImmediate(resolve));
  scheduled?.fn();
  await new Promise((resolve) => setImmediate(resolve));
  await timed.stop();
  await timed.stop();

  assert.equal(scheduled?.ms, RECONCILE_INTERVAL_MS);
  assert.deepEqual(errors, [
    "github_reconcile_failed",
    "github_reconcile_failed",
  ]);
  assert.equal(cleared, 1);
  assert.ok(reconciler instanceof GithubReconciler);
});

test("a tick while a sweep is still running starts no second one", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  let scheduled: (() => void) | undefined;
  const stores = memoryGithub();
  const slow = new GithubReconciler({
    repos: {
      ...stores.repos,
      dueForSync: async () => {
        reads += 1;
        await gate;
        return [];
      },
    },
    connections: stores.connections,
    installations: installationTokens(fakeGithub(world())),
    setInterval: ((fn: () => void) => {
      scheduled = fn;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval,
    clearInterval: (() => {}) as typeof clearInterval,
  });

  slow.start();
  scheduled?.();
  scheduled?.();
  assert.equal(reads, 1);

  release();
  await slow.stop();
  assert.equal(reads, 1);
});

test("stop lets the repository in hand finish, then ends the sweep", async () => {
  const state = twoInstallations();
  const { stores, connectionId, fetch } = await setup(state);
  await seedRepo(stores, "org_1", connectionId, {
    externalId: "3",
    fullName: "acme/other",
  });
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = false;
  const gated: typeof globalThis.fetch = async (input, init) => {
    if (!held && String(input).includes("/repositories/")) {
      held = true;
      await gate;
    }
    return fetch(input, init);
  };
  const reconciler = new GithubReconciler({
    repos: stores.repos,
    connections: stores.connections,
    installations: installationTokens(gated),
    fetch: gated,
    now: () => LATER,
    setInterval: (() =>
      1 as unknown as ReturnType<typeof setInterval>) as typeof setInterval,
    clearInterval: (() => {}) as typeof clearInterval,
  });

  reconciler.start();
  await new Promise((resolve) => setImmediate(resolve));
  const stopped = reconciler.stop();
  release();
  await stopped;

  // The first repository was read; the second was never asked for.
  assert.equal(
    fetch.urls.filter((url) => /\/repositories\/\d+$/.test(url)).length,
    1,
  );
});
