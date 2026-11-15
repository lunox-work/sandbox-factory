import assert from "node:assert/strict";
import { test } from "node:test";

import {
  mergeBackTargets,
  PERMISSIONS_TTL_MS,
} from "../src/github/merge-back.js";
import {
  fakeGithub,
  installationTokens,
  memoryGithub,
  NOW,
  seedConnection,
  seedRepo,
  world,
  type GithubWorld,
} from "./github-fakes.js";

const granted = {
  contents: "write",
  metadata: "read",
  pull_requests: "write",
};

/** A linked connection (stored: contents read) with one repository. */
async function setup(overrides: Partial<GithubWorld> = {}) {
  const stores = memoryGithub();
  const connectionId = await seedConnection(stores, "org_1", "9");
  const repoId = await seedRepo(stores, "org_1", connectionId);
  const state = world(overrides);
  const fetch = fakeGithub(state);
  let now = NOW;
  const targets = mergeBackTargets({
    repos: stores.repos,
    connections: stores.connections,
    installations: installationTokens(fetch),
    now: () => now,
  });
  const probes = () =>
    fetch.urls.filter((url) => url.endsWith("/app/installations/9")).length;
  return {
    stores,
    state,
    connectionId,
    repoId,
    targets,
    probes,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test("an installation that accepted the new permissions is ready, and the stored copy catches up", async () => {
  const f = await setup({ installationPermissions: { 9: granted } });
  // Stored: contents read only (a lost webhook). A read asks GitHub.
  const target = await f.targets.target("org_1", f.repoId);
  assert.equal(target?.fullName, "acme/widgets");
  assert.equal(target.defaultBranch, "main");
  assert.deepEqual(target.missingPermissions, []);
  assert.equal(
    target.acceptUrl,
    "https://github.com/organizations/acme/settings/installations/9",
  );
  assert.ok(target.writer);
  assert.equal(f.probes(), 1);
  assert.deepEqual(
    (await f.stores.connections.get("org_1", f.connectionId))?.permissions,
    granted,
  );
  // Stored now suffices: a page read does not ask again, a merge does.
  await f.targets.target("org_1", f.repoId);
  assert.equal(f.probes(), 1);
  await f.targets.target("org_1", f.repoId, { fresh: true });
  assert.equal(f.probes(), 2);
});

test("permissions still missing are named; page reads keep GitHub's answer a minute, a merge always asks", async () => {
  const f = await setup({
    installationPermissions: { 9: { contents: "write", metadata: "read" } },
  });
  assert.deepEqual(
    (await f.targets.target("org_1", f.repoId))?.missingPermissions,
    ["pull_requests:write"],
  );
  assert.equal(f.probes(), 1);
  await f.targets.target("org_1", f.repoId);
  assert.equal(f.probes(), 1);
  await f.targets.target("org_1", f.repoId, { fresh: true });
  assert.equal(f.probes(), 2);
  // Accepted on GitHub; the minute passes and the next read sees it.
  f.state.installationPermissions = { 9: granted };
  f.advance(PERMISSIONS_TTL_MS);
  assert.deepEqual(
    (await f.targets.target("org_1", f.repoId))?.missingPermissions,
    [],
  );
  assert.equal(f.probes(), 3);
});

test("no target for a repository gone, an unhealthy or uninstalled installation; GitHub silent, the stored permissions decide", async () => {
  const uninstalled = await setup({ uninstalled: [9] });
  assert.equal(
    await uninstalled.targets.target("org_1", uninstalled.repoId),
    null,
  );

  const silent = await setup({ probeStatus: 500 });
  assert.deepEqual(
    (await silent.targets.target("org_1", silent.repoId))?.missingPermissions,
    ["contents:write", "pull_requests:write"],
  );

  const f = await setup({ installationPermissions: { 9: granted } });
  assert.equal(await f.targets.target("org_1", "ghr_missing"), null);
  assert.equal(await f.targets.target("org_2", f.repoId), null);
  await f.stores.connections.update("org_1", f.connectionId, {
    healthy: false,
  });
  assert.equal(await f.targets.target("org_1", f.repoId), null);
  await f.stores.repos.markGoneForConnection("org_1", f.connectionId);
  assert.equal(await f.targets.target("org_1", f.repoId), null);
  // The default clock is the process's.
  assert.ok(
    mergeBackTargets({
      repos: f.stores.repos,
      connections: f.stores.connections,
      installations: installationTokens(fakeGithub(world())),
    }),
  );
});

test("CI read-back's permissions never block a merge-back: without them there is no CI reader and they are named", async () => {
  const blind = await setup({ installationPermissions: { 9: granted } });
  const target = await blind.targets.target("org_1", blind.repoId);
  assert.deepEqual(target?.missingPermissions, []);
  assert.equal(target?.ciReader, null);
  assert.deepEqual(target?.ciMissingPermissions, [
    "checks:read",
    "statuses:read",
  ]);

  const all = { ...granted, checks: "read", statuses: "read" };
  const f = await setup({ installationPermissions: { 9: all } });
  const ready = await f.targets.target("org_1", f.repoId);
  assert.deepEqual(ready?.ciMissingPermissions, []);
  assert.ok(ready?.ciReader);
  // All of them stored: a page read no longer asks GitHub.
  assert.equal(f.probes(), 1);
  await f.targets.target("org_1", f.repoId);
  assert.equal(f.probes(), 1);
});
