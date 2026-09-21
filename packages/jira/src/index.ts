/**
 * Public surface of the Jira integration.
 *
 * Platform-neutral: `fetch` only, no `node:`, `window` or `vscode`, enforced by
 * `types: []` in this package's tsconfig. That is what lets the API, the MCP
 * server, the web app and the skill's CLI share one implementation of the
 * integration mechanics instead of three that drift.
 *
 * Read-only. Nothing here writes to Jira; see `READ_SCOPES`.
 */

export { JiraApiError, JiraClient } from "./client.js";
export type { JiraClientOptions } from "./client.js";
export {
  ApiTokenCredential,
  JiraCredentialError,
  memoryTokenSource,
  OAuthCredential,
} from "./credentials.js";
export type {
  ApiTokenCredentialOptions,
  Credential,
  OAuthCredentialOptions,
  TokenSource,
} from "./credentials.js";
export {
  accessibleSites,
  authorizeUrl,
  exchangeCode,
  JiraAuthError,
  READ_SCOPES,
  refreshTokens,
} from "./oauth.js";
export type {
  AccessibleSitesOptions,
  AuthorizeUrlOptions,
  ExchangeOptions,
  RefreshOptions,
  TokenPair,
} from "./oauth.js";
export {
  ISSUE_FIELDS,
  toBoardDto,
  toIssueDto,
  toSprintDto,
} from "./mapping.js";
export type { IssueMappingOptions } from "./mapping.js";
export { adfToText } from "./adf.js";
export { backlogJql, backlogSource, SKIP_LABEL } from "./backlog.js";
export type { BacklogJqlOptions, BacklogSource } from "./backlog.js";
export { SPEC_FIELDS, specHash, toIssueSpec } from "./spec.js";
export type { JiraIssueSpec } from "./spec.js";
export { stripTrailingSlashes } from "./url.js";
