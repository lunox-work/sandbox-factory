/**
 * Contributor tokens: what an invited contributor's editor, agent or CLI
 * signs in with. One person's own, bound to no workspace; only the
 * secret's hash is stored (`schema/developer.ts`).
 *
 * Owner first, as every store, the owner being the person: each method but
 * `findByHash` takes their user id and puts it in its `WHERE`. `findByHash`
 * is the one that establishes the person, as `ApiTokenStore.findByHash`
 * establishes a workspace; the hash of a high-entropy secret is the
 * capability.
 */

import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";

import type { Database } from "./errors.js";
import { generateId } from "./mapping.js";
import { contributorToken, user } from "./schema.js";

export interface StoredContributorToken {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly prefix: string;
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
  readonly lastUsedAt: Date | null;
  readonly revokedAt: Date | null;
}

/** A live token found by its secret, with the person it acts as. */
export interface ResolvedContributorToken extends StoredContributorToken {
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly name: string;
  };
}

export interface NewContributorToken {
  readonly name: string;
  readonly prefix: string;
  /** Hex SHA-256 of the secret. The secret itself never reaches the store. */
  readonly hash: string;
  readonly expiresAt: Date | null;
}

export interface ContributorTokenStore {
  create(
    userId: string,
    input: NewContributorToken,
  ): Promise<StoredContributorToken>;
  /** Every token the person made, revoked ones too, newest first. */
  list(userId: string): Promise<StoredContributorToken[]>;
  /**
   * Stops a token working. Revoking a revoked one keeps its first time.
   * Undefined when the person holds no such token.
   */
  revoke(
    userId: string,
    id: string,
  ): Promise<StoredContributorToken | undefined>;
  /** The unrevoked token with this hash, or undefined. Expiry is the caller's. */
  findByHash(hash: string): Promise<ResolvedContributorToken | undefined>;
  /** Records a use at `at` unless one was recorded since `staleBefore`. */
  touch(userId: string, id: string, at: Date, staleBefore: Date): Promise<void>;
}

/** At most this many listed, as for API tokens. */
const LIST_LIMIT = 200;

const columns = {
  id: contributorToken.id,
  userId: contributorToken.userId,
  name: contributorToken.name,
  prefix: contributorToken.prefix,
  createdAt: contributorToken.createdAt,
  expiresAt: contributorToken.expiresAt,
  lastUsedAt: contributorToken.lastUsedAt,
  revokedAt: contributorToken.revokedAt,
};

export function createContributorTokenStore(
  db: Database,
): ContributorTokenStore {
  const one = async (userId: string, id: string) => {
    const [row] = await db
      .select(columns)
      .from(contributorToken)
      .where(
        and(eq(contributorToken.userId, userId), eq(contributorToken.id, id)),
      )
      .limit(1);
    return row;
  };

  return {
    async create(userId, input) {
      const id = generateId("ctk");
      await db.insert(contributorToken).values({
        id,
        userId,
        name: input.name,
        prefix: input.prefix,
        hash: input.hash,
        expiresAt: input.expiresAt,
      });
      const created = await one(userId, id);
      if (created === undefined) {
        // Only a person deleted between the two statements gets here; the
        // cascade took the row with them.
        throw new Error("The token's person no longer exists.");
      }
      return created;
    },

    async list(userId) {
      return db
        .select(columns)
        .from(contributorToken)
        .where(eq(contributorToken.userId, userId))
        .orderBy(desc(contributorToken.createdAt), desc(contributorToken.id))
        .limit(LIST_LIMIT);
    },

    async revoke(userId, id) {
      const updated = await db
        .update(contributorToken)
        .set({
          revokedAt: sql`coalesce(${contributorToken.revokedAt}, now())`,
        })
        .where(
          and(eq(contributorToken.userId, userId), eq(contributorToken.id, id)),
        )
        .returning({ id: contributorToken.id });
      return updated.length === 0 ? undefined : one(userId, id);
    },

    async findByHash(hash) {
      const [row] = await db
        .select({ ...columns, email: user.email, userName: user.name })
        .from(contributorToken)
        .innerJoin(user, eq(user.id, contributorToken.userId))
        .where(
          and(
            eq(contributorToken.hash, hash),
            isNull(contributorToken.revokedAt),
          ),
        )
        .limit(1);
      if (row === undefined) return undefined;
      const { email, userName, ...stored } = row;
      return {
        ...stored,
        user: { id: stored.userId, email, name: userName },
      };
    },

    async touch(userId, id, at, staleBefore) {
      await db
        .update(contributorToken)
        .set({ lastUsedAt: at })
        .where(
          and(
            eq(contributorToken.userId, userId),
            eq(contributorToken.id, id),
            or(
              isNull(contributorToken.lastUsedAt),
              lt(contributorToken.lastUsedAt, staleBefore),
            ),
          ),
        );
    },
  };
}
