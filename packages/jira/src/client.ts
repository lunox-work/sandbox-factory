/**
 * The Jira read client. One class, used by all three integration mechanics:
 * the HTTP routes in `apps/api`, the MCP tools in `apps/api/src/mcp`, and the
 * skill's CLI. Whatever differs between them is a `Credential`, not a code path.
 *
 * Read-only by construction: there is no method here that writes, and the
 * scopes in `oauth.ts` would not permit one. That is the security posture of
 * the whole feature — see the `READ_SCOPES` comment.
 *
 * Two Jira APIs are in play, and which one serves a call is not arbitrary:
 *
 * - `/rest/agile/1.0` — boards, sprints, and the issues *on a board*. Board
 *   membership is a Jira Software concept that the platform API cannot express:
 *   a board's filter, its column mapping and its sprint assignment do not exist
 *   in JQL. Reading "the tasks on their board" has to go through here.
 * - `/rest/api/3` — JQL search and single-issue reads, for everything not
 *   scoped to a board.
 */

import {
  jiraBoardPageResponseSchema,
  type JiraBoardDto,
  type JiraIssueDetailDto,
  type JiraIssueDto,
  type JiraIssuePageDto,
  jiraIssuePageResponseSchema,
  jiraIssueResponseSchema,
  type JiraSprintDto,
  jiraSprintPageResponseSchema,
} from "@sandbox-factory/shared";

import type { Credential } from "./credentials.js";
import {
  DETAIL_FIELDS,
  ISSUE_FIELDS,
  toBoardDto,
  toIssueDetailDto,
  toIssueDto,
  toSprintDto,
} from "./mapping.js";
import { type JiraIssueSpec, SPEC_FIELDS, toIssueSpec } from "./spec.js";

/** A non-2xx from Jira, with the status kept so callers can branch on it. */
export class JiraApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Jira's `errorMessages`, when it sent any. Often the only useful detail. */
    readonly errors: readonly string[] = [],
  ) {
    super(message);
    this.name = "JiraApiError";
  }

  /** The credential is rejected: expired, revoked, or the wrong site. */
  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  /**
   * Authenticated but not permitted. On Jira this usually means a *scope* is
   * missing rather than the user lacking access, because a scope the token was
   * never granted cannot be added without fresh consent.
   */
  get isForbidden(): boolean {
    return this.status === 403;
  }

  /**
   * No such board, issue or sprint — **or** one the caller cannot see. Jira
   * deliberately conflates the two so a stranger cannot enumerate board ids,
   * so do not report this as "deleted".
   */
  get isNotFound(): boolean {
    return this.status === 404;
  }

  /** Rate limited. `Retry-After` is on the response; see `retryAfterSeconds`. */
  get isRateLimited(): boolean {
    return this.status === 429;
  }
}

/** Caps a page request. Jira's own hard ceiling for issue reads is 100. */
const MAX_PAGE_SIZE = 100;

export interface JiraClientOptions {
  credential: Credential;
  /**
   * The site origin, for building `browse/` links on issues. Optional: the
   * API-token credential already addresses the site directly, but an OAuth one
   * addresses the `api.atlassian.com` gateway, whose URL is not browsable.
   */
  siteUrl?: string | undefined;
  fetch?: typeof globalThis.fetch;
  /**
   * How many times to retry a 429 or 5xx. Default 2. Jira rate-limits per user
   * per app, and a board sync doing one call per sprint hits it on a large
   * instance.
   */
  maxRetries?: number;
  /** Injectable for tests, so a retry does not really wait. */
  sleep?: (ms: number) => Promise<void>;
}

export interface JiraComment {
  readonly id: string;
  readonly body: unknown;
}

/** The options shared by the three Agile issue endpoints. */
interface IssuePageOptions {
  jql?: string;
  startAt?: number;
  maxResults?: number;
}

