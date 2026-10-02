import assert from "node:assert/strict";
import { test } from "node:test";

import { createGithubConnectionStore } from "../src/github-connections.js";
import type { GithubConnectionRow } from "../src/schema.js";
import { createFakeDb, createSequencedFakeDb } from "./fake-db.js";

function connectionRow(
  overrides: Partial<GithubConnectionRow> = {},
): GithubConnectionRow {
  return {
    id: "ghc_1",
    organizationId: "org_1",
    installationId: "9",
    accountLogin: "acme",
    accountType: "Organization",
    repositorySelection: "selected",
    permissions: { contents: "read", metadata: "read" },
    healthy: true,
    suspendedAt: null,
    uninstalledAt: null,
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
    updatedAt: new Date("2026-10-01T00:00:00.000Z"),
    ...overrides,
  };
}

const installation = {
  installationId: "9",
  accountLogin: "acme",
  accountType: "Organization",
  repositorySelection: "selected",
  permissions: { contents: "read", metadata: "read" },
  suspendedAt: null,
};

test("list and get are owner-scoped summaries", async () => {
  const fake = createFakeDb([connectionRow()]);
  const store = createGithubConnectionStore(fake.db);

  const listed = await store.list("org_1");
  const one = await store.get("org_1", "ghc_1");

  assert.equal(listed[0]?.installationId, "9");
  assert.equal(one?.createdAt, "2026-10-01T00:00:00.000Z");
  assert.equal(one?.suspendedAt, null);
  assert.ok(fake.calls.every((call) => call.filtered === true));
});

test("get misses as null", async () => {
  const store = createGithubConnectionStore(createFakeDb([]).db);

  assert.equal(await store.get("org_1", "ghc_1"), null);
});

test("linking is one upsert whose conflict branch is guarded by the owner", async () => {
  // The guard is the whole of `claimed`: without it, linking an installation
  // another organization holds would move it here.
  const fake = createFakeDb([connectionRow()]);
  const store = createGithubConnectionStore(fake.db);

  const result = await store.link("org_1", installation);

  assert.equal(result.status, "linked");
  const [call] = fake.calls;
  assert.equal(call?.kind, "insert");
  assert.equal(call?.conflictGuarded, true);
  assert.equal(call?.values?.["organizationId"], "org_1");
  assert.match(String(call?.values?.["id"]), /^ghc_/);
  // Re-linking resets health, which is how a reinstall recovers.
  assert.equal(call?.conflictSet?.["healthy"], true);
  assert.equal(call?.conflictSet?.["suspendedAt"], null);
  assert.equal(call?.conflictSet?.["uninstalledAt"], null);
  // Never re-homed: the owner is not among the columns the conflict updates.
  assert.equal(call?.conflictSet?.["organizationId"], undefined);
});

test("an installation held elsewhere comes back claimed", async () => {
  // The guarded conflict branch updates nothing, so nothing is returned.
  const store = createGithubConnectionStore(createFakeDb([]).db);

  assert.deepEqual(await store.link("org_2", installation), {
    status: "claimed",
  });
});

test("a suspended installation links unhealthy", async () => {
  const fake = createFakeDb([
    connectionRow({
      healthy: false,
      suspendedAt: new Date("2026-09-30T00:00:00.000Z"),
    }),
  ]);
  const store = createGithubConnectionStore(fake.db);

  const result = await store.link("org_1", {
    ...installation,
    suspendedAt: "2026-09-30T00:00:00.000Z",
  });

  assert.equal(fake.calls[0]?.values?.["healthy"], false);
  assert.equal(
    result.status === "linked" ? result.connection.suspendedAt : undefined,
    "2026-09-30T00:00:00.000Z",
  );
});

test("stored permissions are read defensively", async () => {
  const store = createGithubConnectionStore(
    createFakeDb([
      connectionRow({ permissions: { contents: "read", odd: 3 } }),
      connectionRow({ id: "ghc_2", permissions: null }),
    ]).db,
  );

  const [first, second] = await store.list("org_1");

  assert.deepEqual(first?.permissions, { contents: "read" });
  assert.deepEqual(second?.permissions, {});
});

test("ownerOf names the organization and connection, or null", async () => {
  const found = createGithubConnectionStore(
    createFakeDb([{ organizationId: "org_1", connectionId: "ghc_1" }]).db,
  );
  const missing = createGithubConnectionStore(createFakeDb([]).db);

  assert.deepEqual(await found.ownerOf("9"), {
    organizationId: "org_1",
    connectionId: "ghc_1",
  });
  assert.equal(await missing.ownerOf("9"), null);
});

