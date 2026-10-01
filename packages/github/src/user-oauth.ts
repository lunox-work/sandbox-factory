/**
 * The App's user-to-server half: a person authorizes the App, and we hold a
 * token that acts as them, within what the App may do.
 *
 * Used for one thing in this phase: **proving which installations a person
 * can see** before one is linked to their organization. The callback's
 * `installation_id` is a small integer anyone can type, so it is only ever
 * linked when it appears in `GET /user/installations` for this token. Nothing
 * unattended depends on a user token; installation tokens do that work.
 *
 * Not the sign-in OAuth app. That one is Better Auth's, asks for
 * `read:user user:email`, and says who someone is. This one is the GitHub
 * App's own client id and secret, and a GitHub App ignores scopes entirely:
 * what the token can do is the App's permissions intersected with the user's.
 *
 * With "Expire user authorization tokens" on (as registered; see
 * docs/github-apps.md) the access token lasts eight hours and comes with a
 * refresh token that **rotates**: each refresh returns a new one and spends
 * the old. `UserCredential` persists the new pair before using it, exactly as
 * the Jira credential does.
 */

import { githubOAuthTokenResponseSchema } from "@sandbox-factory/shared";

import { GithubNetworkError, GithubOAuthError } from "./errors.js";
import { readJson, request } from "./http.js";

/** GitHub's web host, where authorization happens. Not the API host. */
const WEB_HOST = "https://github.com";

export interface AuthorizeUrlOptions {
  clientId: string;
  /** CSRF token; see `apps/api/src/connect-state.ts`. */
  state: string;
  /**
   * Must be one of the callback URLs registered on the App. Sent explicitly
   * so an App with several (production and local) returns to the right one.
   */
  redirectUri: string;
}

/**
 * Where to send the browser. GitHub comes back to `redirectUri` with `code`
 * and `state` — immediately, without a screen, for someone who has already
 * authorized the App.
 */
export function authorizeUrl({
  clientId,
  state,
  redirectUri,
}: AuthorizeUrlOptions): string {
  const url = new URL("/login/oauth/authorize", WEB_HOST);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

/** A user token, with expiries resolved to absolute times. */
export interface UserTokens {
  readonly accessToken: string;
  /** Absent when the App does not expire user tokens. */
  readonly refreshToken: string | undefined;
  /** ISO. Absent when the token does not expire. */
  readonly expiresAt: string | undefined;
}

export interface ExchangeOptions {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri?: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

/** Trades the callback's `code` for the first token. */
export function exchangeCode({
  clientId,
  clientSecret,
  code,
  redirectUri,
  fetch,
  now,
}: ExchangeOptions): Promise<UserTokens> {
  return requestToken(
    {
      client_id: clientId,
      client_secret: clientSecret,
      code,
      ...(redirectUri === undefined ? {} : { redirect_uri: redirectUri }),
    },
    fetch,
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
 * Trades a refresh token for a new pair. The passed-in refresh token is spent
 * by this call; persist the returned one before anything else.
 */
export function refreshUserToken({
  clientId,
  clientSecret,
  refreshToken,
  fetch,
  now,
}: RefreshOptions): Promise<UserTokens> {
  return requestToken(
    {
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    },
    fetch,
    now,
  );
}

/**
 * One POST serves both grants.
 *
 * GitHub answers a refused exchange with **200** and `{ error }`, so success
 * is decided by the body. A non-2xx (an outage, a proxy) and no answer at
 * all are reported the same way, under codes of their own (`http_<status>`,
 * `network`), so the caller has one error to handle — and can tell GitHub
 * refusing the person from GitHub failing to answer (`unanswered`).
 */
async function requestToken(
  body: Record<string, string>,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  now: () => number = Date.now,
): Promise<UserTokens> {
  let response: Response;
  try {
    response = await request(
      fetchImpl,
      `${WEB_HOST}/login/oauth/access_token`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
  } catch (error) {
    throw new GithubOAuthError(
      "network",
      error instanceof GithubNetworkError
        ? error.message
        : "Could not reach GitHub.",
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new GithubOAuthError(
      `http_${response.status}`,
      `GitHub's token endpoint answered ${response.status}.`,
    );
  }

  const parsed = githubOAuthTokenResponseSchema.safeParse(
    await readJson(response),
  );
  if (!parsed.success) {
    throw new GithubOAuthError(
      "malformed",
      "GitHub's token endpoint returned an unexpected shape.",
    );
  }
  const { data } = parsed;
  if (data.error !== undefined || data.access_token === undefined) {
    throw new GithubOAuthError(
      data.error ?? "malformed",
      data.error_description ?? "GitHub returned no access token.",
    );
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt:
      data.expires_in === undefined
        ? undefined
        : new Date(now() + data.expires_in * 1000).toISOString(),
  };
}

/**
 * Where a user token is read from and written back to. The API implements
 * it over `github_grant`; `save` must persist before the token is used,
 * because the refresh that produced it has already spent the old one.
 */
export interface TokenSource {
  load(): Promise<UserTokens>;
  save(tokens: UserTokens): Promise<void>;
}

export interface UserCredentialOptions {
  tokens: TokenSource;
  clientId: string;
  clientSecret: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  /** How long before expiry to refresh, in seconds. Default 300. */
  refreshSkewSeconds?: number;
}

/**
 * A user token that keeps itself fresh. The same shape as the Jira
 * `OAuthCredential`, for the same reasons: concurrent callers share one
 * refresh, since a second refresh would spend the refresh token the first
 * just received; and a failed refresh reloads the source once, in case
 * another holder of the same row refreshed first.
 */
export class UserCredential {
  readonly #options: UserCredentialOptions;
  readonly #now: () => number;
  #inFlight: Promise<UserTokens> | undefined;

  constructor(options: UserCredentialOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  /** The access token to spend on the next request. */
  async token(): Promise<string> {
    return (await this.#current()).accessToken;
  }

  async #current(): Promise<UserTokens> {
    const stored = await this.#options.tokens.load();
    if (!this.#isStale(stored)) return stored;
    if (stored.refreshToken === undefined) {
      throw new GithubOAuthError(
        "bad_refresh_token",
        "The GitHub authorization has expired and cannot be renewed.",
      );
    }
    this.#inFlight ??= this.#refresh(stored.refreshToken)
      .catch((error: unknown) => this.#recover(error))
      .finally(() => {
        this.#inFlight = undefined;
      });
    return this.#inFlight;
  }

  async #refresh(refreshToken: string): Promise<UserTokens> {
    const renewed = await refreshUserToken({
      clientId: this.#options.clientId,
      clientSecret: this.#options.clientSecret,
      refreshToken,
      ...(this.#options.fetch === undefined
        ? {}
        : { fetch: this.#options.fetch }),
      now: this.#now,
    });
    await this.#options.tokens.save(renewed);
    return renewed;
  }

  /** See `OAuthCredential#recover` in packages/jira: the same race. */
  async #recover(error: unknown): Promise<UserTokens> {
    let latest: UserTokens;
    try {
      latest = await this.#options.tokens.load();
    } catch {
      throw error;
    }
    if (this.#isStale(latest)) throw error;
    return latest;
  }

  #isStale(tokens: UserTokens): boolean {
    if (tokens.expiresAt === undefined) return false;
    const expiresAt = Date.parse(tokens.expiresAt);
    // Unreadable is treated as expired: a refresh costs a round trip, while
    // trusting it risks every call failing.
    if (Number.isNaN(expiresAt)) return true;
    const skew = (this.#options.refreshSkewSeconds ?? 300) * 1000;
    return expiresAt - skew <= this.#now();
  }
}
