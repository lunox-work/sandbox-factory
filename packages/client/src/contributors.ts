import {
  contributionListSchema,
  contributionResponseSchema,
  contributionSubmissionListSchema,
  contributionSubmissionResponseSchema,
  contributorTokenListSchema,
  contributorTokenResponseSchema,
  createdContributorTokenResponseSchema,
  folderPreviewResponseSchema,
  handoutFilesSchema,
  oauthGrantListSchema,
  oauthGrantResponseSchema,
  sandboxHandoutSchema,
  type CreateContributorTokenInput,
  type HandoutFilesQuery,
} from "@sandbox-factory/shared";

import { ApiClient } from "./transport.js";

/**
 * An invited contributor's side: the versions they were invited to, each
 * one's public project, and their own submissions and verdicts. Nothing
 * here names a workspace; every route answers 404 for a version the caller
 * holds no live assignment to. A signed-in session, or a contributor token
 * (`lnxc_…`) as the bearer; the token methods take a session only.
 */
export class ContributorClient extends ApiClient {
  #contribution(versionId: string) {
    return `/api/v1/contributions/${encodeURIComponent(versionId)}`;
  }
  /**
   * Claims an invite with the secret from its link (the fragment of
   * `/invite#…`): the version it gives access to.
   */
  async claimInvite(token: string) {
    return contributionResponseSchema.parse(
      await this.request("/api/v1/invites/claim", {
        method: "POST",
        body: JSON.stringify({ token }),
      }),
    ).contribution;
  }
  /** The versions the caller may work on, newest first. */
  async contributions(signal?: AbortSignal) {
    return contributionListSchema.parse(
      await this.request("/api/v1/contributions", { signal }),
    ).contributions;
  }
  async contribution(versionId: string, signal?: AbortSignal) {
    return contributionResponseSchema.parse(
      await this.request(this.#contribution(versionId), { signal }),
    ).contribution;
  }
  /** The public files and the hidden suite's count and commitment hash. */
  async contributionHandout(versionId: string, signal?: AbortSignal) {
    return sandboxHandoutSchema.parse(
      await this.request(`${this.#contribution(versionId)}/handout`, {
        signal,
      }),
    );
  }
  /** The public project as one `.zip`, and the name to save it as. */
  async contributionArchive(versionId: string, signal?: AbortSignal) {
    const file = await this.requestFile(
      `${this.#contribution(versionId)}/archive`,
      "application/zip",
      { signal },
    );
    return { ...file, filename: file.filename ?? `${versionId}.zip` };
  }
  /** One page of the public project's files with their contents. */
  async contributionFiles(
    versionId: string,
    query: HandoutFilesQuery = {},
    signal?: AbortSignal,
  ) {
    const search = new URLSearchParams();
    if (query.cursor !== undefined) search.set("cursor", query.cursor);
    if (query.maxBytes !== undefined)
      search.set("maxBytes", String(query.maxBytes));
    const suffix = search.toString() === "" ? "" : `?${search.toString()}`;
    return handoutFilesSchema.parse(
      await this.request(
        `${this.#contribution(versionId)}/handout/files${suffix}`,
        { signal },
      ),
    );
  }
  /** The caller's own submissions to the version, newest first. */
  async contributionSubmissions(versionId: string, signal?: AbortSignal) {
    return contributionSubmissionListSchema.parse(
      await this.request(`${this.#contribution(versionId)}/submissions`, {
        signal,
      }),
    ).submissions;
  }
  async contributionSubmission(
    versionId: string,
    submissionId: string,
    signal?: AbortSignal,
  ) {
    return contributionSubmissionResponseSchema.parse(
      await this.request(
        `${this.#contribution(versionId)}/submissions/${encodeURIComponent(submissionId)}`,
        { signal },
      ),
    ).submission;
  }
  /**
   * The caller's first submission to the version, to be graded; another
   * with other files is refused `already_submitted` (retry it instead).
   */
  async submitContribution(
    versionId: string,
    files: readonly { path: string; text: string }[],
  ) {
    return contributionSubmissionResponseSchema.parse(
      await this.request(`${this.#contribution(versionId)}/submissions`, {
        method: "POST",
        body: JSON.stringify({ files }),
      }),
    ).submission;
  }
  /** A failed submission's one retry, with new files. */
  async retryContribution(
    versionId: string,
    submissionId: string,
    files: readonly { path: string; text: string }[],
  ) {
    return contributionSubmissionResponseSchema.parse(
      await this.request(
        `${this.#contribution(versionId)}/submissions/${encodeURIComponent(submissionId)}/retry`,
        { method: "POST", body: JSON.stringify({ files }) },
      ),
    ).submission;
  }
  /**
   * What the zipped project folder would submit, refusals included, with
   * nothing stored: the files it changes, the guide files it leaves out,
   * and each file that stops it, by path. `retryOf` previews a retry.
   */
  async previewContributionFolder(
    versionId: string,
    folder: Blob,
    retryOf?: string,
  ) {
    return folderPreviewResponseSchema.parse(
      await this.request(`${this.#folderPath(versionId, retryOf)}?dryRun=1`, {
        method: "POST",
        headers: { "Content-Type": "application/zip" },
        body: folder,
      }),
    ).preview;
  }
  /**
   * The zipped project folder as the caller's first submission, or as the
   * retry of `retryOf`: what it changes in the task, to be graded. A folder
   * that changes read-only files is refused `folder_refused`, by path.
   */
  async submitContributionFolder(
    versionId: string,
    folder: Blob,
    retryOf?: string,
  ) {
    return contributionSubmissionResponseSchema.parse(
      await this.request(this.#folderPath(versionId, retryOf), {
        method: "POST",
        headers: { "Content-Type": "application/zip" },
        body: folder,
      }),
    ).submission;
  }
  #folderPath(versionId: string, retryOf: string | undefined) {
    return retryOf === undefined
      ? `${this.#contribution(versionId)}/submissions/zip`
      : `${this.#contribution(versionId)}/submissions/${encodeURIComponent(retryOf)}/retry/zip`;
  }
  /**
   * What the files would submit, refusals included, with nothing stored:
   * `files[]` sent with `?dryRun=1`. `retryOf` previews a retry.
   */
  async previewContribution(
    versionId: string,
    files: readonly { path: string; text: string }[],
    retryOf?: string,
  ) {
    const path =
      retryOf === undefined
        ? `${this.#contribution(versionId)}/submissions`
        : `${this.#contribution(versionId)}/submissions/${encodeURIComponent(retryOf)}/retry`;
    return folderPreviewResponseSchema.parse(
      await this.request(`${path}?dryRun=1`, {
        method: "POST",
        body: JSON.stringify({ files }),
      }),
    ).preview;
  }
  /** The person's contributor tokens, revoked ones too; never a secret. */
  async contributorTokens(signal?: AbortSignal) {
    return contributorTokenListSchema.parse(
      await this.request("/api/v1/me/contributor-tokens", { signal }),
    ).tokens;
  }
  /**
   * Makes a contributor token for an editor, agent or CLI: its secret is
   * in this answer and never again.
   */
  async createContributorToken(input: CreateContributorTokenInput) {
    return createdContributorTokenResponseSchema.parse(
      await this.request("/api/v1/me/contributor-tokens", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    );
  }
  async revokeContributorToken(id: string) {
    return contributorTokenResponseSchema.parse(
      await this.request(
        `/api/v1/me/contributor-tokens/${encodeURIComponent(id)}/revoke`,
        { method: "POST" },
      ),
    ).token;
  }
  /** The apps (MCP clients) the person let in as a contributor. */
  async contributorGrants(signal?: AbortSignal) {
    return oauthGrantListSchema.parse(
      await this.request("/api/v1/me/contributor-grants", { signal }),
    ).grants;
  }
  async revokeContributorGrant(id: string) {
    return oauthGrantResponseSchema.parse(
      await this.request(
        `/api/v1/me/contributor-grants/${encodeURIComponent(id)}/revoke`,
        { method: "POST" },
      ),
    ).grant;
  }
  /** An errored submission graded again with its own files; no retry spent. */
  async regradeContribution(versionId: string, submissionId: string) {
    return contributionSubmissionResponseSchema.parse(
      await this.request(
        `${this.#contribution(versionId)}/submissions/${encodeURIComponent(submissionId)}/regrade`,
        { method: "POST" },
      ),
    ).submission;
  }
}
