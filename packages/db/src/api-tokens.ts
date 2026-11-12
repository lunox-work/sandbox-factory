/**
 * Workspace API tokens: what a script, CI job or command-line client signs
 * in with. Only the secret's hash is stored; see `schema/developer.ts`.
 *
 * Owner first, as every store: each method but `findByHash` takes the
 * organization and puts it in its `WHERE`. `findByHash` is the one that
 * establishes the organization, as `roleOf` establishes a membership, so it
 * has none to take; the hash of a high-entropy secret is the capability.
 */

import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { ApiScope } from "sandbox-factory";

import type { Database } from "./errors.js";
import { generateId } from "./mapping.js";
import { apiToken, user } from "./schema.js";

export interface StoredApiToken {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly prefix: string;
  readonly scopes: readonly ApiScope[];
  readonly createdBy: { readonly id: string; readonly name: string };
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
  readonly lastUsedAt: Date | null;
  readonly revokedAt: Date | null;
}

/** A live token found by its secret, with the person it acts as. */
export interface ResolvedApiToken extends StoredApiToken {
  readonly createdBy: {
    readonly id: string;
    readonly name: string;
    readonly email: string;
  };
}

export interface NewApiToken {
  readonly createdBy: string;
  readonly name: string;
  readonly prefix: string;
  /** Hex SHA-256 of the secret. The secret itself never reaches the store. */
  readonly hash: string;
  readonly scopes: readonly ApiScope[];
  readonly expiresAt: Date | null;
}

export interface ApiTokenStore {
  create(organizationId: string, input: NewApiToken): Promise<StoredApiToken>;
  /** Every token the organization has made, revoked ones too, newest first. */
  list(organizationId: string): Promise<StoredApiToken[]>;
  /**
   * Stops a token working. Revoking a revoked one keeps its first time.
   * Undefined when the organization holds no such token.
   */
  revoke(
    organizationId: string,
    id: string,
  ): Promise<StoredApiToken | undefined>;
  /** The unrevoked token with this hash, or undefined. Expiry is the caller's. */
  findByHash(hash: string): Promise<ResolvedApiToken | undefined>;
  /**
   * Records a use at `at`, unless one was recorded since `staleBefore`: the
   * condition is in the `WHERE`, so replicas racing on a busy token write
   * once between them.
   */
  touch(
    organizationId: string,
    id: string,
    at: Date,
    staleBefore: Date,
  ): Promise<void>;
}

/** At most this many listed: a workspace with more has a leak, not a list. */
const LIST_LIMIT = 200;

const columns = {
  id: apiToken.id,
  organizationId: apiToken.organizationId,
  name: apiToken.name,
  prefix: apiToken.prefix,
  scopes: apiToken.scopes,
  createdById: apiToken.createdBy,
  createdByName: user.name,
  createdAt: apiToken.createdAt,
  expiresAt: apiToken.expiresAt,
  lastUsedAt: apiToken.lastUsedAt,
  revokedAt: apiToken.revokedAt,
};

type Row = {
  id: string;
  organizationId: string;
  name: string;
  prefix: string;
  scopes: ApiScope[];
  createdById: string;
  createdByName: string;
  createdAt: Date;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
};

function toStored({ createdById, createdByName, ...row }: Row): StoredApiToken {
  return { ...row, createdBy: { id: createdById, name: createdByName } };
}

export function createApiTokenStore(db: Database): ApiTokenStore {
  const one = async (owner: string, id: string) => {
    const [row] = await db
      .select(columns)
      .from(apiToken)
      .innerJoin(user, eq(user.id, apiToken.createdBy))
      .where(and(eq(apiToken.organizationId, owner), eq(apiToken.id, id)))
      .limit(1);
    return row === undefined ? undefined : toStored(row);
  };

  return {
    async create(owner, input) {
      const id = generateId("tok");
      await db.insert(apiToken).values({
        id,
        organizationId: owner,
        createdBy: input.createdBy,
        name: input.name,
        prefix: input.prefix,
        hash: input.hash,
        scopes: [...input.scopes],
        expiresAt: input.expiresAt,
      });
      const created = await one(owner, id);
      if (created === undefined) {
        // Only a creator deleted between the two statements gets here; the
        // cascade took the row with them.
        throw new Error("The token's creator no longer exists.");
      }
      return created;
    },

    async list(owner) {
      const rows = await db
        .select(columns)
        .from(apiToken)
        .innerJoin(user, eq(user.id, apiToken.createdBy))
        .where(eq(apiToken.organizationId, owner))
        .orderBy(desc(apiToken.createdAt), desc(apiToken.id))
        .limit(LIST_LIMIT);
      return rows.map(toStored);
    },

    async revoke(owner, id) {
      const updated = await db
        .update(apiToken)
        .set({ revokedAt: sql`coalesce(${apiToken.revokedAt}, now())` })
        .where(and(eq(apiToken.organizationId, owner), eq(apiToken.id, id)))
        .returning({ id: apiToken.id });
      return updated.length === 0 ? undefined : one(owner, id);
    },

    async findByHash(hash) {
      const [row] = await db
        .select({ ...columns, createdByEmail: user.email })
        .from(apiToken)
        .innerJoin(user, eq(user.id, apiToken.createdBy))
        .where(and(eq(apiToken.hash, hash), isNull(apiToken.revokedAt)))
        .limit(1);
      if (row === undefined) return undefined;
      const { createdByEmail, ...rest } = row;
      const stored = toStored(rest);
      return {
        ...stored,
        createdBy: { ...stored.createdBy, email: createdByEmail },
      };
    },

    async touch(owner, id, at, staleBefore) {
      await db
        .update(apiToken)
        .set({ lastUsedAt: at })
        .where(
          and(
            eq(apiToken.organizationId, owner),
            eq(apiToken.id, id),
            or(
              isNull(apiToken.lastUsedAt),
              lt(apiToken.lastUsedAt, staleBefore),
            ),
          ),
        );
    },
  };
}
