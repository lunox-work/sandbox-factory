/**
 * Public surface of the GitHub integration.
 *
 * One GitHub App, used two ways:
 *
 * - **Installation tokens** for everything unattended — listing and reading
 *   a client's repositories and their trees, and (later) fetching them.
 *   Minted from the App's JWT, cached in memory, never stored, and narrowed
 *   to what each call needs.
 * - **User-to-server tokens** for the connect flow, where they prove which
 *   installations the person linking one may see.
 *
 * Read-only, and `fetch` only: no octokit, no JWT library. Node-only, unlike
 * `packages/jira`, because the App's key and webhook secret exist only in the
 * API and the worker; see this package's tsconfig.
 */

export { appJwt, readPrivateKey } from "./app-jwt.js";
export type { AppJwtOptions } from "./app-jwt.js";
export { GithubClient, TREE_TIMEOUT_MS } from "./client.js";
export type { BranchHead, GithubClientOptions, RateLimit } from "./client.js";
export {
  errorFor,
  failure,
  readFailure,
  GithubApiError,
  GithubAppAuthError,
  GithubAuthError,
  GithubInstallationUnavailable,
  GithubNetworkError,
  GithubNotFound,
  GithubOAuthError,
  GithubRateLimited,
} from "./errors.js";
export { REQUEST_TIMEOUT_MS } from "./http.js";
export { InstallationTokens } from "./installation-tokens.js";
export type {
  InstallationNarrowing,
  InstallationState,
  InstallationTokensOptions,
  TokenProvider,
} from "./installation-tokens.js";
export {
  authorizeUrl,
  exchangeCode,
  refreshUserToken,
  UserCredential,
} from "./user-oauth.js";
export type {
  AuthorizeUrlOptions,
  ExchangeOptions,
  RefreshOptions,
  TokenSource,
  UserCredentialOptions,
  UserTokens,
} from "./user-oauth.js";
export { verifySignature } from "./webhook.js";
