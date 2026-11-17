import assert from "node:assert/strict";
import { test } from "node:test";

import { getTableConfig } from "drizzle-orm/pg-core";

import { createApiTokenStore as createStore } from "../src/api-tokens.js";
import { createTokenCipher } from "../src/cipher.js";
import { apiToken, organization, user } from "../src/schema.js";
import { createFakeDb, createSequencedFakeDb } from "./fake-db.js";

const cipher = createTokenCipher(Buffer.alloc(32, 7).toString("base64"));
const createApiTokenStore = (db: Parameters<typeof createStore>[0]) =>
  createStore(db, cipher);

const createdAt = new Date("2026-11-12T00:00:00.000Z");
const row = {
  id: "tok_1",
  organizationId: "org_1",
  name: "CI",
  prefix: "lnx_abcd1234",
  scopes: ["workspace:read"],
  createdById: "user_1",
  createdByName: "Ada Lovelace",
  createdAt,
  expiresAt: null,
  lastUsedAt: null,
  revokedAt: null,
};
const stored = {
  id: "tok_1",
  organizationId: "org_1",
  name: "CI",
  prefix: "lnx_abcd1234",
  scopes: ["workspace:read"],
  createdBy: { id: "user_1", name: "Ada Lovelace" },
  createdAt,
  expiresAt: null,
  lastUsedAt: null,
  revokedAt: null,
};

test("a token keeps its hash, a default its sealed secret, and dies with its workspace or creator", () => {
  const { columns, foreignKeys } = getTableConfig(apiToken);
  const names = columns.map((column) => column.name).sort();
  assert.deepEqual(names, [
    "created_at",
    "created_by",
    "expires_at",
    "hash",
    "id",
    "is_default",
    "key_id",
    "last_used_at",
    "name",
    "organization_id",
    "prefix",
    "revoked_at",
    "scopes",
    "secret_enc",
  ]);
  assert.equal(columns.find((c) => c.name === "hash")?.isUnique, true);
  for (const table of [organization, user]) {
    const key = foreignKeys.find(
      (candidate) => candidate.reference().foreignTable === table,
    );
    assert.equal(key?.onDelete, "cascade");
  }
});

test("create writes the hash, never a secret, and reads the row back", async () => {
  const fake = createSequencedFakeDb([[], [row]]);
  const created = await createApiTokenStore(fake.db).create("org_1", {
    createdBy: "user_1",
    name: "CI",
    prefix: "lnx_abcd1234",
    hash: "ab".repeat(32),
    scopes: ["workspace:read"],
    expiresAt: null,
  });
  assert.deepEqual(created, stored);
  const insert = fake.calls[0];
  assert.equal(insert?.kind, "insert");
  assert.match(String(insert?.values?.["id"]), /^tok_/);
  assert.equal(insert?.values?.["organizationId"], "org_1");
  assert.equal(insert?.values?.["hash"], "ab".repeat(32));
  assert.equal("secret" in (insert?.values ?? {}), false);
  assert.equal(fake.calls[1]?.filtered, true);
});

test("create refuses when the creator vanished between the statements", async () => {
  const fake = createSequencedFakeDb([[], []]);
  await assert.rejects(
    createApiTokenStore(fake.db).create("org_1", {
      createdBy: "user_gone",
      name: "CI",
      prefix: "lnx_abcd1234",
      hash: "cd".repeat(32),
      scopes: ["judge"],
      expiresAt: null,
    }),
    /no longer exists/,
  );
});

test("list is the workspace's own tokens, newest first", async () => {
  const fake = createFakeDb([row]);
  assert.deepEqual(await createApiTokenStore(fake.db).list("org_1"), [stored]);
  assert.equal(fake.calls[0]?.filtered, true);
  assert.equal(fake.calls[0]?.ordered, true);
  assert.equal(fake.calls[0]?.limited, 200);
});

test("revoke answers the token, or undefined for another workspace's", async () => {
  const revokedAt = new Date("2026-11-13T00:00:00.000Z");
  const hit = createSequencedFakeDb([
    [{ id: "tok_1" }],
    [{ ...row, revokedAt }],
  ]);
  assert.deepEqual(await createApiTokenStore(hit.db).revoke("org_1", "tok_1"), {
    ...stored,
    revokedAt,
  });
  assert.equal(hit.calls[0]?.kind, "update");
  assert.equal(hit.calls[0]?.filtered, true);

  const miss = createSequencedFakeDb([[]]);
  assert.equal(
    await createApiTokenStore(miss.db).revoke("org_2", "tok_1"),
    undefined,
  );
  assert.equal(miss.calls.length, 1);
});

