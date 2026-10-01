/**
 * What a failed GitHub call means, as types a caller can branch on.
 *
 * GitHub's statuses do not map one-to-one onto remedies, which is why the
 * classification lives here once rather than in every caller:
 *
 * - **403 is two different things.** A primary rate limit answers 403 (or
 *   429) with `x-ratelimit-remaining: 0`; a secondary limit answers either
 *   with `retry-after` — or, GitHub's documentation warns, with neither, and
 *   only its body's `message` says "rate limit". Every other 403 is a
 *   permission the token lacks. Reading the status alone would report a busy
 *   minute as a revoked grant.
 * - **404 hides as well as reports.** GitHub answers 404, not 403, for a
 *   private repository the token cannot see, so `GithubNotFound` means "gone
 *   *or* not ours to see" — exactly as Jira's 404 does.
 */

/** Any non-2xx from GitHub that none of the subclasses below describes. */
export class GithubApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GithubApiError";
  }
}

/** The credential was refused: expired, revoked, or lacking a permission. */
export class GithubAuthError extends GithubApiError {
  constructor(status: number, message: string) {
    super(status, message);
    this.name = "GithubAuthError";
  }
}

/** No such resource, or one this credential cannot see. */
export class GithubNotFound extends GithubApiError {
  constructor(message: string) {
    super(404, message);
    this.name = "GithubNotFound";
  }
}

/**
 * Rate limited. `resetAt` is when GitHub says to try again; a sweep that
 * meets this stops rather than spending the rest of its batch on refusals.
 */
export class GithubRateLimited extends GithubApiError {
  constructor(
    status: number,
    message: string,
    readonly resetAt: Date,
  ) {
    super(status, message);
    this.name = "GithubRateLimited";
  }
}

/**
 * GitHub would not mint a token for an installation: 404 once the App is
 * uninstalled, 403 while it is suspended.
 *
 * Its own type, not a `GithubNotFound`, because the two mean different
 * things to a caller and arrive from the same request: a repository read
 * that fails because the token could not be minted says nothing about the
 * repository, and must not mark it gone.
 */
export class GithubInstallationUnavailable extends GithubApiError {
  constructor(status: number, message: string) {
    super(status, message);
    this.name = "GithubInstallationUnavailable";
  }
}

/**
 * GitHub refused the **App's own** credential, the JWT: a key deleted or
 * rotated on GitHub, a wrong `GITHUB_APP_ID`, or a clock far enough off that
 * the JWT reads as expired. Answered 401 by every App endpoint at once.
 *
 * Its own type because it says nothing about any installation. Treating it
 * as `GithubInstallationUnavailable` would flag every connection the sweep
 * reaches as uninstalled over one bad deploy; a caller stops instead, and
 * the connections stay as they were.
 */
export class GithubAppAuthError extends GithubApiError {
  constructor(message: string) {
    super(401, message);
    this.name = "GithubAppAuthError";
  }
}

/**
 * No answer at all: the connection failed, or GitHub took longer than the
 * request timeout. Status 0, because no status came back. A subclass of
 * `GithubApiError` so a caller that answers GitHub's failures as a 502 or an
 * `error` outcome answers this one the same way, rather than as a 500.
 */
export class GithubNetworkError extends GithubApiError {
  constructor(message: string) {
    super(0, message);
    this.name = "GithubNetworkError";
  }
}

/**
 * The OAuth endpoint refused an exchange or a refresh.
 *
 * Separate from the REST errors because GitHub reports these with **200** and
 * `{ error }` in the body, e.g. `bad_verification_code` for a code already
 * spent and `bad_refresh_token` for a refresh token expired, revoked or used.
 */
export class GithubOAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GithubOAuthError";
  }

  /** The refresh token is spent or revoked; only a fresh consent helps. */
  get needsReconnect(): boolean {
    return this.code === "bad_refresh_token";
  }

  /**
   * GitHub never answered the exchange properly — no connection, a timeout,
   * a non-2xx from a proxy — as opposed to answering it with a refusal. The
   * first is worth retrying; the second is about the code or the person.
   */
  get unanswered(): boolean {
    return this.code === "network" || this.code.startsWith("http_");
  }
}

/**
 * Classifies a non-2xx response. `now` is injectable so `resetAt` is
 * testable without a clock. `message` is the body's own, when the caller
 * read it; `failure` below does, and is what callers use.
 */
export function errorFor(
  response: Response,
  what: string,
  now: () => number = Date.now,
  message?: string,
): GithubApiError {
  const { status, headers } = response;
  const remaining = headers.get("x-ratelimit-remaining");
  const retryAfter = headers.get("retry-after");
  if (
    status === 429 ||
    (status === 403 &&
      (remaining === "0" ||
        retryAfter !== null ||
        /rate limit/i.test(message ?? "")))
  ) {
    return new GithubRateLimited(
      status,
      `GitHub rate limited ${what}.`,
      resetAt(headers, now),
    );
  }
  if (status === 401 || status === 403) {
    return new GithubAuthError(status, `GitHub refused ${what} (${status}).`);
  }
  if (status === 404) {
    return new GithubNotFound(`GitHub found no ${what}.`);
  }
  return new GithubApiError(status, `GitHub answered ${status} to ${what}.`);
}

/**
 * `errorFor` with the body read first: a secondary rate limit may say so
 * only there. Reading it also releases the connection, which an unread body
 * holds until it is garbage collected.
 */
export async function failure(
  response: Response,
  what: string,
  now: () => number = Date.now,
): Promise<GithubApiError> {
  let message: string | undefined;
  try {
    const text = await response.text();
    const parsed = JSON.parse(text) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "message" in parsed &&
      typeof parsed.message === "string"
    ) {
      message = parsed.message;
    }
  } catch {
    // No body, or not JSON: the status and headers decide alone.
  }
  return errorFor(response, what, now, message);
}

/**
 * When to try again: `retry-after` (seconds) wins, then the primary limit's
 * `x-ratelimit-reset` (epoch seconds), then a minute from now, which is what
 * GitHub's documentation advises when neither is sent.
 */
function resetAt(headers: Headers, now: () => number): Date {
  const retryAfter = Number(headers.get("retry-after"));
  if (headers.has("retry-after") && Number.isFinite(retryAfter)) {
    return new Date(now() + retryAfter * 1000);
  }
  const reset = Number(headers.get("x-ratelimit-reset"));
  if (headers.has("x-ratelimit-reset") && Number.isFinite(reset)) {
    return new Date(reset * 1000);
  }
  return new Date(now() + 60_000);
}
