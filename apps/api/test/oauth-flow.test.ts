import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";

import type { OrganizationStore } from "@sandbox-factory/db";
import { memoryAdapter } from "better-auth/adapters/memory";
import {
  OAUTH_ACCESS_TOKEN_PREFIX,
  OAUTH_REFRESH_TOKEN_PREFIX,
} from "sandbox-factory";

import { createAuth, type AuthOptions } from "../src/auth.js";
import { createApp } from "../src/routes.js";
import {
  hashOAuthToken,
  ORGANIZATION_HEADER,
  oauthResources,
} from "../src/oauth/provider.js";
import { ORG, OTHER_ORG, roleStore } from "./token-fakes.js";

/**
 * The authorization server end to end, through Better Auth's real plugin
 * over its in-memory adapter: an MCP client registers itself, a signed-in
 * owner consents for one workspace, the client trades the code (with its
 * PKCE verifier) for tokens and refreshes them. What the API's guard later
 * reads, the stored token rows, is checked here; `oauth.test.ts` covers
 * the guard. No database, no network.
 */

const BASE = "http://localhost:4000";
const APP = "http://localhost:5173";
const REDIRECT = "http://127.0.0.1:33418/callback";
const MCP_RESOURCE = `${BASE}/mcp`;

type Row = Record<string, unknown>;

