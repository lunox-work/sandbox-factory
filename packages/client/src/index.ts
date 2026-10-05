import { ApiClient } from "./transport.js";
export { ApiClient, ApiError, type ClientOptions } from "./transport.js";
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
  analysisRunListSchema,
  analysisRunResponseSchema,
  artifactListSchema,
  artifactUrlSchema,
  enqueueSliceResponseSchema,
  generateStarterResponseSchema,
  publishVersionResponseSchema,
  repositoryProposalListSchema,
  repoTreePageDtoSchema,
  repoSnapshotListSchema,
  repoSnapshotDetailDtoSchema,
  replayResponseSchema,
  sandboxFileContentSchema,
  sandboxFileListSchema,
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
  LinkSandboxSourceInput,
  UpdateSandboxVersionInput,
} from "@sandbox-factory/shared";

/** Private repository analysis, available to both browser and extension clients. */
export class GithubAnalysisClient extends ApiClient {
  #base(owner: string) {
    return `/api/v1/orgs/${encodeURIComponent(owner)}/github`;
  }
  async snapshots(owner: string, repoId: string, signal?: AbortSignal) {
    return repoSnapshotListSchema.parse(
      await this.request(
        `${this.#base(owner)}/repositories/${encodeURIComponent(repoId)}/snapshots`,
        { signal },
      ),
    ).snapshots;
  }
  async snapshot(owner: string, snapshotId: string, signal?: AbortSignal) {
    const response = (await this.request(
      `${this.#base(owner)}/snapshots/${encodeURIComponent(snapshotId)}`,
      { signal },
    )) as { snapshot?: unknown };
    return repoSnapshotDetailDtoSchema.parse(response.snapshot);
  }
  async runs(owner: string, repoId: string, signal?: AbortSignal) {
    return analysisRunListSchema.parse(
      await this.request(
        `${this.#base(owner)}/repositories/${encodeURIComponent(repoId)}/runs`,
        { signal },
      ),
    ).runs;
  }
  async run(owner: string, runId: string, signal?: AbortSignal) {
    return analysisRunResponseSchema.parse(
      await this.request(
        `${this.#base(owner)}/runs/${encodeURIComponent(runId)}`,
        { signal },
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
  async repositoryProposals(
    owner: string,
    repoId: string,
    signal?: AbortSignal,
  ) {
    return repositoryProposalListSchema.parse(
      await this.request(
        `${this.#base(owner)}/repositories/${encodeURIComponent(repoId)}/proposals`,
        { signal },
      ),
    ).proposals;
  }
  /** One page of a snapshot's file list, optionally under a directory. */
  async tree(
    owner: string,
    snapshotId: string,
    query: { prefix?: string; cursor?: string; limit?: number } = {},
    signal?: AbortSignal,
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
        { signal },
      ),
    );
  }
  async artifacts(owner: string, runId: string, signal?: AbortSignal) {
    return artifactListSchema.parse(
      await this.request(
        `${this.#base(owner)}/runs/${encodeURIComponent(runId)}/artifacts`,
        { signal },
      ),
    ).artifacts;
  }
  async artifactUrl(owner: string, artifactId: string, signal?: AbortSignal) {
    return artifactUrlSchema.parse(
      await this.request(
        `${this.#base(owner)}/artifacts/${encodeURIComponent(artifactId)}/url`,
        { signal },
      ),
    ).url;
  }
  async logUrl(owner: string, runId: string, signal?: AbortSignal) {
    return artifactUrlSchema.parse(
      await this.request(
        `${this.#base(owner)}/runs/${encodeURIComponent(runId)}/log/url`,
        { signal },
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
  async sandboxes(owner: string, signal?: AbortSignal) {
    return sandboxListSchema.parse(
      await this.request(this.#sandboxes(owner), { signal }),
    ).sandboxes;
  }
  async sandbox(owner: string, sandboxId: string, signal?: AbortSignal) {
    return sandboxResponseSchema.parse(
      await this.request(
        `${this.#sandboxes(owner)}/${encodeURIComponent(sandboxId)}`,
        { signal },
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
  /** Links the repository a sandbox made without one is cut from. */
  async linkSandboxSource(
    owner: string,
    sandboxId: string,
    input: LinkSandboxSourceInput,
  ) {
    return sandboxResponseSchema.parse(
      await this.request(
        `${this.#sandboxes(owner)}/${encodeURIComponent(sandboxId)}/source`,
        { method: "PUT", body: JSON.stringify(input) },
      ),
    ).sandbox;
  }
  async sandboxVersions(
    owner: string,
    sandboxId: string,
    signal?: AbortSignal,
  ) {
    return sandboxVersionListSchema.parse(
      await this.request(
        `${this.#sandboxes(owner)}/${encodeURIComponent(sandboxId)}/versions`,
        { signal },
      ),
    ).versions;
  }
  /**
   * A draft version generated for a sandbox with no repository: the
   * starter agent writes it from the bounty and builds it. Answers with
   * the draft and its run, which is read like any analysis run.
   */
  async generateSandboxVersion(owner: string, sandboxId: string) {
    return generateStarterResponseSchema.parse(
      await this.request(
        `${this.#sandboxes(owner)}/${encodeURIComponent(sandboxId)}/starter`,
        { method: "POST" },
      ),
    );
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
  async sandboxVersion(owner: string, versionId: string, signal?: AbortSignal) {
    return sandboxVersionResponseSchema.parse(
      await this.request(
        `${this.#sandboxes(owner)}/versions/${encodeURIComponent(versionId)}`,
        { signal },
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
  /**
   * Publishes a version whose build passed: approved, frozen, and the
   * sandbox's published version.
   */
  async publishSandboxVersion(owner: string, versionId: string) {
    return publishVersionResponseSchema.parse(
      await this.request(
        `${this.#sandboxes(owner)}/versions/${encodeURIComponent(versionId)}/publish`,
        { method: "POST" },
      ),
    );
  }
  /** Takes the sandbox back to a draft with no published version. */
  async unpublishSandbox(owner: string, sandboxId: string) {
    return sandboxResponseSchema.parse(
      await this.request(
        `${this.#sandboxes(owner)}/${encodeURIComponent(sandboxId)}/unpublish`,
        { method: "POST" },
      ),
    ).sandbox;
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
  /** The private sandbox the version's build wrote: its file list. */
  async sandboxFiles(owner: string, versionId: string, signal?: AbortSignal) {
    return sandboxFileListSchema.parse(
      await this.request(
        `${this.#sandboxes(owner)}/versions/${encodeURIComponent(versionId)}/files`,
        { signal },
      ),
    );
  }
  /** One of those files, as text when it is text and small enough. */
  async sandboxFile(
    owner: string,
    versionId: string,
    path: string,
    signal?: AbortSignal,
  ) {
    return sandboxFileContentSchema.parse(
      await this.request(
        `${this.#sandboxes(owner)}/versions/${encodeURIComponent(versionId)}/files/content?${new URLSearchParams({ path }).toString()}`,
        { signal },
      ),
    );
  }
  /** What replaying the version would use, or why it cannot be replayed. */
  async sandboxReplay(owner: string, versionId: string, signal?: AbortSignal) {
    return replayResponseSchema.parse(
      await this.request(
        `${this.#sandboxes(owner)}/versions/${encodeURIComponent(versionId)}/replay`,
        { signal },
      ),
    );
  }
}

export * from "./memberships.js";
export * from "./bounties.js";
export * from "./jira.js";
export * from "./github.js";
export * from "./pricing.js";
export * from "./runs.js";
