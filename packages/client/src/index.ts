/**
 * The typed API client, shared by the web dashboard and the VS Code extension.
 *
 * Platform-neutral: `fetch` only, no `node:`, `window` or `vscode`. The
 * tsconfig's `types: []` enforces it. Responses are parsed with the shared zod
 * schemas, not cast, so a wrong shape fails here with a clear message.
 *
 * `ApiClient` carries the transport and nothing else today: authentication,
 * JSON handling and the error contract, with `#request` exposed as the
 * protected `request` so a feature adds endpoints as methods rather than
 * restating any of it. The todo methods it used to carry went with the todo
 * domain; the seam is kept because the extension is a second consumer that
 * cannot share the web app's cookie.
 */

import {
  errorSchema,
  analysisRunListSchema,
  analysisRunResponseSchema,
  artifactListSchema,
  artifactUrlSchema,
  enqueueSliceResponseSchema,
  repositoryProposalListSchema,
  repoTreePageDtoSchema,
  repoSnapshotListSchema,
  repoSnapshotDetailDtoSchema,
  replayResponseSchema,
  sandboxListSchema,
  sandboxResponseSchema,
  sandboxVersionListSchema,
  sandboxVersionResponseSchema,
} from "@sandbox-factory/shared";
import type {
  CreateSandboxInput,
  CreateSandboxVersionInput,
  EnqueueAnalysisInput,
  EnqueueFixturesInput,
  EnqueueScopeInput,
  EnqueueSliceInput,
  UpdateSandboxVersionInput,
} from "@sandbox-factory/shared";

export interface ClientOptions {
  /** Base URL, e.g. `https://api.lunox.work`. Trailing slashes are fine. */
  baseUrl: string;
  /**
   * Returns the bearer token, or null when signed out. A function so the
   * token is read lazily and can change without rebuilding the client.
   * `PromiseLike`, not `Promise`, so VS Code's `Thenable` from
   * `context.secrets.get` satisfies it.
   */
  getToken?: () => string | null | PromiseLike<string | null>;
  /** Injectable for tests; defaults to the platform's global fetch. */
  fetch?: typeof globalThis.fetch;
  /**
   * Whether to send cookies. Defaults to `"include"`: the web app uses a
   * session cookie and the API is a different origin in production, where
   * fetch's default `"same-origin"` would drop it and make every call a 401.
   */
  credentials?: RequestCredentials;
}

/** An error carrying the HTTP status, so callers can branch on 401 vs 404. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The route's stable reason (`run_limit`, `graph_failed`, …), if it gave one. */
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** The caller is signed out or the token expired. */
  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  /**
   * The resource is gone, usually removed from another client; callers
   * generally drop it from their local list rather than show an error.
   */
  get isNotFound(): boolean {
    return this.status === 404;
  }
}

/**
 * Strips trailing slashes in linear time. Do not simplify to
 * `replace(/\/+$/, "")`: that is quadratic on a long run of slashes not at the
 * end (80k took ~2.3s), and `baseUrl` comes from callers of a published
 * package. Pinned by the slash tests in client.test.ts.
 */
function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") {
    end -= 1;
  }
  return value.slice(0, end);
}

export class ApiClient {
  readonly #baseUrl: string;
  readonly #getToken: () => string | null | PromiseLike<string | null>;
  readonly #fetch: typeof globalThis.fetch;
  readonly #credentials: RequestCredentials;

  constructor(options: ClientOptions) {
    this.#baseUrl = trimTrailingSlashes(options.baseUrl);
    this.#getToken = options.getToken ?? (() => null);
    this.#credentials = options.credentials ?? "include";
    // Bound to globalThis: an unbound global fetch throws "Illegal invocation"
    // in browsers.
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * One request, authenticated and parsed. `protected` rather than private:
   * this is the seam a subclass builds endpoints on, and the reason the
   * transport lives in a package rather than in each surface.
   */
  protected async request(path: string, init?: RequestInit): Promise<unknown> {
    const token = await this.#getToken();
    const headers = new Headers(init?.headers);
    headers.set("Accept", "application/json");
    if (init?.body !== undefined) {
      headers.set("Content-Type", "application/json");
    }
    if (token !== null && token !== "") {
      headers.set("Authorization", `Bearer ${token}`);
    }

    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      ...init,
      credentials: this.#credentials,
      headers,
    });
    const text = await response.text();

