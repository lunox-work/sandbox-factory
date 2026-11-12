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
 */

import { failure } from "./errors.js";
import { API_URL, readJson, request, restHeaders } from "./http.js";
import type { TokenProvider } from "./installation-tokens.js";

/** What a merge-back token may do, and nothing more. */
export const MERGE_BACK_PERMISSIONS: Readonly<Record<string, string>> = {
  contents: "write",
  pull_requests: "write",
  metadata: "read",
};

export interface PullRequestInput {
  /** `owner/name`. */
  readonly fullName: string;
  /** The commit the version was sliced at: the new commit's parent. */
  readonly baseCommit: string;
  /** The branch the pull request asks to merge into. */
  readonly base: string;
  /** The branch made for it; refused by GitHub when it exists. */
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
    method: "GET" | "POST",
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

  /** One commit with the files on `baseCommit`, its branch, and the pull request. */
  async open(input: PullRequestInput): Promise<OpenedPullRequest> {
    const repo = `/repos/${segments(input.fullName)}`;
    const base = await this.#call(
      "GET",
      `${repo}/git/commits/${encodeURIComponent(input.baseCommit)}`,
      "the version's commit",
    );
    const baseTree = (base["tree"] as { sha?: unknown } | undefined)?.sha;
    if (typeof baseTree !== "string")
      throw new Error("GitHub answered the version's commit with no tree.");
    const tree = await this.#call("POST", `${repo}/git/trees`, "a tree", {
      base_tree: baseTree,
      tree: input.files.map((file) => ({
        path: file.path,
        mode: "100644",
        type: "blob",
        content: file.text,
      })),
    });
    const commit = await this.#call("POST", `${repo}/git/commits`, "a commit", {
      message: input.commitMessage,
      tree: tree["sha"],
      parents: [input.baseCommit],
    });
    const commitSha = commit["sha"];
    if (typeof commitSha !== "string")
      throw new Error("GitHub answered the commit with no sha.");
    await this.#call("POST", `${repo}/git/refs`, "a branch", {
      ref: `refs/heads/${input.branch}`,
      sha: commitSha,
    });
    const pull = await this.#call("POST", `${repo}/pulls`, "a pull request", {
      title: input.title,
      head: input.branch,
      base: input.base,
      body: input.body,
      maintainer_can_modify: false,
    });
    const number = pull["number"];
    const url = pull["html_url"];
    if (typeof number !== "number" || typeof url !== "string")
      throw new Error("GitHub answered the pull request with no number.");
    return { number, url, commitSha };
  }
}