test("findByHash answers the live token with the person it acts as", async () => {
  const fake = createFakeDb([{ ...row, createdByEmail: "ada@example.test" }]);
  assert.deepEqual(await createApiTokenStore(fake.db).findByHash("ef"), {
    ...stored,
    createdBy: {
      id: "user_1",
      name: "Ada Lovelace",
      email: "ada@example.test",
    },
  });
  assert.equal(fake.calls[0]?.filtered, true);
  assert.equal(fake.calls[0]?.limited, 1);
  assert.equal(
    await createApiTokenStore(createFakeDb([]).db).findByHash("ef"),
    undefined,
  );
});

test("touch writes the use time under the workspace", async () => {
  const fake = createFakeDb([]);
  const at = new Date("2026-11-12T10:00:00.000Z");
  await createApiTokenStore(fake.db).touch(
    "org_1",
    "tok_1",
    at,
    new Date(at.getTime() - 60_000),
  );
  assert.equal(fake.calls[0]?.kind, "update");
  assert.deepEqual(fake.calls[0]?.values, { lastUsedAt: at });
  assert.equal(fake.calls[0]?.filtered, true);
});

const defaultInput = {
  createdBy: "user_1",
  name: "Default",
  prefix: "lnx_abcd1234",
  hash: "12".repeat(32),
  scopes: ["workspace:read"] as const,
  expiresAt: null,
  secret: "lnx_" + "a".repeat(40),
};

test("createDefault seals the secret beside its hash, and reads the row back", async () => {
  const fake = createSequencedFakeDb([[{ id: "tok_1" }], [row]]);
  const created = await createApiTokenStore(fake.db).createDefault(
    "org_1",
    defaultInput,
  );
  assert.deepEqual(created, stored);
  const values = fake.calls[0]?.values ?? {};
  assert.equal(values["isDefault"], true);
  assert.equal(values["keyId"], cipher.keyId);
  assert.equal(values["hash"], "12".repeat(32));
  const sealed = String(values["secretEnc"]);
  assert.match(sealed, /^v1:/);
  assert.equal(sealed.includes(defaultInput.secret), false);
  assert.equal(cipher.decrypt(sealed), defaultInput.secret);
});

test("createDefault answers undefined when a live default already exists", async () => {
  const fake = createSequencedFakeDb([[]]);
  assert.equal(
    await createApiTokenStore(fake.db).createDefault("org_1", defaultInput),
    undefined,
  );
  assert.equal(fake.calls.length, 1);
});

test("findDefault answers the person's live default with its secret opened", async () => {
  const fake = createFakeDb([
    { ...row, secretEnc: cipher.encrypt(defaultInput.secret) },
  ]);
  assert.deepEqual(
    await createApiTokenStore(fake.db).findDefault("org_1", "user_1"),
    { token: stored, secret: defaultInput.secret },
  );
  assert.equal(fake.calls[0]?.filtered, true);
  assert.equal(fake.calls[0]?.limited, 1);
  assert.equal(
    await createApiTokenStore(createFakeDb([]).db).findDefault(
      "org_1",
      "user_1",
    ),
    undefined,
  );
});

test("findDefault reports a secret another key sealed as unreadable", async () => {
  const other = createTokenCipher(Buffer.alloc(32, 9).toString("base64"));
  const fake = createFakeDb([
    { ...row, secretEnc: other.encrypt(defaultInput.secret) },
  ]);
  assert.deepEqual(
    await createApiTokenStore(fake.db).findDefault("org_1", "user_1"),
    { token: stored, secret: null },
  );
});

test("findDefault does not swallow a failure that is not the cipher's", async () => {
  const broken = {
    ...cipher,
    decrypt: () => {
      throw new Error("boom");
    },
  };
  const fake = createFakeDb([{ ...row, secretEnc: "v1:x" }]);
  await assert.rejects(
    createStore(fake.db, broken).findDefault("org_1", "user_1"),
    /boom/,
  );
});
