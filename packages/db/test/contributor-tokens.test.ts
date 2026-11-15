import assert from "node:assert/strict";
import { test } from "node:test";

import { getTableConfig } from "drizzle-orm/pg-core";

import { createContributorTokenStore } from "../src/contributor-tokens.js";
import { contributorToken, user } from "../src/schema.js";
import { createFakeDb, createSequencedFakeDb } from "./fake-db.js";

const createdAt = new Date("2026-11-15T00:00:00.000Z");
const stored = {
  id: "ctk_1",
  userId: "user_1",
  name: "Claude Code",
  prefix: "lnxc_abcd1234",
  createdAt,
  expiresAt: null,
  lastUsedAt: null,
  revokedAt: null,
};

test("a contributor token keeps only its hash, names no workspace, and dies with its person", () => {
  const { columns, foreignKeys } = getTableConfig(contributorToken);
  assert.deepEqual(columns.map((column) => column.name).sort(), [
    "created_at",
    "expires_at",
    "hash",
    "id",
    "last_used_at",
    "name",
    "prefix",
    "revoked_at",
    "user_id",
  ]);
  assert.equal(columns.find((c) => c.name === "hash")?.isUnique, true);
  assert.equal(foreignKeys.length, 1);
  assert.equal(foreignKeys[0]?.reference().foreignTable, user);
  assert.equal(foreignKeys[0]?.onDelete, "cascade");
});

test("create writes the hash under the person, never a secret, and reads it back", async () => {
  const fake = createSequencedFakeDb([[], [stored]]);
  const created = await createContributorTokenStore(fake.db).create("user_1", {
    name: "Claude Code",
    prefix: "lnxc_abcd1234",
    hash: "ab".repeat(32),
    expiresAt: null,
  });
  assert.deepEqual(created, stored);
  const insert = fake.calls[0];
  assert.equal(insert?.kind, "insert");
  assert.match(String(insert?.values?.["id"]), /^ctk_/);
  assert.equal(insert?.values?.["userId"], "user_1");
  assert.equal(insert?.values?.["hash"], "ab".repeat(32));
  assert.equal("secret" in (insert?.values ?? {}), false);
  assert.equal(fake.calls[1]?.filtered, true);
});

test("create refuses when the person vanished between the statements", async () => {
  const fake = createSequencedFakeDb([[], []]);
  await assert.rejects(
    createContributorTokenStore(fake.db).create("user_gone", {
      name: "CLI",
      prefix: "lnxc_abcd1234",
      hash: "cd".repeat(32),
      expiresAt: null,
    }),
    /no longer exists/,
  );
});

test("list is the person's own tokens, newest first", async () => {
  const fake = createFakeDb([stored]);
  assert.deepEqual(await createContributorTokenStore(fake.db).list("user_1"), [
    stored,
  ]);
  assert.equal(fake.calls[0]?.filtered, true);
  assert.equal(fake.calls[0]?.ordered, true);
  assert.equal(fake.calls[0]?.limited, 200);
});

test("revoke answers the token, or undefined for another person's", async () => {
  const revokedAt = new Date("2026-11-16T00:00:00.000Z");
  const hit = createSequencedFakeDb([
    [{ id: "ctk_1" }],
    [{ ...stored, revokedAt }],
  ]);
  assert.deepEqual(
    await createContributorTokenStore(hit.db).revoke("user_1", "ctk_1"),
    { ...stored, revokedAt },
  );
  assert.equal(hit.calls[0]?.kind, "update");
  assert.equal(hit.calls[0]?.filtered, true);
  const miss = createSequencedFakeDb([[]]);
  assert.equal(
    await createContributorTokenStore(miss.db).revoke("user_2", "ctk_1"),
    undefined,
  );
  assert.equal(miss.calls.length, 1);
});

test("findByHash answers the live token with the person it acts as", async () => {
  const fake = createFakeDb([
    { ...stored, email: "ada@example.test", userName: "Ada Lovelace" },
  ]);
  assert.deepEqual(
    await createContributorTokenStore(fake.db).findByHash("ef"),
    {
      ...stored,
      user: { id: "user_1", email: "ada@example.test", name: "Ada Lovelace" },
    },
  );
  assert.equal(fake.calls[0]?.filtered, true);
  assert.equal(fake.calls[0]?.limited, 1);
  assert.equal(
    await createContributorTokenStore(createFakeDb([]).db).findByHash("ef"),
    undefined,
  );
});

test("touch writes the use time under the person", async () => {
  const fake = createFakeDb([]);
  const at = new Date("2026-11-15T10:00:00.000Z");
  await createContributorTokenStore(fake.db).touch(
    "user_1",
    "ctk_1",
    at,
    new Date(at.getTime() - 60_000),
  );
  assert.equal(fake.calls[0]?.kind, "update");
  assert.deepEqual(fake.calls[0]?.values, { lastUsedAt: at });
  assert.equal(fake.calls[0]?.filtered, true);
});
