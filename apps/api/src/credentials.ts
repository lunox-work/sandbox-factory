/**
 * The `/api/v1` guard: turns whatever credential a request carries into a
 * `Principal`, then decides whether that credential may reach the route
 * the request matched.
 *
 * - `Authorization: Bearer lnx_…` is a workspace API token, looked up by
 *   its hash. It must be unrevoked, unexpired, and its creator must still
 *   be an owner or admin of its organization, read now, not when it was
 *   made: demoting or removing the creator stops every token they made.
 * - `Authorization: Bearer lnxat_…` is an OAuth access token the provider
 *   in `oauth/provider.ts` issued, looked up the same way. Its grant (the
 *   consent: person, client, organization) must still stand, and the
 *   person must still be an owner or admin there.
 * - Anything else is Better Auth's to answer, as it always was: the web
 *   app's cookie, or the extension's `bearer()` session token (bare
 *   alphanumerics, never one of the prefixes above). A session a device
 *   sign-in returned is a `device` principal.
 *
 * Admission, by credential:
 *
 * - `session`: every route, unchanged; roles decide the rest.
 * - `device`: only the routes a command-line client needs to mint its
 *   token (`DEVICE_ROUTES`).
 * - `token` and `oauth`: only routes in the public registry, and
 *   only with the scope the registry names for them (a self route names
 *   none: it acts on the presenting credential alone). A route not listed is
 *   refused, whatever the scopes: deny by default. Which organization it
 *   may name is `requireMembership`'s check, in `routes.ts`.
 */

import type { ApiTokenStore, OAuthGrantStore } from "@sandbox-factory/db";
import type { Context, MiddlewareHandler } from "hono";
import { matchedRoutes } from "hono/route";
import { isApiScope } from "sandbox-factory";

import { isAtLeastAdmin } from "./access.js";
import { bearerApiToken, hashSecret } from "./api-tokens/secret.js";
import type { Auth } from "./auth.js";
import type { AuthVariables } from "./http-context.js";
import { bearerOAuthToken, hashOAuthToken } from "./oauth/provider.js";
import { sessionPrincipal, type Principal } from "./principal.js";
import { publicRoute } from "./public-api/registry.js";

/** A use is recorded at most this often per token or grant. */
export const LAST_USED_RESOLUTION_MS = 60_000;

/** What a device sign-in's session may reach: who am I, where, mint. */
export const DEVICE_ROUTES: ReadonlySet<string> = new Set([
  "GET /api/v1/me",
  "GET /api/v1/me/orgs",
  "POST /api/v1/orgs/:orgId/tokens/cli",
]);

export interface CredentialOptions {
  readonly auth: Pick<Auth, "api">;
  /** Without it, every API token is refused. */
  readonly apiTokens?: Pick<ApiTokenStore, "findByHash" | "touch"> | undefined;
  /** Without it, every OAuth access token is refused. */
  readonly oauthGrants?:
    Pick<OAuthGrantStore, "findAccessToken" | "touch"> | undefined;
  /**
   * The protected-resource metadata URL (RFC 9728) a refused bearer is
   * pointed at, so an OAuth client knows where to sign in again.
   */
  readonly resourceMetadata?: string | undefined;
  /** The acting role, read at use. Without it, every bound token is refused. */
  readonly roleOf?:
    | ((userId: string, organizationId: string) => Promise<string | undefined>)
    | undefined;
  readonly now?: (() => Date) | undefined;
}

type Env = { Variables: AuthVariables };

/** The Hono pattern and method that will answer, if a specific route does. */
export function answeringRoute(
  c: Context,
): { method: string; path: string } | undefined {
  // Hono answers HEAD with the GET route.
  const method = c.req.method === "HEAD" ? "GET" : c.req.method;
  // Middleware and `app.all` fallbacks are registered as ALL; the first
  // route registered for the method is the one that answers.
  const found = matchedRoutes(c).find((route) => route.method === method);
  return found === undefined ? undefined : { method, path: found.path };
}

const INVALID_TOKEN = {
  error: "This API token is not valid.",
  code: "invalid_token",
} as const;

const INVALID_ACCESS_TOKEN = {
  error: "This access token is not valid. Sign in again.",
  code: "invalid_token",
} as const;

/** Whether a use at `at` should be recorded over one at `last`. */
function stale(last: Date | null, at: Date): Date | undefined {
  const staleBefore = new Date(at.getTime() - LAST_USED_RESOLUTION_MS);
  return last === null || last < staleBefore ? staleBefore : undefined;
}

