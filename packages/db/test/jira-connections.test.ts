import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

import { createTokenCipher } from "../src/cipher.js";
import { createJiraConnectionStore } from "../src/jira-connections.js";
import type { JiraConnectionRow } from "../src/schema.js";
import { createFakeDb } from "./fake-db.js";

const cipher = createTokenCipher(randomBytes(32).toString("base64"));

function connectionRow(
  overrides: Partial<JiraConnectionRow> = {},
): JiraConnectionRow {
  return {
    id: "jrc_1",
    organizationId: "org_1",
    cloudId: "cloud-1",
    siteUrl: "https://acme.atlassian.net",
    siteName: "Acme",
    kind: "oauth",
    accessTokenEnc: cipher.encrypt("access-1"),
    refreshTokenEnc: cipher.encrypt("refresh-1"),
    keyId: cipher.keyId,
    expiresAt: new Date("2026-09-21T01:00:00.000Z"),
    scopes: "read:jira-work offline_access",
    resourceScopes: "read:jira-work",
    credentialRevision: 1,
    email: "user@acme.test",
    healthy: true,
    createdAt: new Date("2026-09-21T00:00:00.000Z"),
    updatedAt: new Date("2026-09-21T00:00:00.000Z"),
    ...overrides,
  };
}

function store(rows: readonly JiraConnectionRow[]) {
  const fake = createFakeDb(rows);
  return { ...fake, store: createJiraConnectionStore(fake.db, cipher) };
}

test("list returns summaries and filters by organization", async () => {
  const { store: connections, calls } = store([connectionRow()]);

  const listed = await connections.list("org_1");

  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.siteName, "Acme");
  assert.deepEqual(listed[0]?.scopes, ["read:jira-work", "offline_access"]);
  // The ownership boundary: a read that stopped filtering would be a leak.
  assert.equal(calls[0]?.filtered, true);
});

test("a summary carries no token material", async () => {
  // These go to the browser. A token reaching a summary would put a live
  // credential in a page and in every HTTP cache between here and there.
  const { store: connections } = store([connectionRow()]);

  const listed = await connections.list("org_1");

  const serialized = JSON.stringify(listed);
  assert.ok(!serialized.includes("access-1"));
  assert.ok(!serialized.includes("refresh-1"));
  assert.ok(!serialized.includes("accessToken"));
  assert.ok(!serialized.includes("Enc"));
});

test("get scopes the read to the owner", async () => {
  const { store: connections, calls } = store([connectionRow()]);

  await connections.get("org_1", "jrc_1");

  assert.equal(calls[0]?.filtered, true);
});

test("get returns null when the row is not the caller's", async () => {
  // The fake returns no rows, which is what a mismatched owner produces.
  const { store: connections } = store([]);

  assert.equal(await connections.get("org_2", "jrc_1"), null);
});

test("upsert encrypts both tokens and records the key id", async () => {
  const { store: connections, calls } = store([connectionRow()]);

  await connections.upsert("org_1", {
    cloudId: "cloud-1",
    siteUrl: "https://acme.atlassian.net",
    siteName: "Acme",
    email: "user@acme.test",
    accessToken: "access-plain",
    refreshToken: "refresh-plain",
    expiresAt: "2026-09-21T01:00:00.000Z",
    scopes: ["read:jira-work", "offline_access"],
  });

  const values = calls[0]?.values ?? {};
  // Neither token may reach the row in the clear.
  assert.notEqual(values["accessTokenEnc"], "access-plain");
  assert.notEqual(values["refreshTokenEnc"], "refresh-plain");
  assert.match(String(values["accessTokenEnc"]), /^v1:/);
  assert.match(String(values["refreshTokenEnc"]), /^v1:/);
  assert.equal(values["keyId"], cipher.keyId);
  // And they must be the real thing when read back.
  assert.equal(
    cipher.decrypt(String(values["accessTokenEnc"])),
    "access-plain",
  );
  assert.equal(
    cipher.decrypt(String(values["refreshTokenEnc"])),
    "refresh-plain",
  );
});

test("upsert generates a prefixed id and scopes the row to the owner", async () => {
  const { store: connections, calls } = store([connectionRow()]);

  await connections.upsert("org_1", {
    cloudId: "cloud-1",
    siteUrl: "https://acme.atlassian.net",
    siteName: "Acme",
    accessToken: "a",
    refreshToken: "r",
    expiresAt: null,
    scopes: [],
  });

  const values = calls[0]?.values ?? {};
  assert.match(String(values["id"]), /^jrc_/);
  assert.equal(values["organizationId"], "org_1");
});

test("upsert marks a reconnected site healthy again", async () => {
  // Reconnecting is how a user clears the "reconnect Jira" state.
  const { store: connections, calls } = store([connectionRow()]);

  await connections.upsert("org_1", {
    cloudId: "cloud-1",
    siteUrl: "https://acme.atlassian.net",
    siteName: "Acme",
    accessToken: "a",
    refreshToken: "r",
    expiresAt: null,
    scopes: [],
  });

  assert.equal((calls[0]?.values ?? {})["healthy"], true);
});

test("upsert stores a grant with no refresh token as null, not as ciphertext", async () => {
  // A grant made without `offline_access` genuinely has none.
  const { store: connections, calls } = store([connectionRow()]);

  await connections.upsert("org_1", {
    cloudId: "cloud-1",
    siteUrl: "https://acme.atlassian.net",
    siteName: "Acme",
    accessToken: "a",
    refreshToken: null,
    expiresAt: null,
    scopes: [],
  });

  assert.equal((calls[0]?.values ?? {})["refreshTokenEnc"], null);
});

