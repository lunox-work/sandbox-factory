import assert from "node:assert/strict";
import { test } from "node:test";

import {
  GithubApiError,
  GithubAppAuthError,
  GithubInstallationUnavailable,
  GithubNetworkError,
  GithubNotFound,
  GithubRateLimited,
  InstallationTokens,
} from "../src/index.js";
import { fakeFetch, json, keys } from "./helpers.js";

const NOW = Date.parse("2026-10-01T00:00:00.000Z");
const HOUR = 60 * 60_000;

/** GitHub's mint endpoint, faked: a new token per call, valid for an hour. */
function mintEndpoint(clock: { now: number }) {
  let minted = 0;
  return fakeFetch(() => {
    minted += 1;
    return json(
      {
        token: `ghs_${minted}`,
        expires_at: new Date(clock.now + HOUR).toISOString(),
      },
      201,
    );
  });
}

function tokensWith(
  fetch: typeof globalThis.fetch,
  clock: { now: number } = { now: NOW },
) {
  return new InstallationTokens({
    appId: "123",
    privateKey: keys.privateKey,
    fetch,
    now: () => clock.now,
  });
}

test("a token is minted with the App's JWT and cached until near expiry", async () => {
  const clock = { now: NOW };
  const fetch = mintEndpoint(clock);
  const tokens = tokensWith(fetch, clock);

  assert.equal(await tokens.token("9"), "ghs_1");
  assert.equal(await tokens.token("9"), "ghs_1");
  assert.equal(fetch.calls.length, 1);

  const [call] = fetch.calls;
  assert.equal(call?.method, "POST");
  assert.equal(
    call?.url,
    "https://api.github.com/app/installations/9/access_tokens",
  );
  // The App's JWT, three segments: never an installation or user token.
  assert.match(
    call?.headers["authorization"] ?? "",
    /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/,
  );
  assert.equal(call?.headers["x-github-api-version"], "2022-11-28");

  // Fifty-six minutes in, the token has under five minutes left: re-minted
  // rather than handed out to fail mid-request.
  clock.now = NOW + 56 * 60_000;
  assert.equal(await tokens.token("9"), "ghs_2");
  assert.equal(fetch.calls.length, 2);
});

test("concurrent callers on a cold cache share one mint", async () => {
  const fetch = mintEndpoint({ now: NOW });
  const tokens = tokensWith(fetch);

  const all = await Promise.all(
    Array.from({ length: 10 }, () => tokens.token("9")),
  );

  assert.deepEqual(new Set(all), new Set(["ghs_1"]));
  assert.equal(fetch.calls.length, 1);
});

test("a narrowed token is minted and cached apart from the full one", async () => {
  const fetch = mintEndpoint({ now: NOW });
  const tokens = tokensWith(fetch);

  const full = await tokens.token("9");
  const narrowed = await tokens.token("9", {
    repositoryIds: [3, 1],
    permissions: { metadata: "read", contents: "read" },
  });
  // The same narrowing, asked in another order, is the same token.
  const again = await tokens.provider("9", {
    repositoryIds: [1, 3],
    permissions: { contents: "read", metadata: "read" },
  })();

  assert.notEqual(full, narrowed);
  assert.equal(again, narrowed);
  assert.equal(fetch.calls.length, 2);
  assert.deepEqual(fetch.calls[0]?.body, {});
  assert.deepEqual(fetch.calls[1]?.body, {
    repository_ids: [3, 1],
    permissions: { metadata: "read", contents: "read" },
  });
});

test("forget drops every cached token for that installation only", async () => {
  const fetch = mintEndpoint({ now: NOW });
  const tokens = tokensWith(fetch);
  await tokens.token("9");
  await tokens.token("9", { repositoryIds: [1] });
  await tokens.token("10");

  tokens.forget("9");
  await tokens.token("9");
  await tokens.token("9", { repositoryIds: [1] });
  await tokens.token("10");

  assert.equal(fetch.calls.length, 5);
});