function setup() {
  const tables: Record<string, Row[]> = Object.fromEntries(
    [
      "user",
      "session",
      "account",
      "verification",
      "organization",
      "member",
      "invitation",
      "deviceCode",
      "oauthClient",
      "oauthResource",
      "oauthClientResource",
      "oauthRefreshToken",
      "oauthAccessToken",
      "oauthConsent",
      "oauthClientAssertion",
    ].map((model) => [model, []]),
  );
  const roles: Record<string, string> = {};
  const organizations: OrganizationStore = roleStore(roles);
  const auth = createAuth({
    db: {} as AuthOptions["db"],
    database: memoryAdapter(tables),
    organizations,
    baseUrl: BASE,
    appUrl: APP,
    trustedOrigins: [APP],
    secret: "0123456789abcdef0123456789abcdef",
    google: { clientId: "g", clientSecret: "g" },
    github: { clientId: "h", clientSecret: "h" },
    atlassian: { clientId: "a", clientSecret: "a" },
  });

  const call = (path: string, init: RequestInit = {}) =>
    auth.handler(new Request(`${BASE}/api/auth${path}`, init));

  /** A person with a live session, as a provider sign-in would leave them. */
  function signIn(role: string | undefined) {
    const userId = `user_${randomBytes(6).toString("hex")}`;
    const now = new Date();
    tables["user"]?.push({
      id: userId,
      email: `${userId}@example.test`,
      name: "Ada Lovelace",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    const token = randomBytes(16).toString("hex");
    tables["session"]?.push({
      id: `session_${userId}`,
      token,
      userId,
      expiresAt: new Date(now.getTime() + 3_600_000),
      createdAt: now,
      updatedAt: now,
    });
    if (role !== undefined) roles[`${userId}:${ORG}`] = role;
    return { userId, bearer: `Bearer ${token}` };
  }

  async function register(): Promise<string> {
    const res = await call("/oauth2/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Claude Code",
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    });
    assert.equal(res.status, 201, await res.clone().text());
    return ((await res.json()) as { client_id: string }).client_id;
  }

  /** Authorizes as `bearer`, answering the signed query the consent page gets. */
  async function authorize(
    clientId: string,
    bearer: string,
    challenge: string,
    scope = "workspace:read offline_access",
  ): Promise<URL> {
    const query = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      scope,
      state: "state-1",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: MCP_RESOURCE,
    });
    const res = await call(`/oauth2/authorize?${query.toString()}`, {
      headers: { authorization: bearer },
      redirect: "manual",
    });
    const location = res.headers.get("location");
    assert.ok(location !== null, `expected a redirect, got ${res.status}`);
    return new URL(location, BASE);
  }

  function consent(
    bearer: string,
    oauthQuery: string,
    organization: string | undefined,
    scope?: string,
  ) {
    return call("/oauth2/consent", {
      method: "POST",
      headers: {
        authorization: bearer,
        "content-type": "application/json",
        origin: APP,
        ...(organization === undefined
          ? {}
          : { [ORGANIZATION_HEADER]: organization }),
      },
      body: JSON.stringify({
        accept: true,
        oauth_query: oauthQuery,
        ...(scope === undefined ? {} : { scope }),
      }),
    });
  }

  function token(body: Record<string, string>) {
    return call("/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    });
  }

  return { auth, tables, roles, signIn, register, authorize, consent, token };
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

test("an MCP client registers, an owner consents for one workspace, and the tokens carry it", async () => {
  const { tables, signIn, register, authorize, consent, token } = setup();
  const { userId, bearer } = signIn("owner");
  const clientId = await register();
  const { verifier, challenge } = pkce();

  // Signed in, no consent yet: the consent page, with a signed query.
  const page = await authorize(clientId, bearer, challenge);
  assert.equal(`${page.origin}${page.pathname}`, `${APP}/oauth/consent`);
  assert.equal(page.searchParams.get("client_id"), clientId);
  assert.ok(page.searchParams.get("sig"));

  const consented = await consent(bearer, page.search.slice(1), ORG);
  assert.equal(consented.status, 200, await consented.clone().text());
  const redirect = new URL(((await consented.json()) as { url: string }).url);
  assert.equal(`${redirect.origin}${redirect.pathname}`, REDIRECT);
  assert.equal(redirect.searchParams.get("state"), "state-1");
  const code = redirect.searchParams.get("code");
  assert.ok(code);

  const issued = await token({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    client_id: clientId,
    code_verifier: verifier,
    resource: MCP_RESOURCE,
  });
  assert.equal(issued.status, 200, await issued.clone().text());
  const tokens = (await issued.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    scope: string;
  };
  assert.ok(tokens.access_token.startsWith(OAUTH_ACCESS_TOKEN_PREFIX));
  assert.ok(tokens.refresh_token.startsWith(OAUTH_REFRESH_TOKEN_PREFIX));
  assert.equal(tokens.expires_in, 15 * 60);

  // The grant and the token, as the API's guard will read them.
  const [grant] = tables["oauthConsent"] ?? [];
  assert.equal(grant?.["referenceId"], ORG);
  assert.equal(grant?.["userId"], userId);
  assert.deepEqual(grant?.["scopes"], ["workspace:read", "offline_access"]);
  const stored = (tables["oauthAccessToken"] ?? []).find(
    (row) =>
      row["token"] ===
      hashOAuthToken(
        tokens.access_token.slice(OAUTH_ACCESS_TOKEN_PREFIX.length),
      ),
  );
  assert.equal(stored?.["referenceId"], ORG);
  assert.equal(stored?.["clientId"], clientId);

  // A refresh keeps the workspace.
  const refreshed = await token({
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
    client_id: clientId,
  });
  assert.equal(refreshed.status, 200, await refreshed.clone().text());
  const next = (await refreshed.json()) as { access_token: string };
  const again = (tables["oauthAccessToken"] ?? []).find(
    (row) =>
      row["token"] ===
      hashOAuthToken(next.access_token.slice(OAUTH_ACCESS_TOKEN_PREFIX.length)),
  );
  assert.equal(again?.["referenceId"], ORG);
});

test("a code is refused without the PKCE verifier", async () => {
  const { signIn, register, authorize, consent, token } = setup();
  const { bearer } = signIn("admin");
  const clientId = await register();
  const { challenge } = pkce();
  const page = await authorize(clientId, bearer, challenge);
  const consented = await consent(bearer, page.search.slice(1), ORG);
  const code = new URL(
    ((await consented.json()) as { url: string }).url,
  ).searchParams.get("code");
  const issued = await token({
    grant_type: "authorization_code",
    code: code ?? "",
    redirect_uri: REDIRECT,
    client_id: clientId,
    code_verifier: pkce().verifier,
  });
  assert.equal(issued.status, 400);
});

test("consent names a workspace, which the person must own or administer", async () => {
  const { tables, signIn, register, authorize, consent } = setup();
  const clientId = await register();

  const member = signIn("member");
  let page = await authorize(clientId, member.bearer, pkce().challenge);
  const codeOf = async (res: Response) => {
    assert.equal(res.status, 403);
    return ((await res.json()) as { code?: string }).code;
  };
  assert.equal(
    await codeOf(await consent(member.bearer, page.search.slice(1), ORG)),
    "WORKSPACE_FORBIDDEN",
  );

  const owner = signIn("owner");
  page = await authorize(clientId, owner.bearer, pkce().challenge);
  assert.equal(
    await codeOf(await consent(owner.bearer, page.search.slice(1), undefined)),
    "WORKSPACE_REQUIRED",
  );
  // One they are not in.
  assert.equal(
    await codeOf(await consent(owner.bearer, page.search.slice(1), OTHER_ORG)),
    "WORKSPACE_FORBIDDEN",
  );
  assert.deepEqual(tables["oauthConsent"], []);
});

test("a person may grant fewer scopes than asked, never more", async () => {
  const { tables, signIn, register, authorize, consent } = setup();
  const { bearer } = signIn("owner");
  const clientId = await register();
  const page = await authorize(
    clientId,
    bearer,
    pkce().challenge,
    "workspace:read bounties:write offline_access",
  );
  const widened = await consent(
    bearer,
    page.search.slice(1),
    ORG,
    "workspace:read webhooks:write",
  );
  assert.equal(widened.status, 400);
  const narrowed = await consent(
    bearer,
    page.search.slice(1),
    ORG,
    "workspace:read offline_access",
  );
  assert.equal(narrowed.status, 200);
  assert.deepEqual(tables["oauthConsent"]?.[0]?.["scopes"], [
    "workspace:read",
    "offline_access",
  ]);
});

test("a plain S256-less request is refused before any consent", async () => {
  const { auth, signIn, register } = setup();
  const { bearer } = signIn("owner");
  const clientId = await register();
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope: "workspace:read",
    state: "s",
    code_challenge: "plain-challenge",
    code_challenge_method: "plain",
  });
  const res = await auth.handler(
    new Request(`${BASE}/api/auth/oauth2/authorize?${query.toString()}`, {
      headers: { authorization: bearer },
      redirect: "manual",
    }),
  );
  const location = new URL(res.headers.get("location") ?? "", BASE);
  assert.equal(location.searchParams.get("error"), "invalid_request");
  assert.equal(`${location.origin}${location.pathname}`, REDIRECT);
});

