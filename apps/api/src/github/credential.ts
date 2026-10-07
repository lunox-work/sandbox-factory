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
 *   Every one names what it is for, and its token is narrowed to that.
 * - A **user** client, for the connect flow, over the person's own grant.
 */

import type { GithubGrantStore, GithubGrantSummary } from "@sandbox-factory/db";
import {
  GithubAuthError,
  GithubClient,
  GithubOAuthError,
  type InstallationNarrowing,
  type InstallationTokens,
  type TokenSource,
  UserCredential,
} from "@sandbox-factory/github";

/**
 * What an installation client is for, which decides what its token can
 * reach. Reads only: a client that writes belongs to the sandbox plan and
 * will be its own kind, so that widening the App's grant for it later
 * cannot hand write access to any call made here.
 *
 * - `discovery` — installation-wide, metadata only: listing what an
 *   installation covers, and counting it for the authority check.
 * - `repository` — one repository, contents and metadata: reading its
 *   pointer, its tree and its languages. Narrowed by GitHub's numeric id,
 *   so a token minted for one repository cannot read its neighbours.
 */
export type InstallationScope =
  | { readonly kind: "discovery" }
  | { readonly kind: "repository"; readonly repositoryId: string };

/** What a `discovery` token may do. */
export const DISCOVERY_PERMISSIONS: Readonly<Record<string, string>> = {
  metadata: "read",
};

/** What a `repository` token may do. */
export const REPOSITORY_READ_PERMISSIONS: Readonly<Record<string, string>> = {
  contents: "read",
  metadata: "read",
};

/** The narrowing a scope mints its token with. */
export function narrowingFor(scope: InstallationScope): InstallationNarrowing {
  if (scope.kind === "discovery") {
    return { permissions: DISCOVERY_PERMISSIONS };
  }
  const repositoryId = Number(scope.repositoryId);
  if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
    // Ids are checked where they enter; this is a bug, not a request.
    throw new Error("A repository scope needs GitHub's numeric id.");
  }
  return {
    repositoryIds: [repositoryId],
    permissions: REPOSITORY_READ_PERMISSIONS,
  };
}

/**
 * A client acting as an installation, for one stated purpose. Cheap: the
 * token is cached by `tokens`, apart for each narrowing.
 */
export function installationClient(
  tokens: InstallationTokens,
  installationId: string,
  scope: InstallationScope,
  fetchImpl?: typeof globalThis.fetch,
): GithubClient {
  return new GithubClient({
    token: tokens.provider(installationId, narrowingFor(scope)),
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
 * What a failed user call meant for the grant it was made with.
 *
 * - `flagged` — the grant is finished, and is now marked so: the person
 *   must connect again.
 * - `superseded` — it would have been, but the grant was replaced while the
 *   call was out (the person reconnected), so nothing was flagged. The new
 *   grant is untried, and telling the person to reconnect would be wrong.
 * - `other` — the failure says nothing about the grant.
 */
export type GrantFailure = "flagged" | "superseded" | "other";

/**
 * Whether a failed user call means the grant is finished, and if so, flags
 * it — fenced on the revision the call began from, so a person who
 * reconnected meanwhile is not flagged for the old grant's failure. The
 * answer is what the fenced write did, not what the error suggested: a
 * caller that said `reconnect` over a grant still healthy would send the
 * person round a loop that changes nothing.
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
): Promise<GrantFailure> {
  const finished =
    (error instanceof GithubAuthError && error.status === 401) ||
    (error instanceof GithubOAuthError && error.needsReconnect);
  if (!finished) return "other";
  const flagged = await grants.markUnhealthy(
    target.organizationId,
    target.userId,
    target.credentialRevision,
  );
  return flagged ? "flagged" : "superseded";
}
