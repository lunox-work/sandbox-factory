import assert from "node:assert/strict";
import { test } from "node:test";

import {
  GithubAuthError,
  GithubInstallationUnavailable,
  GithubOAuthError,
} from "@sandbox-factory/github";

import {
  grantTokenSource,
  installationClient,
  noteGrantFailure,
  userClientFor,
} from "../src/github/credential.js";
import {
  fakeGithub,
  installationTokens,
  memoryGithub,
  NOW,
  world,
} from "./github-fakes.js";

/**
 * The grant's refresh write-back: GitHub spends the refresh token on every
 * refresh, so the new pair must be persisted, and a write over a grant
 * replaced meanwhile must be refused rather than clobber it.
 */

const grant = {
  githubLogin: "dana",
  githubUserId: "42",
  accessToken: "ghu_old",
  refreshToken: "ghr_old",
  // Already expired at NOW.
  expiresAt: new Date(NOW - 1000).toISOString(),
};

test("no grant is missing, and a flagged one asks for a reconnect", async () => {
  const stores = memoryGithub();
  const options = {
    grants: stores.grants,
    clientId: "Iv1.app",
    clientSecret: "s",
  };

  const missing = await userClientFor(options, "org_1", "user_1");
  await stores.grants.upsert("org_1", "user_1", grant);
  await stores.grants.markUnhealthy("org_1", "user_1", 1);
  const flagged = await userClientFor(options, "org_1", "user_1");

  assert.deepEqual(missing, { ok: false, reason: "missing" });
  assert.deepEqual(flagged, { ok: false, reason: "reconnect" });
});

test("an expired user token is refreshed and the new pair persisted first", async () => {
  const stores = memoryGithub();
  await stores.grants.upsert("org_1", "user_1", grant);
  const fetch = fakeGithub(world());

  const result = await userClientFor(
    {
      grants: stores.grants,
      clientId: "Iv1.app",
      clientSecret: "s",
      fetch,
      now: () => NOW,
    },
    "org_1",
    "user_1",
  );
  assert.ok(result.ok);
  const me = await result.client.user();

  assert.equal(me.login, "dana");
  assert.ok(fetch.urls[0]?.endsWith("/login/oauth/access_token"));
  const stored = await stores.grants.tokens("org_1", "user_1");
  assert.equal(stored?.accessToken, "ghu_user");
  assert.equal(stored?.refreshToken, "ghr_user");
  assert.equal(stored?.credentialRevision, 2);
});

test("a write-back over a grant replaced meanwhile is refused", async () => {
  const stores = memoryGithub();
  await stores.grants.upsert("org_1", "user_1", grant);
  const source = grantTokenSource(stores.grants, "org_1", "user_1");
  await source.load();
  // The person reconnects while this refresh is in flight.
  await stores.grants.upsert("org_1", "user_1", {
    ...grant,
    accessToken: "ghu_new",
  });

  await assert.rejects(
    source.save({
      accessToken: "ghu_stale",
      refreshToken: undefined,
      expiresAt: undefined,
    }),
    (error: GithubOAuthError) => error.code === "revision",
  );
  assert.equal(
    (await stores.grants.tokens("org_1", "user_1"))?.accessToken,
    "ghu_new",
  );
});

test("a save before any load is refused, and a load with no grant fails as a reconnect", async () => {
  const stores = memoryGithub();
  const source = grantTokenSource(stores.grants, "org_1", "user_1");

  await assert.rejects(
    source.save({
      accessToken: "x",
      refreshToken: undefined,
      expiresAt: undefined,
    }),
    GithubOAuthError,
  );
  await assert.rejects(
    source.load(),
    (error: GithubOAuthError) => error.needsReconnect,
  );
});

test("a saved pair moves the revision the next save is fenced on", async () => {
  const stores = memoryGithub();
  await stores.grants.upsert("org_1", "user_1", {
    ...grant,
    refreshToken: null,
    expiresAt: null,
  });
  const source = grantTokenSource(stores.grants, "org_1", "user_1");

  const loaded = await source.load();
  await source.save({
    accessToken: "ghu_2",
    refreshToken: "ghr_2",
    expiresAt: undefined,
  });
  await source.save({
    accessToken: "ghu_3",
    refreshToken: undefined,
    expiresAt: undefined,
  });

  assert.equal(loaded.refreshToken, undefined);
  assert.equal(loaded.expiresAt, undefined);
  assert.equal(
    (await stores.grants.tokens("org_1", "user_1"))?.credentialRevision,
    3,
  );
});

test("only a revoked or spent grant is flagged; a missing permission is not", async () => {
  const stores = memoryGithub();
  await stores.grants.upsert("org_1", "user_1", grant);
  const target = {
    organizationId: "org_1",
    userId: "user_1",
    credentialRevision: 1,
  };

  assert.equal(
    await noteGrantFailure(
      stores.grants,
      target,
      new GithubAuthError(403, "no"),
    ),
    false,
  );
  assert.equal(
    await noteGrantFailure(
      stores.grants,
      target,
      new GithubInstallationUnavailable(404, "gone"),
    ),
    false,
  );
  assert.equal((await stores.grants.get("org_1", "user_1"))?.healthy, true);
  assert.equal(
    await noteGrantFailure(
      stores.grants,
      target,
      new GithubOAuthError("bad_refresh_token", "spent"),
    ),
    true,
  );
  assert.equal((await stores.grants.get("org_1", "user_1"))?.healthy, false);
});

test("an installation client works with the default fetch wiring", () => {
  // Constructed without an injected fetch, as the server does.
  const client = installationClient(
    installationTokens(fakeGithub(world())),
    "9",
    { kind: "discovery" },
  );

  assert.equal(client.rateLimit, undefined);
});
