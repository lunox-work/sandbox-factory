/**
 * Reading a merge-back pull request's CI back: the check runs and commit
 * statuses GitHub holds for its head commit, summed into one state.
 *
 * Apart from the writer, with a token of its own minted for one
 * repository with `CI_READ_PERMISSIONS` alone: an installation that has
 * not accepted them still opens pull requests, and its CI reads `unknown`.
 *
 * The state is the strictest of what is there: any failure is `failing`,
 * else anything not finished is `pending`, else `passing`. Nothing at all
 * is `pending` until the grace period has passed, then `none`: a
 * repository with no CI, or whose CI never started on the branch.
 */

import { failure } from "./errors.js";
import { API_URL, readJson, request, restHeaders } from "./http.js";
import type { TokenProvider } from "./installation-tokens.js";

/** What reading CI back needs, and nothing more. */
export const CI_READ_PERMISSIONS: Readonly<Record<string, string>> = {
  checks: "read",
  statuses: "read",
  metadata: "read",
};

/** One check run, latest per name (GitHub's default `filter=latest`). */
export interface CheckRunSummary {
  readonly name: string;
  /** `queued`, `in_progress`, `completed`… */
  readonly status: string;
  /** Null until completed. */
  readonly conclusion: string | null;
  readonly url: string | null;
}

/** One commit status, latest per context. */
export interface CommitStatusSummary {
  readonly context: string;
  /** `pending`, `success`, `failure` or `error`. */
  readonly state: string;
  readonly url: string | null;
}

export type CiState = "pending" | "passing" | "failing" | "none";

export interface CiSummary {
  readonly state: CiState;
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly pending: number;
  /** The failing checks' names, at most twenty. */
  readonly failing: readonly string[];
  readonly detailsUrl: string | null;
}

/** Conclusions that do not fail a pull request. */
const PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);
/** The most failing names a summary keeps. */
const FAILING_NAMES = 20;

/**
 * The state of a head commit's checks and statuses. `graceOver`: long
 * enough has passed since the pull request opened that no checks at all
 * means the repository runs none (`none`), not that they have not started.
 */
export function summarizeCi(
  checkRuns: readonly CheckRunSummary[],
  statuses: readonly CommitStatusSummary[],
  { graceOver }: { readonly graceOver: boolean },
): CiSummary {
  const outcomes = [
    ...checkRuns.map((run) => ({
      name: run.name,
      url: run.url,
      outcome:
        run.status !== "completed" || run.conclusion === null
          ? ("pending" as const)
          : PASSING_CONCLUSIONS.has(run.conclusion)
            ? ("passed" as const)
            : ("failed" as const),
    })),
    ...statuses.map((status) => ({
      name: status.context,
      url: status.url,
      outcome:
        status.state === "success"
          ? ("passed" as const)
          : status.state === "pending"
            ? ("pending" as const)
            : ("failed" as const),
    })),
  ];
  const count = (outcome: string) =>
    outcomes.filter((item) => item.outcome === outcome).length;
  const failedItems = outcomes.filter((item) => item.outcome === "failed");
  const failed = failedItems.length;
  const pending = count("pending");
  const state: CiState =
    failed > 0
      ? "failing"
      : pending > 0
        ? "pending"
        : outcomes.length > 0
          ? "passing"
          : graceOver
            ? "none"
            : "pending";
  return {
    state,
    total: outcomes.length,
    passed: count("passed"),
    failed,
    pending,
    failing: failedItems.slice(0, FAILING_NAMES).map((item) => item.name),
    detailsUrl: (failedItems[0] ?? outcomes[0])?.url ?? null,
  };
}

export interface PullRequestCiReaderOptions {
  readonly token: TokenProvider;
  readonly fetch?: typeof globalThis.fetch;
  readonly apiUrl?: string;
}

const segments = (fullName: string) =>
  fullName.split("/").map(encodeURIComponent).join("/");

const text = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

export class PullRequestCiReader {
  readonly #token: TokenProvider;
  readonly #fetch: typeof globalThis.fetch;
  readonly #apiUrl: string;

  constructor(options: PullRequestCiReaderOptions) {
    this.#token = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    let apiUrl = options.apiUrl ?? API_URL;
    while (apiUrl.endsWith("/")) apiUrl = apiUrl.slice(0, -1);
    this.#apiUrl = apiUrl;
  }

  async #get(path: string, what: string): Promise<Record<string, unknown>> {
    const response = await request(this.#fetch, `${this.#apiUrl}${path}`, {
      method: "GET",
      headers: restHeaders(`Bearer ${await this.#token()}`),
    });
    if (!response.ok) throw await failure(response, what);
    const parsed = await readJson(response);
    if (typeof parsed !== "object" || parsed === null)
      throw new Error(`GitHub answered ${what} with no object.`);
    return parsed as Record<string, unknown>;
  }

  /** The commit's check runs, the first hundred (latest per name). */
  async checkRuns(fullName: string, sha: string): Promise<CheckRunSummary[]> {
    const listed = await this.#get(
      `/repos/${segments(fullName)}/commits/${encodeURIComponent(sha)}/check-runs?per_page=100`,
      "check runs",
    );
    const runs = listed["check_runs"];
    if (!Array.isArray(runs))
      throw new Error("GitHub answered check runs with no list.");
    return runs.flatMap((item: unknown) => {
      if (typeof item !== "object" || item === null) return [];
      const run = item as Record<string, unknown>;
      const name = text(run["name"]);
      const status = text(run["status"]);
      if (name === null || status === null) return [];
      return [
        {
          name,
          status,
          conclusion: text(run["conclusion"]),
          url: text(run["html_url"]) ?? text(run["details_url"]),
        },
      ];
    });
  }

  /** The commit's statuses, latest per context (the combined status). */
  async statuses(
    fullName: string,
    sha: string,
  ): Promise<CommitStatusSummary[]> {
    const combined = await this.#get(
      `/repos/${segments(fullName)}/commits/${encodeURIComponent(sha)}/status?per_page=100`,
      "commit statuses",
    );
    const statuses = combined["statuses"];
    if (!Array.isArray(statuses))
      throw new Error("GitHub answered commit statuses with no list.");
    return statuses.flatMap((item: unknown) => {
      if (typeof item !== "object" || item === null) return [];
      const status = item as Record<string, unknown>;
      const context = text(status["context"]);
      const state = text(status["state"]);
      if (context === null || state === null) return [];
      return [{ context, state, url: text(status["target_url"]) }];
    });
  }
}
