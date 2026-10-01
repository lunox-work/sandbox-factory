/**
 * The GitHub REST client. Hand-rolled over `fetch`, like the Jira one, and
 * read-only: nothing here writes to GitHub.
 *
 * One class serves every credential. What differs between an installation
 * token and a user token is only where the token comes from, so the client
 * takes a `TokenProvider` and never learns which it holds:
 *
 *   installation   `tokens.provider(installationId)` — the repository calls
 *   user           `credential.token` — `user`, `userInstallations`,
 *                  `userInstallationRepositoryCount`
 *
 * GitHub's own rules decide which calls each may make; a user token asking
 * for `installationRepositories` is refused by GitHub, not by this file.
 */

import {
  type GithubInstallationResponse,
  githubInstallationPageResponseSchema,
  githubRefResponseSchema,
  type GithubRepositoryResponse,
  githubRepositoryPageResponseSchema,
  githubRepositoryResponseSchema,
  type GithubUserResponse,
  githubUserResponseSchema,
} from "@sandbox-factory/shared";

import { failure, GithubApiError } from "./errors.js";
import { API_URL, readJson, request, restHeaders } from "./http.js";
import type { TokenProvider } from "./installation-tokens.js";

export interface GithubClientOptions {
  token: TokenProvider;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  /** For a GitHub Enterprise host. Defaults to github.com's API. */
  apiUrl?: string;
  /**
   * The most pages a paginated read follows. Default 50, at 100 per page:
   * an installation on five thousand repositories is far past any client of
   * this product, and an unbounded loop is not a risk worth carrying.
   */
  maxPages?: number;
}

/** The rate limit as of the last response that reported one. */
export interface RateLimit {
  readonly limit: number;
  readonly remaining: number;
  readonly resetAt: Date;
}

/**
 * A branch head, read conditionally.
 *
 * `not-modified` is GitHub's 304 for an `If-None-Match` that still matches,
 * which costs nothing against the rate limit — so a quiet repository costs
 * the reconcile sweep nothing either. `empty` is a repository with no commits
 * yet, which GitHub answers with 409 rather than a ref.
 */
export type BranchHead =
  | {
      readonly status: "modified";
      readonly sha: string;
      readonly etag: string | null;
    }
  | { readonly status: "not-modified" }
  | { readonly status: "empty" };

/**
 * What `#parse` needs from a schema. Structural rather than zod's own type,
 * so this package needs no direct dependency on zod: the schemas come from
 * `@sandbox-factory/shared`, which owns that one.
 */
interface Schema<T> {
  safeParse(
    value: unknown,
  ): { success: true; data: T } | { success: false; data?: undefined };
}

export class GithubClient {
  readonly #token: TokenProvider;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => number;
  readonly #apiUrl: string;
  readonly #maxPages: number;
  #rateLimit: RateLimit | undefined;

  constructor(options: GithubClientOptions) {
    this.#token = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#now = options.now ?? Date.now;
    // No trailing slash, so `#nextPage`'s prefix check has one form to match.
    this.#apiUrl = (options.apiUrl ?? API_URL).replace(/\/+$/, "");
    this.#maxPages = options.maxPages ?? 50;
  }

  get rateLimit(): RateLimit | undefined {
    return this.#rateLimit;
  }

  /** Who a user token belongs to. */
  async user(): Promise<GithubUserResponse> {
    const response = await this.#get("/user", "user");
    return this.#parse(response, githubUserResponseSchema, "user");
  }

