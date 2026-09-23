/**
 * Public surface of the Jira integration.
 *
 * Platform-neutral: `fetch` only, no `node:`, `window` or `vscode`, enforced by
 * `types: []` in this package's tsconfig. That is what lets the API, the MCP
 * server, the web app and the skill's CLI share one implementation of the
 * integration mechanics instead of three that drift.
 *
 * Reads and two narrow writes. `JiraClient` only reads; `JiraWriteClient`
 * posts a comment and adds a label, the bounty write-back, and nothing else.
 * Consent asks for `WRITE_SCOPES` (`READ_SCOPES` plus `write:jira-work`).
 */

export { JiraApiError, JiraClient } from "./client.js";
export type { JiraClientOptions } from "./client.js";
export type { JiraComment } from "./client.js";
export { JiraWriteClient, JiraWriteResponseError } from "./write-client.js";
export type { JiraWriteClientOptions } from "./write-client.js";
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
  WRITE_SCOPES,
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
  DETAIL_FIELDS,
  ISSUE_FIELDS,
  toBoardDto,
  toIssueDetailDto,
  toIssueDto,
  toSprintDto,
} from "./mapping.js";
export type { IssueMappingOptions } from "./mapping.js";
export { adfToText, adfToTextResult } from "./adf.js";
export type { AdfTextResult } from "./adf.js";
export { backlogJql, backlogSource, SKIP_LABEL } from "./backlog.js";
export type { BacklogJqlOptions, BacklogSource } from "./backlog.js";
export { pricingSpecHash, SPEC_FIELDS, specHash, toIssueSpec } from "./spec.js";
export type { JiraIssueSpec } from "./spec.js";
export { stripTrailingSlashes } from "./url.js";