    let payload: unknown = undefined;
    if (text !== "") {
      try {
        payload = JSON.parse(text);
      } catch {
        throw new ApiError(
          response.status,
          `Expected JSON from ${path}, got: ${text.slice(0, 200)}`,
        );
      }
    }

    if (!response.ok) {
      const parsed = errorSchema.safeParse(payload);
      throw new ApiError(
        response.status,
        parsed.success
          ? parsed.data.error
          : `HTTP ${response.status} from ${path}`,
        parsed.success ? (parsed.data.code ?? null) : null,
      );
    }

    return payload;
  }
}

/** Private repository analysis, available to both browser and extension clients. */
export class GithubAnalysisClient extends ApiClient {
  #base(owner: string) {
    return `/api/v1/orgs/${encodeURIComponent(owner)}/github`;
  }
  async snapshots(owner: string, repoId: string) {
    return repoSnapshotListSchema.parse(
      await this.request(
        `${this.#base(owner)}/repositories/${encodeURIComponent(repoId)}/snapshots`,
      ),
    ).snapshots;
  }
  async snapshot(owner: string, snapshotId: string) {
    const response = (await this.request(
      `${this.#base(owner)}/snapshots/${encodeURIComponent(snapshotId)}`,
    )) as { snapshot?: unknown };
    return repoSnapshotDetailDtoSchema.parse(response.snapshot);
  }
  async runs(owner: string, repoId: string) {
    return analysisRunListSchema.parse(
      await this.request(
        `${this.#base(owner)}/repositories/${encodeURIComponent(repoId)}/runs`,
      ),
    ).runs;
  }
  async run(owner: string, runId: string) {
    return analysisRunResponseSchema.parse(
      await this.request(
        `${this.#base(owner)}/runs/${encodeURIComponent(runId)}`,
      ),
    ).run;
  }
  async enqueue(owner: string, repoId: string, input: EnqueueAnalysisInput) {
    return analysisRunResponseSchema.parse(
      await this.request(
        `${this.#base(owner)}/repositories/${encodeURIComponent(repoId)}/runs`,
        { method: "POST", body: JSON.stringify(input) },
      ),
    ).run;
  }
  /** A slice run on a repository's snapshot, queued behind its graph run. */
  async enqueueSlice(owner: string, repoId: string, input: EnqueueSliceInput) {
    return enqueueSliceResponseSchema.parse(
      await this.request(
        `${this.#base(owner)}/repositories/${encodeURIComponent(repoId)}/slices`,
        { method: "POST", body: JSON.stringify(input) },
      ),
    );
  }
  /** A scope agent run for one proposal, queued behind the snapshot's graph run. */
  async enqueueScope(owner: string, repoId: string, input: EnqueueScopeInput) {
    return enqueueSliceResponseSchema.parse(
      await this.request(
        `${this.#base(owner)}/repositories/${encodeURIComponent(repoId)}/scope`,
        { method: "POST", body: JSON.stringify(input) },
      ),
    );
  }
  /** A fixtures agent run for a succeeded slice run. */
  async enqueueFixtures(
    owner: string,
    sliceRunId: string,
    input: EnqueueFixturesInput,
  ) {
    return analysisRunResponseSchema.parse(
      await this.request(
        `${this.#base(owner)}/runs/${encodeURIComponent(sliceRunId)}/fixtures`,
        { method: "POST", body: JSON.stringify(input) },
      ),
    ).run;
  }
  /** Proposals with a spec, on the boards linked to the repository. */
  async repositoryProposals(owner: string, repoId: string) {
    return repositoryProposalListSchema.parse(
      await this.request(
        `${this.#base(owner)}/repositories/${encodeURIComponent(repoId)}/proposals`,
      ),
    ).proposals;
  }
  /** One page of a snapshot's file list, optionally under a directory. */
  async tree(
    owner: string,
    snapshotId: string,
    query: { prefix?: string; cursor?: string; limit?: number } = {},
  ) {
    const search = new URLSearchParams();
    if (query.prefix !== undefined && query.prefix !== "")
      search.set("prefix", query.prefix);
    if (query.cursor !== undefined) search.set("cursor", query.cursor);
    if (query.limit !== undefined) search.set("limit", String(query.limit));
    const encoded = search.toString();
    const suffix = encoded === "" ? "" : `?${encoded}`;
    return repoTreePageDtoSchema.parse(
      await this.request(
        `${this.#base(owner)}/snapshots/${encodeURIComponent(snapshotId)}/tree${suffix}`,
      ),
    );
  }
  async artifacts(owner: string, runId: string) {
    return artifactListSchema.parse(
      await this.request(
        `${this.#base(owner)}/runs/${encodeURIComponent(runId)}/artifacts`,
      ),
    ).artifacts;
  }
  async artifactUrl(owner: string, artifactId: string) {
    return artifactUrlSchema.parse(
      await this.request(
        `${this.#base(owner)}/artifacts/${encodeURIComponent(artifactId)}/url`,
      ),
    ).url;
  }
  async logUrl(owner: string, runId: string) {
    return artifactUrlSchema.parse(
      await this.request(
        `${this.#base(owner)}/runs/${encodeURIComponent(runId)}/log/url`,
      ),
    ).url;
  }
}