  /**
   * The App's installations this user can see. User token only.
   *
   * **Seeing is not administering.** GitHub lists every installation that
   * covers a repository the person can reach at all — an outside
   * collaborator with read access to one repository sees the whole
   * organization's installation here. So this list proves an installation
   * id is real and near the person, not that they may link it; the API's
   * authority check (`apps/api/src/github/authority.ts`) decides that.
   */
  async userInstallations(): Promise<GithubInstallationResponse[]> {
    const pages = await this.#paginate(
      "/user/installations?per_page=100",
      "installations",
      githubInstallationPageResponseSchema,
    );
    return pages.flatMap((page) => page.installations);
  }

  /**
   * The repositories an installation can see. Installation token only.
   * `repositorySelection` is from the first page, where GitHub reports it.
   */
  async installationRepositories(): Promise<{
    repositorySelection: string | undefined;
    repositories: GithubRepositoryResponse[];
  }> {
    const pages = await this.#paginate(
      "/installation/repositories?per_page=100",
      "installation repositories",
      githubRepositoryPageResponseSchema,
    );
    return {
      repositorySelection: pages[0]?.repository_selection,
      repositories: pages.flatMap((page) => page.repositories),
    };
  }

  /**
   * How many of an installation's repositories this user can reach. User
   * token only. GitHub answers with the intersection of the installation's
   * repositories and the person's own access, so it equals
   * `installationRepositoryCount` exactly when they can already read every
   * repository the installation covers.
   */
  async userInstallationRepositoryCount(
    installationId: string,
  ): Promise<number> {
    return this.#count(
      `/user/installations/${encodeURIComponent(installationId)}/repositories?per_page=1`,
      "installation repositories",
    );
  }

  /** How many repositories the installation covers. Installation token only. */
  async installationRepositoryCount(): Promise<number> {
    return this.#count(
      "/installation/repositories?per_page=1",
      "installation repositories",
    );
  }

  /**
   * One repository by its numeric id, which survives renames and transfers.
   * A 404 means deleted or no longer visible to this credential.
   */
  async repository(externalId: string): Promise<GithubRepositoryResponse> {
    const response = await this.#get(
      `/repositories/${encodeURIComponent(externalId)}`,
      "repository",
    );
    return this.#parse(response, githubRepositoryResponseSchema, "repository");
  }

  /**
   * The commit a branch points at, sent `If-None-Match` when an ETag from the
   * last read is known. `git/ref` rather than `branches/{b}`: the answer is
   * a ref and a sha, a few hundred bytes, where the branch endpoint embeds
   * the whole commit.
   */
  async branchHead(
    fullName: string,
    branch: string,
    etag?: string | null,
  ): Promise<BranchHead> {
    const path = `/repos/${segments(fullName)}/git/ref/heads/${segments(branch)}`;
    const response = await this.#send(
      path,
      etag === undefined || etag === null ? {} : { "If-None-Match": etag },
    );
    if (response.status === 304 || response.status === 409) {
      // Nothing to read, but an unread body holds the connection open.
      await response.body?.cancel();
      return { status: response.status === 304 ? "not-modified" : "empty" };
    }
    if (!response.ok) throw await failure(response, "branch", this.#now);
    const ref = await this.#parse(response, githubRefResponseSchema, "branch");
    return {
      status: "modified",
      sha: ref.object.sha,
      etag: response.headers.get("etag"),
    };
  }

  async #get(path: string, what: string): Promise<Response> {
    const response = await this.#send(path, {});
    if (!response.ok) throw await failure(response, what, this.#now);
    return response;
  }

  /** A list's `total_count`, from a one-item page. */
  async #count(path: string, what: string): Promise<number> {
    const response = await this.#get(path, what);
    const page = await this.#parse(
      response,
      githubRepositoryPageResponseSchema,
      what,
    );
    if (page.total_count === undefined) {
      throw new GithubApiError(
        response.status,
        `GitHub returned no count of ${what}.`,
      );
    }
    return page.total_count;
  }

  /** Every page of a list, following `Link: rel="next"`. */
  async #paginate<T>(
    path: string,
    what: string,
    schema: Schema<T>,
  ): Promise<T[]> {
    const pages: T[] = [];
    let next: string | undefined = path;
    while (next !== undefined && pages.length < this.#maxPages) {
      const response = await this.#get(next, what);
      pages.push(await this.#parse(response, schema, what));
      next = this.#nextPage(response.headers.get("link"));
    }
    return pages;
  }

  /**
   * The `next` URL from a `Link` header, absolute.
   *
   * Only followed when it is under our API URL: the header is GitHub's, but
   * the token goes wherever it points, and a link elsewhere is never where a
   * token should be sent. Kept absolute rather than cut to a path, because
   * an Enterprise API URL has a path of its own (`/api/v3`) that the link
   * already includes.
   */
  #nextPage(link: string | null): string | undefined {
    if (link === null) return undefined;
    for (const part of link.split(",")) {
      const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
      if (match?.[1] === undefined) continue;
      const url = new URL(match[1], this.#apiUrl).toString();
      return url.startsWith(`${this.#apiUrl}/`) ? url : undefined;
    }
    return undefined;
  }

  /** A path on the API URL, or an absolute URL `#nextPage` already checked. */
  async #send(
    pathOrUrl: string,
    extraHeaders: Record<string, string>,
  ): Promise<Response> {
    const token = await this.#token();
    const url = pathOrUrl.startsWith("/")
      ? `${this.#apiUrl}${pathOrUrl}`
      : pathOrUrl;
    const response = await request(this.#fetch, url, {
      headers: { ...restHeaders(`Bearer ${token}`), ...extraHeaders },
    });
    this.#noteRateLimit(response.headers);
    return response;
  }

  #noteRateLimit(headers: Headers): void {
    const limit = Number(headers.get("x-ratelimit-limit"));
    const remaining = Number(headers.get("x-ratelimit-remaining"));
    const reset = Number(headers.get("x-ratelimit-reset"));
    if (
      headers.has("x-ratelimit-remaining") &&
      [limit, remaining, reset].every(Number.isFinite)
    ) {
      this.#rateLimit = {
        limit,
        remaining,
        resetAt: new Date(reset * 1000),
      };
    }
  }

  async #parse<T>(
    response: Response,
    schema: Schema<T>,
    what: string,
  ): Promise<T> {
    const parsed = schema.safeParse(await readJson(response));
    if (!parsed.success) {
      throw new GithubApiError(
        response.status,
        `GitHub returned an unexpected shape for ${what}.`,
      );
    }
    return parsed.data;
  }
}

/** Each `/`-separated part encoded, the slashes kept: `release/1.0` stays two. */
function segments(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}
