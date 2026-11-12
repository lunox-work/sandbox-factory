import assert from "node:assert/strict";
import { test } from "node:test";

import { createOAuthGrantStore } from "../src/oauth-grants.js";
import { createFakeDb, createSequencedFakeDb } from "./fake-db.js";

const createdAt = new Date("2026-11-12T00:00:00.000Z");
const updatedAt = new Date("2026-11-12T01:00:00.000Z");
const expiresAt = new Date("2026-11-12T02:00:00.000Z");

const grantRow = {
  id: "consent_1",
  clientId: "client_1",
  clientName: "Claude Code",
  userId: "user_1",
  userName: "Ada Lovelace",
  scopes: ["workspace:read", "offline_access"],
  createdAt,
  updatedAt,
  lastUsedAt: null,
};
const grant = {
  id: "consent_1",
  client: { id: "client_1", name: "Claude Code" },
  user: { id: "user_1", name: "Ada Lovelace" },
  scopes: ["workspace:read", "offline_access"],
  createdAt,
  updatedAt,
  lastUsedAt: null,
};

test("findAccessToken answers the token with its grant and person", async () => {
  const fake = createFakeDb([
    {
      id: "at_1",
      clientId: "client_1",
      grantId: "consent_1",
      organizationId: "org_1",
      userId: "user_1",
      userEmail: "ada@example.test",
      userName: "Ada Lovelace",
      scopes: ["workspace:read"],
      expiresAt,
      grantLastUsedAt: null,
    },
  ]);
  assert.deepEqual(await createOAuthGrantStore(fake.db).findAccessToken("ab"), {
    id: "at_1",
    clientId: "client_1",
    grantId: "consent_1",
    organizationId: "org_1",
    user: { id: "user_1", email: "ada@example.test", name: "Ada Lovelace" },
    scopes: ["workspace:read"],
    expiresAt,
    grantLastUsedAt: null,
  });
  assert.equal(fake.calls[0]?.filtered, true);
  assert.equal(fake.calls[0]?.limited, 1);
});

test("findAccessToken finds nothing for a missing or unbound token", async () => {
  assert.equal(
    await createOAuthGrantStore(createFakeDb([]).db).findAccessToken("ab"),
    undefined,
  );
  const unbound = createFakeDb([
    {
      id: "at_1",
      clientId: "client_1",
      grantId: "consent_1",
      organizationId: null,
      userId: "user_1",
      userEmail: "ada@example.test",
      userName: "Ada Lovelace",
      scopes: ["workspace:read"],
      expiresAt,
      grantLastUsedAt: null,
    },
  ]);
  assert.equal(
    await createOAuthGrantStore(unbound.db).findAccessToken("ab"),
    undefined,
  );
});

test("list is the workspace's grants, most recently approved first", async () => {
  const fake = createFakeDb([grantRow]);
  assert.deepEqual(await createOAuthGrantStore(fake.db).list("org_1"), [grant]);
  assert.equal(fake.calls[0]?.filtered, true);
  assert.equal(fake.calls[0]?.ordered, true);
  assert.equal(fake.calls[0]?.limited, 200);
});

test("touch writes the use time under the workspace", async () => {
  const fake = createFakeDb([]);
  const at = new Date("2026-11-12T10:00:00.000Z");
  await createOAuthGrantStore(fake.db).touch(
    "org_1",
    "consent_1",
    at,
    new Date(at.getTime() - 60_000),
  );
  assert.equal(fake.calls[0]?.kind, "update");
  assert.deepEqual(fake.calls[0]?.values, { lastUsedAt: at });
  assert.equal(fake.calls[0]?.filtered, true);
});

test("revoke deletes the grant's tokens, then the grant", async () => {
  const fake = createSequencedFakeDb([[grantRow], [], [], []]);
  assert.deepEqual(
    await createOAuthGrantStore(fake.db).revoke("org_1", "consent_1"),
    grant,
  );
  assert.deepEqual(
    fake.calls.map((call) => call.kind),
    ["select", "delete", "delete", "delete"],
  );
  assert.ok(fake.calls.every((call) => call.filtered === true));
});

test("revoke of another workspace's grant touches nothing", async () => {
  const fake = createSequencedFakeDb([[]]);
  assert.equal(
    await createOAuthGrantStore(fake.db).revoke("org_2", "consent_1"),
    undefined,
  );
  assert.equal(fake.calls.length, 1);
});

test("revokeAccessToken ends the token and the refresh token it came with", async () => {
  const fake = createSequencedFakeDb([[{ refreshId: "rt_1" }], []]);
  assert.equal(
    await createOAuthGrantStore(fake.db).revokeAccessToken("org_1", "at_1"),
    true,
  );
  assert.deepEqual(
    fake.calls.map((call) => call.kind),
    ["update", "update"],
  );
  assert.ok(fake.calls.every((call) => call.filtered === true));
});

test("revokeAccessToken without a refresh token, or of another workspace's, ends no more", async () => {
  const lone = createSequencedFakeDb([[{ refreshId: null }]]);
  assert.equal(
    await createOAuthGrantStore(lone.db).revokeAccessToken("org_1", "at_1"),
    true,
  );
  assert.equal(lone.calls.length, 1);
  const miss = createSequencedFakeDb([[]]);
  assert.equal(
    await createOAuthGrantStore(miss.db).revokeAccessToken("org_2", "at_1"),
    false,
  );
  assert.equal(miss.calls.length, 1);
});
