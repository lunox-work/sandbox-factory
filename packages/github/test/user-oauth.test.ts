import assert from "node:assert/strict";
import { test } from "node:test";

import {
  authorizeUrl,
  exchangeCode,
  GithubOAuthError,
  refreshUserToken,
  UserCredential,
  type TokenSource,
  type UserTokens,
} from "../src/index.js";
import { fakeFetch, json } from "./helpers.js";

const NOW = Date.parse("2026-10-01T00:00:00.000Z");
const credentials = { clientId: "Iv1.app", clientSecret: "shh" };

test("the authorize URL carries the App's client id, the callback and the state", () => {
  const url = new URL(
    authorizeUrl({
      clientId: "Iv1.app",
      state: "signed.state",
      redirectUri: "https://platform.test/api/v1/github/callback",
    }),
  );

  assert.equal(
    url.origin + url.pathname,
    "https://github.com/login/oauth/authorize",
  );
  assert.equal(url.searchParams.get("client_id"), "Iv1.app");
  assert.equal(url.searchParams.get("state"), "signed.state");
  assert.equal(
    url.searchParams.get("redirect_uri"),
    "https://platform.test/api/v1/github/callback",
  );
  // A GitHub App ignores scopes; sending some would suggest otherwise.
  assert.equal(url.searchParams.has("scope"), false);
});

test("an exchange resolves expiry to an absolute time", async () => {
  const fetch = fakeFetch(() =>
    json({
      access_token: "ghu_1",
      expires_in: 28_800,
      refresh_token: "ghr_1",
      refresh_token_expires_in: 15_897_600,
      token_type: "bearer",
      scope: "",
    }),
  );

  const tokens = await exchangeCode({
    ...credentials,
    code: "abc",
    redirectUri: "https://platform.test/cb",
    fetch,
    now: () => NOW,
  });

  assert.deepEqual(tokens, {
    accessToken: "ghu_1",
    refreshToken: "ghr_1",
    expiresAt: "2026-10-01T08:00:00.000Z",
  });
  assert.equal(
    fetch.calls[0]?.url,
    "https://github.com/login/oauth/access_token",
  );
  assert.equal(fetch.calls[0]?.headers["accept"], "application/json");
  assert.deepEqual(fetch.calls[0]?.body, {
    client_id: "Iv1.app",
    client_secret: "shh",
    code: "abc",
    redirect_uri: "https://platform.test/cb",
  });
});

test("a token from an App that does not expire them has no expiry", async () => {
  const tokens = await exchangeCode({
    ...credentials,
    code: "abc",
    fetch: fakeFetch(() => json({ access_token: "ghu_1" })),
  });

  assert.equal(tokens.expiresAt, undefined);
  assert.equal(tokens.refreshToken, undefined);
});

test("a refused exchange arrives as 200 and is still an error", async () => {
  await assert.rejects(
    exchangeCode({
      ...credentials,
      code: "spent",
      fetch: fakeFetch(() =>
        json({
          error: "bad_verification_code",
          error_description: "The code passed is incorrect or expired.",
        }),
      ),
    }),
    (error: GithubOAuthError) =>
      error instanceof GithubOAuthError &&
      error.code === "bad_verification_code" &&
      !error.needsReconnect,
  );
});

test("a non-2xx or an unreadable body is reported under a code of its own", async () => {
  await assert.rejects(
    exchangeCode({
      ...credentials,
      code: "abc",
      fetch: fakeFetch(() => new Response("bad gateway", { status: 502 })),
    }),
    (error: GithubOAuthError) => error.code === "http_502" && error.unanswered,
  );
  await assert.rejects(
    exchangeCode({
      ...credentials,
      code: "abc",
      fetch: fakeFetch(() => new Response("<html>", { status: 200 })),
    }),
    (error: GithubOAuthError) => error.code === "malformed",
  );
  await assert.rejects(
    exchangeCode({
      ...credentials,
      code: "abc",
      fetch: fakeFetch(() => json({ access_token: 42 })),
    }),
    (error: GithubOAuthError) => error.code === "malformed",
  );
});

test("an exchange GitHub never answers is `network`, not a refusal", async () => {
  // The callback tells "GitHub refused this person" from "GitHub did not
  // answer" by this, and only the first is worth telling them they denied.
  const fetch = fakeFetch(() => {
    throw new TypeError("fetch failed");
  });

  await assert.rejects(
    exchangeCode({ ...credentials, code: "abc", fetch }),
    (error: GithubOAuthError) =>
      error.code === "network" &&
      error.unanswered &&
      !error.needsReconnect &&
      error.message === "Could not reach GitHub.",
  );
  assert.ok(fetch.calls[0]?.signal instanceof AbortSignal);
});

test("a refusal GitHub did answer is not `unanswered`", async () => {
  await assert.rejects(
    exchangeCode({
      ...credentials,
      code: "abc",
      fetch: fakeFetch(() => json({ error: "bad_verification_code" })),
    }),
    (error: GithubOAuthError) => !error.unanswered,
  );
});

