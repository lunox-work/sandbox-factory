import {
  proposalActionResponseSchema,
  ticketListResponseSchema,
  ticketResponseSchema,
  type CreateTicketInput,
  type UpdateTicketInput,
} from "@sandbox-factory/shared";
import { ApiClient } from "./transport.js";
export const ownerPath = (owner: string) =>
  `/api/v1/orgs/${encodeURIComponent(owner)}`;
export class TicketClient extends ApiClient {
  async proposeTicket(
    owner: string,
    id: string,
    requestId: string,
    signal?: AbortSignal,
  ) {
    return proposalActionResponseSchema.parse(
      await this.request(
        `${ownerPath(owner)}/tickets/${encodeURIComponent(id)}/propose`,
        {
          method: "POST",
          body: JSON.stringify({ requestId }),
          ...(signal === undefined ? {} : { signal }),
        },
      ),
    );
  }
  async tickets(
    owner: string,
    query: { limit?: number; cursor?: string } = {},
    signal?: AbortSignal,
  ) {
    const params = new URLSearchParams();
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    if (query.cursor !== undefined) params.set("cursor", query.cursor);
    return ticketListResponseSchema.parse(
      await this.request(`${ownerPath(owner)}/tickets?${params}`, { signal }),
    );
  }
  async ticket(owner: string, id: string, signal?: AbortSignal) {
    return ticketResponseSchema.parse(
      await this.request(
        `${ownerPath(owner)}/tickets/${encodeURIComponent(id)}`,
        { signal },
      ),
    ).ticket;
  }
  async createTicket(owner: string, input: CreateTicketInput) {
    return ticketResponseSchema.parse(
      await this.request(`${ownerPath(owner)}/tickets`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    ).ticket;
  }
  async updateTicket(owner: string, id: string, input: UpdateTicketInput) {
    return ticketResponseSchema.parse(
      await this.request(
        `${ownerPath(owner)}/tickets/${encodeURIComponent(id)}`,
        { method: "PATCH", body: JSON.stringify(input) },
      ),
    ).ticket;
  }
  async deleteTicket(owner: string, id: string) {
    await this.request(
      `${ownerPath(owner)}/tickets/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  }
}
