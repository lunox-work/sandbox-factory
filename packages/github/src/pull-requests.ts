/**
 * The one thing this package writes to GitHub: merge-back's pull request.
 *
 * Apart from `GithubClient`, which only reads, so that no read path can
 * reach a write. Its token is minted for one repository with
 * `MERGE_BACK_PERMISSIONS` and for nothing else.
 *
 * A submission's files, carried back to the repository's names, become one
 * commit on the commit the version was sliced at, on a branch of their own,
 * and a pull request from it onto the default branch. GitHub shows whether
 * it still merges; nothing here rebases.
 *
 * `open` is safe to call again after any partial failure, or from a second
 * request racing the first: a branch already there is reused when its head
 * carries exactly the tree this would commit (Git trees are content
 * addressed, so the same files on the same base give the same sha), and an
 * open pull request from it is returned rather than a second one opened. A
 * branch someone pushed other work to is refused (`BranchConflictError`),
 * never force-pushed.
 *
 * Once it is open, the same writer reads it back (`getPullRequest`) and,
 * for a merge-back opened to merge when CI passes, merges it (`merge`):
 * squashed, at the head the caller read CI on, so a push since is never
 * merged unread. GitHub's refusal (branch protection, a review required,
 * not mergeable) is answered, not thrown, so the caller records it.
 */

import {
  failure,
  GithubApiError,
  GithubNotFound,
  readFailure,
} from "./errors.js";
import { API_URL, readJson, request, restHeaders } from "./http.js";
import type { TokenProvider } from "./installation-tokens.js";

/** What a merge-back token may do, and nothing more. */
export const MERGE_BACK_PERMISSIONS: Readonly<Record<string, string>> = {
  contents: "write",
  pull_requests: "write",
  metadata: "read",
};

/** GitHub's permission levels, each including the ones before it. */
const LEVELS = ["read", "write", "admin"];

/**
 * The permissions in `required` that `granted` (an installation's, as
 * GitHub reports them) does not cover, as `name:level`, e.g.
 * `["pull_requests:write"]`. Empty when every one is held.
 */
export function missingPermissions(
  granted: Readonly<Record<string, string>>,
  required: Readonly<Record<string, string>>,
): string[] {
  return Object.entries(required).flatMap(([name, level]) =>
    LEVELS.indexOf(granted[name] ?? "") >= LEVELS.indexOf(level)
      ? []
      : [`${name}:${level}`],
  );
}

/**
 * The merge-back's branch exists and its head is not the commit a
 * merge-back would make: someone pushed to it. Nothing is overwritten.
 */
export class BranchConflictError extends Error {
  constructor(readonly branch: string) {
    super(`Branch ${branch} already exists with other changes.`);
    this.name = "BranchConflictError";
  }
}

export interface PullRequestInput {
  /** `owner/name`. */
  readonly fullName: string;
  /** The commit the version was sliced at: the new commit's parent. */
  readonly baseCommit: string;
  /** The branch the pull request asks to merge into. */
  readonly base: string;
  /** The branch made for it, or reused when it carries the same tree. */
  readonly branch: string;
  readonly title: string;
  readonly body: string;
  readonly commitMessage: string;
  /** Each changed file, whole, at its repository path. */
  readonly files: readonly { readonly path: string; readonly text: string }[];
}

export interface OpenedPullRequest {
  readonly number: number;
  readonly url: string;
  readonly commitSha: string;
}

export interface PullRequestWriterOptions {
  readonly token: TokenProvider;
  readonly fetch?: typeof globalThis.fetch;
  readonly apiUrl?: string;
}

const segments = (fullName: string) =>
  fullName.split("/").map(encodeURIComponent).join("/");

/** A commit, as far as a merge-back compares it. */
export interface CommitSummary {
  readonly sha: string;
  readonly treeSha: string;
}

/** An open pull request. */
export interface PullRequestSummary {
  readonly number: number;
  readonly url: string;
}

/** A pull request as a merge-back follows it. */
export interface PullRequestRead {
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly state: "open" | "closed";
  readonly merged: boolean;
  /** The commit it landed as; null until merged. */
  readonly mergeCommitSha: string | null;
  readonly headSha: string;
  /** Null while GitHub is still working it out. */
  readonly mergeable: boolean | null;
}

