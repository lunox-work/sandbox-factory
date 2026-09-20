import assert from "node:assert/strict";
import { test } from "node:test";

import {
  accessibleSites,
  authorizeUrl,
  exchangeCode,
  JiraAuthError,
  READ_SCOPES,
  refreshTokens,
} from "../src/index.js";

interface StubResponse {
  status?: number;
  body?: unknown;
  /** A raw body, for the non-JSON cases. Takes precedence over `body`. */
  text?: string;
}

/** A fetch stub returning one canned response, recording what it was sent. */
function stubFetch(response: StubResponse): {
  fetch: typeof globalThis.fetch;
  calls: { url: string; init: RequestInit | undefined }[];
} {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const body =
      response.text ??
      (response.body === undefined ? "" : JSON.stringify(response.body));
    return new Response(body, { status: response.status ?? 200 });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const tokenBody = {
  access_token: "access-1",
  refresh_token: "refresh-1",
  expires_in: 3600,
  scope: "read:jira-work offline_access",
};

test("authorizeUrl carries the audience, scopes and state", () => {
  const url = new URL(
    authorizeUrl({
      clientId: "client-1",
      redirectUri: "https://api.test/api/v1/jira/callback",
      state: "state-1",
    }),
  );

  assert.equal(url.origin, "https://auth.atlassian.com");
  assert.equal(url.pathname, "/authorize");
  // The literal audience for every Cloud REST API; a wrong one fails at consent.
  assert.equal(url.searchParams.get("audience"), "api.atlassian.com");
  assert.equal(url.searchParams.get("client_id"), "client-1");
  assert.equal(url.searchParams.get("state"), "state-1");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("scope"), READ_SCOPES.join(" "));
});

test("authorizeUrl forces consent by default, so a refresh token is issued", () => {
  const withPrompt = new URL(
    authorizeUrl({
      clientId: "c",
      redirectUri: "https://api.test/cb",
      state: "s",
    }),
  );
  assert.equal(withPrompt.searchParams.get("prompt"), "consent");

  const without = new URL(
    authorizeUrl({
      clientId: "c",
      redirectUri: "https://api.test/cb",
      state: "s",
      prompt: false,
    }),
  );
  assert.equal(without.searchParams.get("prompt"), null);
});

test("READ_SCOPES requests offline_access and the agile board scopes", () => {
  // Without offline_access there is no refresh token and the connection dies
  // after an hour; without the board scopes the agile endpoints 404.
  assert.ok(READ_SCOPES.includes("offline_access"));
  assert.ok(READ_SCOPES.includes("read:board-scope:jira-software"));
  assert.ok(READ_SCOPES.includes("read:sprint:jira-software"));
});

test("READ_SCOPES asks for nothing that can write", () => {
  // The security posture of the whole feature: a leaked token cannot mutate.
  for (const scope of READ_SCOPES) {
    assert.ok(
      !scope.startsWith("write:") && !scope.startsWith("manage:"),
      `${scope} is not a read scope`,
    );
  }
});

test("exchangeCode resolves expires_in to an absolute instant", async () => {
  const { fetch, calls } = stubFetch({ body: tokenBody });

  const tokens = await exchangeCode({
    clientId: "client-1",
    clientSecret: "secret-1",
    redirectUri: "https://api.test/cb",
    code: "code-1",
    fetch,
    now: () => Date.parse("2026-09-18T00:00:00.000Z"),
  });

  assert.equal(tokens.accessToken, "access-1");
  assert.equal(tokens.refreshToken, "refresh-1");
  assert.equal(tokens.expiresAt, "2026-09-18T01:00:00.000Z");
  assert.deepEqual(tokens.scopes, ["read:jira-work", "offline_access"]);
  const body = JSON.parse(String(calls[0]?.init?.body)) as Record<
    string,
    string
  >;
  assert.equal(body["grant_type"], "authorization_code");
  assert.equal(body["code"], "code-1");
  assert.equal(body["redirect_uri"], "https://api.test/cb");
});

test("refreshTokens sends the refresh grant", async () => {
  const { fetch, calls } = stubFetch({
    body: {
      ...tokenBody,
      access_token: "access-2",
      refresh_token: "refresh-2",
    },
  });

  const tokens = await refreshTokens({
    clientId: "client-1",
    clientSecret: "secret-1",
    refreshToken: "refresh-1",
    fetch,
    now: () => 0,
  });

  // The new refresh token must come back: Atlassian rotates on every refresh
  // and the old one is now dead.
  assert.equal(tokens.refreshToken, "refresh-2");
  const body = JSON.parse(String(calls[0]?.init?.body)) as Record<
    string,
    string
  >;
  assert.equal(body["grant_type"], "refresh_token");
  assert.equal(body["refresh_token"], "refresh-1");
});

