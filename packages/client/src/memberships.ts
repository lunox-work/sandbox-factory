import {
  accountNameResponseSchema,
  accountUsernameResponseSchema,
  invitationCreatedResponseSchema,
  membershipListSchema,
  pendingInvitationListSchema,
  organizationMemberListSchema,
  accountResponseSchema,
  provenEmailListSchema,
} from "@sandbox-factory/shared";
import { ApiClient } from "./transport.js";

export class MembershipClient extends ApiClient {
  async saveName(name: string) {
    return accountNameResponseSchema.parse(
      await this.request("/api/v1/me/name", {
        method: "PUT",
        body: JSON.stringify({ name }),
      }),
    ).name;
  }
  async saveUsername(username: string) {
    return accountUsernameResponseSchema.parse(
      await this.request("/api/v1/me/username", {
        method: "PUT",
        body: JSON.stringify({ username }),
      }),
    ).username;
  }
  async makeEmailPrimary(id: string) {
    await this.request(`/api/v1/me/emails/${encodeURIComponent(id)}/primary`, {
      method: "POST",
    });
  }
  async invite(owner: string, input: { email: string } | { handle: string }) {
    return invitationCreatedResponseSchema.parse(
      await this.request(
        `/api/v1/orgs/${encodeURIComponent(owner)}/invitations`,
        { method: "POST", body: JSON.stringify(input) },
      ),
    ).invitation;
  }
  async memberships(signal?: AbortSignal) {
    return membershipListSchema.parse(
      await this.request("/api/v1/me/orgs", { signal }),
    ).organizations;
  }
  async invitations(signal?: AbortSignal) {
    return pendingInvitationListSchema.parse(
      await this.request("/api/v1/me/invitations", { signal }),
    ).invitations;
  }
  async members(owner: string, signal?: AbortSignal) {
    return organizationMemberListSchema.parse(
      await this.request(`/api/v1/orgs/${encodeURIComponent(owner)}/members`, {
        signal,
      }),
    ).members;
  }
  async account(signal?: AbortSignal) {
    return accountResponseSchema.parse(
      await this.request("/api/v1/me", { signal }),
    ).user;
  }
  async emails(signal?: AbortSignal) {
    return provenEmailListSchema.parse(
      await this.request("/api/v1/me/emails", { signal }),
    ).emails;
  }
}