export function credentialGuard(
  options: CredentialOptions,
): MiddlewareHandler<Env> {
  const now = options.now ?? (() => new Date());

  async function tokenPrincipal(
    secret: string,
  ): Promise<Principal | undefined> {
    const { apiTokens, roleOf } = options;
    if (apiTokens === undefined || roleOf === undefined) return undefined;
    const found = await apiTokens.findByHash(hashSecret(secret));
    const at = now();
    if (
      found === undefined ||
      found.revokedAt !== null ||
      (found.expiresAt !== null && found.expiresAt.getTime() <= at.getTime())
    )
      return undefined;
    const role = await roleOf(found.createdBy.id, found.organizationId);
    if (role === undefined || !isAtLeastAdmin(role)) return undefined;
    const staleBefore = stale(found.lastUsedAt, at);
    if (staleBefore !== undefined) {
      // Not awaited: bookkeeping must not slow or fail the request.
      apiTokens
        .touch(found.organizationId, found.id, at, staleBefore)
        .catch((error: unknown) => {
          console.error("Failed to record an API token's use", error);
        });
    }
    return {
      user: found.createdBy,
      organizationId: found.organizationId,
      scopes: found.scopes,
      via: "token",
      credentialId: found.id,
      role,
    };
  }

  /** An OAuth access token's principal: its grant's person, workspace and scopes. */
  async function oauthPrincipal(value: string): Promise<Principal | undefined> {
    const { oauthGrants, roleOf } = options;
    if (oauthGrants === undefined || roleOf === undefined) return undefined;
    const found = await oauthGrants.findAccessToken(hashOAuthToken(value));
    const at = now();
    if (found === undefined || found.expiresAt.getTime() <= at.getTime())
      return undefined;
    const role = await roleOf(found.user.id, found.organizationId);
    if (role === undefined || !isAtLeastAdmin(role)) return undefined;
    const staleBefore = stale(found.grantLastUsedAt, at);
    if (staleBefore !== undefined) {
      oauthGrants
        .touch(found.organizationId, found.grantId, at, staleBefore)
        .catch((error: unknown) => {
          console.error("Failed to record an OAuth grant's use", error);
        });
    }
    return {
      user: found.user,
      organizationId: found.organizationId,
      // `offline_access` reaches no route; only the API's scopes count.
      scopes: found.scopes.filter(isApiScope),
      via: "oauth",
      credentialId: found.id,
      client: found.clientId,
      role,
    };
  }

  /** The refusal for a bearer that names a credential no longer valid. */
  function invalid(
    c: Context<Env>,
    body: typeof INVALID_TOKEN | typeof INVALID_ACCESS_TOKEN,
  ) {
    c.header(
      "WWW-Authenticate",
      options.resourceMetadata === undefined
        ? 'Bearer error="invalid_token"'
        : `Bearer resource_metadata="${options.resourceMetadata}", error="invalid_token"`,
    );
    return c.json(body, 401);
  }

  return async (c, next) => {
    let principal: Principal;
    const authorization = c.req.header("authorization");
    const secret = bearerApiToken(authorization);
    const accessToken = bearerOAuthToken(authorization);
    if (secret !== undefined) {
      const resolved = await tokenPrincipal(secret);
      if (resolved === undefined) return invalid(c, INVALID_TOKEN);
      principal = resolved;
    } else if (accessToken !== undefined) {
      const resolved = await oauthPrincipal(accessToken);
      if (resolved === undefined) return invalid(c, INVALID_ACCESS_TOKEN);
      principal = resolved;
    } else {
      const session = await options.auth.api.getSession({
        headers: c.req.raw.headers,
      });
      if (session === null) {
        return c.json({ error: "Authentication required." }, 401);
      }
      const { deviceClientId } = session.session as {
        deviceClientId?: string | null;
      };
      principal = sessionPrincipal(
        {
          id: session.user.id,
          email: session.user.email,
          name: session.user.name,
        },
        session.session.id,
        deviceClientId ?? null,
      );
    }

    const refusal = admit(principal, answeringRoute(c));
    if (refusal !== undefined) return c.json(refusal, 403);

    c.set("principal", principal);
    c.set("user", principal.user);
    c.set("sessionId", principal.credentialId);
    await next();
    return;
  };
}

/** Why `principal` may not reach `route`, or undefined when it may. */
export function admit(
  principal: Principal,
  route: { method: string; path: string } | undefined,
): { error: string; code: string } | undefined {
  if (principal.via === "session") return undefined;
  const key = route === undefined ? undefined : `${route.method} ${route.path}`;
  if (principal.via === "device") {
    return key !== undefined && DEVICE_ROUTES.has(key)
      ? undefined
      : {
          error: "A device sign-in may only mint its client's API token.",
          code: "device_session",
        };
  }
  // A bound credential: `token` or `oauth`.
  const declared =
    route === undefined ? undefined : publicRoute(route.method, route.path);
  if (declared === undefined) {
    return {
      error: "This route is not part of the public API.",
      code: "not_public",
    };
  }
  // A self route needs no scope: it can only reach the credential itself.
  if (declared.scope !== null && !principal.scopes.includes(declared.scope)) {
    return {
      error: `This credential lacks the ${declared.scope} scope.`,
      code: "insufficient_scope",
    };
  }
  return undefined;
}