test("a refresh sends the refresh grant", async () => {
  const fetch = fakeFetch(() =>
    json({ access_token: "ghu_2", expires_in: 60, refresh_token: "ghr_2" }),
  );

  const tokens = await refreshUserToken({
    ...credentials,
    refreshToken: "ghr_1",
    fetch,
    now: () => NOW,
  });

  assert.equal(tokens.refreshToken, "ghr_2");
  assert.deepEqual(fetch.calls[0]?.body, {
    client_id: "Iv1.app",
    client_secret: "shh",
    grant_type: "refresh_token",
    refresh_token: "ghr_1",
  });
});

/** A token source over a variable, recording saves. */
function source(initial: UserTokens): TokenSource & {
  saved: UserTokens[];
  current: UserTokens;
} {
  const state = {
    saved: [] as UserTokens[],
    current: initial,
    load: () => Promise.resolve(state.current),
    save: (tokens: UserTokens) => {
      state.saved.push(tokens);
      state.current = tokens;
      return Promise.resolve();
    },
  };
  return state;
}

const fresh: UserTokens = {
  accessToken: "ghu_1",
  refreshToken: "ghr_1",
  expiresAt: new Date(NOW + 8 * 60 * 60_000).toISOString(),
};
const stale: UserTokens = {
  accessToken: "ghu_old",
  refreshToken: "ghr_old",
  expiresAt: new Date(NOW + 60_000).toISOString(),
};

test("a live token is used as stored", async () => {
  const fetch = fakeFetch(() => json({}));
  const credential = new UserCredential({
    ...credentials,
    tokens: source(fresh),
    fetch,
    now: () => NOW,
  });

  assert.equal(await credential.token(), "ghu_1");
  assert.equal(fetch.calls.length, 0);
});

test("a token near expiry is refreshed once, persisted, then used", async () => {
  const tokens = source(stale);
  const fetch = fakeFetch(() =>
    json({
      access_token: "ghu_new",
      expires_in: 28_800,
      refresh_token: "ghr_new",
    }),
  );
  const credential = new UserCredential({
    ...credentials,
    tokens,
    fetch,
    now: () => NOW,
  });

  // Concurrent: a second refresh would spend the refresh token the first
  // just received.
  const all = await Promise.all([credential.token(), credential.token()]);

  assert.deepEqual(all, ["ghu_new", "ghu_new"]);
  assert.equal(fetch.calls.length, 1);
  assert.equal(tokens.saved[0]?.refreshToken, "ghr_new");
});

test("a token that never expires is never refreshed", async () => {
  const fetch = fakeFetch(() => json({}));
  const credential = new UserCredential({
    ...credentials,
    tokens: source({
      accessToken: "ghu_1",
      refreshToken: undefined,
      expiresAt: undefined,
    }),
    fetch,
  });

  assert.equal(await credential.token(), "ghu_1");
  assert.equal(fetch.calls.length, 0);
});

test("an expired token with nothing to refresh with asks for a reconnect", async () => {
  const credential = new UserCredential({
    ...credentials,
    tokens: source({ ...stale, refreshToken: undefined }),
    now: () => NOW,
  });

  await assert.rejects(
    credential.token(),
    (error: GithubOAuthError) => error.needsReconnect,
  );
});

test("an unreadable expiry is treated as expired", async () => {
  const fetch = fakeFetch(() =>
    json({ access_token: "ghu_new", expires_in: 60, refresh_token: "ghr_new" }),
  );
  const credential = new UserCredential({
    ...credentials,
    tokens: source({ ...fresh, expiresAt: "whenever" }),
    fetch,
    now: () => NOW,
  });

  assert.equal(await credential.token(), "ghu_new");
});

test("a failed refresh reloads, in case another holder already refreshed", async () => {
  const tokens = source(stale);
  const fetch = fakeFetch(() => {
    // The other holder wins the race while this refresh is in flight.
    tokens.current = fresh;
    return json({ error: "bad_refresh_token" });
  });
  const credential = new UserCredential({
    ...credentials,
    tokens,
    fetch,
    now: () => NOW,
  });

  assert.equal(await credential.token(), "ghu_1");
});

test("a failed refresh with nothing better stored surfaces the refresh error", async () => {
  const tokens = source(stale);
  const credential = new UserCredential({
    ...credentials,
    tokens,
    fetch: fakeFetch(() => json({ error: "bad_refresh_token" })),
    now: () => NOW,
  });

  await assert.rejects(
    credential.token(),
    (error: GithubOAuthError) => error.code === "bad_refresh_token",
  );
});

test("a reload that itself fails still surfaces the refresh error", async () => {
  let loads = 0;
  const credential = new UserCredential({
    ...credentials,
    tokens: {
      load: () => {
        loads += 1;
        return loads === 1
          ? Promise.resolve(stale)
          : Promise.reject(new Error("database down"));
      },
      save: () => Promise.resolve(),
    },
    fetch: fakeFetch(() => json({ error: "bad_refresh_token" })),
    now: () => NOW,
  });

  await assert.rejects(
    credential.token(),
    (error: GithubOAuthError) => error.code === "bad_refresh_token",
  );
});
