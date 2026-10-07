import {
  proposalActionResponseSchema,
  bountyListResponseSchema,
  bountySizingResponseSchema,
  bountyResponseSchema,
  bountyVersionListSchema,
  bountyContextResponseSchema,
  syncBountyContextResponseSchema,
  type ContextSourceDto,
  type CreateBountyInput,
  type LinkBountyJiraInput,
  type UpdateBountyInput,
} from "@sandbox-factory/shared";
import { ApiClient } from "./transport.js";
export const ownerPath = (owner: string) =>
  `/api/v1/orgs/${encodeURIComponent(owner)}`;
/** A list page's query: its size, and where the page before it ended. */
function pageParams(query: { limit?: number; cursor?: string }) {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.cursor !== undefined) params.set("cursor", query.cursor);
  return params;
}
export class BountyClient extends ApiClient {
  /** The run sizing the bounty for its first proposal, or null. */
  async bountySizing(owner: string, id: string, signal?: AbortSignal) {
    return bountySizingResponseSchema.parse(
      await this.request(
        `${ownerPath(owner)}/bounties/${encodeURIComponent(id)}/sizing`,
        signal === undefined ? {} : { signal },
      ),
    ).run;
  }
  async proposeBounty(
    owner: string,
    id: string,
    requestId: string,
    signal?: AbortSignal,
  ) {
    return proposalActionResponseSchema.parse(
      await this.request(
        `${ownerPath(owner)}/bounties/${encodeURIComponent(id)}/propose`,
        {
          method: "POST",
          body: JSON.stringify({ requestId }),
          ...(signal === undefined ? {} : { signal }),
        },
      ),
    );
  }
  async bounties(
    owner: string,
    query: { limit?: number; cursor?: string } = {},
    signal?: AbortSignal,
  ) {
    return bountyListResponseSchema.parse(
      await this.request(`${ownerPath(owner)}/bounties?${pageParams(query)}`, {
        signal,
      }),
    );
  }
  /** The caller's bounties across every organization they belong to. */
  async myBounties(
    query: { limit?: number; cursor?: string } = {},
    signal?: AbortSignal,
  ) {
    return bountyListResponseSchema.parse(
      await this.request(`/api/v1/me/bounties?${pageParams(query)}`, {
        signal,
      }),
    );
  }
  async bounty(owner: string, id: string, signal?: AbortSignal) {
    return bountyResponseSchema.parse(
      await this.request(
        `${ownerPath(owner)}/bounties/${encodeURIComponent(id)}`,
        { signal },
      ),
    ).bounty;
  }
  /** Its overview's versions, newest first. */
  async bountyVersions(owner: string, id: string, signal?: AbortSignal) {
    return bountyVersionListSchema.parse(
      await this.request(
        `${ownerPath(owner)}/bounties/${encodeURIComponent(id)}/versions`,
        { signal },
      ),
    ).versions;
  }
  /** Where each of its sources stands against its latest sync. */
  async bountyContext(owner: string, id: string, signal?: AbortSignal) {
    return bountyContextResponseSchema.parse(
      await this.request(
        `${ownerPath(owner)}/bounties/${encodeURIComponent(id)}/context`,
        { signal },
      ),
    );
  }
  /**
   * Reads one of its sources now and keeps what it found as the source's
   * next context version, when it is new.
   */
  async syncBountyContext(owner: string, id: string, source: ContextSourceDto) {
    return syncBountyContextResponseSchema.parse(
      await this.request(
        `${ownerPath(owner)}/bounties/${encodeURIComponent(id)}/context/${source}/sync`,
        { method: "POST" },
      ),
    );
  }
  async createBounty(owner: string, input: CreateBountyInput) {
    return bountyResponseSchema.parse(
      await this.request(`${ownerPath(owner)}/bounties`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    ).bounty;
  }
  async updateBounty(owner: string, id: string, input: UpdateBountyInput) {
    return bountyResponseSchema.parse(
      await this.request(
        `${ownerPath(owner)}/bounties/${encodeURIComponent(id)}`,
        { method: "PATCH", body: JSON.stringify(input) },
      ),
    ).bounty;
  }
  /**
   * Approves the bounty's overview at its version, which holds it as it is,
   * or takes that back, against the revision seen.
   */
  async decideBounty(
    owner: string,
    id: string,
    decision: "approve" | "unapprove",
    expectedRevision: number,
  ) {
    return bountyResponseSchema.parse(
      await this.request(
        `${ownerPath(owner)}/bounties/${encodeURIComponent(id)}/${decision}`,
        { method: "POST", body: JSON.stringify({ expectedRevision }) },
      ),
    ).bounty;
  }
  /** Links the bounty to a Jira issue, whose text it then follows. */
  async linkBountyJira(owner: string, id: string, input: LinkBountyJiraInput) {
    return bountyResponseSchema.parse(
      await this.request(
        `${ownerPath(owner)}/bounties/${encodeURIComponent(id)}/jira`,
        { method: "PUT", body: JSON.stringify(input) },
      ),
    ).bounty;
  }
  /** Takes the bounty's Jira issue from it; its text stays. */
  async unlinkBountyJira(owner: string, id: string) {
    return bountyResponseSchema.parse(
      await this.request(
        `${ownerPath(owner)}/bounties/${encodeURIComponent(id)}/jira`,
        { method: "DELETE" },
      ),
    ).bounty;
  }
  async deleteBounty(owner: string, id: string) {
    await this.request(
      `${ownerPath(owner)}/bounties/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  }
}
