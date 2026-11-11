/**
 * The public API's credentials and what they read about themselves:
 * workspace API tokens, the token a command-line client mints after its
 * device sign-in, and the workspace's usage.
 */

import {
  API_SCOPES,
  API_TOKEN_PREFIX,
  CLI_CLIENTS,
  type CliClient,
} from "sandbox-factory";
import { z } from "zod";

export const apiScopeSchema = z.enum(API_SCOPES);

/** One or more scopes, each once. */
export const apiScopeListSchema = z
  .array(apiScopeSchema)
  .min(1)
  .max(API_SCOPES.length)
  .refine((scopes) => new Set(scopes).size === scopes.length, {
    message: "Name each scope once.",
  });

/** A workspace API token as listed: never its secret, which is not kept. */
export const apiTokenDtoSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** The secret's first characters, `lnx_` included, to tell tokens apart. */
  prefix: z.string().startsWith(API_TOKEN_PREFIX),
  scopes: z.array(apiScopeSchema),
  /** Who made it. The token acts as them, while they stay owner or admin. */
  createdBy: z.object({ id: z.string().min(1), name: z.string() }),
  createdAt: z.iso.datetime(),
  /** Null for a token that does not expire. */
  expiresAt: z.iso.datetime().nullable(),
  /** Updated at most once a minute. */
  lastUsedAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
});

export const apiTokenListSchema = z.object({
  tokens: z.array(apiTokenDtoSchema),
});

export const apiTokenResponseSchema = z.object({ token: apiTokenDtoSchema });

/** Body for `POST /api/v1/orgs/:orgId/tokens`. */
export const createApiTokenSchema = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: apiScopeListSchema,
  /** Days until it stops working; absent or null for never. */
  expiresInDays: z.number().int().min(1).max(366).nullable().optional(),
});

/** The one response that carries a token's secret. */
export const createdApiTokenResponseSchema = z.object({
  token: apiTokenDtoSchema,
  secret: z.string().startsWith(API_TOKEN_PREFIX),
});

export const cliClientSchema = z.enum(
  Object.keys(CLI_CLIENTS) as [CliClient, ...CliClient[]],
);

/**
 * Body for `POST /api/v1/orgs/:orgId/tokens/cli`, sent with the session a
 * device sign-in returned. `scopes` defaults to all the client may hold.
 */
export const createCliTokenSchema = z.object({
  client: cliClientSchema,
  scopes: apiScopeListSchema.optional(),
  /** Where it runs, e.g. a host name, to tell a person's tokens apart. */
  label: z.string().trim().min(1).max(60).optional(),
});

/** Query for `GET /api/v1/orgs/:orgId/usage`. */
export const usageQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
});

export const RUN_FAMILIES = ["sizing", "analysis"] as const;

/** Runs started in a window, counted by family, kind and state. */
export const usageResponseSchema = z.object({
  window: z.object({
    from: z.iso.datetime(),
    to: z.iso.datetime(),
    days: z.number().int().positive(),
  }),
  runs: z.array(
    z.object({
      /** `sizing`: bounty runs; `analysis`: repository and sandbox runs. */
      family: z.enum(RUN_FAMILIES),
      /** A sizing run's kind, or an analysis run's tool. */
      kind: z.string(),
      status: z.string(),
      count: z.number().int().nonnegative(),
    }),
  ),
});

export type ApiScopeDto = z.infer<typeof apiScopeSchema>;
export type ApiTokenDto = z.infer<typeof apiTokenDtoSchema>;
export type CreateApiTokenInput = z.infer<typeof createApiTokenSchema>;
export type CreatedApiTokenDto = z.infer<typeof createdApiTokenResponseSchema>;
export type CreateCliTokenInput = z.infer<typeof createCliTokenSchema>;
export type UsageDto = z.infer<typeof usageResponseSchema>;