export class JiraClient {
  readonly #credential: Credential;
  readonly #siteUrl: string | undefined;
  readonly #fetch: typeof globalThis.fetch;
  readonly #maxRetries: number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: JiraClientOptions) {
    this.#credential = options.credential;
    this.#siteUrl = options.siteUrl;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#maxRetries = options.maxRetries ?? 2;
    this.#sleep =
      options.sleep ??
      ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Every board the credential can see, following pagination to the end. */
  async boards(
    options: { projectKeyOrId?: string } = {},
  ): Promise<JiraBoardDto[]> {
    const collected: JiraBoardDto[] = [];
    let startAt = 0;
    // Bounded by `isLast`/short page rather than a fixed trip count: a large
    // instance genuinely has hundreds of boards.
    for (;;) {
      const query = new URLSearchParams({
        startAt: String(startAt),
        maxResults: String(MAX_PAGE_SIZE),
      });
      if (options.projectKeyOrId !== undefined) {
        query.set("projectKeyOrId", options.projectKeyOrId);
      }
      const payload = await this.#get(`/rest/agile/1.0/board?${query}`);
      const page = jiraBoardPageResponseSchema.parse(payload);
      collected.push(...page.values.map(toBoardDto));
      // `isLast` is authoritative when present; the short-page check covers the
      // instances that omit it.
      if (page.isLast === true || page.values.length < MAX_PAGE_SIZE) {
        return collected;
      }
      startAt += page.values.length;
    }
  }

  /**
   * The issues on a board — the board's own filter and column set applied, which
   * is what makes this different from a JQL search for the same project.
   *
   * One page per call. Board backlogs reach into the thousands, and a client
   * that wants them all should loop on `nextStartAt` and decide its own budget.
   */
  async boardIssues(
    boardId: number,
    options: IssuePageOptions & {
      /** Restrict to one sprint. Scrum boards only. */
      sprintId?: number;
    } = {},
  ): Promise<JiraIssuePageDto> {
    const path =
      options.sprintId === undefined
        ? `/rest/agile/1.0/board/${boardId}/issue`
        : `/rest/agile/1.0/board/${boardId}/sprint/${options.sprintId}/issue`;
    return this.#issuePage(path, options);
  }

  /**
   * The issues in a board's backlog — the ones *not* in any sprint. A distinct
   * endpoint, not a filter: `boardIssues` includes sprint-assigned issues.
   */
  async backlogIssues(
    boardId: number,
    options: IssuePageOptions = {},
  ): Promise<JiraIssuePageDto> {
    return this.#issuePage(`/rest/agile/1.0/board/${boardId}/backlog`, options);
  }