/** What GitHub said to a merge: merged, or why not (it stays open). */
export type MergeOutcome =
  | { readonly merged: true; readonly sha: string }
  | {
      readonly merged: false;
      readonly status: number;
      /** GitHub's own words: branch protection, a review required… */
      readonly reason: string;
    };

/** The statuses GitHub refuses a merge with, which leave the pull request open. */
const MERGE_REFUSED = new Set([405, 409, 422]);

const isConflict = (error: unknown) =>
  error instanceof GithubApiError && error.status === 422;

export class PullRequestWriter {
  readonly #token: TokenProvider;
  readonly #fetch: typeof globalThis.fetch;
  readonly #apiUrl: string;

  constructor(options: PullRequestWriterOptions) {
    this.#token = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    let apiUrl = options.apiUrl ?? API_URL;
    while (apiUrl.endsWith("/")) apiUrl = apiUrl.slice(0, -1);
    this.#apiUrl = apiUrl;
  }

  async #call(
    method: "GET" | "POST" | "PUT",
    path: string,
    what: string,
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    const headers = restHeaders(`Bearer ${await this.#token()}`);
    const response = await request(this.#fetch, `${this.#apiUrl}${path}`, {
      method,
      headers:
        body === undefined
          ? headers
          : { ...headers, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw await failure(response, what);
    const parsed = await readJson(response);
    if (typeof parsed !== "object" || parsed === null)
      throw new Error(`GitHub answered ${what} with no object.`);
    return parsed as Record<string, unknown>;
  }

  /** A commit and its tree. */
  async getCommit(fullName: string, sha: string): Promise<CommitSummary> {
    const commit = await this.#call(
      "GET",
      `/repos/${segments(fullName)}/git/commits/${encodeURIComponent(sha)}`,
      "a commit",
    );
    const treeSha = (commit["tree"] as { sha?: unknown } | undefined)?.sha;
    if (typeof treeSha !== "string")
      throw new Error("GitHub answered the commit with no tree.");
    return { sha, treeSha };
  }

