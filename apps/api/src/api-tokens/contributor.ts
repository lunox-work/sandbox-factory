/**
 * A person's own contributor credentials, from their signed-in session:
 *
 * - `GET /api/v1/me/contributor-tokens` lists their contributor tokens,
 *   revoked ones too, never a secret.
 * - `POST /api/v1/me/contributor-tokens` makes one (`lnxc_…`) and answers
 *   its secret, once: what an editor, an agent or a CLI signs in with to
 *   reach the person's contributions and nothing else.
 * - `POST /api/v1/me/contributor-tokens/:id/revoke` stops one working.
 * - `GET /api/v1/me/contributor-grants` and `POST …/:id/revoke`: the apps
 *   (MCP clients) the person let in as a contributor over OAuth, and ending
 *   one, its tokens with it.
 *
 * A person's own session only, whatever workspaces they belong to: a token
 * or OAuth app cannot make, list or revoke credentials (none of these is
 * in the public registry, so the guard refuses them first; the check below
 * is the second layer). The person is the session's, never a path's.
 */

import type {
  ContributorTokenStore,
  OAuthGrantStore,
  StoredContributorToken,
} from "@sandbox-factory/db";
import {
  contributorTokenDtoSchema,
  createContributorTokenSchema,
  type ContributorTokenDto,
} from "@sandbox-factory/shared";
import type { Context, Hono } from "hono";

import type { AuthVariables } from "../http-context.js";
import { toOAuthGrantDto } from "../oauth/grants.js";
import {
  displayPrefix,
  generateContributorSecret,
  hashSecret,
} from "./secret.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export const CONTRIBUTOR_TOKENS_PATH = "/api/v1/me/contributor-tokens";
export const CONTRIBUTOR_GRANTS_PATH = "/api/v1/me/contributor-grants";

export interface ContributorTokenRouteOptions {
  readonly tokens: ContributorTokenStore;
  /** The person's contributor grants; their routes are not mounted without it. */
  readonly grants?: Pick<OAuthGrantStore, "list" | "revoke"> | undefined;
  readonly now?: (() => Date) | undefined;
  readonly generate?: (() => string) | undefined;
}

type Env = { Variables: AuthVariables };

export function toContributorTokenDto(
  token: StoredContributorToken,
): ContributorTokenDto {
  return contributorTokenDtoSchema.parse({
    id: token.id,
    name: token.name,
    prefix: token.prefix,
    createdAt: token.createdAt.toISOString(),
    expiresAt: token.expiresAt?.toISOString() ?? null,
    lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
    revokedAt: token.revokedAt?.toISOString() ?? null,
  });
}

export function mountContributorTokenRoutes(
  app: Hono<Env>,
  options: ContributorTokenRouteOptions,
): void {
  const now = options.now ?? (() => new Date());
  const generate = options.generate ?? generateContributorSecret;

  const refusal = (c: Context<Env>) =>
    c.get("principal").via === "session"
      ? null
      : c.json(
          {
            error: "Contributor tokens are managed from a signed-in session.",
            code: "session_required",
          },
          403,
        );

  app.get(CONTRIBUTOR_TOKENS_PATH, async (c) => {
    const refused = refusal(c);
    if (refused !== null) return refused;
    const tokens = await options.tokens.list(c.get("user").id);
    return c.json({ tokens: tokens.map(toContributorTokenDto) });
  });

  app.post(CONTRIBUTOR_TOKENS_PATH, async (c) => {
    const refused = refusal(c);
    if (refused !== null) return refused;
    const parsed = createContributorTokenSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      return c.json(
        {
          error: parsed.error.issues[0]?.message ?? "Invalid token request.",
          code: "invalid_token_request",
        },
        400,
      );
    const secret = generate();
    const at = now();
    const { expiresInDays } = parsed.data;
    const token = await options.tokens.create(c.get("user").id, {
      name: parsed.data.name,
      prefix: displayPrefix(secret),
      hash: hashSecret(secret),
      expiresAt:
        expiresInDays === null
          ? null
          : new Date(at.getTime() + expiresInDays * DAY_MS),
    });
    // The secret is in this body and nowhere else; keep it out of caches.
    c.header("Cache-Control", "no-store");
    return c.json({ token: toContributorTokenDto(token), secret }, 201);
  });

  app.post(`${CONTRIBUTOR_TOKENS_PATH}/:id/revoke`, async (c) => {
    const refused = refusal(c);
    if (refused !== null) return refused;
    const revoked = await options.tokens.revoke(
      c.get("user").id,
      c.req.param("id"),
    );
    if (revoked === undefined) return c.json({ error: "Not found" }, 404);
    return c.json({ token: toContributorTokenDto(revoked) });
  });

  const { grants } = options;
  if (grants === undefined) return;

  app.get(CONTRIBUTOR_GRANTS_PATH, async (c) => {
    const refused = refusal(c);
    if (refused !== null) return refused;
    const listed = await grants.list({ contributor: c.get("user").id });
    return c.json({ grants: listed.map(toOAuthGrantDto) });
  });

  app.post(`${CONTRIBUTOR_GRANTS_PATH}/:id/revoke`, async (c) => {
    const refused = refusal(c);
    if (refused !== null) return refused;
    const revoked = await grants.revoke(
      { contributor: c.get("user").id },
      c.req.param("id"),
    );
    if (revoked === undefined) return c.json({ error: "Not found" }, 404);
    return c.json({ grant: toOAuthGrantDto(revoked) });
  });
}
