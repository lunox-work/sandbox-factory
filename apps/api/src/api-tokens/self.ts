/**
 * `POST /api/v1/tokens/self/revoke`: a bound credential ends itself. What a
 * command-line client's `logout` and an app's sign-out call.
 *
 * It names nothing: the credential revoked is the one presenting the
 * request, read from the principal the guard resolved, so no body, path or
 * scope can point it at another. A self route in the registry (no scope
 * needed). An API token is revoked as its workspace's list would revoke
 * it; an OAuth access token is revoked with the refresh token it came
 * with, while the grant stands (revoking that is a person's act, from
 * connected apps). The next request with it is 401.
 *
 * A session has nothing to revoke here; it signs out through Better Auth.
 */

import type { ApiTokenStore, OAuthGrantStore } from "@sandbox-factory/db";
import type { Hono } from "hono";

import type { AuthVariables } from "../http-context.js";

export const SELF_REVOKE_PATH = "/api/v1/tokens/self/revoke";

export interface SelfRevokeOptions {
  readonly tokens?: Pick<ApiTokenStore, "revoke"> | undefined;
  readonly grants?: Pick<OAuthGrantStore, "revokeAccessToken"> | undefined;
}

type Env = { Variables: AuthVariables };

export function mountSelfRevokeRoute(
  app: Hono<Env>,
  { tokens, grants }: SelfRevokeOptions,
): void {
  app.post(SELF_REVOKE_PATH, async (c) => {
    const principal = c.get("principal");
    const { organizationId, credentialId } = principal;
    if (organizationId === null) {
      return c.json(
        {
          error:
            "Only an API token or OAuth access token revokes itself; a session signs out.",
          code: "bound_credential_required",
        },
        403,
      );
    }
    const revoked =
      principal.via === "token"
        ? (await tokens?.revoke(organizationId, credentialId)) !== undefined
        : principal.via === "oauth"
          ? ((await grants?.revokeAccessToken(organizationId, credentialId)) ??
            false)
          : false;
    // Unreachable while the guard resolved it from the same stores; a 404
    // keeps a torn state from reading as done.
    if (!revoked) return c.json({ error: "Not found" }, 404);
    return c.body(null, 204);
  });
}
