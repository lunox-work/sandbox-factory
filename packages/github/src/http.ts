/**
 * The headers every REST call sends, and the one place they are set.
 *
 * - `Accept: application/vnd.github+json` — GitHub's documented media type.
 * - `X-GitHub-Api-Version` — pinned, so a new default version cannot change
 *   a response shape under us. Bumping it is a reviewed change.
 * - `User-Agent` — GitHub refuses requests without one.
 */

import { GithubNetworkError } from "./errors.js";

export const API_URL = "https://api.github.com";
export const API_VERSION = "2022-11-28";
export const USER_AGENT = "sandbox-factory";

/**
 * How long one request may take. Without it a hung connection holds the
 * request that started it for undici's five-minute header timeout — a
 * callback the person is waiting on, or a sweep the next tick then overlaps.
 * GitHub answers these reads in well under a second.
 */
export const REQUEST_TIMEOUT_MS = 10_000;

export function restHeaders(authorization: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: authorization,
    "X-GitHub-Api-Version": API_VERSION,
    "User-Agent": USER_AGENT,
  };
}

/** The body as JSON, or undefined for an empty or non-JSON body. */
export async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * `fetch` with the timeout above (or a longer one for a read known to be
 * large), and with a request that never got an
 * answer reported as `GithubNetworkError` rather than undici's bare
 * `TypeError`, so every caller's handling of GitHub's failures covers it.
 */
export async function request(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timedOut =
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError");
    throw new GithubNetworkError(
      timedOut
        ? `GitHub did not answer within ${timeoutMs / 1000} seconds.`
        : "Could not reach GitHub.",
    );
  }
}