/**
 * Sandboxes and their versions, for the owner console. Everything here is
 * behind membership; the private provenance (`source`) comes back only for
 * owners and admins and is never shown to a contributor.
 */
export class SandboxClient extends GithubAnalysisClient {
  #sandboxes(owner: string) {
    return `/api/v1/orgs/${encodeURIComponent(owner)}/sandboxes`;
  }
  async sandboxes(owner: string) {
    return sandboxListSchema.parse(await this.request(this.#sandboxes(owner)))
      .sandboxes;
  }
  async sandbox(owner: string, sandboxId: string) {
    return sandboxResponseSchema.parse(
      await this.request(
        `${this.#sandboxes(owner)}/${encodeURIComponent(sandboxId)}`,
      ),
    ).sandbox;
  }
  async createSandbox(owner: string, input: CreateSandboxInput) {
    return sandboxResponseSchema.parse(
      await this.request(this.#sandboxes(owner), {
        method: "POST",
        body: JSON.stringify(input),
      }),
    ).sandbox;
  }
  async sandboxVersions(owner: string, sandboxId: string) {
    return sandboxVersionListSchema.parse(
      await this.request(
        `${this.#sandboxes(owner)}/${encodeURIComponent(sandboxId)}/versions`,
      ),
    ).versions;
  }
  /** A draft version cut from a succeeded slice run. */
  async createSandboxVersion(
    owner: string,
    sandboxId: string,
    input: CreateSandboxVersionInput,
  ) {
    return sandboxVersionResponseSchema.parse(
      await this.request(
        `${this.#sandboxes(owner)}/${encodeURIComponent(sandboxId)}/versions`,
        { method: "POST", body: JSON.stringify(input) },
      ),
    );
  }
  async sandboxVersion(owner: string, versionId: string) {
    return sandboxVersionResponseSchema.parse(
      await this.request(
        `${this.#sandboxes(owner)}/versions/${encodeURIComponent(versionId)}`,
      ),
    );
  }
  async updateSandboxVersion(
    owner: string,
    versionId: string,
    input: UpdateSandboxVersionInput,
  ) {
    return sandboxVersionResponseSchema.parse(
      await this.request(
        `${this.#sandboxes(owner)}/versions/${encodeURIComponent(versionId)}`,
        { method: "PATCH", body: JSON.stringify(input) },
      ),
    );
  }
  /** Queues the build run for a draft; the run is read like any analysis run. */
  async buildSandboxVersion(owner: string, versionId: string) {
    return analysisRunResponseSchema.parse(
      await this.request(
        `${this.#sandboxes(owner)}/versions/${encodeURIComponent(versionId)}/build`,
        { method: "POST" },
      ),
    ).run;
  }
  /** What replaying the version would use, or why it cannot be replayed. */
  async sandboxReplay(owner: string, versionId: string) {
    return replayResponseSchema.parse(
      await this.request(
        `${this.#sandboxes(owner)}/versions/${encodeURIComponent(versionId)}/replay`,
      ),
    );
  }
}