test("a refused mint is GithubInstallationUnavailable, never GithubNotFound", async () => {
  // Uninstalled (404) or suspended (403): about the installation, not about
  // whatever the caller was reading.
  for (const status of [403, 404]) {
    let calls = 0;
    const tokens = tokensWith(
      fakeFetch(() => {
        calls += 1;
        return json({ message: "nope" }, status);
      }),
    );

    await assert.rejects(tokens.token("9"), (error: Error) => {
      assert.ok(error instanceof GithubInstallationUnavailable);
      assert.ok(!(error instanceof GithubNotFound));
      assert.equal((error as GithubInstallationUnavailable).status, status);
      return true;
    });
    // Not cached: the next call asks again.
    await assert.rejects(tokens.token("9"), GithubInstallationUnavailable);
    assert.equal(calls, 2);
  }
});

test("a 401 is the App's own credential refused, not the installation", async () => {
  // A deleted key, a wrong App id, a clock off by minutes: every
  // installation would answer the same, so none of them may be flagged.
  const tokens = tokensWith(fakeFetch(() => json({ message: "Bad JWT" }, 401)));

  await assert.rejects(tokens.token("9"), (error: Error) => {
    assert.ok(error instanceof GithubAppAuthError);
    assert.ok(!(error instanceof GithubInstallationUnavailable));
    assert.match(error.message, /GITHUB_APP_ID/);
    return true;
  });
});

test("a 403 that says rate limit only in its body is a rate limit", async () => {
  // GitHub's secondary limit may send neither retry-after nor a zero
  // remaining count. Read as a refusal, it would flag the connection.
  const tokens = tokensWith(
    fakeFetch(() =>
      json({ message: "You have exceeded a secondary rate limit." }, 403),
    ),
  );

  await assert.rejects(tokens.token("9"), GithubRateLimited);
});

test("a rate-limited or failing mint keeps its own type, so it is retried", async () => {
  const limited = tokensWith(
    fakeFetch(() => json({}, 403, { "x-ratelimit-remaining": "0" })),
  );
  const outage = tokensWith(fakeFetch(() => json({}, 502)));

  await assert.rejects(limited.token("9"), GithubRateLimited);
  await assert.rejects(outage.token("9"), (error: Error) => {
    return (
      error instanceof GithubApiError &&
      !(error instanceof GithubInstallationUnavailable)
    );
  });
});

test("a mint response of the wrong shape is an error, not a blank token", async () => {
  const tokens = tokensWith(
    fakeFetch(() => json({ token: "ghs_1", expires_at: "soon" }, 201)),
  );

  await assert.rejects(tokens.token("9"), GithubApiError);
});

test("a mint already in flight when forget is called is not cached", async () => {
  // new_permissions_accepted arrives while a mint is on the wire: the token
  // it returns carries the old permissions and must not be kept.
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let minted = 0;
  const fetch = fakeFetch(async () => {
    minted += 1;
    const n = minted;
    if (n === 1) await gate;
    return json(
      { token: `ghs_${n}`, expires_at: new Date(NOW + HOUR).toISOString() },
      201,
    );
  });
  const tokens = tokensWith(fetch);

  const early = tokens.token("9");
  tokens.forget("9");
  // A caller after forget starts its own mint rather than joining the old.
  const late = tokens.token("9");
  release();

  assert.equal(await early, "ghs_1");
  assert.equal(await late, "ghs_2");
  assert.equal(await tokens.token("9"), "ghs_2");
  assert.equal(fetch.calls.length, 2);
});

test("a token is not kept past an hour of our own clock", async () => {
  // A clock here running slow makes GitHub's expires_at look further off
  // than it is; an hour from when we asked is the bound we can trust.
  const clock = { now: NOW };
  let minted = 0;
  const fetch = fakeFetch(() => {
    minted += 1;
    return json(
      {
        token: `ghs_${minted}`,
        expires_at: new Date(clock.now + 2 * HOUR).toISOString(),
      },
      201,
    );
  });
  const tokens = tokensWith(fetch, clock);

  assert.equal(await tokens.token("9"), "ghs_1");
  clock.now = NOW + 56 * 60_000;

  assert.equal(await tokens.token("9"), "ghs_2");
});

