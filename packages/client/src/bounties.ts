import {
  proposalActionResponseSchema,
  bountyListResponseSchema,
  bountyResponseSchema,
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
