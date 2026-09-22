import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ApiTokenCredential,
  JiraCredentialError,
  memoryTokenSource,
  OAuthCredential,
  type TokenPair,
  type TokenSource,
} from "../src/index.js";

const hour = 60 * 60 * 1000;

/** A token pair expiring `ms` from `now`. */
function pair(
  now: number,
  ms: number,
  overrides: Partial<TokenPair> = {},
): TokenPair {
  return {
    accessToken: "access-1",
    refreshToken: "refresh-1",
    expiresAt: new Date(now + ms).toISOString(),
    scopes: [],
    ...overrides,
  };
}

/** A token endpoint stub that counts calls and rotates the refresh token. */
function refreshStub(now: number): {
  fetch: typeof globalThis.fetch;
  calls: () => number;
  now: () => number;
} {
  let issued = 0;
  const fetch = (async () => {
    issued += 1;
    return new Response(
      JSON.stringify({
        access_token: `access-${issued + 1}`,
        refresh_token: `refresh-${issued + 1}`,
        expires_in: 3600,
        scope: "read:jira-work",
      }),
      { status: 200 },
    );
  }) as typeof globalThis.fetch;
  return { fetch, calls: () => issued, now: () => now };
}

test("a live token is spent without a refresh", async () => {
  const now = Date.parse("2026-09-18T00:00:00.000Z");
  const stub = refreshStub(now);
  const credential = new OAuthCredential({
    tokens: memoryTokenSource(pair(now, hour)),
    clientId: "c",
    clientSecret: "s",
    cloudId: "cloud-1",
    fetch: stub.fetch,
    now: stub.now,
  });

  assert.equal(await credential.authorize(), "Bearer access-1");
  assert.equal(stub.calls(), 0);
});

test("an expired token is refreshed and the new pair persisted", async () => {
  const now = Date.parse("2026-09-18T00:00:00.000Z");
  const stub = refreshStub(now);
  const source = memoryTokenSource(pair(now, -hour));
  const credential = new OAuthCredential({
    tokens: source,
    clientId: "c",
    clientSecret: "s",
    cloudId: "cloud-1",
    fetch: stub.fetch,
    now: stub.now,
  });

  assert.equal(await credential.authorize(), "Bearer access-2");
  assert.equal(stub.calls(), 1);
  // Persisted before use: the rotated refresh token is the only one that works.
  assert.equal((await source.load()).refreshToken, "refresh-2");
});

test("a token inside the skew window is refreshed before it expires", async () => {
  const now = Date.parse("2026-09-18T00:00:00.000Z");
  const stub = refreshStub(now);
  // 30s left, default skew is 60s: refreshed, so it cannot expire mid-flight.
  const credential = new OAuthCredential({
    tokens: memoryTokenSource(pair(now, 30_000)),
    clientId: "c",
    clientSecret: "s",
    cloudId: "cloud-1",
    fetch: stub.fetch,
    now: stub.now,
  });

  assert.equal(await credential.authorize(), "Bearer access-2");
  assert.equal(stub.calls(), 1);
});

test("concurrent calls on an expired token share one refresh", async () => {
  const now = Date.parse("2026-09-18T00:00:00.000Z");
  const stub = refreshStub(now);
  const credential = new OAuthCredential({
    tokens: memoryTokenSource(pair(now, -hour)),
    clientId: "c",
    clientSecret: "s",
    cloudId: "cloud-1",
    fetch: stub.fetch,
    now: stub.now,
  });

  const headers = await Promise.all([
    credential.authorize(),
    credential.authorize(),
    credential.authorize(),
  ]);

  // One call, not three. Three would rotate the refresh token three times and
  // leave two of them writing back tokens Atlassian has already invalidated.
  assert.equal(stub.calls(), 1);
  assert.deepEqual(headers, [
    "Bearer access-2",
    "Bearer access-2",
    "Bearer access-2",
  ]);
});

test("a refresh is retried on the next call, not cached forever", async () => {
  const now = Date.parse("2026-09-18T00:00:00.000Z");
  let issued = 0;
  // Every refresh hands back an already-expired token, so the next call must
  // refresh again. That is what proves the in-flight promise is cleared once it
  // settles rather than latching the first result forever.
  const fetch = (async () => {
    issued += 1;
    return new Response(
      JSON.stringify({
        access_token: `access-${issued + 1}`,
        refresh_token: `refresh-${issued + 1}`,
        expires_in: -1,
      }),
      { status: 200 },
    );
  }) as typeof globalThis.fetch;
  const credential = new OAuthCredential({
    tokens: memoryTokenSource(pair(now, -hour)),
    clientId: "c",
    clientSecret: "s",
    cloudId: "cloud-1",
    fetch,
    now: () => now,
  });

  assert.equal(await credential.authorize(), "Bearer access-2");
  assert.equal(await credential.authorize(), "Bearer access-3");
  assert.equal(issued, 2);
});