test("owners maps installations to their organizations, and skips the query for none", async () => {
  const fake = createFakeDb([
    { installationId: "9", organizationId: "org_1" },
    { installationId: "10", organizationId: "org_2" },
  ]);
  const store = createGithubConnectionStore(fake.db);

  const owners = await store.owners(["9", "10", "11"]);
  const none = await store.owners([]);

  assert.equal(owners.get("9"), "org_1");
  assert.equal(owners.get("11"), undefined);
  assert.equal(none.size, 0);
  assert.equal(fake.calls.length, 1);
});

test("update writes only the fields given, scoped to the owner", async () => {
  const fake = createFakeDb([connectionRow()]);
  const store = createGithubConnectionStore(fake.db);

  assert.equal(
    await store.update("org_1", "ghc_1", {
      healthy: false,
      suspendedAt: "2026-10-01T00:00:00.000Z",
    }),
    true,
  );
  await store.update("org_1", "ghc_1", {
    permissions: { contents: "read" },
    repositorySelection: "all",
    suspendedAt: null,
  });
  await store.update("org_1", "ghc_1", {
    uninstalledAt: "2026-10-01T00:00:00.000Z",
  });
  await store.update("org_1", "ghc_1", { uninstalledAt: null });

  const [first, second, third, fourth] = fake.calls;
  assert.ok(third?.values?.["uninstalledAt"] instanceof Date);
  assert.equal(fourth?.values?.["uninstalledAt"], null);
  assert.deepEqual(Object.keys(first?.values ?? {}).sort(), [
    "healthy",
    "suspendedAt",
    "updatedAt",
  ]);
  assert.deepEqual(Object.keys(second?.values ?? {}).sort(), [
    "permissions",
    "repositorySelection",
    "suspendedAt",
    "updatedAt",
  ]);
  assert.equal(second?.values?.["suspendedAt"], null);
  assert.ok(fake.calls.every((call) => call.filtered === true));
});

test("a summary says when the installation was found uninstalled", async () => {
  const store = createGithubConnectionStore(
    createFakeDb([
      connectionRow({
        healthy: false,
        uninstalledAt: new Date("2026-10-01T02:00:00.000Z"),
      }),
    ]).db,
  );

  const one = await store.get("org_1", "ghc_1");

  assert.equal(one?.uninstalledAt, "2026-10-01T02:00:00.000Z");
});

test("flaggedForProbe is a bounded, ordered, filtered read", async () => {
  const flagged = {
    organizationId: "org_1",
    connectionId: "ghc_1",
    installationId: "9",
  };
  const fake = createFakeDb([flagged]);
  const store = createGithubConnectionStore(fake.db);

  assert.deepEqual(await store.flaggedForProbe(20), [flagged]);
  assert.equal(fake.calls[0]?.limited, 20);
  assert.equal(fake.calls[0]?.ordered, true);
  assert.equal(fake.calls[0]?.filtered, true);
});

test("update and remove report a miss", async () => {
  const store = createGithubConnectionStore(createFakeDb([]).db);

  assert.equal(await store.update("org_1", "ghc_1", { healthy: true }), false);
  assert.equal(await store.remove("org_2", "ghc_1"), false);
});

test("remove deletes the owner's row", async () => {
  const fake = createFakeDb([connectionRow()]);
  const store = createGithubConnectionStore(fake.db);

  assert.equal(await store.remove("org_1", "ghc_1"), true);
  assert.equal(fake.calls[0]?.kind, "delete");
  assert.equal(fake.calls[0]?.filtered, true);
});

test("disconnect locks registration and snapshot writers before collecting every tree", async () => {
  const fake = createSequencedFakeDb([
    [{ id: "ghc_1" }],
    [{ id: "ghr_1" }],
    [
      { id: "rsn_1", treeKey: "trees/one" },
      { id: "rsn_2", treeKey: "trees/two" },
    ],
    [
      { id: "arn_1", logKey: "logs/one" },
      { id: "arn_2", logKey: null },
    ],
    [{ objectKey: "runs/one/graph.json" }],
    [],
  ]);
  assert.deepEqual(
    await createGithubConnectionStore(fake.db).removeWithTrees(
      "org_1",
      "ghc_1",
    ),
    {
      removed: true,
      treeKeys: ["trees/one", "trees/two"],
      objectKeys: ["trees/one", "trees/two", "runs/one/graph.json", "logs/one"],
    },
  );
  assert.equal(fake.calls[0]?.lock, "update");
  assert.equal(fake.calls[1]?.lock, "update");
  assert.ok(fake.calls.every(({ filtered }) => filtered));
  assert.equal(fake.calls[2]?.limited, undefined);
  assert.equal(fake.calls[5]?.kind, "delete");

  const missing = createFakeDb([]);
  assert.deepEqual(
    await createGithubConnectionStore(missing.db).removeWithTrees(
      "org_2",
      "ghc_1",
    ),
    { removed: false, treeKeys: [] },
  );
  assert.equal(missing.calls.length, 1);
});
