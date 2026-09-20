/**
 * How a request proves who it is — the seam that lets one REST client serve all
 * three integration mechanics.
 *
 * Atlassian Cloud accepts two credentials, and they differ in more than the
 * header: they use different hosts and different URL shapes.
 *
 *   OAuth 3LO    `Authorization: Bearer <token>`
 *                https://api.atlassian.com/ex/jira/<cloudId>/rest/...
 *
 *   API token    `Authorization: Basic base64(email:token)`
 *                https://<site>.atlassian.net/rest/...
 *
 * `Credential` hides both differences behind `authorize()` and `baseUrl()`, so
 * `JiraClient` never branches on which one it holds. A self-hosted Data Center
 * instance would slot in here as a third implementation without touching the
 * client.
 *
 * The OAuth credential also owns *refresh*: it holds a `TokenSource` and renews
 * the pair before it expires, so no caller has to think about expiry.
 */

import { refreshTokens, type TokenPair } from "./oauth.js";

/** What every request needs, whichever credential produced it. */
export interface Credential {
  /**
   * The `Authorization` header value for the next request. Async because the
   * OAuth credential may refresh first.
   */
  authorize(): Promise<string>;
  /**
   * The REST root this credential addresses, with no trailing slash. The two
   * credential types use genuinely different hosts, not just different auth.
   */
  baseUrl(): string;
  /** For diagnostics and the connection list. */
  readonly kind: "oauth" | "api-token";
}

/**
 * Where a token pair is read from and written back to.
 *
 * The API implements this over the `jira_connection` table; an MCP session
 * implements it over whatever it holds the grant in; a CLI could implement it
 * over a file. `save` is called on every refresh and **must persist before the
 * token is used**, because Atlassian rotates refresh tokens — see `oauth.ts`.
 */
export interface TokenSource {
  load(): Promise<TokenPair>;
  save(tokens: TokenPair): Promise<void>;
}

export interface OAuthCredentialOptions {
  tokens: TokenSource;
  clientId: string;
  clientSecret: string;
  /** The site to address. Every OAuth REST URL embeds it. */
  cloudId: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  /**
   * How long before expiry to renew, in seconds. Default 60: a token that
   * expires mid-flight fails the request it was fetched for, and Atlassian's
   * hour-long lifetime makes a minute's slack free.
   */
  refreshSkewSeconds?: number;
}

/** The options once the defaults are filled in, so `#options` has no holes. */
interface ResolvedOAuthOptions extends OAuthCredentialOptions {
  fetch: typeof globalThis.fetch;
  now: () => number;
  refreshSkewSeconds: number;
}

/**
 * A 3LO credential that keeps itself fresh.
 *
 * Concurrent calls share one refresh: `#inFlight` holds the promise, so ten
 * parallel board reads on an expired token make one token call, not ten. Ten
 * would not merely be wasteful — each rotates the refresh token, so the nine
 * losers would persist tokens already invalidated by the winner and the
 * connection would break.
 */
export class OAuthCredential implements Credential {
  readonly kind = "oauth";

  readonly #options: ResolvedOAuthOptions;
  #inFlight: Promise<TokenPair> | undefined;

  constructor(options: OAuthCredentialOptions) {
    this.#options = {
      ...options,
      fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
      now: options.now ?? Date.now,
      refreshSkewSeconds: options.refreshSkewSeconds ?? 60,
    };
  }

  async authorize(): Promise<string> {
    const tokens = await this.#current();
    return `Bearer ${tokens.accessToken}`;
  }

  baseUrl(): string {
    // The `/ex/jira/<cloudId>` gateway, not the site's own hostname: a 3LO
    // token is not accepted at `<site>.atlassian.net`.
    return `https://api.atlassian.com/ex/jira/${this.#options.cloudId}`;
  }

  /** The stored pair, refreshed first if it is at or near expiry. */
  async #current(): Promise<TokenPair> {
    const stored = await this.#options.tokens.load();
    if (!this.#isStale(stored)) {
      return stored;
    }

    if (stored.refreshToken === undefined) {
      // Nothing to refresh with: the grant was made without `offline_access`.
      throw new JiraCredentialError(
        "The Jira connection has expired and cannot be renewed. Reconnect Jira.",
      );
    }

    // Collapse concurrent refreshes; see the class comment.
    this.#inFlight ??= this.#refresh(stored.refreshToken).finally(() => {
      this.#inFlight = undefined;
    });
    return this.#inFlight;
  }

  async #refresh(refreshToken: string): Promise<TokenPair> {
    const renewed = await refreshTokens({
      clientId: this.#options.clientId,
      clientSecret: this.#options.clientSecret,
      refreshToken,
      fetch: this.#options.fetch,
      now: this.#options.now,
    });
    // Persisted before it is handed out: the new refresh token has already
    // invalidated the old one at Atlassian, so losing it here strands the
    // connection.
    await this.#options.tokens.save(renewed);
    return renewed;
  }

  #isStale(tokens: TokenPair): boolean {
    const expiresAt = Date.parse(tokens.expiresAt);
    if (Number.isNaN(expiresAt)) {
      // An unreadable expiry is treated as expired: a refresh costs one round
      // trip, whereas trusting it risks every call failing with a 401.
      return true;
    }
    return (
      expiresAt - this.#options.refreshSkewSeconds * 1000 <= this.#options.now()
    );
  }
}

export interface ApiTokenCredentialOptions {
  /** The site origin, e.g. `https://acme.atlassian.net`. */
  siteUrl: string;
  /** The Atlassian account email. Basic auth needs both halves. */
  email: string;
  /** A token from id.atlassian.com/manage-profile/security/api-tokens. */
  apiToken: string;
  /**
   * Base64 encoder. Defaults to `btoa`, which exists in browsers, Node 16+ and
   * workers alike — deliberately not `node:buffer`, which would break this
   * package's platform-neutrality (see tsconfig).
   */
  encodeBase64?: (value: string) => string;
}

/**
 * A long-lived API token, as basic auth.
 *
 * Kept alongside OAuth because it is the only credential that works for a
 * headless caller with no browser to consent in — a cron job, a CI step, or a
 * self-hosted MCP server started from a shell. It never expires, which is
 * exactly why it is the weaker option: there is nothing to rotate on its own.
 */
export class ApiTokenCredential implements Credential {
  readonly kind = "api-token";

  readonly #header: string;
  readonly #baseUrl: string;

  constructor({
    siteUrl,
    email,
    apiToken,
    encodeBase64,
  }: ApiTokenCredentialOptions) {
    const encode =
      encodeBase64 ??
      ((value: string) => {
        if (typeof globalThis.btoa !== "function") {
          throw new JiraCredentialError(
            "No base64 encoder available; pass `encodeBase64`.",
          );
        }
        return globalThis.btoa(value);
      });
    this.#header = `Basic ${encode(`${email}:${apiToken}`)}`;
    this.#baseUrl = siteUrl.replace(/\/+$/, "");
  }

  authorize(): Promise<string> {
    return Promise.resolve(this.#header);
  }

  baseUrl(): string {
    return this.#baseUrl;
  }
}

/** A credential that cannot produce a usable header. */
export class JiraCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JiraCredentialError";
  }
}

/**
 * A `TokenSource` over a plain object, for tests and for a short-lived process
 * that holds its grant in memory. Not for the API: a restart loses the refresh
 * token, and with it the connection.
 */
export function memoryTokenSource(initial: TokenPair): TokenSource {
  let current = initial;
  return {
    load: () => Promise.resolve(current),
    save: (tokens: TokenPair) => {
      current = tokens;
      return Promise.resolve();
    },
  };
}
