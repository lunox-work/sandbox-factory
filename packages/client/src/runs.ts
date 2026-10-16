import {
  bountyRunResponseSchema,
  bountyRunListResponseSchema,
  flowTypicalResponseSchema,
} from "@sandbox-factory/shared";
import { ApiClient } from "./transport.js";
import { ownerPath } from "./bounties.js";
/**
 * Where a workspace's changes are pushed, as server-sent events: `ready`
 * once it is open, then `change` with `{ kind, id }` for each run or
 * proposal that moved. A path, not a method: the stream is the platform's
 * own (`EventSource` in a browser), which this client does not depend on.
 */
export function runEventsPath(owner: string): string {
  return `${ownerPath(owner)}/events`;
}

export class BountyRunClient extends ApiClient {
  /** The workspace's median wait for each of `flows`; one with none absent. */
  async typicalWaits(
    owner: string,
    flows: readonly string[],
    signal?: AbortSignal,
  ) {
    const query = new URLSearchParams(flows.map((flow) => ["flow", flow]));
    return flowTypicalResponseSchema.parse(
      await this.request(`${ownerPath(owner)}/flows/typical?${query}`, {
        signal,
      }),
    ).flows;
  }
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
  /**
   * Sizes every ticket a board's scan selects: one model call each. Only
   * ever on a person's say-so; connecting a site sizes nothing.
   */
  async start(owner: string, boardId: string, requestId: string) {
    return bountyRunResponseSchema.parse(
      await this.request(
        `${ownerPath(owner)}/jira/boards/${encodeURIComponent(boardId)}/runs`,
        { method: "POST", body: JSON.stringify({ requestId }) },
      ),
    ).run;
  }
}
