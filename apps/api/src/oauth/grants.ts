/**
 * Connected apps: the OAuth grants a workspace has given, behind the
 * membership guard.
 *
 * - `GET .../oauth/grants` lists them: the client, who approved it, the
 *   scopes, when it was approved and last used. Never a token.
 * - `POST .../oauth/grants/:id/revoke` ends one: its tokens stop working at
 *   once and the app must ask for consent again.
 *
 * Owners and admins, from a person's own session. Not in the public
 * registry, so a token or an OAuth app cannot list or revoke grants (the
 * guard refuses them first; the check below is the second layer).
 */

import type { OAuthGrant, OAuthGrantStore } from "@sandbox-factory/db";
import {
  oauthGrantDtoSchema,
  type OAuthGrantDto,
} from "@sandbox-factory/shared";
import type { Context, Hono } from "hono";

import { isAtLeastAdmin } from "../access.js";
import type { AuthVariables } from "../http-context.js";

type Env = { Variables: AuthVariables };

export function toOAuthGrantDto(grant: OAuthGrant): OAuthGrantDto {
  return oauthGrantDtoSchema.parse({
    id: grant.id,
    client: grant.client,
    user: grant.user,
    scopes: grant.scopes,
    createdAt: grant.createdAt.toISOString(),
    updatedAt: grant.updatedAt.toISOString(),
    lastUsedAt: grant.lastUsedAt?.toISOString() ?? null,
  });
}

export function mountOAuthGrantRoutes(
  app: Hono<Env>,
  { grants }: { grants: Pick<OAuthGrantStore, "list" | "revoke"> },
): void {
  const base = "/api/v1/orgs/:orgId/oauth/grants";

  function refusal(c: Context<Env>) {
    if (c.get("principal").via !== "session") {
      return c.json(
        {
          error: "Connected apps are managed from a signed-in session.",
          code: "session_required",
        },
        403,
      );
    }
    if (!isAtLeastAdmin(c.get("member").role)) {
      return c.json(
        { error: "Only owners and admins can manage connected apps." },
        403,
      );
    }
    return null;
  }

  app.get(base, async (c) => {
    const refused = refusal(c);
    if (refused !== null) return refused;
    const listed = await grants.list(c.get("member").organizationId);
    return c.json({ grants: listed.map(toOAuthGrantDto) });
  });

  app.post(`${base}/:id/revoke`, async (c) => {
    const refused = refusal(c);
    if (refused !== null) return refused;
    const revoked = await grants.revoke(
      c.get("member").organizationId,
      c.req.param("id"),
    );
    if (revoked === undefined) return c.json({ error: "Not found" }, 404);
    return c.json({ grant: toOAuthGrantDto(revoked) });
  });
}