test("clients cannot be created or changed from a session", async () => {
  const { auth, signIn } = setup();
  const { bearer } = signIn("owner");
  const res = await auth.handler(
    new Request(`${BASE}/api/auth/oauth2/create-client`, {
      method: "POST",
      headers: {
        authorization: bearer,
        "content-type": "application/json",
        origin: APP,
      },
      body: JSON.stringify({ redirect_uris: [REDIRECT] }),
    }),
  );
  assert.ok(res.status === 401 || res.status === 403, String(res.status));
});

test("the resources are the API's origin and each MCP endpoint", () => {
  assert.deepEqual(oauthResources("https://platform.lunox.work/ignored"), [
    "https://platform.lunox.work",
    "https://platform.lunox.work/mcp",
    "https://platform.lunox.work/mcp/duediligence",
    "https://platform.lunox.work/mcp/carveout",
  ]);
});

test("the authorization server describes itself at both well-known paths", async () => {
  const { auth } = setup();
  const app = createApp({ corsOrigins: [APP], auth, publicUrl: BASE });
  for (const path of [
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-authorization-server/api/auth",
  ]) {
    const res = await app.request(path);
    assert.equal(res.status, 200, path);
    const metadata = (await res.json()) as Record<string, unknown>;
    assert.equal(metadata["issuer"], `${BASE}/api/auth`);
    assert.equal(
      metadata["authorization_endpoint"],
      `${BASE}/api/auth/oauth2/authorize`,
    );
    assert.equal(metadata["token_endpoint"], `${BASE}/api/auth/oauth2/token`);
    assert.equal(
      metadata["registration_endpoint"],
      `${BASE}/api/auth/oauth2/register`,
    );
    assert.deepEqual(metadata["code_challenge_methods_supported"], ["S256"]);
    assert.deepEqual(metadata["grant_types_supported"], [
      "authorization_code",
      "refresh_token",
    ]);
    const scopes = metadata["scopes_supported"] as string[];
    assert.ok(scopes.includes("workspace:read"));
    assert.ok(scopes.includes("offline_access"));
    assert.equal(scopes.includes("openid"), false);
    assert.ok(
      (metadata["token_endpoint_auth_methods_supported"] as string[]).includes(
        "none",
      ),
    );
  }
  // An OAuth server, not an identity provider.
  assert.equal(
    (await app.request("/.well-known/openid-configuration")).status,
    404,
  );
});
