/**
 * Installation tokens: what every unattended call to a client's repositories
 * spends.
 *
 * Minted from the App's JWT, valid for an hour, and **never stored**: a
 * process holds them in memory until five minutes before they expire, and a
 * restart mints new ones. Nothing about them reaches the database, so there
 * is nothing to encrypt, rotate or leak at rest.
 *
 * A token can be narrowed when it is minted — to some repositories, to fewer
 * permissions than the installation holds. Narrowed and unnarrowed tokens are
 * cached apart, keyed by the narrowing, so a call that asked for one
 * repository is never handed a token for all of them.
 */

import type { KeyObject } from "node:crypto";

import {
  githubInstallationResponseSchema,
  githubInstallationTokenResponseSchema,
} from "@sandbox-factory/shared";

import { appJwt } from "./app-jwt.js";
import {
  failure,
  GithubApiError,
  GithubAppAuthError,
  GithubInstallationUnavailable,
  GithubNetworkError,
  GithubNotFound,
  GithubRateLimited,
  readFailure,
} from "./errors.js";
import { API_URL, readJson, request, restHeaders } from "./http.js";

/** How long GitHub's installation tokens live. */
const TOKEN_LIFETIME_MS = 60 * 60_000;

/**
 * How much life a cached token must have left to stand in for a re-mint that
 * failed for a reason of GitHub's own (a rate limit, an outage).
 */
const FALLBACK_MARGIN_MS = 60_000;

/** Hands a client the token for its next request. */
export type TokenProvider = () => Promise<string>;

/** What a minted token may reach, narrower than the installation. */
export interface InstallationNarrowing {
  /** GitHub's numeric repository ids. Absent: every repository it can see. */
  readonly repositoryIds?: readonly number[];
  /** e.g. `{ contents: "read" }`. Absent: everything the installation holds. */
  readonly permissions?: Readonly<Record<string, string>>;
}

export interface InstallationTokensOptions {
  appId: string;
  privateKey: KeyObject;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  /** For a GitHub Enterprise host. Defaults to github.com's API. */
  apiUrl?: string;
  /**
   * How long before expiry a cached token stops being handed out. Default
   * five minutes: a token that expires mid-request fails the request, and
   * an hour's lifetime makes the slack free.
   */
  refreshSkewMs?: number;
}

interface CachedToken {
  readonly token: string;
  readonly expiresAt: number;
}

/** How the installation looks to GitHub right now; see `probe`. */
export interface InstallationState {
  readonly suspendedAt: string | null;
}

export class InstallationTokens {
  readonly #options: InstallationTokensOptions;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => number;
  readonly #apiUrl: string;
  readonly #cache = new Map<string, CachedToken>();
  readonly #inFlight = new Map<string, Promise<string>>();
  /**
   * Bumped by `forget`. A mint that started before the bump finishes for the
   * callers already waiting on it but is not cached, because it may carry
   * the permissions or the installation `forget` was told are gone.
   */
  readonly #generation = new Map<string, number>();

  constructor(options: InstallationTokensOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#now = options.now ?? Date.now;
    this.#apiUrl = withoutTrailingSlashes(options.apiUrl ?? API_URL);
  }

  /**
   * A live token for an installation, minted only when the cache has none.
   *
   * Concurrent callers share one mint: ten repositories reconciled at once on
   * a cold cache make one call to GitHub, not ten.
   */
  async token(
    installationId: string,
    narrowing: InstallationNarrowing = {},
  ): Promise<string> {
    const key = cacheKey(installationId, narrowing);
    const cached = this.#cache.get(key);
    const skew = this.#options.refreshSkewMs ?? 5 * 60_000;
    if (cached !== undefined && cached.expiresAt - skew > this.#now()) {
      return cached.token;
    }

    const waiting = this.#inFlight.get(key);
    if (waiting !== undefined) return waiting;

    const generation = this.#generation.get(installationId) ?? 0;
    const current = () =>
      (this.#generation.get(installationId) ?? 0) === generation;
    const pending: Promise<string> = this.#mint(installationId, narrowing)
      .then((minted) => {
        if (current()) this.#cache.set(key, minted);
        return minted.token;
      })
      .catch((error: unknown) => {
        // Inside the refresh window the old token still works. A re-mint
        // refused for a reason of GitHub's own should not fail a call it
        // could make; a refusal about the installation must.
        if (
          transient(error) &&
          cached !== undefined &&
          current() &&
          cached.expiresAt - FALLBACK_MARGIN_MS > this.#now()
        ) {
          return cached.token;
        }
        throw error;
      })
      .finally(() => {
        // `forget` may have replaced this entry with a newer mint already.
        if (this.#inFlight.get(key) === pending) this.#inFlight.delete(key);
      });
    this.#inFlight.set(key, pending);
    return pending;
  }

  /** A `TokenProvider` bound to one installation and narrowing. */
  provider(
    installationId: string,
    narrowing: InstallationNarrowing = {},
  ): TokenProvider {
    return () => this.token(installationId, narrowing);
  }

  /**
   * Drops every cached token for an installation, narrowed or not, and
   * detaches any mint in flight so the next call starts its own. Called when
   * GitHub says the installation is gone, suspended or re-permissioned, so
   * the next call learns that from a mint rather than spending a dead token.
   */
  forget(installationId: string): void {
    this.#generation.set(
      installationId,
      (this.#generation.get(installationId) ?? 0) + 1,
    );
    const prefix = `${installationId}\n`;
    for (const map of [this.#cache, this.#inFlight]) {
      for (const key of map.keys()) {
        if (key.startsWith(prefix)) map.delete(key);
      }
    }
  }

  /**
   * The installation as GitHub sees it now, asked with the App's JWT rather
   * than a token: whether it still exists, and whether it is suspended.
   * `null` once it is uninstalled.
   *
   * What the sweep asks about a connection it has flagged, so a flag left
   * by a lost `unsuspend` delivery, or by a refusal that has since passed,
   * does not stay for good.
   */
  async probe(installationId: string): Promise<InstallationState | null> {
    const response = await request(
      this.#fetch,
      `${this.#apiUrl}/app/installations/${encodeURIComponent(installationId)}`,
      { headers: restHeaders(`Bearer ${this.#jwt()}`) },
    );
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      throw this.#appRefusal(
        response,
        await failure(response, "an installation", this.#now),
      );
    }
    const parsed = githubInstallationResponseSchema.safeParse(
      await readJson(response),
    );
    if (!parsed.success) {
      throw new GithubApiError(
        response.status,
        "GitHub returned an unexpected shape for an installation.",
      );
    }
    return { suspendedAt: parsed.data.suspended_at ?? null };
  }

  #jwt(): string {
    return appJwt({
      appId: this.#options.appId,
      privateKey: this.#options.privateKey,
      now: this.#now(),
    });
  }

  /** A 401 to the JWT is about the App, whichever endpoint answered it. */
  #appRefusal(response: Response, error: GithubApiError): GithubApiError {
    if (response.status === 401 && !(error instanceof GithubRateLimited)) {
      return new GithubAppAuthError(
        "GitHub refused the App's own credential (401). Check GITHUB_APP_ID, " +
          "the private key, and the clock.",
      );
    }
    return error;
  }