test("a still-valid token stands in when a re-mint fails for GitHub's reasons", async () => {
  const clock = { now: NOW };
  let fail: Response | undefined;
  let minted = 0;
  const fetch = fakeFetch(() => {
    if (fail !== undefined) return fail;
    minted += 1;
    return json(
      {
        token: `ghs_${minted}`,
        expires_at: new Date(clock.now + HOUR).toISOString(),
      },
      201,
    );
  });
  const tokens = tokensWith(fetch, clock);
  await tokens.token("9");
  // Inside the five-minute refresh window, with three minutes of life left.
  clock.now = NOW + 57 * 60_000;

  fail = json({}, 502);
  assert.equal(await tokens.token("9"), "ghs_1");
  fail = json({}, 429, { "retry-after": "30" });
  assert.equal(await tokens.token("9"), "ghs_1");

  // An uninstall is not GitHub having a bad minute: it must surface.
  fail = json({}, 404);
  await assert.rejects(tokens.token("9"), GithubInstallationUnavailable);

  // Nor does a token with under a minute left stand in.
  fail = json({}, 502);
  clock.now = NOW + HOUR - 30_000;
  await assert.rejects(tokens.token("9"), GithubApiError);
});

test("a mint GitHub never answers is a network error, and is bounded", async () => {
  const fetch = fakeFetch(() => {
    throw new TypeError("fetch failed");
  });
  const tokens = tokensWith(fetch);

  await assert.rejects(tokens.token("9"), GithubNetworkError);
  assert.ok(fetch.calls[0]?.signal instanceof AbortSignal);
});

test("a probe reads the installation with the App's JWT", async () => {
  const fetch = fakeFetch((request) =>
    request.url.endsWith("/app/installations/9")
      ? json({ id: 9, suspended_at: "2026-09-30T12:00:00Z" })
      : json({}, 404),
  );
  const tokens = tokensWith(fetch);

  assert.deepEqual(await tokens.probe("9"), {
    suspendedAt: "2026-09-30T12:00:00Z",
  });
  assert.equal(fetch.calls[0]?.method, "GET");
  assert.match(
    fetch.calls[0]?.headers["authorization"] ?? "",
    /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/,
  );
  // Uninstalled is an answer, not an error.
  assert.equal(await tokens.probe("10"), null);
});

test("a probe of a live installation reports it unsuspended", async () => {
  const tokens = tokensWith(fakeFetch(() => json({ id: 9 })));

  assert.deepEqual(await tokens.probe("9"), { suspendedAt: null });
});

test("a probe refused with 401 is the App's credential, other failures keep their type", async () => {
  await assert.rejects(
    tokensWith(fakeFetch(() => json({}, 401))).probe("9"),
    GithubAppAuthError,
  );
  await assert.rejects(
    tokensWith(
      fakeFetch(() => json({}, 403, { "x-ratelimit-remaining": "0" })),
    ).probe("9"),
    GithubRateLimited,
  );
  await assert.rejects(
    tokensWith(fakeFetch(() => json({ id: "nine" }))).probe("9"),
    /unexpected shape/,
  );
});

test("an enterprise API host is honoured", async () => {
  const fetch = mintEndpoint({ now: NOW });
  const tokens = new InstallationTokens({
    appId: "123",
    privateKey: keys.privateKey,
    fetch,
    now: () => NOW,
    apiUrl: "https://ghe.example.test/api/v3",
  });

  await tokens.token("9");

  assert.equal(
    fetch.calls[0]?.url,
    "https://ghe.example.test/api/v3/app/installations/9/access_tokens",
  );
});
