import {
  bountyRunResponseSchema,
  bountyRunListResponseSchema,
} from "@sandbox-factory/shared";
import { ApiClient } from "./transport.js";
import { ownerPath } from "./bounties.js";
export class BountyRunClient extends ApiClient {
  async run(owner: string, id: string, signal?: AbortSignal) {
    return bountyRunResponseSchema.parse(
      await this.request(`${ownerPath(owner)}/runs/${encodeURIComponent(id)}`, {
        signal,
      }),
    ).run;
  }
  async runs(owner: string, boardId: string, signal?: AbortSignal) {
    return bountyRunListResponseSchema.parse(
      await this.request(
        `${ownerPath(owner)}/jira/boards/${encodeURIComponent(boardId)}/runs`,
        { signal },
      ),
    );
  }
}
