import assert from "node:assert/strict";
import { test } from "node:test";

import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { treeFacts } from "sandbox-factory";

import { createRepoSnapshotStore } from "../src/repo-snapshots.js";
import type { RepoSnapshotRow } from "../src/schema.js";
import { createFakeDb, createSequencedFakeDb } from "./fake-db.js";

/*
 * What the fake can check: that every read is filtered and ordered, and how
 * results are shaped. Whether the owner join, the `gone` guard and the
 * reference check hold is SQL, and `github-pointer.test.ts` runs it.
 */

const facts = treeFacts([{ path: "src/a.ts", size: 10 }]);

function row(overrides: Partial<RepoSnapshotRow> = {}): RepoSnapshotRow {
  return {
    id: "rsn_1",
    repoId: "ghr_1",
    commitSha: "c".repeat(40),
    ref: "refs/heads/main",
    treeSha: "t".repeat(40),
    treeKey: `trees/ghr_1/${"c".repeat(40)}.json.gz`,
    treeTruncated: false,
    fileCount: 1,
    totalBytes: 10,
    languages: { TypeScript: 10 },
    facts,
    createdAt: new Date("2026-10-02T00:00:00.000Z"),
    ...overrides,
  };
}

const joined = (snapshot: RepoSnapshotRow = row()) => ({
  snapshot,
  repoFullName: "acme/app",
});

const input = {
  repoId: "ghr_1",
  commitSha: "c".repeat(40),
  ref: "refs/heads/main",
  treeSha: "t".repeat(40),
  treeKey: "trees/ghr_1/c.json.gz",
  treeTruncated: true,
  fileCount: 1,
  totalBytes: 10,
  languages: { TypeScript: 10 },
  facts,
};

test("list is owner-filtered, newest first, bounded, and carries no facts", async () => {
  const fake = createFakeDb([joined()]);
  const listed = await createRepoSnapshotStore(fake.db).list(
    "org_1",
    "ghr_1",
    20,
  );

  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.createdAt, "2026-10-02T00:00:00.000Z");
  assert.equal("facts" in (listed[0] ?? {}), false);
  assert.equal(fake.calls[0]?.filtered, true);
  assert.equal(fake.calls[0]?.ordered, true);
  assert.equal(fake.calls[0]?.limited, 20);
});

test("get returns the facts and the repository's name, or null", async () => {
  const fake = createFakeDb([joined()]);
  const found = await createRepoSnapshotStore(fake.db).get("org_1", "rsn_1");
  assert.equal(found?.repoFullName, "acme/app");
  assert.deepEqual(found?.facts, facts);
  assert.equal(fake.calls[0]?.filtered, true);

  const empty = createFakeDb([]);
  assert.equal(
    await createRepoSnapshotStore(empty.db).get("org_1", "rsn_x"),
    null,
  );
});

test("findByCommit and current read one row, or null", async () => {
  const fake = createFakeDb([joined()]);
  const store = createRepoSnapshotStore(fake.db);
  assert.equal(
    (await store.findByCommit("org_1", "ghr_1", "c".repeat(40)))?.id,
    "rsn_1",
  );
  assert.equal(
    (await store.current("org_1", "ghr_1"))?.repoFullName,
    "acme/app",
  );
  assert.equal(fake.calls[1]?.ordered, true);
  assert.equal(fake.calls[1]?.limited, 1);

  const empty = createRepoSnapshotStore(createFakeDb([]).db);
  assert.equal(await empty.findByCommit("org_1", "ghr_1", "x"), null);
  assert.equal(await empty.current("org_1", "ghr_1"), null);
});

test("create locks the live repository, then inserts ignoring a twin", async () => {
  const fake = createSequencedFakeDb([[{ id: "ghr_1" }], [row()]]);
  const created = await createRepoSnapshotStore(fake.db).create("org_1", input);

  assert.equal(created.status, "created");
  assert.equal(fake.calls[0]?.kind, "update");
  assert.equal(fake.calls[0]?.filtered, true);
  const insert = fake.calls[1];
  assert.equal(insert?.kind, "insert");
  assert.equal(insert?.ignoredConflict, true);
  assert.match(String(insert?.values?.["id"]), /^rsn_/);
  assert.equal(insert?.values?.["treeTruncated"], true);
  assert.deepEqual(insert?.values?.["facts"], facts);
});

test("create answers exists for a twin and refused for a gone repository", async () => {
  const twin = createSequencedFakeDb([[{ id: "ghr_1" }], []]);
  assert.equal(
    (await createRepoSnapshotStore(twin.db).create("org_1", input)).status,
    "exists",
  );

  const gone = createSequencedFakeDb([[]]);
  assert.equal(
    (await createRepoSnapshotStore(gone.db).create("org_1", input)).status,
    "refused",
  );
  // Nothing is inserted once the repository is refused.
  assert.equal(gone.calls.length, 1);
});

test("prune reads the surplus through the owner, then deletes those rows", async () => {
  const fake = createSequencedFakeDb([
    [{ id: "rsn_old" }],
    [{ id: "rsn_old" }],
    [{ treeKey: "trees/ghr_1/old.json.gz" }],
  ]);
  const removed = await createRepoSnapshotStore(fake.db).prune(
    "org_1",
    "ghr_1",
    20,
  );

  assert.deepEqual(removed, ["trees/ghr_1/old.json.gz"]);
  assert.equal(fake.calls[0]?.kind, "select");
  assert.equal(fake.calls[0]?.filtered, true);
  assert.equal(fake.calls[0]?.ordered, true);
  assert.equal(fake.calls[1]?.lock, "update");
  assert.equal(fake.calls[2]?.kind, "delete");
  assert.equal(fake.calls[2]?.filtered, true);
});

test("prune's delete names the owner in its own WHERE, not only in the read before it", async () => {
  const fake = createSequencedFakeDb([
    [{ id: "rsn_old" }],
    [{ id: "rsn_old" }],
    [{ treeKey: "trees/ghr_1/old.json.gz" }],
  ]);
  // The fake ignores conditions; this one keeps the DELETE's to render it.
  const conditions: SQL[] = [];
  const db = fake.db as unknown as {
    delete: (table: unknown) => { where: (condition: SQL) => unknown };
  };
  const remove = db.delete.bind(db);
  db.delete = (table) => {
    const chained = remove(table);
    const where = chained.where.bind(chained);
    chained.where = (condition) => {
      conditions.push(condition);
      return where(condition);
    };
    return chained;
  };

  await createRepoSnapshotStore(fake.db).prune("org_1", "ghr_1", 20);

  const [condition] = conditions;
  assert.ok(condition !== undefined);
  const query = new PgDialect().sqlToQuery(condition);
  assert.match(query.sql, /"github_repo"\."organization_id" = \$\d+/);
  assert.ok(query.params.includes("org_1"));
});

test("prune with nothing past the limit deletes nothing", async () => {
  const fake = createSequencedFakeDb([[]]);
  assert.deepEqual(
    await createRepoSnapshotStore(fake.db).prune("org_1", "ghr_1", 20),
    [],
  );
  assert.equal(fake.calls.length, 1);
});
