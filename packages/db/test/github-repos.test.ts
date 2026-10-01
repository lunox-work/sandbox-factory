import assert from "node:assert/strict";
import { test } from "node:test";

import { createGithubRepoStore } from "../src/github-repos.js";
import type { GithubRepoRow } from "../src/schema.js";
import { createFakeDb } from "./fake-db.js";

const sha = "a".repeat(40);

function repoRow(overrides: Partial<GithubRepoRow> = {}): GithubRepoRow {
  return {
    id: "ghr_1",
    organizationId: "org_1",
    connectionId: "ghc_1",
    role: "source",
    externalId: "1296269",
    fullName: "acme/widgets",
    defaultBranch: "main",
    isPrivate: true,
    sizeKb: 120,
    headSha: sha,
    headEtag: 'W/"abc"',
    pushedAt: new Date("2026-10-01T00:00:00.000Z"),
    lastSyncedAt: new Date("2026-10-01T00:01:00.000Z"),
    syncStatus: "ok",
    syncError: null,
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
    updatedAt: new Date("2026-10-01T00:00:00.000Z"),
    ...overrides,
  };
}

const metadata = {
  fullName: "acme/widgets",
  defaultBranch: "main",
  isPrivate: true,
  sizeKb: 120,
  pushedAt: "2026-10-01T00:00:00.000Z",
};

test("a summary carries the pointer and no ETag", async () => {
  // The ETag is the sweep's bookkeeping, not something a person reads.
  const store = createGithubRepoStore(createFakeDb([repoRow()]).db);

  const [summary] = await store.list("org_1");

  assert.deepEqual(summary, {
    id: "ghr_1",
    connectionId: "ghc_1",
    role: "source",
    externalId: "1296269",
    fullName: "acme/widgets",
    defaultBranch: "main",
    isPrivate: true,
    sizeKb: 120,
    headSha: sha,
    pushedAt: "2026-10-01T00:00:00.000Z",
    lastSyncedAt: "2026-10-01T00:01:00.000Z",
    syncStatus: "ok",
    syncError: null,
    createdAt: "2026-10-01T00:00:00.000Z",
  });
});

test("an unknown stored status reads as an error rather than breaking the page", async () => {
  const store = createGithubRepoStore(
    createFakeDb([
      repoRow({ syncStatus: "weird", pushedAt: null, lastSyncedAt: null }),
    ]).db,
  );

  const summary = await store.get("org_1", "ghr_1");

  assert.equal(summary?.syncStatus, "error");
  assert.equal(summary?.pushedAt, null);
});

test("reads are owner-scoped and miss as null", async () => {
  const fake = createFakeDb([]);
  const store = createGithubRepoStore(fake.db);

  assert.equal(await store.get("org_1", "ghr_1"), null);
  assert.equal(await store.findByExternalId("org_1", "ghc_1", "1"), null);
  assert.ok(fake.calls.every((call) => call.filtered === true));
});

test("findByExternalId finds the row of that connection", async () => {
  const store = createGithubRepoStore(createFakeDb([repoRow()]).db);

  const found = await store.findByExternalId("org_1", "ghc_1", "1296269");

  assert.equal(found?.id, "ghr_1");
});

test("registering is an upsert that resets the row to pending", async () => {
  const fake = createFakeDb([repoRow({ syncStatus: "pending" })]);
  const store = createGithubRepoStore(fake.db);

  await store.register("org_1", {
    ...metadata,
    connectionId: "ghc_1",
    externalId: "1296269",
    role: "source",
  });

  const [call] = fake.calls;
  assert.match(String(call?.values?.["id"]), /^ghr_/);
  assert.equal(call?.values?.["organizationId"], "org_1");
  assert.equal(call?.conflictSet?.["syncStatus"], "pending");
  assert.equal(call?.conflictGuarded, true);
  assert.ok(call?.conflictSet?.["pushedAt"] instanceof Date);
});

test("a register that returns nothing is an error", async () => {
  const store = createGithubRepoStore(createFakeDb([]).db);

  await assert.rejects(
    store.register("org_1", {
      ...metadata,
      pushedAt: null,
      connectionId: "ghc_1",
      externalId: "1",
      role: "source",
    }),
    /register/,
  );
});

test("recordSync writes the head and ETag only when the head was read", async () => {
  const read = createFakeDb([repoRow()]);
  const notModified = createFakeDb([repoRow()]);

  await createGithubRepoStore(read.db).recordSync("org_1", "ghr_1", metadata, {
    sha,
    etag: 'W/"def"',
  });
  const summary = await createGithubRepoStore(notModified.db).recordSync(
    "org_1",
    "ghr_1",
    { ...metadata, pushedAt: null },
  );

  assert.equal(read.calls[0]?.values?.["headSha"], sha);
  assert.equal(read.calls[0]?.values?.["headEtag"], 'W/"def"');
  assert.equal("headSha" in (notModified.calls[0]?.values ?? {}), false);
  assert.equal(notModified.calls[0]?.values?.["syncStatus"], "ok");
  assert.ok(notModified.calls[0]?.values?.["lastSyncedAt"] instanceof Date);
  assert.equal(summary?.id, "ghr_1");
  assert.equal(
    await createGithubRepoStore(createFakeDb([]).db).recordSync(
      "org_1",
      "ghr_1",
      metadata,
    ),
    null,
  );
});

