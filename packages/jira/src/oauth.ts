/**
 * Atlassian OAuth 2.0 (3LO) — the authorization-code flow, plus refresh.
 *
 * This is the "SaaS" credential mechanic: the user consents once in a browser,
 * we exchange the code for an access/refresh pair, and every later call spends
 * the access token. Nothing here touches storage — `TokenSource` in
 * `credentials.ts` decides where the pair lives and when it is refreshed, so
 * the same flow serves the API (tokens in Postgres) and the MCP server (tokens
 * in the session).
 *
 * Three details are easy to get wrong and are handled here:
 *
 * - **`offline_access` is mandatory for a refresh token.** Atlassian issues one
 *   only when the scope is requested, and silently omits it otherwise, so the
 *   integration works for an hour and then breaks. `authorizeUrl` always sends
 *   it; `READ_SCOPES` includes it.
 * - **Refresh tokens rotate.** Every refresh returns a *new* refresh token and
 *   invalidates the old one. `refreshTokens` returns it and callers must
 *   persist it, or the next refresh fails with `invalid_grant`.
 * - **`audience` and `prompt=consent` are required on the authorize URL.**
 *   Without the audience the consent screen errors; without `prompt=consent`
 *   a returning user is sent back with no refresh token.
 */

import {
  accessibleResourceSchema,
  type JiraSiteDto,
  tokenResponseSchema,
} from "@sandbox-factory/shared";

/** Atlassian's authorization server. Not the API host. */
const AUTH_HOST = "https://auth.atlassian.com";

/**
 * The read-only scope set this integration asks for.
 *
 * Deliberately read-only: the whole feature is "read the tasks on their board",
 * and a token that cannot write cannot be turned into one that can. Adding a
 * `write:` scope here is a security decision — it changes what a leaked token
 * can do — and needs the consent screen to say so.
 *
 * **The Agile API needs granular scopes, and needs all of them.** Each
 * `/rest/agile/1.0` endpoint declares its own pair, and a token missing any
 * one of them is refused outright — not degraded. Taken from Atlassian's
 * OpenAPI description, which is the only place these are stated completely:
 *
 * | Call                    | Scopes                                              |
 * | ----------------------- | --------------------------------------------------- |
 * | `GET /board`            | `read:board-scope:jira-software`, `read:project:jira` |
 * | `GET /board/{id}/backlog` | `read:board-scope:jira-software`, `read:issue-details:jira` |
 * | `GET /board/{id}/issue` | `read:board-scope:jira-software`, `read:issue-details:jira` |
 * | `GET /board/{id}/sprint` | `read:sprint:jira-software`                        |
 *
 * `read:project:jira` and `read:issue-details:jira` are easy to leave out,
 * because the classic `read:jira-work` looks like it covers the same ground
 * and does for the platform API. It does not satisfy the Agile endpoints,
 * which answer **401 `Unauthorized; scope does not match`** instead — a status
 * that reads as a dead credential rather than a missing permission. The
 * classic pair is kept for the platform calls (`/rest/api/3/*`) that `search`
 * and `issue` make.
 *
 * `offline_access` is what makes a refresh token appear at all; see above.
 *
 * A scope added here must also be enabled on the Atlassian app itself:
 * requesting one the app was never permitted produces the same 401, and no
 * amount of re-consenting changes it.
 */
export const READ_SCOPES: readonly string[] = [
  "read:jira-work",
  "read:jira-user",
  "read:board-scope:jira-software",
  "read:sprint:jira-software",
  "read:project:jira",
  "read:issue-details:jira",
  "offline_access",
];

export interface AuthorizeUrlOptions {
  clientId: string;
  /** Must match a callback registered on the Atlassian app, exactly. */
  redirectUri: string;
  /** CSRF token. The caller stores it and compares it on the callback. */
  state: string;
  /** Defaults to `READ_SCOPES`. */
  scopes?: readonly string[];
  /**
   * Whether to force the consent screen. Default true, and changing it is
   * rarely right: Atlassian returns no refresh token to a user who has already
   * consented unless it is set, so the connection silently expires in an hour.
   */
  prompt?: boolean;
}

/**
 * The URL to send the user to. The caller redirects; the browser comes back to
 * `redirectUri` with `code` and `state`.
 */
export function authorizeUrl({
  clientId,
  redirectUri,
  state,
  scopes = READ_SCOPES,
  prompt = true,
}: AuthorizeUrlOptions): string {
  const url = new URL("/authorize", AUTH_HOST);
  // `api.atlassian.com` is the literal audience value for all Cloud REST APIs,
  // not a placeholder for the user's site.
  url.searchParams.set("audience", "api.atlassian.com");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");
  if (prompt) {
    url.searchParams.set("prompt", "consent");
  }
  return url.toString();
}

