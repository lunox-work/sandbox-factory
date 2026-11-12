/**
 * The OAuth 2.1 authorization server's tables, owned by Better Auth's
 * `@better-auth/oauth-provider` plugin: clients (most registered
 * dynamically by MCP clients), the protected resources tokens are issued
 * for, consents, and opaque access and refresh tokens. Property names and
 * exported names follow the plugin's model and field names, which its
 * adapter resolves by string (see the note in `schema.ts`).
 *
 * A consent is a **grant**: one person, one client, one organization
 * (`reference_id`), the scopes they approved. Every token carries the same
 * three, and the API admits a token only while its grant stands. Token
 * columns hold a SHA-256 of the value, never the value.
 */

import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { session, user } from "./auth.js";
import { organization } from "./organizations.js";

const at = (name: string) => timestamp(name, { withTimezone: true });

export const oauthClient = pgTable("oauth_client", {
  id: text("id").primaryKey(),
  clientId: text("client_id").notNull().unique(),
  /** Encrypted or hashed by the plugin; null for a public client. */
  clientSecret: text("client_secret"),
  clientDiscoveryId: text("client_discovery_id"),
  disabled: boolean("disabled").default(false),
  skipConsent: boolean("skip_consent"),
  enableEndSession: boolean("enable_end_session"),
  subjectType: text("subject_type"),
  scopes: text("scopes").array(),
  clientCredentialsScopes: text("client_credentials_scopes")
    .array()
    .default([]),
  /** The person who registered it from a session; null when registered openly. */
  userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
  createdAt: at("created_at"),
  updatedAt: at("updated_at"),
  /** `client_name`: what the consent page and the grant list show. */
  name: text("name"),
  uri: text("uri"),
  icon: text("icon"),
  contacts: text("contacts").array(),
  tos: text("tos"),
  policy: text("policy"),
  softwareId: text("software_id"),
  softwareVersion: text("software_version"),
  softwareStatement: text("software_statement"),
  redirectUris: text("redirect_uris").array().notNull(),
  postLogoutRedirectUris: text("post_logout_redirect_uris").array(),
  backchannelLogoutUri: text("backchannel_logout_uri"),
  backchannelLogoutSessionRequired: boolean(
    "backchannel_logout_session_required",
  ),
  tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
  applicationType: text("application_type"),
  jwks: text("jwks"),
  jwksUri: text("jwks_uri"),
  grantTypes: text("grant_types").array(),
  responseTypes: text("response_types").array(),
  requirePKCE: boolean("require_pkce"),
  dpopBoundAccessTokens: boolean("dpop_bound_access_tokens").default(false),
  referenceId: text("reference_id"),
  metadata: jsonb("metadata"),
});

/** A protected resource (RFC 8707): the API's origin and its MCP endpoints. */
export const oauthResource = pgTable("oauth_resource", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull().unique(),
  name: text("name").notNull(),
  accessTokenTtl: integer("access_token_ttl"),
  refreshTokenTtl: integer("refresh_token_ttl"),
  signingAlgorithm: text("signing_algorithm"),
  signingKeyId: text("signing_key_id"),
  allowedScopes: text("allowed_scopes").array(),
  customClaims: jsonb("custom_claims"),
  dpopBoundAccessTokensRequired: boolean(
    "dpop_bound_access_tokens_required",
  ).default(false),
  disabled: boolean("disabled").default(false),
  createdAt: at("created_at"),
  updatedAt: at("updated_at"),
  policyVersion: integer("policy_version").default(1),
  metadata: jsonb("metadata"),
});

/** Which client may ask for which resource, when that is enforced per client. */
export const oauthClientResource = pgTable(
  "oauth_client_resource",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    resourceId: text("resource_id")
      .notNull()
      .references(() => oauthResource.identifier, { onDelete: "cascade" }),
    metadata: jsonb("metadata"),
    createdAt: at("created_at"),
  },
  (table) => [
    uniqueIndex("oauth_client_resource_pair_unique").on(
      table.clientId,
      table.resourceId,
    ),
    index("oauth_client_resource_resource_idx").on(table.resourceId),
  ],
);

