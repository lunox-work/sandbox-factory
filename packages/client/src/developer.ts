import {
  apiTokenListSchema,
  apiTokenResponseSchema,
  createdApiTokenResponseSchema,
  oauthGrantListSchema,
  oauthGrantResponseSchema,
  usageResponseSchema,
  type CreateApiTokenInput,
} from "@sandbox-factory/shared";
import { ownerPath } from "./bounties.js";
import { ApiClient } from "./transport.js";

/**
 * The developer portal's reads and writes: a workspace's API tokens, the
 * apps it granted access over OAuth, its usage, and the public API's own
 * OpenAPI document.
 *
 * Tokens and grants are managed from a person's session, owners and admins
 * only; the API refuses a token here. A token's secret comes back once, from
 * `createToken`, and from nowhere else.
 */
export class DeveloperClient extends ApiClient {
  async tokens(owner: string, signal?: AbortSignal) {
    return apiTokenListSchema.parse(
      await this.request(`${ownerPath(owner)}/tokens`, { signal }),
    ).tokens;
  }
  /** Makes a token: the listed token, and its secret, which is not kept. */
  async createToken(owner: string, input: CreateApiTokenInput) {
    return createdApiTokenResponseSchema.parse(
      await this.request(`${ownerPath(owner)}/tokens`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    );
  }
  async revokeToken(owner: string, id: string) {
    return apiTokenResponseSchema.parse(
      await this.request(
        `${ownerPath(owner)}/tokens/${encodeURIComponent(id)}/revoke`,
        { method: "POST" },
      ),
    ).token;
  }
  /** The OAuth apps (MCP clients and others) holding a grant here. */
  async grants(owner: string, signal?: AbortSignal) {
    return oauthGrantListSchema.parse(
      await this.request(`${ownerPath(owner)}/oauth/grants`, { signal }),
    ).grants;
  }
  /** Ends a grant: its tokens stop working and the app must ask again. */
  async revokeGrant(owner: string, id: string) {
    return oauthGrantResponseSchema.parse(
      await this.request(
        `${ownerPath(owner)}/oauth/grants/${encodeURIComponent(id)}/revoke`,
        { method: "POST" },
      ),
    ).grant;
  }
  /** The runs started in the last `days` days, counted by family, kind and state. */
  async usage(owner: string, days: number, signal?: AbortSignal) {
    return usageResponseSchema.parse(
      await this.request(
        `${ownerPath(owner)}/usage?${new URLSearchParams({ days: String(days) }).toString()}`,
        { signal },
      ),
    );
  }
  /**
   * `GET /api/v1/openapi.json`, unparsed beyond being a JSON object: it is
   * generated from the schemas this package already parses with, and the
   * reader only lays it out.
   */
  async openApi(signal?: AbortSignal): Promise<Record<string, unknown>> {
    const document = await this.request("/api/v1/openapi.json", { signal });
    if (
      typeof document !== "object" ||
      document === null ||
      Array.isArray(document)
    ) {
      throw new TypeError("The OpenAPI document is not a JSON object.");
    }
    return document as Record<string, unknown>;
  }
}