/** An access/refresh pair, with the expiry resolved to an absolute time. */
export interface TokenPair {
  readonly accessToken: string;
  /**
   * Absent when the grant had no `offline_access`, which means the connection
   * dies at `expiresAt` with no way to renew it.
   */
  readonly refreshToken: string | undefined;
  /** Absolute expiry, as an ISO string. Derived from `expires_in` on receipt. */
  readonly expiresAt: string;
  readonly scopes: readonly string[];
}

/** A failed call to Atlassian's token or API endpoints. */
export class JiraAuthError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Atlassian's `error` field, e.g. `invalid_grant`, when it sent one. */
    readonly code?: string | undefined,
  ) {
    super(message);
    this.name = "JiraAuthError";
  }

  /**
   * The refresh token is spent, revoked or rotated past. The only cure is a
   * fresh consent, so callers surface "reconnect Jira" rather than retrying.
   */
  get needsReconnect(): boolean {
    return this.code === "invalid_grant" || this.status === 401;
  }
}

export interface ExchangeOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** The `code` query parameter from the callback. */
  code: string;
  fetch?: typeof globalThis.fetch;
  /** Injectable for tests; defaults to `Date.now`. */
  now?: () => number;
}

/** Exchanges an authorization code for the first token pair. */
export async function exchangeCode({
  clientId,
  clientSecret,
  redirectUri,
  code,
  fetch: fetchImpl,
  now,
}: ExchangeOptions): Promise<TokenPair> {
  return requestToken(
    {
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    },
    fetchImpl,
    now,
  );
}

export interface RefreshOptions {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

/**
 * Trades a refresh token for a new pair.
 *
 * The returned `refreshToken` is a **new** one and the passed-in token is now
 * invalid — Atlassian rotates on every refresh. Persist the result before
 * making the next call, or a crash in between strands the connection.
 */
export async function refreshTokens({
  clientId,
  clientSecret,
  refreshToken,
  fetch: fetchImpl,
  now,
}: RefreshOptions): Promise<TokenPair> {
  return requestToken(
    {
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    },
    fetchImpl,
    now,
  );
}

/** Shared POST to `/oauth/token`, which both grants use with different bodies. */
async function requestToken(
  body: Record<string, string>,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  now: () => number = Date.now,
): Promise<TokenPair> {
  const response = await fetchImpl(`${AUTH_HOST}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let payload: unknown = undefined;
  if (text !== "") {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new JiraAuthError(
        response.status,
        `Expected JSON from the Atlassian token endpoint, got: ${text.slice(0, 200)}`,
      );
    }
  }

  if (!response.ok) {
    // Atlassian reports failures as `{ error, error_description }`. Read them
    // defensively: an edge proxy can answer with a different shape.
    const error = payload as
      { error?: unknown; error_description?: unknown } | undefined;
    const code = typeof error?.error === "string" ? error.error : undefined;
    const description =
      typeof error?.error_description === "string"
        ? error.error_description
        : `HTTP ${response.status} from the Atlassian token endpoint.`;
    throw new JiraAuthError(response.status, description, code);
  }

  const parsed = tokenResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new JiraAuthError(
      response.status,
      "The Atlassian token endpoint returned an unexpected shape.",
    );
  }

  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token,
    // Resolved to an absolute instant here, once, so nothing downstream has to
    // remember when the response arrived.
    expiresAt: new Date(now() + parsed.data.expires_in * 1000).toISOString(),
    scopes: parsed.data.scope === undefined ? [] : parsed.data.scope.split(" "),
  };
}

export interface AccessibleSitesOptions {
  accessToken: string;
  fetch?: typeof globalThis.fetch;
}

/**
 * The Jira sites this token can reach, with the `cloudId` every REST call needs.
 *
 * There is no way to derive a cloudId from the token itself, and a token is
 * valid for however many sites the user consented to, so this call is not
 * optional — it is how a URL gets built at all. An empty list means the token
 * is fine but the user granted no Jira site; `sites.ts` explains the causes.
 */
export async function accessibleSites({
  accessToken,
  fetch: fetchImpl = globalThis.fetch,
}: AccessibleSitesOptions): Promise<JiraSiteDto[]> {
  const response = await fetchImpl(
    "https://api.atlassian.com/oauth/token/accessible-resources",
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    },
  );

  if (!response.ok) {
    throw new JiraAuthError(
      response.status,
      `Could not list Atlassian sites (HTTP ${response.status}).`,
    );
  }

  const payload: unknown = await response.json();
  const parsed = accessibleResourceSchema.array().safeParse(payload);
  if (!parsed.success) {
    throw new JiraAuthError(
      response.status,
      "Atlassian returned an unexpected shape for accessible resources.",
    );
  }

  // Keep only Jira. A token scoped for Confluence too lists those sites here,
  // and offering one as a board source produces 404s on every later call.
  return parsed.data
    .filter((site) => site.scopes.some((scope) => scope.includes(":jira")))
    .map((site) => ({
      cloudId: site.id,
      url: site.url,
      name: site.name,
      avatarUrl: site.avatarUrl,
    }));
}
