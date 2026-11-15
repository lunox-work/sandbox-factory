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
 *   they stay owner or admin there. A grant made as a contributor binds no
 *   organization and resolves like `contributor` instead (`contributor`).
 * - `contributor`: a contributor token (`lnxc_…`), a person's own. No
 *   organization and no role: it acts as that person on the versions they
 *   were invited to, which their assignments decide, route by route.
 *
 * Bound credentials (`token`, `oauth`, `contributor`) reach only the routes
 * the public registry declares, with the scope declared there; a
 * contributor credential only the contributor routes, a workspace one only
 * the workspace's (`credentials.ts`).
 */

import { API_SCOPES, type CredentialScope } from "sandbox-factory";

export type CredentialKind =
  "session" | "token" | "oauth" | "device" | "contributor";

export interface Principal {
  readonly user: { id: string; email: string; name: string };
  /**
   * The organization a workspace credential belongs to; null for a session
   * and for a contributor credential.
   */
  readonly organizationId: string | null;
  readonly scopes: readonly CredentialScope[];
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
  /**
   * A contributor credential: an `lnxc_` token, or an OAuth grant made as
   * a contributor. It reaches the contributor routes alone.
   */
  readonly contributor?: true | undefined;
}

/**
 * Whether a credential is bound: it carries scopes, reaches only the
 * public registry's routes, and names its own organization or none.
 */
export function isBound(principal: Principal): boolean {
  return (
    principal.via === "token" ||
    principal.via === "oauth" ||
    principal.via === "contributor"
  );
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
