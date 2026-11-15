/**
 * OAuth grants as the API reads them. Better Auth's OAuth provider plugin
 * writes every row (`schema/oauth.ts`); this store answers the two
 * questions it does not: which grant and person an access token stands
 * for, and which grants a workspace has given.
 *
 * A grant is one consent row: a person, a client and an organization
 * (`reference_id`), with the scopes approved. A **contributor grant** names
 * no organization (`reference_id` null: the plugin's consent "given
 * without a reference"): the person signed in as an invited contributor,
 * and it reaches only their own contributions. Null rather than a marker
 * string because `reference_id` is a foreign key to `organization`.
 *
 * Owner first, as every store: each method but `findAccessToken` takes the
 * grant's owner (`GrantOwner`: an organization, or a contributor's own
 * person) and puts it in its `WHERE`; `findAccessToken` is the one that
 * establishes it, as `ApiTokenStore.findByHash` does, the hash of a random
 * token being the capability.
 */

import {
  and,
  desc,
  eq,
  isNull,
  lt,
  ne,
  or,
  sql,
  type AnyColumn,
  type SQL,
} from "drizzle-orm";

import type { Database } from "./errors.js";
import {
  oauthAccessToken,
  oauthClient,
  oauthConsent,
  oauthRefreshToken,
  user,
} from "./schema.js";

/** A live access token, with the grant it belongs to and who it acts as. */
export interface ResolvedOAuthAccessToken {
  readonly id: string;
  readonly clientId: string;
  readonly grantId: string;
  /** The workspace the grant binds; null for a contributor grant. */
  readonly organizationId: string | null;
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly name: string;
  };
  /** As issued, `offline_access` included; the caller keeps the API's. */
  readonly scopes: readonly string[];
  readonly expiresAt: Date;
  readonly grantLastUsedAt: Date | null;
}

export interface OAuthGrant {
  readonly id: string;
  readonly client: { readonly id: string; readonly name: string | null };
  readonly user: { readonly id: string; readonly name: string };
  readonly scopes: readonly string[];
  readonly createdAt: Date;
  /** When the person last approved it, which may widen its scopes. */
  readonly updatedAt: Date;
  readonly lastUsedAt: Date | null;
}

/**
 * Whose grant: an organization's (its id, the grant's `reference_id`), or
 * one contributor's own (`{ contributor: userId }`: no reference, that
 * person's).
 */
export type GrantOwner = string | { readonly contributor: string };

export interface OAuthGrantStore {
  /**
   * The unrevoked access token with this hash, while its grant stands and
   * its client is enabled. Expiry is the caller's.
   */
  findAccessToken(hash: string): Promise<ResolvedOAuthAccessToken | undefined>;
  /** Records a use at `at` unless one was recorded since `staleBefore`. */
  touch(
    owner: GrantOwner,
    grantId: string,
    at: Date,
    staleBefore: Date,
  ): Promise<void>;
  /** The owner's grants, most recently approved first. */
  list(owner: GrantOwner): Promise<OAuthGrant[]>;
  /**
   * Ends a grant: its access and refresh tokens are deleted and the
   * consent with them, so the client must ask again. Undefined when the
   * owner holds no such grant.
   */
  revoke(owner: GrantOwner, grantId: string): Promise<OAuthGrant | undefined>;
  /**
   * Ends one access token and the refresh token it was issued with, and
   * nothing else: the grant stands, so the app may sign in again without a
   * new consent. What a client's logout calls with the token it holds.
   * False when the owner holds no such token.
   */
  revokeAccessToken(owner: GrantOwner, tokenId: string): Promise<boolean>;
}

/** At most this many listed, as for API tokens. */
const LIST_LIMIT = 200;

const grantColumns = {
  id: oauthConsent.id,
  clientId: oauthConsent.clientId,
  clientName: oauthClient.name,
  userId: user.id,
  userName: user.name,
  scopes: oauthConsent.scopes,
  createdAt: oauthConsent.createdAt,
  updatedAt: oauthConsent.updatedAt,
  lastUsedAt: oauthConsent.lastUsedAt,
};

type GrantRow = {
  id: string;
  clientId: string;
  clientName: string | null;
  userId: string;
  userName: string;
  scopes: string[];
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt: Date | null;
};

function toGrant(row: GrantRow): OAuthGrant {
  return {
    id: row.id,
    client: { id: row.clientId, name: row.clientName },
    user: { id: row.userId, name: row.userName },
    scopes: row.scopes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastUsedAt: row.lastUsedAt,
  };
}

/** Grants with their client's name and their person, from `executor`. */
function selectGrants(executor: Pick<Database, "select">) {
  return executor
    .select(grantColumns)
    .from(oauthConsent)
    .innerJoin(oauthClient, eq(oauthClient.clientId, oauthConsent.clientId))
    .innerJoin(user, eq(user.id, oauthConsent.userId));
}

