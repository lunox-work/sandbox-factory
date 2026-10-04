import {
  proposalActionResponseSchema,
  bountyListResponseSchema,
  bountyResponseSchema,
  type CreateBountyInput,
  type UpdateBountyInput,
} from "@sandbox-factory/shared";
import { ApiClient } from "./transport.js";
export const ownerPath = (owner: string) =>
  `/api/v1/orgs/${encodeURIComponent(owner)}`;
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
    const params = new URLSearchParams();
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    if (query.cursor !== undefined) params.set("cursor", query.cursor);
    return bountyListResponseSchema.parse(
      await this.request(`${ownerPath(owner)}/bounties?${params}`, { signal }),
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
  async deleteBounty(owner: string, id: string) {
    await this.request(
      `${ownerPath(owner)}/bounties/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  }
}
