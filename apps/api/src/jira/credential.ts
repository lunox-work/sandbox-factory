/**
 * Turning a stored connection into a Jira client.
 *
 * The bridge between two packages that each refuse to know about the other:
 * `packages/db` stores encrypted token material and says nothing about OAuth,
 * `packages/jira` performs OAuth and says nothing about storage. The seam is a
 * `TokenSource`, and this is the API's implementation of it over the
 * `jira_connection` table.
 *
 * It lives here rather than in either package because it is the only place
 * that legitimately knows both halves — and because the refresh write-back
 * needs the store's `saveTokens`, which exists precisely so this file can call
 * it. Putting it in `packages/db` would drag Atlassian's token endpoint into
 * the storage layer; putting it in `packages/jira` would drag the schema into
 * a package the browser bundles.
 */

import type { JiraConnectionStore } from "@sandbox-factory/db";
import {
  JiraApiError,
  JiraAuthError,
  JiraClient,
  OAuthCredential,
  type TokenSource,
} from "@sandbox-factory/jira";

/** What building a client needs beyond the connection itself. */
export interface JiraClientFactoryOptions {
  connections: JiraConnectionStore;
  /** The second Atlassian app's credentials, as the routes hold them. */
  clientId: string;
  clientSecret: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

/**
 * Why a connection could not produce a client.
 *
 * `reconnect` is the one worth distinguishing: it means the grant is gone and
 * no retry will help, so the UI says "reconnect Jira" against the site the
 * user recognises rather than showing a generic failure.
 */
export type JiraClientFailure =
  { readonly reason: "not-found" } | { readonly reason: "reconnect" };

export type JiraClientResult =
  | { readonly ok: true; readonly client: JiraClient; readonly cloudId: string }
  | { readonly ok: false; readonly failure: JiraClientFailure };

/**
 * A `TokenSource` over one connection row.
 *
 * `load` refuses a row with no access token rather than handing back an empty
 * string: that row is a connection whose tokens failed to decrypt or were
 * never written, and a credential built on it would fail later with a 401 that
 * looks like a revoked grant.
 *
 * `save` writes through the store on every refresh, before the new token is
 * used. Atlassian rotates refresh tokens, so a lost write strands the
 * connection with a refresh token it has already spent.
 */
export function connectionTokenSource(
  connections: JiraConnectionStore,
  organizationId: string,
  connectionId: string,
): TokenSource {
  return {
    async load() {
      const stored = await connections.tokens(organizationId, connectionId);
      if (stored === null || stored.accessToken === null) {
        throw new JiraAuthError(
          401,
          "This Jira connection has no usable token.",
          "invalid_grant",
        );
      }
      return {
        accessToken: stored.accessToken,
        refreshToken: stored.refreshToken ?? undefined,
        // A row written before expiry was recorded refreshes on first use,
        // which is cheaper than treating the token as valid and finding out.
        expiresAt: stored.expiresAt ?? new Date(0).toISOString(),
        scopes: stored.scopes,
      };
    },

    async save(tokens) {
      await connections.saveTokens(connectionId, {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? null,
        expiresAt: tokens.expiresAt,
        scopes: tokens.scopes,
      });
    },
  };
}

/**
 * A client addressing the site a connection was granted for.
 *
 * Owner-scoped: the connection is read with the organization id in the
 * `WHERE` clause, so another organization's connection id is `not-found`
 * rather than a client. Every caller reaches this through the membership
 * guard, which makes this the second check rather than the only one.
 *
 * A connection Atlassian has already refused is not retried. `healthy` is set
 * false when a refresh fails, and building a credential on it would spend
 * another round trip to learn what the row already records.
 */
export async function jiraClientFor(
  options: JiraClientFactoryOptions,
  organizationId: string,
  connectionId: string,
): Promise<JiraClientResult> {
  const {
    connections,
    clientId,
    clientSecret,
    fetch: fetchImpl,
    now,
  } = options;

  const connection = await connections.get(organizationId, connectionId);
  if (connection === null) {
    return { ok: false, failure: { reason: "not-found" } };
  }
  if (!connection.healthy) {
    return { ok: false, failure: { reason: "reconnect" } };
  }

  const credential = new OAuthCredential({
    tokens: connectionTokenSource(connections, organizationId, connectionId),
    clientId,
    clientSecret,
    cloudId: connection.cloudId,
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
    ...(now === undefined ? {} : { now }),
  });

  return {
    ok: true,
    cloudId: connection.cloudId,
    client: new JiraClient({
      credential,
      // So issue DTOs carry a browsable `browse/` link. The OAuth credential
      // addresses `api.atlassian.com`, whose URL is not one a user can open.
      siteUrl: connection.siteUrl,
      ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
    }),
  };
}

/**
 * Marks a connection unhealthy when Atlassian has refused the grant, and says
 * whether that is what happened.
 *
 * Called from the catch of every route that uses a client. A revoked grant is
 * a state the UI has to show, not a 500: nothing is broken, and the remedy is
 * a fresh consent.
 *
 * **Two error types, because a grant can die at either end.** `JiraAuthError`
 * comes from the token endpoint — a refresh that Atlassian refused, which is
 * the case that hits after an access token has already expired.
 * `JiraApiError` with a 401 comes from the REST API, and is what a grant
 * revoked *while a live access token was still valid* looks like: the refresh
 * never runs, because there was nothing to refresh. Checking only the first
 * leaves that connection reported as a bad request forever, and the UI never
 * says "reconnect".
 *
 * A 403 is deliberately not included. That is a missing scope, which survives
 * a reconnect unless the user consents to more — a different remedy, and
 * flagging the connection unhealthy would mislabel a working grant.
 */
export async function noteAuthFailure(
  connections: JiraConnectionStore,
  connectionId: string,
  error: unknown,
): Promise<boolean> {
  const revoked =
    (error instanceof JiraAuthError && error.needsReconnect) ||
    (error instanceof JiraApiError && error.isUnauthorized);
  if (!revoked) {
    return false;
  }
  await connections.markUnhealthy(connectionId);
  return true;
}
