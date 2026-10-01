/**
 * Turning stored GitHub state into clients.
 *
 * The bridge between `packages/db`, which stores an encrypted user grant and
 * knows nothing of GitHub, and `packages/github`, which speaks to GitHub and
 * knows nothing of storage — the same seam `jira/credential.ts` is for Jira.
 *
 * Two kinds of client come out of here, and they are not interchangeable:
 *
 * - An **installation** client, for a client's repositories. Its token is
 *   minted from the App's key and never stored; nothing here persists it.
 * - A **user** client, for the connect flow, over the person's own grant.
 */

import type { GithubGrantStore, GithubGrantSummary } from "@sandbox-factory/db";
import {
  GithubAuthError,
  GithubClient,
  GithubOAuthError,
  type InstallationTokens,
  type TokenSource,
  UserCredential,
} from "@sandbox-factory/github";

/** A client acting as an installation. Cheap: the token is cached by `tokens`. */
export function installationClient(
  tokens: InstallationTokens,
  installationId: string,
  fetchImpl?: typeof globalThis.fetch,
): GithubClient {
  return new GithubClient({
    token: tokens.provider(installationId),
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
  });
}

/**
 * A `TokenSource` over one person's grant.
 *
 * `save` is fenced on the revision `load` read: GitHub spends the refresh
 * token on every refresh, so a write-back over a grant replaced meanwhile
 * would strand the newer one. A refused save throws, which the credential
 * answers by reloading.
 */
export function grantTokenSource(
  grants: GithubGrantStore,
  organizationId: string,
  userId: string,
): TokenSource {
  let loadedRevision: number | undefined;
  return {
    async load() {
      const stored = await grants.tokens(organizationId, userId);
      if (stored === null) {
        throw new GithubOAuthError(
          "bad_refresh_token",
          "There is no GitHub authorization to use.",
        );
      }
      loadedRevision = stored.credentialRevision;
      return {
        accessToken: stored.accessToken,
        refreshToken: stored.refreshToken ?? undefined,
        expiresAt: stored.expiresAt ?? undefined,
      };
    },

    async save(tokens) {
      const saved =
        loadedRevision !== undefined &&
        (await grants.saveTokens(organizationId, userId, loadedRevision, {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken ?? null,
          expiresAt: tokens.expiresAt ?? null,
        }));
      if (!saved) {
        throw new GithubOAuthError(
          "revision",
          "The GitHub authorization changed during refresh.",
        );
      }
      loadedRevision = (loadedRevision ?? 0) + 1;
    },
  };
}

export interface UserClientOptions {
  grants: GithubGrantStore;
  /** The App's own OAuth half; not the sign-in pair. */
  clientId: string;
  clientSecret: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

export type UserClientResult =
  | {
      readonly ok: true;
      readonly client: GithubClient;
      readonly grant: GithubGrantSummary;
    }
  /**
   * `missing`: this person never connected GitHub for this organization.
   * `reconnect`: they did, and GitHub has since refused the grant.
   * Both are cured the same way — pressing Connect — but read differently.
   */
  | { readonly ok: false; readonly reason: "missing" | "reconnect" };

/** A client acting as the signed-in person, over their stored grant. */
export async function userClientFor(
  options: UserClientOptions,
  organizationId: string,
  userId: string,
): Promise<UserClientResult> {
  const grant = await options.grants.get(organizationId, userId);
  if (grant === null) return { ok: false, reason: "missing" };
  if (!grant.healthy) return { ok: false, reason: "reconnect" };

  const credential = new UserCredential({
    tokens: grantTokenSource(options.grants, organizationId, userId),
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return {
    ok: true,
    grant,
    client: new GithubClient({
      token: () => credential.token(),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    }),
  };
}

/**
 * Whether a failed user call means the grant is finished, and if so, flags
 * it — fenced on the revision the call began from, so a person who
 * reconnected meanwhile is not flagged for the old grant's failure.
 *
 * A 401 from the REST API is a revoked token; a refused refresh is a spent
 * one. A 403 is not: it is a permission the person lacks, which a reconnect
 * does not change.
 */
export async function noteGrantFailure(
  grants: GithubGrantStore,
  target: {
    readonly organizationId: string;
    readonly userId: string;
    readonly credentialRevision: number;
  },
  error: unknown,
): Promise<boolean> {
  const finished =
    (error instanceof GithubAuthError && error.status === 401) ||
    (error instanceof GithubOAuthError && error.needsReconnect);
  if (finished) {
    await grants.markUnhealthy(
      target.organizationId,
      target.userId,
      target.credentialRevision,
    );
  }
  return finished;
}