  /** A board's sprints, newest state first as Jira orders them. */
  async sprints(
    boardId: number,
    options: { state?: "future" | "active" | "closed" } = {},
  ): Promise<JiraSprintDto[]> {
    const query = new URLSearchParams({ maxResults: String(MAX_PAGE_SIZE) });
    if (options.state !== undefined) {
      query.set("state", options.state);
    }
    const payload = await this.#get(
      `/rest/agile/1.0/board/${boardId}/sprint?${query}`,
    );
    // A Kanban board has no sprints and answers 400, not an empty list. That is
    // a question about the board's type, not a failure, so it is normalised.
    return jiraSprintPageResponseSchema.parse(payload).values.map(toSprintDto);
  }

  /**
   * A JQL search, for everything not scoped to a board.
   *
   * Uses `/rest/api/3/search/jql`, which is token-paginated: pass the previous
   * response's `nextPageToken` to continue. The older offset-paginated
   * `/rest/api/3/search` was removed from Jira Cloud in 2025, so `startAt` has
   * no meaning here.
   */
  async search(
    jql: string,
    options: { maxResults?: number; nextPageToken?: string } = {},
  ): Promise<JiraIssuePageDto> {
    const query = new URLSearchParams({
      jql,
      maxResults: String(Math.min(options.maxResults ?? 50, MAX_PAGE_SIZE)),
      fields: ISSUE_FIELDS.join(","),
    });
    if (options.nextPageToken !== undefined) {
      query.set("nextPageToken", options.nextPageToken);
    }
    const payload = await this.#get(`/rest/api/3/search/jql?${query}`);
    const page = jiraIssuePageResponseSchema.parse(payload);
    return {
      issues: page.issues.map((issue) =>
        toIssueDto(issue, { siteUrl: this.#siteUrl }),
      ),
      ...(page.total === undefined ? {} : { total: page.total }),
      ...(page.nextPageToken === undefined
        ? {}
        : { nextPageToken: page.nextPageToken }),
    };
  }

  /** One issue by key (`ACME-123`) or numeric id. */
  async issue(keyOrId: string): Promise<JiraIssueDto> {
    const query = new URLSearchParams({ fields: ISSUE_FIELDS.join(",") });
    const payload = await this.#get(
      `/rest/api/3/issue/${encodeURIComponent(keyOrId)}?${query}`,
    );
    return toIssueDto(jiraIssueResponseSchema.parse(payload), {
      siteUrl: this.#siteUrl,
    });
  }

  /**
   * One issue in full, for showing a person the ticket they clicked on.
   *
   * The second of the two calls that read a description — `issueSpec` is the
   * other — and like it, one ticket at a time, by name. `ISSUE_FIELDS` still
   * omits `description`, so the board and backlog reads that feed every list
   * cannot pull ticket text; this is the call that exists so they do not have
   * to. Nothing it returns is stored.
   */
  async issueDetail(keyOrId: string): Promise<JiraIssueDetailDto> {
    const query = new URLSearchParams({ fields: DETAIL_FIELDS.join(",") });
    const payload = await this.#get(
      `/rest/api/3/issue/${encodeURIComponent(keyOrId)}?${query}`,
    );
    return toIssueDetailDto(jiraIssueResponseSchema.parse(payload), {
      siteUrl: this.#siteUrl,
    });
  }

  /**
   * One issue's **spec**: its summary and description, flattened to text, with
   * a hash of the pair.
   *
   * Separate from `issue()` because this is the only call in the package that
   * reads a ticket's description. `ISSUE_FIELDS` deliberately omits it, so a
   * board or backlog read cannot pull ticket text even by accident; a caller
   * that wants the words has to ask for them one ticket at a time, by name.
   *
   * The platform stores the returned `specHash` and not the text. Re-reading a
   * ticket later and comparing hashes is how a proposal is known to be stale.
   */
  async issueSpec(keyOrId: string): Promise<JiraIssueSpec> {
    const query = new URLSearchParams({ fields: SPEC_FIELDS.join(",") });
    const payload = await this.#get(
      `/rest/api/3/issue/${encodeURIComponent(keyOrId)}?${query}`,
    );
    const issue = jiraIssueResponseSchema.parse(payload);
    return toIssueSpec(issue.key, issue.fields ?? {});
  }

  /** Comments are read only for explicit recovery of an ambiguous write. */
  async comments(keyOrId: string): Promise<JiraComment[]> {
    const comments: JiraComment[] = [];
    let startAt = 0;
    for (;;) {
      const query = new URLSearchParams({
        startAt: String(startAt),
        maxResults: "100",
      });
      const payload = await this.#get(
        `/rest/api/3/issue/${encodeURIComponent(keyOrId)}/comment?${query}`,
      );
      const record =
        typeof payload === "object" && payload !== null
          ? (payload as Record<string, unknown>)
          : {};
      const page = Array.isArray(record["comments"]) ? record["comments"] : [];
      for (const value of page) {
        if (typeof value !== "object" || value === null) continue;
        const comment = value as Record<string, unknown>;
        if (typeof comment["id"] === "string") {
          comments.push({ id: comment["id"], body: comment["body"] });
        }
      }
      const total =
        typeof record["total"] === "number" ? record["total"] : comments.length;
      if (page.length === 0 || comments.length >= total) return comments;
      startAt += page.length;
    }
  }

  /** Shared by the three Agile issue endpoints, which paginate identically. */
  async #issuePage(
    path: string,
    options: IssuePageOptions,
  ): Promise<JiraIssuePageDto> {
    const startAt = options.startAt ?? 0;
    const maxResults = Math.min(options.maxResults ?? 50, MAX_PAGE_SIZE);
    const query = new URLSearchParams({
      startAt: String(startAt),
      maxResults: String(maxResults),
      fields: ISSUE_FIELDS.join(","),
    });
    if (options.jql !== undefined && options.jql !== "") {
      query.set("jql", options.jql);
    }
    const payload = await this.#get(`${path}?${query}`);
    const page = jiraIssuePageResponseSchema.parse(payload);
    const issues = page.issues.map((issue) =>
      toIssueDto(issue, { siteUrl: this.#siteUrl }),
    );
    // The Agile API reports `total`, so "is there more" is answerable without
    // requesting a page past the end.
    const consumed = startAt + issues.length;
    const hasMore =
      page.total === undefined
        ? issues.length === maxResults
        : consumed < page.total;
    return {
      issues,
      ...(page.total === undefined ? {} : { total: page.total }),
      ...(hasMore ? { nextStartAt: consumed } : {}),
    };
  }

  /** A GET with auth, retries and error translation. */
  async #get(path: string): Promise<unknown> {
    let attempt = 0;
    for (;;) {
      // Re-read inside the loop: a retry after a 401 refresh needs the new
      // token, and the credential may have rotated it since the last attempt.
      const authorization = await this.#credential.authorize();
      const response = await this.#fetch(
        `${this.#credential.baseUrl()}${path}`,
        {
          headers: { Authorization: authorization, Accept: "application/json" },
        },
      );

      if (response.ok) {
        return response.json();
      }

      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < this.#maxRetries) {
        await this.#sleep(retryDelayMs(response, attempt));
        attempt += 1;
        continue;
      }

      throw await toApiError(response);
    }
  }
}

