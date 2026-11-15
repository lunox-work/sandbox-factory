/**
 * The OAuth 2.1 authorization server: Better Auth's maintained
 * `@better-auth/oauth-provider` plugin, configured so an MCP client (Claude
 * Code, Cursor) can register itself, send a person through sign-in and
 * consent in the browser, and call the public API with what it gets back.
 *
 * - Authorization code with PKCE (S256 only, the plugin's rule), refresh
 *   tokens on `offline_access`, opaque access tokens that live
 *   `ACCESS_TOKEN_SECONDS`. No client-credentials grant: every token acts
 *   as a person.
 * - Open dynamic client registration, public clients included, as MCP
 *   clients need. Clients cannot be managed from a session; people manage
 *   grants, not clients.
 * - **A grant binds one organization**, or none for a contributor. The
 *   consent page sends the chosen workspace in `ORGANIZATION_HEADER`;
 *   `consentReferenceId` admits it only for an owner or admin there and
 *   stores it as the consent's and every token's `reference_id`. Sent
 *   `CONTRIBUTOR_CONSENT` instead, the person signs in as an invited
 *   contributor: the grant holds `contributions:write` and nothing else and
 *   binds no workspace (`reference_id` stays empty: it is a foreign key to
 *   `organization`, so it cannot carry a marker). A workspace grant never
 *   holds the contributor scope. The API's credential guard reads the token
 *   back into a `Principal` (`credentials.ts`), a contributor grant as a
 *   contributor credential.
 * - Tokens carry prefixes (`lnxat_`, `lnxrt_`) and are stored as the same
 *   SHA-256 the API looks them up by. Sign-in itself is unchanged: the
 *   login page is the web app's, which offers Google, GitHub and Atlassian.
 */

import { tryGetCurrentAuthEndpointContext } from "@better-auth/core/context";
import { oauthProvider } from "@better-auth/oauth-provider";
import { APIError } from "better-auth";
import {
  API_SCOPES,
  CONTRIBUTOR_CONSENT,
  CONTRIBUTOR_SCOPES,
  isApiScope,
  isContributorScope,
  MCP_TOOLSETS,
  OAUTH_ACCESS_TOKEN_PREFIX,
  OAUTH_REFRESH_TOKEN_PREFIX,
  OFFLINE_ACCESS_SCOPE,
} from "sandbox-factory";

import { isAtLeastAdmin } from "../access.js";
import { hashSecret } from "../api-tokens/secret.js";

/** The request header the consent page names the chosen workspace in. */
export const ORGANIZATION_HEADER = "x-lunox-organization";

/** Where the web app asks for sign-in and consent. */
export const CONSENT_PATH = "/oauth/consent";

/** An access token's life; a client refreshes rather than holds one long. */
export const ACCESS_TOKEN_SECONDS = 15 * 60;

/** Every scope a client may ask for: the API's, a contributor's, and refresh. */
export const OAUTH_SCOPES = [
  ...API_SCOPES,
  ...CONTRIBUTOR_SCOPES,
  OFFLINE_ACCESS_SCOPE,
];

/** The MCP endpoints, each a toolset; see `mcp/`. */
export const MCP_PATHS = Object.keys(MCP_TOOLSETS);

export type RoleOf = (
  userId: string,
  organizationId: string,
) => Promise<string | undefined>;

export interface OAuthProviderConfig {
  /** Public origin of the API, e.g. `https://platform.lunox.work`. */
  readonly baseUrl: string;
  /** Public origin of the web app, which serves the consent page. */
  readonly appUrl: string;
  /** The person's role in a workspace. Without it, no consent is granted. */
  readonly roleOf?: RoleOf | undefined;
}

/** The API's public origin, without a path. */
export function publicOrigin(baseUrl: string): string {
  return new URL(baseUrl).origin;
}

/** Better Auth's issuer: its base URL with the `/api/auth` base path. */
export function issuerOf(baseUrl: string): string {
  return `${publicOrigin(baseUrl)}/api/auth`;
}

/**
 * The protected resources tokens are issued for (RFC 8707): the API's
 * origin, which every route under it shares, and each MCP endpoint. An MCP
 * client names its endpoint; the token then works on every one of them,
 * since each calls the same API.
 */
export function oauthResources(baseUrl: string): string[] {
  const origin = publicOrigin(baseUrl);
  return [origin, ...MCP_PATHS.map((path) => `${origin}${path}`)];
}

/** The SHA-256 a token value is stored and looked up by, prefix excluded. */
export function hashOAuthToken(value: string): string {
  return hashSecret(value);
}

/**
 * The access token in an `Authorization: Bearer lnxat_…` header, without
 * its prefix, or undefined for any other header.
 */
