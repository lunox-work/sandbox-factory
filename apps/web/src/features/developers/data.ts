/**
 * The developer portal's server reads, under the same user- and
 * owner-scoped keys as every other read (`data/query.tsx`).
 *
 * The client is the portal's own instance of `DeveloperClient`, built the
 * way the shared ones are: same origin, fetch resolved at call time so the
 * tests' stub reaches it.
 */

import { ApiError, DeveloperClient } from "@sandbox-factory/client";
import type {
  ApiTokenDto,
  CreateApiTokenInput,
  OAuthGrantDto,
} from "@sandbox-factory/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { queryKeys, useOwnerQuery, useUserId } from "../../data/query";

export const developer = new DeveloperClient({
  baseUrl: "",
  fetch: ((input, init) => globalThis.fetch(input, init)) as typeof fetch,
});

/** What a failed write says, in the API's words when it gave some. */
export function failureText(error: unknown, fallback: string): string {
  return error instanceof ApiError && error.status !== 404
    ? error.message
    : fallback;
}

export function useApiTokens(owner: string) {
  const query = useOwnerQuery(owner, "api-tokens", (id, signal) =>
    developer.tokens(id, signal),
  );
  /** Makes a token and lists it; the secret is handed back, never cached. */
  async function create(input: CreateApiTokenInput) {
    const created = await developer.createToken(owner, input);
    query.setData((current) => [created.token, ...(current ?? [])]);
    return created;
  }
  async function revoke(id: string) {
    const revoked = await developer.revokeToken(owner, id);
    query.setData((current) =>
      (current ?? []).map((token) => (token.id === id ? revoked : token)),
    );
    return revoked;
  }
  return { ...query, create, revoke };
}

/**
 * The OAuth grants, or `null` when this server has no grants route: a 404
 * from the list is the route missing (membership is already settled by the
 * shell), which reads as "not available yet" rather than as a failure.
 */
export function useOAuthGrants(owner: string) {
  const query = useOwnerQuery<OAuthGrantDto[] | null>(
    owner,
    "oauth-grants",
    async (id, signal) => {
      try {
        return await developer.grants(id, signal);
      } catch (error) {
        if (error instanceof ApiError && error.isNotFound) return null;
        throw error;
      }
    },
  );
  async function revoke(id: string) {
    await developer.revokeGrant(owner, id);
    // Revoking ends the grant; it leaves the list.
    query.setData((current) =>
      current === null || current === undefined
        ? (current ?? null)
        : current.filter((grant) => grant.id !== id),
    );
  }
  return { ...query, revoke };
}

/** Runs in the last `days` days. The previous window stays up while the next loads. */
export function useUsage(owner: string, days: number) {
  const userId = useUserId();
  return useQuery({
    queryKey: queryKeys.resource(userId, owner, "usage", days),
    queryFn: ({ signal }) => developer.usage(owner, days, signal),
    placeholderData: keepPreviousData,
  });
}

/**
 * The public API's OpenAPI document. The same for every workspace and every
 * deploy's lifetime, so read once per session.
 */
export function useOpenApiDocument() {
  const userId = useUserId();
  return useQuery({
    queryKey: queryKeys.me(userId, "openapi"),
    queryFn: ({ signal }) => developer.openApi(signal),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** Whether a token works now: neither revoked nor past its expiry. */
export function tokenState(
  token: ApiTokenDto,
  now: Date = new Date(),
): "active" | "revoked" | "expired" {
  if (token.revokedAt !== null) return "revoked";
  if (token.expiresAt !== null && new Date(token.expiresAt) <= now) {
    return "expired";
  }
  return "active";
}
