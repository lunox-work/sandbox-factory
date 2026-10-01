/**
 * The GitHub grant store: a person's user-to-server authorization of the
 * App, one per organization they connected from.
 *
 * The same two boundaries as the Jira connection store. Ownership: every
 * method takes the organization first and the user second, both in the
 * `WHERE`. Encryption: tokens are sealed on the way in and opened on the way
 * out, so nothing above this file handles ciphertext and nothing below it
 * holds a usable token.
 *
 * Keyed by (organization, user) rather than by the row id, because that pair
 * is what every caller has: the organization from the path and the user from
 * the session.
 */

import { and, eq, sql } from "drizzle-orm";

import type { TokenCipher } from "./cipher.js";
import type { Database } from "./errors.js";
import { generateId } from "./mapping.js";
import { githubGrant } from "./schema.js";
import type { GithubGrantRow } from "./schema.js";

/** A grant as the API describes it. Carries no token material. */
export interface GithubGrantSummary {
  readonly id: string;
  readonly githubLogin: string;
  readonly githubUserId: string;
  readonly healthy: boolean;
  readonly expiresAt: string | null;
  readonly credentialRevision: number;
}

/** The decrypted grant, for building a credential. Never leaves the API. */
export interface GithubGrantTokens {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresAt: string | null;
  readonly credentialRevision: number;
}

export interface GithubGrantInput {
  readonly githubLogin: string;
  readonly githubUserId: string;
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresAt: string | null;
}

export interface GithubGrantStore {
  /**
   * Records a completed authorization, replacing the person's previous one
   * for this organization and moving the revision on, so a refresh still in
   * flight on the old grant cannot overwrite the new one.
   */
  upsert(
    organizationId: string,
    userId: string,
    input: GithubGrantInput,
  ): Promise<GithubGrantSummary>;
  get(
    organizationId: string,
    userId: string,
  ): Promise<GithubGrantSummary | null>;
  tokens(
    organizationId: string,
    userId: string,
  ): Promise<GithubGrantTokens | null>;
  /**
   * Writes back a refreshed pair, fenced on the revision it was refreshed
   * from. `false` when the row has moved on, which the credential reads as
   * "someone else refreshed first" and reloads.
   */
  saveTokens(
    organizationId: string,
    userId: string,
    expectedRevision: number,
    tokens: {
      readonly accessToken: string;
      readonly refreshToken: string | null;
      readonly expiresAt: string | null;
    },
  ): Promise<boolean>;
  /** Flags a grant GitHub has refused, fenced like `saveTokens`. */
  markUnhealthy(
    organizationId: string,
    userId: string,
    expectedRevision: number,
  ): Promise<boolean>;
}

export function createGithubGrantStore(
  db: Database,
  cipher: TokenCipher,
): GithubGrantStore {
  /** `encrypt` returns null only for null; a token is never null here. */
  function seal(value: string): string {
    return cipher.encrypt(value) ?? "";
  }

  async function first(
    organizationId: string,
    userId: string,
  ): Promise<GithubGrantRow | undefined> {
    const rows = (await db
      .select()
      .from(githubGrant)
      .where(
        and(
          eq(githubGrant.organizationId, organizationId),
          eq(githubGrant.userId, userId),
        ),
      )) as GithubGrantRow[];
    return rows[0];
  }

  return {
    async upsert(organizationId, userId, input) {
      const values = {
        githubLogin: input.githubLogin,
        githubUserId: input.githubUserId,
        accessTokenEnc: seal(input.accessToken),
        refreshTokenEnc: cipher.encrypt(input.refreshToken),
        keyId: cipher.keyId,
        expiresAt: input.expiresAt === null ? null : new Date(input.expiresAt),
        healthy: true,
        updatedAt: new Date(),
      };
      const rows = (await db
        .insert(githubGrant)
        .values({ id: generateId("ghg"), organizationId, userId, ...values })
        .onConflictDoUpdate({
          target: [githubGrant.organizationId, githubGrant.userId],
          set: {
            ...values,
            credentialRevision: sql`${githubGrant.credentialRevision} + 1`,
          },
        })
        .returning()) as GithubGrantRow[];
      const row = rows[0];
      if (row === undefined) {
        throw new Error("Failed to record the GitHub grant.");
      }
      return toSummary(row);
    },

    async get(organizationId, userId) {
      const row = await first(organizationId, userId);
      return row === undefined ? null : toSummary(row);
    },

    async tokens(organizationId, userId) {
      const row = await first(organizationId, userId);
      if (row === undefined) return null;
      // A decrypt failure throws: an unreadable token is a key problem, and
      // reporting it as "no grant" would send the person round the flow for
      // nothing.
      return {
        accessToken: cipher.decrypt(row.accessTokenEnc) ?? "",
        refreshToken: cipher.decrypt(row.refreshTokenEnc),
        expiresAt: row.expiresAt?.toISOString() ?? null,
        credentialRevision: row.credentialRevision,
      };
    },

    async saveTokens(organizationId, userId, expectedRevision, tokens) {
      const rows = await db
        .update(githubGrant)
        .set({
          accessTokenEnc: seal(tokens.accessToken),
          refreshTokenEnc: cipher.encrypt(tokens.refreshToken),
          keyId: cipher.keyId,
          expiresAt:
            tokens.expiresAt === null ? null : new Date(tokens.expiresAt),
          healthy: true,
          credentialRevision: expectedRevision + 1,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(githubGrant.organizationId, organizationId),
            eq(githubGrant.userId, userId),
            eq(githubGrant.credentialRevision, expectedRevision),
          ),
        )
        .returning();
      return rows.length > 0;
    },

    async markUnhealthy(organizationId, userId, expectedRevision) {
      const rows = await db
        .update(githubGrant)
        .set({ healthy: false, updatedAt: new Date() })
        .where(
          and(
            eq(githubGrant.organizationId, organizationId),
            eq(githubGrant.userId, userId),
            eq(githubGrant.credentialRevision, expectedRevision),
          ),
        )
        .returning();
      return rows.length > 0;
    },
  };
}

function toSummary(row: GithubGrantRow): GithubGrantSummary {
  return {
    id: row.id,
    githubLogin: row.githubLogin,
    githubUserId: row.githubUserId,
    healthy: row.healthy,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    credentialRevision: row.credentialRevision,
  };
}
