import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

import { createTokenCipher } from "../src/cipher.js";
import { createGithubGrantStore } from "../src/github-grants.js";
import type { GithubGrantRow } from "../src/schema.js";
import { createFakeDb } from "./fake-db.js";

const cipher = createTokenCipher(randomBytes(32).toString("base64"));

function grantRow(overrides: Partial<GithubGrantRow> = {}): GithubGrantRow {
  return {
    id: "ghg_1",
    organizationId: "org_1",
    userId: "user_1",
    githubLogin: "dana",
    githubUserId: "42",
    accessTokenEnc: cipher.encrypt("ghu_1") ?? "",
    refreshTokenEnc: cipher.encrypt("ghr_1"),
    keyId: cipher.keyId,
    expiresAt: new Date("2026-10-01T08:00:00.000Z"),
    credentialRevision: 1,
    healthy: true,
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
    updatedAt: new Date("2026-10-01T00:00:00.000Z"),
    ...overrides,
  };
}

const input = {
  githubLogin: "dana",
  githubUserId: "42",
  accessToken: "ghu_1",
  refreshToken: "ghr_1",
  expiresAt: "2026-10-01T08:00:00.000Z",
};

test("an upsert stores ciphertext, never the token", async () => {
  const fake = createFakeDb([grantRow()]);
  const store = createGithubGrantStore(fake.db, cipher);

  const summary = await store.upsert("org_1", "user_1", input);

  const values = fake.calls[0]?.values ?? {};
  assert.match(String(values["accessTokenEnc"]), /^v1:/);
  assert.match(String(values["refreshTokenEnc"]), /^v1:/);
  assert.ok(!JSON.stringify(values).includes("ghu_1"));
  assert.ok(!JSON.stringify(values).includes("ghr_1"));
  assert.equal(values["organizationId"], "org_1");
  assert.equal(values["userId"], "user_1");
  // And none in the summary, which goes to the browser.
  assert.ok(!JSON.stringify(summary).includes("ghu_1"));
  assert.equal(summary.githubLogin, "dana");
});

test("re-granting moves the revision on and clears the unhealthy flag", async () => {
  // So a refresh still in flight on the old grant cannot overwrite this one.
  const fake = createFakeDb([grantRow({ credentialRevision: 2 })]);
  const store = createGithubGrantStore(fake.db, cipher);

  await store.upsert("org_1", "user_1", input);

  const conflictSet = fake.calls[0]?.conflictSet ?? {};
  assert.ok("credentialRevision" in conflictSet);
  assert.equal(conflictSet["healthy"], true);
});

test("a grant without expiry or refresh token is stored as such", async () => {
  const fake = createFakeDb([
    grantRow({ refreshTokenEnc: null, expiresAt: null }),
  ]);
  const store = createGithubGrantStore(fake.db, cipher);

  const summary = await store.upsert("org_1", "user_1", {
    ...input,
    refreshToken: null,
    expiresAt: null,
  });

  assert.equal(fake.calls[0]?.values?.["refreshTokenEnc"], null);
  assert.equal(fake.calls[0]?.values?.["expiresAt"], null);
  assert.equal(summary.expiresAt, null);
});

test("an upsert that returns nothing is an error, not a missing grant", async () => {
  const store = createGithubGrantStore(createFakeDb([]).db, cipher);

  await assert.rejects(store.upsert("org_1", "user_1", input), /GitHub grant/);
});

test("tokens decrypt for the owner, and miss as null", async () => {
  const found = createGithubGrantStore(createFakeDb([grantRow()]).db, cipher);
  const missing = createGithubGrantStore(createFakeDb([]).db, cipher);

  assert.deepEqual(await found.tokens("org_1", "user_1"), {
    accessToken: "ghu_1",
    refreshToken: "ghr_1",
    expiresAt: "2026-10-01T08:00:00.000Z",
    credentialRevision: 1,
  });
  assert.equal(await missing.tokens("org_1", "user_1"), null);
  assert.equal(await missing.get("org_1", "user_1"), null);
});

test("get is a summary with no token material", async () => {
  const store = createGithubGrantStore(createFakeDb([grantRow()]).db, cipher);

  const summary = await store.get("org_1", "user_1");

  assert.equal(summary?.healthy, true);
  assert.ok(!JSON.stringify(summary).includes("v1:"));
});

test("saveTokens is fenced on the revision and reports a lost race", async () => {
  const won = createFakeDb([grantRow({ credentialRevision: 2 })]);
  const lost = createFakeDb([]);

  const saved = await createGithubGrantStore(won.db, cipher).saveTokens(
    "org_1",
    "user_1",
    1,
    { accessToken: "ghu_2", refreshToken: "ghr_2", expiresAt: null },
  );
  const refused = await createGithubGrantStore(lost.db, cipher).saveTokens(
    "org_1",
    "user_1",
    1,
    {
      accessToken: "ghu_2",
      refreshToken: null,
      expiresAt: "2026-10-02T00:00:00.000Z",
    },
  );

  assert.equal(saved, true);
  assert.equal(refused, false);
  assert.equal(won.calls[0]?.values?.["credentialRevision"], 2);
  assert.equal(won.calls[0]?.filtered, true);
});

test("markUnhealthy is fenced the same way", async () => {
  const fake = createFakeDb([grantRow()]);

  assert.equal(
    await createGithubGrantStore(fake.db, cipher).markUnhealthy(
      "org_1",
      "user_1",
      1,
    ),
    true,
  );
  assert.equal(
    await createGithubGrantStore(createFakeDb([]).db, cipher).markUnhealthy(
      "org_1",
      "user_1",
      1,
    ),
    false,
  );
  assert.equal(fake.calls[0]?.values?.["healthy"], false);
});