test("an unparseable expiry is treated as expired", async () => {
  const now = Date.parse("2026-09-18T00:00:00.000Z");
  const stub = refreshStub(now);
  const credential = new OAuthCredential({
    tokens: memoryTokenSource(pair(now, hour, { expiresAt: "not a date" })),
    clientId: "c",
    clientSecret: "s",
    cloudId: "cloud-1",
    fetch: stub.fetch,
    now: stub.now,
  });

  assert.equal(await credential.authorize(), "Bearer access-2");
});

test("an expired token with nothing to refresh says to reconnect", async () => {
  const now = Date.parse("2026-09-18T00:00:00.000Z");
  const stub = refreshStub(now);
  const credential = new OAuthCredential({
    tokens: memoryTokenSource(pair(now, -hour, { refreshToken: undefined })),
    clientId: "c",
    clientSecret: "s",
    cloudId: "cloud-1",
    fetch: stub.fetch,
    now: stub.now,
  });

  await assert.rejects(credential.authorize(), JiraCredentialError);
  assert.equal(stub.calls(), 0);
});

test("the OAuth base URL is the gateway, keyed by cloudId", () => {
  const credential = new OAuthCredential({
    tokens: memoryTokenSource(pair(0, hour)),
    clientId: "c",
    clientSecret: "s",
    cloudId: "cloud-1",
  });

  // Not `<site>.atlassian.net`, which rejects a 3LO token outright.
  assert.equal(
    credential.baseUrl(),
    "https://api.atlassian.com/ex/jira/cloud-1",
  );
  assert.equal(credential.kind, "oauth");
});

test("an API token authenticates as basic auth against the site itself", async () => {
  const credential = new ApiTokenCredential({
    siteUrl: "https://acme.atlassian.net/",
    email: "user@acme.test",
    apiToken: "token-1",
  });

  assert.equal(
    await credential.authorize(),
    `Basic ${btoa("user@acme.test:token-1")}`,
  );
  // Trailing slashes stripped, so paths do not double up.
  assert.equal(credential.baseUrl(), "https://acme.atlassian.net");
  assert.equal(credential.kind, "api-token");
});

test("the base64 encoder is injectable", async () => {
  const credential = new ApiTokenCredential({
    siteUrl: "https://acme.atlassian.net",
    email: "user@acme.test",
    apiToken: "token-1",
    encodeBase64: (value) => `encoded(${value})`,
  });

  assert.equal(
    await credential.authorize(),
    "Basic encoded(user@acme.test:token-1)",
  );
});

test("memoryTokenSource round-trips a saved pair", async () => {
  const source = memoryTokenSource(pair(0, hour));
  const replacement = pair(0, hour, { accessToken: "replaced" });

  await source.save(replacement);

  assert.equal((await source.load()).accessToken, "replaced");
});

/**
 * A token source shared with another holder of the same grant, who refreshes
 * first. Every `load` after the first hands back the winner's live pair, and
 * `save` refuses this holder's pair the way a revision check would.
 */
function racedTokenSource(
  now: number,
  outcome: "winner-persisted" | "still-stale",
): { source: TokenSource; saves: number } & { loads: number } {
  const state = {
    source: undefined as unknown as TokenSource,
    saves: 0,
    loads: 0,
  };
  state.source = {
    load: () => {
      state.loads += 1;
      if (state.loads === 1 || outcome === "still-stale") {
        return Promise.resolve(pair(now, -hour));
      }
      return Promise.resolve(
        pair(now, hour, { accessToken: "winner", refreshToken: "winner-r" }),
      );
    },
    save: () => {
      state.saves += 1;
      return Promise.reject(
        new Error("The Jira credential changed during refresh."),
      );
    },
  };
  return state;
}

test("a refresh lost to another holder of the grant adopts that holder's pair", async () => {
  const now = Date.parse("2026-09-18T00:00:00.000Z");
  const stub = refreshStub(now);
  const raced = racedTokenSource(now, "winner-persisted");
  const credential = new OAuthCredential({
    tokens: raced.source,
    clientId: "c",
    clientSecret: "s",
    cloudId: "cloud-1",
    fetch: stub.fetch,
    now: stub.now,
  });

  // The refresh ran and its persist was refused, but the source now holds a
  // live pair written by whoever won — so the call succeeds with that pair
  // rather than reporting a conflict nobody can act on.
  assert.equal(await credential.authorize(), "Bearer winner");
  assert.equal(stub.calls(), 1);
  assert.equal(raced.saves, 1);
});

test("a refresh that fails while the source is still stale reports the failure", async () => {
  const now = Date.parse("2026-09-18T00:00:00.000Z");
  const stub = refreshStub(now);
  const raced = racedTokenSource(now, "still-stale");
  const credential = new OAuthCredential({
    tokens: raced.source,
    clientId: "c",
    clientSecret: "s",
    cloudId: "cloud-1",
    fetch: stub.fetch,
    now: stub.now,
  });

  // Nobody else refreshed: the reload finds the same expired pair, and the
  // save's own error is what the caller sees, not a second-hand one.
  await assert.rejects(credential.authorize(), {
    message: "The Jira credential changed during refresh.",
  });
});
