/**
 * Workspace API tokens, behind the membership guard:
 *
 * - `GET .../tokens` lists them, revoked ones too, never a secret.
 * - `POST .../tokens` makes one and answers its secret, once.
 * - `POST .../tokens/:id/revoke` stops one working.
 * - `POST .../tokens/cli` mints a command-line client's token with the
 *   session its device sign-in returned, then ends that session.
 *
 * Owners and admins only, and never with a token: a token cannot make,
 * list or revoke tokens. The first three take a person's own session (the
 * guard already refuses tokens and device sessions here, since none of
 * these is in the public registry; the check below is the second layer).
 * The last takes only a device session.
 */

import type { ApiTokenStore, StoredApiToken } from "@sandbox-factory/db";
import {
  apiTokenDtoSchema,
  createApiTokenSchema,
  createCliTokenSchema,
  type ApiTokenDto,
} from "@sandbox-factory/shared";
import type { Context, Hono } from "hono";
import { cliScopes, type ApiScope } from "sandbox-factory";

import { isAtLeastAdmin } from "../access.js";
import type { AuthVariables } from "../http-context.js";
import { displayPrefix, generateSecret, hashSecret } from "./secret.js";

/** How long a command-line client's token lasts before it signs in again. */
export const CLI_TOKEN_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ApiTokenRouteOptions {
  readonly tokens: ApiTokenStore;
  /**
   * Ends the device session that minted a CLI token, so it cannot mint
   * another. Given the request's headers, which carry its bearer token.
   */
  readonly endSession?: ((headers: Headers) => Promise<unknown>) | undefined;
  readonly now?: (() => Date) | undefined;
  readonly generate?: (() => string) | undefined;
}

type Env = { Variables: AuthVariables };

export function toApiTokenDto(token: StoredApiToken): ApiTokenDto {
  return apiTokenDtoSchema.parse({
    id: token.id,
    name: token.name,
    prefix: token.prefix,
    scopes: token.scopes,
    createdBy: token.createdBy,
    createdAt: token.createdAt.toISOString(),
    expiresAt: token.expiresAt?.toISOString() ?? null,
    lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
    revokedAt: token.revokedAt?.toISOString() ?? null,
  });
}

export function mountApiTokenRoutes(
  app: Hono<Env>,
  options: ApiTokenRouteOptions,
): void {
  const base = "/api/v1/orgs/:orgId/tokens";
  const now = options.now ?? (() => new Date());
  const generate = options.generate ?? generateSecret;

  /** Why the caller may not manage tokens here, or null when they may. */
  function refusal(c: Context<Env>, via: "session" | "device") {
    if (c.get("principal").via !== via) {
      return c.json(
        via === "session"
          ? {
              error: "API tokens are managed from a signed-in session.",
              code: "session_required",
            }
          : {
              error:
                "Mint a CLI token with the session a device sign-in returned.",
              code: "device_session_required",
            },
        403,
      );
    }
    if (!isAtLeastAdmin(c.get("member").role)) {
      return c.json(
        { error: "Only owners and admins can manage API tokens." },
        403,
      );
    }
    return null;
  }

  async function issue(
    c: Context<Env>,
    input: { name: string; scopes: readonly ApiScope[]; days: number | null },
  ) {
    const secret = generate();
    const at = now();
    const token = await options.tokens.create(c.get("member").organizationId, {
      createdBy: c.get("user").id,
      name: input.name,
      prefix: displayPrefix(secret),
      hash: hashSecret(secret),
      scopes: input.scopes,
      expiresAt:
        input.days === null
          ? null
          : new Date(at.getTime() + input.days * DAY_MS),
    });
    // The secret is in this body and nowhere else; keep it out of caches.
    c.header("Cache-Control", "no-store");
    return c.json({ token: toApiTokenDto(token), secret }, 201);
  }

  app.get(base, async (c) => {
    const refused = refusal(c, "session");
    if (refused !== null) return refused;
    const tokens = await options.tokens.list(c.get("member").organizationId);
    return c.json({ tokens: tokens.map(toApiTokenDto) });
  });

  app.post(base, async (c) => {
    const refused = refusal(c, "session");
    if (refused !== null) return refused;
    const parsed = createApiTokenSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json(
        {
          error: parsed.error.issues[0]?.message ?? "Invalid token request.",
          code: "invalid_token_request",
        },
        400,
      );
    }
    return issue(c, {
      name: parsed.data.name,
      scopes: parsed.data.scopes,
      days: parsed.data.expiresInDays ?? null,
    });
  });

  app.post(`${base}/cli`, async (c) => {
    const refused = refusal(c, "device");
    if (refused !== null) return refused;
    const parsed = createCliTokenSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json(
        {
          error: parsed.error.issues[0]?.message ?? "Invalid token request.",
          code: "invalid_token_request",
        },
        400,
      );
    }
    const { client, label } = parsed.data;
    if (client !== c.get("principal").client) {
      return c.json(
        {
          error: "This sign-in was approved for another client.",
          code: "client_mismatch",
        },
        403,
      );
    }
    const allowed = cliScopes(client);
    const scopes = parsed.data.scopes ?? allowed;
    const extra = scopes.filter((scope) => !allowed.includes(scope));
    if (extra.length > 0) {
      return c.json(
        {
          error: `${client} may not hold ${extra.join(", ")}.`,
          code: "invalid_scope",
        },
        400,
      );
    }
    const response = await issue(c, {
      name: label === undefined ? `${client} CLI` : `${client} CLI on ${label}`,
      scopes,
      days: CLI_TOKEN_DAYS,
    });
    try {
      await options.endSession?.(c.req.raw.headers);
    } catch (error) {
      // The token is made; a session left over expires on its own.
      console.error("Failed to end a device session", error);
    }
    return response;
  });

  app.post(`${base}/:id/revoke`, async (c) => {
    const refused = refusal(c, "session");
    if (refused !== null) return refused;
    const revoked = await options.tokens.revoke(
      c.get("member").organizationId,
      c.req.param("id"),
    );
    if (revoked === undefined) return c.json({ error: "Not found" }, 404);
    return c.json({ token: toApiTokenDto(revoked) });
  });
}