/**
 * How long to wait before retrying. Honours `Retry-After` when Jira sends one —
 * it does on 429, and ignoring it is what turns a rate limit into a ban — and
 * otherwise backs off exponentially from 500ms.
 */
function retryDelayMs(response: Response, attempt: number): number {
  const header = response.headers.get("retry-after");
  if (header !== null) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      // Capped: Jira occasionally asks for minutes, which is longer than any
      // caller here is willing to block a request for.
      return Math.min(seconds * 1000, 30_000);
    }
  }
  return 500 * 2 ** attempt;
}

/**
 * Turns a failed response into a `JiraApiError`, reading Jira's error body.
 *
 * **Two body shapes, because two different services answer these URLs.** Jira
 * itself sends `{ errorMessages: [...] }`. The `api.atlassian.com` gateway in
 * front of it sends `{ code, message }` — and that is the one that carries
 * "Unauthorized; scope does not match", the only signal distinguishing an app
 * that was never granted a scope from a grant the user revoked. Reading only
 * `errorMessages` throws that away and leaves every gateway rejection wearing
 * the generic text below.
 */
async function toApiError(response: Response): Promise<JiraApiError> {
  let messages: string[] = [];
  try {
    const body = (await response.json()) as {
      errorMessages?: unknown;
      message?: unknown;
    } | null;
    if (Array.isArray(body?.errorMessages)) {
      messages = body.errorMessages.filter(
        (item): item is string => typeof item === "string",
      );
    }
    // The gateway's single `message`, used only when Jira sent no list of its
    // own, so a Jira error is never displaced by a wrapper's summary.
    if (messages.length === 0 && typeof body?.message === "string") {
      messages = [body.message];
    }
  } catch {
    // A non-JSON error body (an HTML gateway page, usually) tells us nothing
    // the status does not.
  }
  const detail =
    messages.length > 0 ? messages.join(" ") : describe(response.status);
  return new JiraApiError(response.status, detail, messages);
}

/** A readable default when Jira sends no `errorMessages`. */
function describe(status: number): string {
  switch (status) {
    case 401:
      return "Jira rejected the credential. Reconnect the site.";
    case 403:
      return "Jira refused the request. The connection may be missing a scope.";
    case 404:
      return "Not found, or not visible to this account.";
    case 429:
      return "Jira is rate limiting this connection. Try again shortly.";
    default:
      return `Jira returned HTTP ${status}.`;
  }
}