test("tokens decrypts the stored pair", async () => {
  const { store: connections } = store([connectionRow()]);

  const tokens = await connections.tokens("org_1", "jrc_1");

  assert.equal(tokens?.accessToken, "access-1");
  assert.equal(tokens?.refreshToken, "refresh-1");
  assert.equal(tokens?.expiresAt, "2026-09-21T01:00:00.000Z");
  assert.deepEqual(tokens?.scopes, ["read:jira-work", "offline_access"]);
});

test("tokens is scoped to the owner too", async () => {
  // The most important filter in the file: this one hands back credentials.
  const { store: connections, calls } = store([connectionRow()]);

  await connections.tokens("org_1", "jrc_1");

  assert.equal(calls[0]?.filtered, true);
});

test("tokens returns null for a connection the caller does not own", async () => {
  const { store: connections } = store([]);

  assert.equal(await connections.tokens("org_2", "jrc_1"), null);
});

test("an unreadable token throws rather than reporting no connection", async () => {
  // A key problem must not look like a missing connection: the user would be
  // sent round the OAuth flow to no effect.
  const otherCipher = createTokenCipher(randomBytes(32).toString("base64"));
  const fake = createFakeDb([connectionRow()]);
  const connections = createJiraConnectionStore(fake.db, otherCipher);

  await assert.rejects(() => connections.tokens("org_1", "jrc_1"));
});

test("saveTokens re-encrypts and stamps the current key", async () => {
  // Called on every refresh; Atlassian rotates, so this write is what keeps
  // the connection alive.
  const { store: connections, calls } = store([connectionRow()]);

  await connections.saveTokens("org_1", "jrc_1", 1, {
    accessToken: "access-2",
    refreshToken: "refresh-2",
    expiresAt: "2026-09-21T02:00:00.000Z",
    scopes: ["read:jira-work"],
  });

  const values = calls[0]?.values ?? {};
  assert.equal(cipher.decrypt(String(values["accessTokenEnc"])), "access-2");
  assert.equal(cipher.decrypt(String(values["refreshTokenEnc"])), "refresh-2");
  assert.equal(values["keyId"], cipher.keyId);
  assert.equal(values["scopes"], "read:jira-work");
  // A successful refresh proves the grant is live again.
  assert.equal(values["healthy"], true);
  assert.equal(calls[0]?.filtered, true);
});

test("markUnhealthy flags the row without touching the tokens", async () => {
  // The row is kept so the UI can name the site the user recognises.
  const { store: connections, calls } = store([connectionRow()]);

  assert.equal(await connections.markUnhealthy("org_1", "jrc_1", 1), true);

  const values = calls[0]?.values ?? {};
  assert.equal(values["healthy"], false);
  assert.equal(values["accessTokenEnc"], undefined);
  assert.equal(values["refreshTokenEnc"], undefined);
  // Owner and revision are in the WHERE, not just the id.
  assert.equal(calls[0]?.filtered, true);
});

test("markUnhealthy reports a row that has moved on", async () => {
  // A reconnect mid-request bumps the revision; the fake returns no row for
  // the stale update, as Postgres would.
  const { store: connections } = store([]);
  assert.equal(await connections.markUnhealthy("org_1", "jrc_1", 1), false);
});

test("remove reports whether anything was deleted, scoped to the owner", async () => {
  const { store: connections, calls } = store([connectionRow()]);
  assert.equal(await connections.remove("org_1", "jrc_1"), true);
  assert.equal(calls[0]?.filtered, true);

  const { store: empty } = store([]);
  assert.equal(await empty.remove("org_2", "jrc_1"), false);
});

test("the write grant is derived from both scope lists", async () => {
  // The token's scopes say what Atlassian issued; the site's say what that
  // token may do there. Either one alone is permission the other end refuses.
  const both = store([
    connectionRow({
      scopes: "read:jira-work write:jira-work offline_access",
      resourceScopes: "read:jira-work write:jira-work",
    }),
  ]);
  assert.equal((await both.store.list("org_1"))[0]?.writeGranted, true);

  const tokenOnly = store([
    connectionRow({
      scopes: "read:jira-work write:jira-work offline_access",
      resourceScopes: "read:jira-work",
    }),
  ]);
  assert.equal((await tokenOnly.store.list("org_1"))[0]?.writeGranted, false);

  const siteOnly = store([
    connectionRow({
      scopes: "read:jira-work offline_access",
      resourceScopes: "read:jira-work write:jira-work",
    }),
  ]);
  assert.equal((await siteOnly.store.list("org_1"))[0]?.writeGranted, false);
});

test("an empty scope column reads as no scopes", async () => {
  const { store: connections } = store([connectionRow({ scopes: "" })]);

  const listed = await connections.list("org_1");

  assert.deepEqual(listed[0]?.scopes, []);
});

test("an insert that returns no row fails loudly", async () => {
  // Should be unreachable — the statement has a RETURNING clause — but
  // returning a summary built from `undefined` would surface much later, as a
  // connection that exists in the UI and not in the database.
  const { store: connections } = store([]);

  await assert.rejects(
    () =>
      connections.upsert("org_1", {
        cloudId: "cloud-1",
        siteUrl: "https://acme.atlassian.net",
        siteName: "Acme",
        accessToken: "a",
        refreshToken: "r",
        expiresAt: null,
        scopes: [],
      }),
    /Failed to record the Jira connection/,
  );
});
