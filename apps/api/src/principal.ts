/**
 * Who is asking, and with what: the one shape every credential resolves to.
 *
 * - `session`: the web app's cookie, or the extension's `bearer()` session
 *   token. Bound to no organization; a route takes it from the path and
 *   checks membership. Holds every scope, so only roles limit it.
 * - `token`: a workspace API token (`lnx_…`). Bound to the organization it
 *   was made in, holding the scopes it was given, acting as its creator
 *   while they stay owner or admin there.
 * - `device`: the session a command-line client's device sign-in returned.
 *   It may only mint that client's token (`api-tokens/routes.ts`).
 * - `oauth`: an OAuth access token (`lnxat_…`) from the provider in
 *   `oauth/provider.ts`. Resolves like `token`: the organization and scopes
 *   its grant was consented to, acting as the person who consented while
 *   they stay owner or admin there.
 *
 * Bound credentials (`token`, `oauth`) reach only the routes the public
 * registry declares, with the scope declared there; see `credentials.ts`.
 */

import { API_SCOPES, type ApiScope } from "sandbox-factory";

export type CredentialKind = "session" | "token" | "oauth" | "device";

export interface Principal {
  readonly user: { id: string; email: string; name: string };
  /** The organization a bound credential belongs to; null for a session. */
  readonly organizationId: string | null;
  readonly scopes: readonly ApiScope[];
  readonly via: CredentialKind;
  /** The credential itself: a session's id, or a token's. */
  readonly credentialId: string;
  /**
   * A device session's client (`duediligence`, `carveout`), or an OAuth
   * token's client id.
   */
  readonly client?: string | undefined;
  /** A bound credential's acting role, read when it was presented. */
  readonly role?: string | undefined;
}

/** Whether a credential belongs to one organization and carries scopes. */
export function isBound(principal: Principal): boolean {
  return principal.via === "token" || principal.via === "oauth";
}

/** A signed-in person's session: every scope, no organization. */
export function sessionPrincipal(
  user: Principal["user"],
  sessionId: string,
  deviceClient: string | null,
): Principal {
  return deviceClient === null
    ? {
        user,
        organizationId: null,
        scopes: API_SCOPES,
        via: "session",
        credentialId: sessionId,
      }
    : {
        user,
        organizationId: null,
        scopes: [],
        via: "device",
        credentialId: sessionId,
        client: deviceClient,
      };
}