/**
 * The rows `owner` holds in a table with `reference_id` and `user_id`: the
 * organization's, or the contributor's own unreferenced ones.
 */
function ownedBy(
  table: { referenceId: AnyColumn; userId: AnyColumn },
  owner: GrantOwner,
): SQL | undefined {
  return typeof owner === "string"
    ? eq(table.referenceId, owner)
    : and(isNull(table.referenceId), eq(table.userId, owner.contributor));
}

export function createOAuthGrantStore(db: Database): OAuthGrantStore {
  const oneGrant = (owner: GrantOwner, grantId: string) =>
    and(ownedBy(oauthConsent, owner), eq(oauthConsent.id, grantId));

  return {
    async findAccessToken(hash) {
      const [row] = await db
        .select({
          id: oauthAccessToken.id,
          clientId: oauthAccessToken.clientId,
          grantId: oauthConsent.id,
          organizationId: oauthConsent.referenceId,
          userId: user.id,
          userEmail: user.email,
          userName: user.name,
          scopes: oauthAccessToken.scopes,
          expiresAt: oauthAccessToken.expiresAt,
          grantLastUsedAt: oauthConsent.lastUsedAt,
        })
        .from(oauthAccessToken)
        // The grant: same client, person and organization, or both
        // unreferenced (a contributor grant). A token whose consent is gone
        // finds none.
        .innerJoin(
          oauthConsent,
          and(
            eq(oauthConsent.clientId, oauthAccessToken.clientId),
            eq(oauthConsent.userId, oauthAccessToken.userId),
            sql`${oauthConsent.referenceId} is not distinct from ${oauthAccessToken.referenceId}`,
          ),
        )
        .innerJoin(
          oauthClient,
          eq(oauthClient.clientId, oauthAccessToken.clientId),
        )
        .innerJoin(user, eq(user.id, oauthAccessToken.userId))
        .where(
          and(
            eq(oauthAccessToken.token, hash),
            isNull(oauthAccessToken.revoked),
            or(isNull(oauthClient.disabled), ne(oauthClient.disabled, true)),
          ),
        )
        .limit(1);
      if (row === undefined) return undefined;
      return {
        id: row.id,
        clientId: row.clientId,
        grantId: row.grantId,
        organizationId: row.organizationId,
        user: { id: row.userId, email: row.userEmail, name: row.userName },
        scopes: row.scopes,
        expiresAt: row.expiresAt,
        grantLastUsedAt: row.grantLastUsedAt,
      };
    },

    async touch(owner, grantId, at, staleBefore) {
      await db
        .update(oauthConsent)
        .set({ lastUsedAt: at })
        .where(
          and(
            oneGrant(owner, grantId),
            or(
              isNull(oauthConsent.lastUsedAt),
              lt(oauthConsent.lastUsedAt, staleBefore),
            ),
          ),
        );
    },

    async list(owner) {
      const rows = await selectGrants(db)
        .where(ownedBy(oauthConsent, owner))
        .orderBy(desc(oauthConsent.updatedAt), desc(oauthConsent.id))
        .limit(LIST_LIMIT);
      return rows.map(toGrant);
    },

    async revoke(owner, grantId) {
      return db.transaction(async (tx) => {
        const [row] = await selectGrants(tx)
          .where(oneGrant(owner, grantId))
          .limit(1);
        if (row === undefined) return undefined;
        // Access tokens first: they reference the refresh tokens.
        await tx
          .delete(oauthAccessToken)
          .where(
            and(
              eq(oauthAccessToken.clientId, row.clientId),
              eq(oauthAccessToken.userId, row.userId),
              ownedBy(oauthAccessToken, owner),
            ),
          );
        await tx
          .delete(oauthRefreshToken)
          .where(
            and(
              eq(oauthRefreshToken.clientId, row.clientId),
              eq(oauthRefreshToken.userId, row.userId),
              ownedBy(oauthRefreshToken, owner),
            ),
          );
        await tx.delete(oauthConsent).where(oneGrant(owner, grantId));
        return toGrant(row);
      });
    },

    async revokeAccessToken(owner, tokenId) {
      return db.transaction(async (tx) => {
        const [token] = await tx
          .update(oauthAccessToken)
          .set({ revoked: sql`coalesce(${oauthAccessToken.revoked}, now())` })
          .where(
            and(
              ownedBy(oauthAccessToken, owner),
              eq(oauthAccessToken.id, tokenId),
            ),
          )
          .returning({ refreshId: oauthAccessToken.refreshId });
        if (token === undefined) return false;
        // The refresh token it came with would mint the next one.
        if (token.refreshId !== null)
          await tx
            .update(oauthRefreshToken)
            .set({
              revoked: sql`coalesce(${oauthRefreshToken.revoked}, now())`,
            })
            .where(
              and(
                ownedBy(oauthRefreshToken, owner),
                eq(oauthRefreshToken.id, token.refreshId),
              ),
            );
        return true;
      });
    },
  };
}
