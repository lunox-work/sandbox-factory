import type { RateCardValuesDto } from "@sandbox-factory/shared";
import {
  proposalActionResponseSchema,
  proposalCategoriesDtoSchema,
  proposalDetailResponseSchema,
  proposalListResponseSchema,
  proposalProfileResponseSchema,
  proposalSpecResponseSchema,
  proposalSpecRevisionsResponseSchema,
  rateCardResponseSchema,
} from "@sandbox-factory/shared";
import { ownerPath } from "./bounties.js";
import { ApiClient } from "./transport.js";
export class PricingClient extends ApiClient {
  async titles(
    owner: string,
    boardId: string,
    ids: readonly string[],
    onLine: (value: unknown) => void,
    signal: AbortSignal,
  ) {
    await this.stream(
      `${ownerPath(owner)}/jira/boards/${encodeURIComponent(boardId)}/proposal-titles?ids=${ids.map(encodeURIComponent).join(",")}`,
      onLine,
      signal,
    );
  }
  async action(owner: string, path: string, body: object) {
    return proposalActionResponseSchema.parse(
      await this.request(`${ownerPath(owner)}${path}`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );
  }
  async saveRateCard(
    owner: string,
    input: RateCardValuesDto & { expectedRevision: number },
  ) {
    return rateCardResponseSchema.parse(
      await this.request(`${ownerPath(owner)}/rate-card`, {
        method: "PUT",
        body: JSON.stringify(input),
      }),
    ).rateCard;
  }
  async rateCard(owner: string, signal?: AbortSignal) {
    return rateCardResponseSchema.parse(
      await this.request(`${ownerPath(owner)}/rate-card`, { signal }),
    ).rateCard;
  }
  async proposals(
    owner: string,
    query: Record<string, string> = {},
    signal?: AbortSignal,
  ) {
    return proposalListResponseSchema.parse(
      await this.request(
        `${ownerPath(owner)}/proposals?${new URLSearchParams(query)}`,
        { signal },
      ),
    );
  }
  async categories(owner: string, boardId?: string, signal?: AbortSignal) {
    return proposalCategoriesDtoSchema.parse(
      await this.request(
        `${ownerPath(owner)}${boardId === undefined ? "" : `/jira/boards/${encodeURIComponent(boardId)}`}/proposal-categories`,
        { signal },
      ),
    );
  }
  async detail(
    owner: string,
    id: string,
    boardId?: string,
    signal?: AbortSignal,
  ) {
    return proposalDetailResponseSchema.parse(
      await this.request(
        `${ownerPath(owner)}/proposals/${encodeURIComponent(id)}${boardId === undefined ? "" : `?boardId=${encodeURIComponent(boardId)}`}`,
        { signal },
      ),
    );
  }
  async revisions(owner: string, id: string, signal?: AbortSignal) {
    return proposalSpecRevisionsResponseSchema.parse(
      await this.request(
        `${ownerPath(owner)}/proposals/${encodeURIComponent(id)}/spec/revisions`,
        { signal },
      ),
    ).revisions;
  }
  async profile(owner: string, id: string, signal?: AbortSignal) {
    return proposalProfileResponseSchema.parse(
      await this.request(
        `${ownerPath(owner)}/proposals/${encodeURIComponent(id)}/profile`,
        { signal },
      ),
    ).profile;
  }
  async spec(
    owner: string,
    id: string,
    signal?: AbortSignal,
    revision?: number,
  ) {
    return proposalSpecResponseSchema.parse(
      await this.request(
        `${ownerPath(owner)}/proposals/${encodeURIComponent(id)}/spec${revision === undefined ? "" : `?revision=${revision}`}`,
        { signal },
      ),
    );
  }
}