test("setHead clears the ETag, which described the old head", async () => {
  const fake = createFakeDb([repoRow()]);
  const store = createGithubRepoStore(fake.db);

  const moved = await store.setHead("org_1", "ghr_1", {
    headSha: "b".repeat(40),
    pushedAt: "2026-10-01T01:00:00.000Z",
  });
  await store.setHead("org_1", "ghr_1", {
    headSha: "c".repeat(40),
    pushedAt: null,
  });

  assert.equal(moved, true);
  assert.equal(fake.calls[0]?.values?.["headEtag"], null);
  assert.ok(fake.calls[0]?.values?.["pushedAt"] instanceof Date);
  // With a push time, whether the read is stamped is decided in SQL against
  // the stored time (see the Postgres suite); without one, it is.
  assert.equal(fake.calls[0]?.values?.["lastSyncedAt"] instanceof Date, false);
  assert.equal("pushedAt" in (fake.calls[1]?.values ?? {}), false);
  assert.ok(fake.calls[1]?.values?.["lastSyncedAt"] instanceof Date);
});

test("a late push that the guard refuses reports false", async () => {
  // The fake cannot run the `pushed_at <=` guard; an empty result stands in
  // for the row it left alone.
  const store = createGithubRepoStore(createFakeDb([]).db);

  assert.equal(
    await store.setHead("org_1", "ghr_1", {
      headSha: sha,
      pushedAt: "2026-09-01T00:00:00.000Z",
    }),
    false,
  );
});

test("update writes only the fields given", async () => {
  const fake = createFakeDb([repoRow()]);
  const store = createGithubRepoStore(fake.db);

  await store.update("org_1", "ghr_1", { fullName: "acme/gadgets" });
  await store.update("org_1", "ghr_1", {
    defaultBranch: "trunk",
    isPrivate: false,
  });

  assert.deepEqual(Object.keys(fake.calls[0]?.values ?? {}).sort(), [
    "fullName",
    "updatedAt",
  ]);
  assert.deepEqual(Object.keys(fake.calls[1]?.values ?? {}).sort(), [
    "defaultBranch",
    "isPrivate",
    "updatedAt",
  ]);
  assert.equal(
    await createGithubRepoStore(createFakeDb([]).db).update("org_1", "x", {}),
    false,
  );
});

test("gone and revive count the rows they moved, and skip an empty list", async () => {
  const fake = createFakeDb([repoRow(), repoRow({ id: "ghr_2" })]);
  const store = createGithubRepoStore(fake.db);

  assert.equal(await store.markGone("org_1", ["ghr_1", "ghr_2"]), 2);
  assert.equal(await store.markGoneForConnection("org_1", "ghc_1"), 2);
  assert.equal(await store.revive("org_1", ["ghr_1", "ghr_2"]), 2);
  assert.equal(await store.markGone("org_1", []), 0);
  assert.equal(await store.revive("org_1", []), 0);

  assert.equal(fake.calls.length, 3);
  assert.equal(fake.calls[0]?.values?.["syncStatus"], "gone");
  assert.equal(fake.calls[2]?.values?.["syncStatus"], "pending");
  assert.ok(fake.calls.every((call) => call.filtered === true));
});

test("a sync error is one short line, and stamps the read", async () => {
  const fake = createFakeDb([repoRow()]);
  const store = createGithubRepoStore(fake.db);

  await store.markSyncError(
    "org_1",
    "ghr_1",
    `first\n  second\t${"x".repeat(300)}`,
  );

  const message = String(fake.calls[0]?.values?.["syncError"]);
  assert.ok(!message.includes("\n"));
  assert.ok(message.startsWith("first second x"));
  assert.equal(message.length, 200);
  assert.ok(message.endsWith("…"));
  assert.ok(fake.calls[0]?.values?.["lastSyncedAt"] instanceof Date);
  assert.equal(
    await createGithubRepoStore(createFakeDb([]).db).markSyncError(
      "org_1",
      "x",
      "short",
    ),
    false,
  );
});

test("dueForSync is a bounded, ordered read", async () => {
  const due = {
    organizationId: "org_1",
    id: "ghr_1",
    connectionId: "ghc_1",
    installationId: "9",
    externalId: "1296269",
    headEtag: null,
  };
  const fake = createFakeDb([due]);
  const store = createGithubRepoStore(fake.db);

  const rows = await store.dueForSync(
    new Date("2026-10-01T00:00:00.000Z"),
    100,
  );

  assert.deepEqual(rows, [due]);
  assert.equal(fake.calls[0]?.limited, 100);
  assert.equal(fake.calls[0]?.ordered, true);
  assert.equal(fake.calls[0]?.filtered, true);
});

test("remove deletes the owner's row, or reports a miss", async () => {
  const fake = createFakeDb([repoRow()]);

  assert.equal(
    await createGithubRepoStore(fake.db).remove("org_1", "ghr_1"),
    true,
  );
  assert.equal(fake.calls[0]?.kind, "delete");
  assert.equal(
    await createGithubRepoStore(createFakeDb([]).db).remove("org_1", "ghr_1"),
    false,
  );
});