  /** The commit a branch points at; null when there is no such branch. */
  async getBranch(fullName: string, branch: string): Promise<string | null> {
    let ref;
    try {
      ref = await this.#call(
        "GET",
        `/repos/${segments(fullName)}/git/ref/heads/${branch
          .split("/")
          .map(encodeURIComponent)
          .join("/")}`,
        "a branch",
      );
    } catch (error) {
      if (error instanceof GithubNotFound) return null;
      throw error;
    }
    const sha = (ref["object"] as { sha?: unknown } | undefined)?.sha;
    if (typeof sha !== "string")
      throw new Error("GitHub answered the branch with no commit.");
    return sha;
  }

  /** The open pull request from a branch of the repository itself, if any. */
  async findOpenPullRequest(
    fullName: string,
    branch: string,
  ): Promise<PullRequestSummary | null> {
    const owner = fullName.split("/")[0] ?? "";
    const query = new URLSearchParams({
      head: `${owner}:${branch}`,
      state: "open",
      per_page: "1",
    });
    const listed = await this.#call(
      "GET",
      `/repos/${segments(fullName)}/pulls?${query.toString()}`,
      "pull requests",
    );
    if (!Array.isArray(listed))
      throw new Error("GitHub answered pull requests with no list.");
    const first = listed[0] as Record<string, unknown> | undefined;
    return first === undefined ? null : pullOf(first);
  }

  /** One pull request, as a merge-back follows it. */
  async getPullRequest(
    fullName: string,
    number: number,
  ): Promise<PullRequestRead> {
    const pull = await this.#call(
      "GET",
      `/repos/${segments(fullName)}/pulls/${number}`,
      "a pull request",
    );
    const { url } = pullOf(pull);
    const state = pull["state"];
    const headSha = (pull["head"] as { sha?: unknown } | undefined)?.sha;
    if ((state !== "open" && state !== "closed") || typeof headSha !== "string")
      throw new Error("GitHub answered the pull request with no state.");
    const mergeable = pull["mergeable"];
    const mergeCommit = pull["merge_commit_sha"];
    const merged = pull["merged"] === true;
    const title = pull["title"];
    return {
      number,
      url,
      title: typeof title === "string" ? title : "",
      state,
      merged,
      mergeCommitSha:
        merged && typeof mergeCommit === "string" ? mergeCommit : null,
      headSha,
      mergeable: typeof mergeable === "boolean" ? mergeable : null,
    };
  }

  /**
   * Merges the pull request, squashed, only while its head is still `sha`.
   * A refusal GitHub answers with 405, 409 or 422 is returned; anything
   * else (a token without write access, GitHub down) throws.
   */
  async merge(
    fullName: string,
    number: number,
    input: { readonly sha: string; readonly title: string },
  ): Promise<MergeOutcome> {
    const response = await request(
      this.#fetch,
      `${this.#apiUrl}/repos/${segments(fullName)}/pulls/${number}/merge`,
      {
        method: "PUT",
        headers: {
          ...restHeaders(`Bearer ${await this.#token()}`),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sha: input.sha,
          merge_method: "squash",
          commit_title: `${input.title} (#${number})`,
        }),
      },
    );
    if (MERGE_REFUSED.has(response.status)) {
      const { message } = await readFailure(response, "a merge");
      return {
        merged: false,
        status: response.status,
        reason: (message ?? `GitHub answered ${response.status}.`).slice(
          0,
          300,
        ),
      };
    }
    if (!response.ok) throw await failure(response, "a merge");
    const parsed = (await readJson(response)) as Record<string, unknown> | null;
    const sha = parsed?.["sha"];
    if (parsed?.["merged"] !== true || typeof sha !== "string")
      throw new Error("GitHub answered the merge with no commit.");
    return { merged: true, sha };
  }

  /**
   * The head of the merge-back's branch: made now with one commit of
   * `treeSha` on `baseCommit`, or found there already, and then ours only
   * when its head carries the same tree.
   */
  async #branch(input: PullRequestInput, treeSha: string): Promise<string> {
    const repo = `/repos/${segments(input.fullName)}`;
    let found = await this.getBranch(input.fullName, input.branch);
    if (found === null) {
      const commit = await this.#call(
        "POST",
        `${repo}/git/commits`,
        "a commit",
        {
          message: input.commitMessage,
          tree: treeSha,
          parents: [input.baseCommit],
        },
      );
      const commitSha = commit["sha"];
      if (typeof commitSha !== "string")
        throw new Error("GitHub answered the commit with no sha.");
      try {
        await this.#call("POST", `${repo}/git/refs`, "a branch", {
          ref: `refs/heads/${input.branch}`,
          sha: commitSha,
        });
        return commitSha;
      } catch (error) {
        // Made meanwhile by a request racing this one: compared below.
        if (!isConflict(error)) throw error;
        found = await this.getBranch(input.fullName, input.branch);
        if (found === null) throw error;
      }
    }
    const head = await this.getCommit(input.fullName, found);
    if (head.treeSha !== treeSha) throw new BranchConflictError(input.branch);
    return found;
  }

  /**
   * One commit with the files on `baseCommit`, its branch, and the pull
   * request; or what an earlier attempt already made of them. See the file
   * comment.
   */
  async open(input: PullRequestInput): Promise<OpenedPullRequest> {
    const repo = `/repos/${segments(input.fullName)}`;
    const base = await this.getCommit(input.fullName, input.baseCommit);
    const tree = await this.#call("POST", `${repo}/git/trees`, "a tree", {
      base_tree: base.treeSha,
      tree: input.files.map((file) => ({
        path: file.path,
        mode: "100644",
        type: "blob",
        content: file.text,
      })),
    });
    const treeSha = tree["sha"];
    if (typeof treeSha !== "string")
      throw new Error("GitHub answered the tree with no sha.");

    const commitSha = await this.#branch(input, treeSha);
    const existing = await this.findOpenPullRequest(
      input.fullName,
      input.branch,
    );
    if (existing !== null) return { ...existing, commitSha };
    try {
      const pull = await this.#call("POST", `${repo}/pulls`, "a pull request", {
        title: input.title,
        head: input.branch,
        base: input.base,
        body: input.body,
        maintainer_can_modify: false,
      });
      return { ...pullOf(pull), commitSha };
    } catch (error) {
      // GitHub refuses a second open pull request from one branch.
      if (!isConflict(error)) throw error;
      const raced = await this.findOpenPullRequest(
        input.fullName,
        input.branch,
      );
      if (raced === null) throw error;
      return { ...raced, commitSha };
    }
  }
}

function pullOf(pull: Record<string, unknown>): PullRequestSummary {
  const number = pull["number"];
  const url = pull["html_url"];
  if (typeof number !== "number" || typeof url !== "string")
    throw new Error("GitHub answered the pull request with no number.");
  return { number, url };
}