  async #mint(
    installationId: string,
    narrowing: InstallationNarrowing,
  ): Promise<CachedToken> {
    const startedAt = this.#now();
    const jwt = this.#jwt();
    const body: Record<string, unknown> = {};
    if (narrowing.repositoryIds !== undefined) {
      body["repository_ids"] = [...narrowing.repositoryIds];
    }
    if (narrowing.permissions !== undefined) {
      body["permissions"] = { ...narrowing.permissions };
    }

    const response = await request(
      this.#fetch,
      `${this.#apiUrl}/app/installations/${encodeURIComponent(
        installationId,
      )}/access_tokens`,
      {
        method: "POST",
        headers: {
          ...restHeaders(`Bearer ${jwt}`),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) {
      const refused = await readFailure(
        response,
        "an installation token",
        this.#now,
      );
      const error = this.#appRefusal(response, refused.error);
      // A 403 or 404 is about the installation: suspended, or uninstalled.
      // A 401 is about the App and a rate limit or an outage about neither;
      // each keeps its own type so a caller does not flag the connection.
      if (
        !(error instanceof GithubRateLimited) &&
        [403, 404].includes(response.status)
      ) {
        throw new GithubInstallationUnavailable(
          response.status,
          `GitHub will not mint a token for installation ${installationId} (${response.status}).`,
        );
      }
      // A token narrowed to a repository the installation no longer covers
      // is refused with 422, as is one asking for a permission it lacks.
      // Only the first says the repository is gone for us, and only GitHub's
      // message tells them apart; it is the 404 an unnarrowed read of that
      // repository would have answered, so it reads as one.
      if (
        response.status === 422 &&
        narrowing.repositoryIds !== undefined &&
        /repositor/i.test(refused.message ?? "")
      ) {
        throw new GithubNotFound(
          `GitHub found no such repository in installation ${installationId}.`,
        );
      }
      throw error;
    }

    const parsed = githubInstallationTokenResponseSchema.safeParse(
      await readJson(response),
    );
    const expiresAt = parsed.success
      ? Date.parse(parsed.data.expires_at)
      : Number.NaN;
    if (!parsed.success || Number.isNaN(expiresAt)) {
      throw new GithubApiError(
        response.status,
        "GitHub returned an unexpected shape for an installation token.",
      );
    }
    // GitHub's `expires_at` is on GitHub's clock. Capped at an hour from
    // when we asked, on ours, so a clock running slow here does not hand
    // out a token GitHub has already expired.
    return {
      token: parsed.data.token,
      expiresAt: Math.min(expiresAt, startedAt + TOKEN_LIFETIME_MS),
    };
  }
}

/** A failure of GitHub's own, which a still-valid token can ride out. */
function transient(error: unknown): boolean {
  return (
    error instanceof GithubRateLimited ||
    error instanceof GithubNetworkError ||
    (error instanceof GithubApiError &&
      !(error instanceof GithubInstallationUnavailable) &&
      error.status >= 500)
  );
}

/**
 * The cache key for an installation and a narrowing.
 *
 * Canonical — ids sorted, permission keys sorted — so the same narrowing
 * asked for in a different order shares a token. Newline-separated because
 * an installation id never contains one.
 */
function cacheKey(
  installationId: string,
  narrowing: InstallationNarrowing,
): string {
  const ids =
    narrowing.repositoryIds === undefined
      ? "*"
      : [...narrowing.repositoryIds].sort((a, b) => a - b).join(",");
  const permissions =
    narrowing.permissions === undefined
      ? "*"
      : Object.keys(narrowing.permissions)
          .sort()
          .map((name) => `${name}=${narrowing.permissions?.[name] ?? ""}`)
          .join(",");
  return `${installationId}\n${ids}\n${permissions}`;
}

/** A URL with every trailing slash cut; a loop, as a regex is quadratic here. */
function withoutTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === "/") end -= 1;
  return url.slice(0, end);
}