export function bearerOAuthToken(
  header: string | undefined,
): string | undefined {
  if (header === undefined) return undefined;
  const value = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header)?.[1];
  return value?.startsWith(OAUTH_ACCESS_TOKEN_PREFIX) === true
    ? value.slice(OAUTH_ACCESS_TOKEN_PREFIX.length)
    : undefined;
}

function refuse(message: string, code: string): APIError {
  return new APIError("FORBIDDEN", { message, code });
}

/**
 * The organization a consent binds, read from the consent request; or no
 * reference for a contributor's.
 *
 * The plugin asks for it twice in that request (storing the consent, then
 * issuing the code) and once on every authorization request, where no
 * workspace is chosen yet: undefined then finds only a consent given
 * without a reference (a contributor's, which covers a client asking for
 * the contributor scope again), so a workspace's is always asked anew. On
 * the consent request itself a choice is required: a workspace the person
 * owns or administers, with API scopes only; or `CONTRIBUTOR_CONSENT`, with
 * the contributor scope and no API scope (`scopes` is what the person
 * approved).
 */
export async function consentOrganization(
  userId: string | undefined,
  roleOf: RoleOf | undefined,
  scopes: readonly string[] = [],
): Promise<string | undefined> {
  const context = tryGetCurrentAuthEndpointContext();
  const chosen = context?.headers?.get(ORGANIZATION_HEADER)?.trim();
  if (chosen === undefined || chosen === "") {
    if (context?.path === "/oauth2/consent") {
      throw refuse("Choose a workspace to grant.", "WORKSPACE_REQUIRED");
    }
    return undefined;
  }
  if (chosen === CONTRIBUTOR_CONSENT) {
    if (userId === undefined || !scopes.some(isContributorScope))
      throw refuse(
        "Signing in as a contributor grants the contributions scope.",
        "CONTRIBUTOR_SCOPE_REQUIRED",
      );
    if (scopes.some(isApiScope))
      throw refuse(
        "A contributor grant reaches your contributions only; a workspace's scopes need a workspace.",
        "CONTRIBUTOR_SCOPE_ONLY",
      );
    return undefined;
  }
  if (scopes.some(isContributorScope))
    throw refuse(
      "The contributions scope is granted signing in as a contributor, never with a workspace.",
      "CONTRIBUTOR_SCOPE_FORBIDDEN",
    );
  const role =
    userId === undefined || roleOf === undefined
      ? undefined
      : await roleOf(userId, chosen);
  if (role === undefined || !isAtLeastAdmin(role)) {
    throw refuse(
      "Only an owner or admin of a workspace can grant an app access to it.",
      "WORKSPACE_FORBIDDEN",
    );
  }
  return chosen;
}

export function oauthProviderPlugin({
  baseUrl,
  appUrl,
  roleOf,
}: OAuthProviderConfig) {
  const consentPage = new URL(CONSENT_PATH, appUrl).href;
  const [origin = baseUrl, ...mcp] = oauthResources(baseUrl);
  return oauthProvider({
    // No `openid`: this is an OAuth server for the API, not an identity
    // provider, so there are no ID tokens and no userinfo to keep private.
    scopes: OAUTH_SCOPES,
    grantTypes: ["authorization_code", "refresh_token"],
    // Signed-out people land on the consent page too; the web app shows
    // sign-in there and returns to it, signed query and all.
    loginPage: consentPage,
    consentPage,
    postLogin: {
      page: consentPage,
      shouldRedirect: () => false,
      consentReferenceId: ({ user, scopes }) =>
        consentOrganization(user.id, roleOf, scopes),
    },
    allowDynamicClientRegistration: true,
    allowUnauthenticatedClientRegistration: true,
    // Native MCP clients often omit `application_type` while registering a
    // loopback or custom-scheme callback.
    clientRegistrationDefaultApplicationType: "infer",
    clientPrivileges: () => false,
    resources: [
      { identifier: origin, name: "Lunox API" },
      ...mcp.map((identifier) => ({ identifier, name: "Lunox MCP" })),
    ],
    // Every resource is this one API; a client may ask for any of them.
    enforcePerClientResources: false,
    accessTokenExpiresIn: ACCESS_TOKEN_SECONDS,
    // Opaque tokens only, looked up by hash: no signing keys to keep.
    disableJwtPlugin: true,
    storeTokens: { hash: (value) => hashOAuthToken(value) },
    prefix: {
      opaqueAccessToken: OAUTH_ACCESS_TOKEN_PREFIX,
      refreshToken: OAUTH_REFRESH_TOKEN_PREFIX,
    },
  });
}