test("a grant without offline_access yields no refresh token", async () => {
  const { fetch } = stubFetch({
    body: { access_token: "a", expires_in: 3600 },
  });

  const tokens = await exchangeCode({
    clientId: "c",
    clientSecret: "s",
    redirectUri: "https://api.test/cb",
    code: "code",
    fetch,
    now: () => 0,
  });

  assert.equal(tokens.refreshToken, undefined);
  assert.deepEqual(tokens.scopes, []);
});

test("invalid_grant is reported as needing a reconnect", async () => {
  const { fetch } = stubFetch({
    status: 400,
    body: { error: "invalid_grant", error_description: "Refresh token spent." },
  });

  const error = await refreshTokens({
    clientId: "c",
    clientSecret: "s",
    refreshToken: "dead",
    fetch,
  }).catch((caught: unknown) => caught);

  assert.ok(error instanceof JiraAuthError);
  assert.equal(error.code, "invalid_grant");
  assert.equal(error.message, "Refresh token spent.");
  // The signal the API uses to flag the connection rather than retry.
  assert.equal(error.needsReconnect, true);
});

test("a 401 needs a reconnect even without an error code", async () => {
  const { fetch } = stubFetch({ status: 401, body: {} });

  const error = await refreshTokens({
    clientId: "c",
    clientSecret: "s",
    refreshToken: "r",
    fetch,
  }).catch((caught: unknown) => caught);

  assert.ok(error instanceof JiraAuthError);
  assert.equal(error.needsReconnect, true);
});

test("a non-JSON token response fails with the body in the message", async () => {
  const { fetch } = stubFetch({ status: 502, text: "<html>gateway</html>" });

  const error = await exchangeCode({
    clientId: "c",
    clientSecret: "s",
    redirectUri: "https://api.test/cb",
    code: "code",
    fetch,
  }).catch((caught: unknown) => caught);

  assert.ok(error instanceof JiraAuthError);
  assert.match(error.message, /gateway/);
});

test("a token response of the wrong shape is refused", async () => {
  const { fetch } = stubFetch({ body: { nonsense: true } });

  const error = await exchangeCode({
    clientId: "c",
    clientSecret: "s",
    redirectUri: "https://api.test/cb",
    code: "code",
    fetch,
  }).catch((caught: unknown) => caught);

  assert.ok(error instanceof JiraAuthError);
  assert.match(error.message, /unexpected shape/);
});

test("a failed token call with no body still reports its status", async () => {
  const { fetch } = stubFetch({ status: 500, text: "" });

  const error = await refreshTokens({
    clientId: "c",
    clientSecret: "s",
    refreshToken: "r",
    fetch,
  }).catch((caught: unknown) => caught);

  assert.ok(error instanceof JiraAuthError);
  assert.match(error.message, /HTTP 500/);
});

test("accessibleSites maps id to cloudId and keeps only Jira sites", async () => {
  const { fetch, calls } = stubFetch({
    body: [
      {
        id: "cloud-1",
        url: "https://acme.atlassian.net",
        name: "Acme",
        avatarUrl: "https://cdn.test/a.png",
        scopes: ["read:jira-work"],
      },
      {
        // Confluence-only: offering it as a board source produces 404s.
        id: "cloud-2",
        url: "https://acme-wiki.atlassian.net",
        name: "Acme Wiki",
        scopes: ["read:confluence-content.all"],
      },
    ],
  });

  const sites = await accessibleSites({ accessToken: "access-1", fetch });

  assert.equal(sites.length, 1);
  assert.equal(sites[0]?.cloudId, "cloud-1");
  assert.equal(sites[0]?.name, "Acme");
  assert.equal(
    calls[0]?.url,
    "https://api.atlassian.com/oauth/token/accessible-resources",
  );
});

test("accessibleSites fails loudly when the token is refused", async () => {
  const { fetch } = stubFetch({ status: 401, body: {} });

  await assert.rejects(
    accessibleSites({ accessToken: "dead", fetch }),
    JiraAuthError,
  );
});

test("accessibleSites refuses an unexpected shape", async () => {
  const { fetch } = stubFetch({ body: { not: "an array" } });

  await assert.rejects(
    accessibleSites({ accessToken: "a", fetch }),
    /unexpected shape/,
  );
});