export const oauthRefreshToken = pgTable(
  "oauth_refresh_token",
  {
    id: text("id").primaryKey(),
    /** Hex SHA-256 of the token, prefix excluded. */
    token: text("token").notNull().unique(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => session.id, {
      onDelete: "set null",
    }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** The organization the grant binds; it goes with the organization. */
    referenceId: text("reference_id").references(() => organization.id, {
      onDelete: "cascade",
    }),
    authorizationCodeId: text("authorization_code_id"),
    resources: text("resources").array(),
    requestedUserInfoClaims: text("requested_user_info_claims").array(),
    expiresAt: at("expires_at").notNull(),
    createdAt: at("created_at").notNull(),
    revoked: at("revoked"),
    rotatedAt: at("rotated_at"),
    rotationReplayResponse: text("rotation_replay_response"),
    rotationReplayExpiresAt: at("rotation_replay_expires_at"),
    authTime: at("auth_time"),
    confirmation: jsonb("confirmation"),
    scopes: text("scopes").array().notNull(),
  },
  (table) => [
    index("oauth_refresh_token_client_user_idx").on(
      table.clientId,
      table.userId,
    ),
  ],
);

export const oauthAccessToken = pgTable(
  "oauth_access_token",
  {
    id: text("id").primaryKey(),
    /** Hex SHA-256 of the token, prefix excluded: the lookup key per request. */
    token: text("token").notNull().unique(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => session.id, {
      onDelete: "set null",
    }),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    referenceId: text("reference_id").references(() => organization.id, {
      onDelete: "cascade",
    }),
    authorizationCodeId: text("authorization_code_id"),
    resources: text("resources").array(),
    requestedUserInfoClaims: text("requested_user_info_claims").array(),
    refreshId: text("refresh_id").references(() => oauthRefreshToken.id, {
      onDelete: "cascade",
    }),
    expiresAt: at("expires_at").notNull(),
    createdAt: at("created_at").notNull(),
    revoked: at("revoked"),
    confirmation: jsonb("confirmation"),
    scopes: text("scopes").array().notNull(),
  },
  (table) => [
    index("oauth_access_token_client_user_idx").on(
      table.clientId,
      table.userId,
    ),
  ],
);

/**
 * A grant: what one person approved for one client in one organization.
 * Unique per triple, so a token's grant is one row.
 */
export const oauthConsent = pgTable(
  "oauth_consent",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    referenceId: text("reference_id").references(() => organization.id, {
      onDelete: "cascade",
    }),
    resources: text("resources").array(),
    requestedUserInfoClaims: text("requested_user_info_claims").array(),
    scopes: text("scopes").array().notNull(),
    createdAt: at("created_at").notNull(),
    updatedAt: at("updated_at").notNull(),
    /**
     * Ours, not the plugin's: when a token of this grant last reached the
     * API, written at most once a minute by the credential guard.
     */
    lastUsedAt: at("last_used_at"),
  },
  (table) => [
    uniqueIndex("oauth_consent_grant_unique").on(
      table.clientId,
      table.userId,
      table.referenceId,
    ),
    index("oauth_consent_reference_idx").on(table.referenceId),
  ],
);

/** Single-use `private_key_jwt` assertion ids; the row id is the digest. */
export const oauthClientAssertion = pgTable("oauth_client_assertion", {
  id: text("id").primaryKey(),
  expiresAt: at("expires_at").notNull(),
});

export type OAuthClientRow = typeof oauthClient.$inferSelect;
export type OAuthAccessTokenRow = typeof oauthAccessToken.$inferSelect;
export type OAuthConsentRow = typeof oauthConsent.$inferSelect;
