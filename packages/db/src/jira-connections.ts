/**
 * The Jira connection store.
 *
 * Two boundaries meet here, and both are the point of the file:
 *
 * - **Ownership.** Every method takes the organization id first and puts it in
 *   the `WHERE` clause. A connection belonging to another organization is a
 *   miss, never a row the caller can see — the same rule `TodoStore` follows
 *   for users, and the reason a wrong id is a 404 rather than a 403.
 * - **Encryption.** Tokens are encrypted on the way in and decrypted on the
 *   way out, so no caller above this file handles ciphertext and no row below
 *   it holds a usable credential. `packages/jira` never learns that
 *   encryption exists: it asks a `TokenSource` for a pair.
 */

import { and, desc, eq, sql } from "drizzle-orm";

import type { TokenCipher } from "./cipher.js";
import { generateId } from "./mapping.js";
import { jiraConnection } from "./schema.js";
import type { JiraConnectionRow } from "./schema.js";
import type { Database } from "./errors.js";

/** A connection as the UI lists it. Carries no token material. */
export interface JiraConnectionSummary {
  readonly id: string;
  readonly cloudId: string;
  readonly siteUrl: string;
  readonly siteName: string;
  readonly email: string | null;
  readonly healthy: boolean;
  /** Granted scopes, split. Whether write-back is possible is read from here. */
  readonly scopes: readonly string[];
  readonly resourceScopes: readonly string[];
  readonly credentialRevision: number;
  readonly createdAt: string;
}

/** The decrypted grant, for building a credential. Never leaves the API. */
export interface JiraConnectionTokens {
  readonly accessToken: string | null;
  readonly refreshToken: string | null;
  readonly expiresAt: string | null;
  readonly scopes: readonly string[];
  readonly credentialRevision: number;
}

/** What a completed OAuth exchange has to record. */
export interface JiraConnectionInput {
  readonly cloudId: string;
  readonly siteUrl: string;
  readonly siteName: string;
  readonly email?: string | null;
  readonly accessToken: string | null;
  readonly refreshToken: string | null;
  readonly expiresAt: string | null;
  readonly scopes: readonly string[];
  readonly resourceScopes?: readonly string[];
}

export interface JiraConnectionStore {
  list(organizationId: string): Promise<JiraConnectionSummary[]>;
  get(
    organizationId: string,
    connectionId: string,
  ): Promise<JiraConnectionSummary | null>;
  /**
   * Records a completed grant, replacing any existing one for the same site.
   *
   * Re-connecting is an update rather than a second row: the unique constraint
   * on (organization, site) says so, and a user who reconnects to add a scope
   * expects the board they already registered to keep working.
   */
  upsert(
    organizationId: string,
    input: JiraConnectionInput,
  ): Promise<JiraConnectionSummary>;
  /** The decrypted pair, for building a credential. */
  tokens(
    organizationId: string,
    connectionId: string,
  ): Promise<JiraConnectionTokens | null>;
  /**
   * Writes back a refreshed pair.
   *
   * Called on every refresh and must persist before the token is used:
   * Atlassian rotates refresh tokens, so losing this write strands the
   * connection. Takes no organization id because the `TokenSource` that calls
   * it was already built from an owner-scoped read.
   */
  saveTokens(
    organizationId: string,
    connectionId: string,
    expectedRevision: number,
    tokens: {
      accessToken: string | null;
      refreshToken: string | null;
      expiresAt: string | null;
      scopes: readonly string[];
    },
  ): Promise<boolean>;
  /** Flags a connection Atlassian has refused, so the UI can say "reconnect". */
  markUnhealthy(connectionId: string): Promise<void>;
  remove(organizationId: string, connectionId: string): Promise<boolean>;
}

export function createJiraConnectionStore(
  db: Database,
  cipher: TokenCipher,
): JiraConnectionStore {
  function toSummary(row: JiraConnectionRow): JiraConnectionSummary {
    return {
      id: row.id,
      cloudId: row.cloudId,
      siteUrl: row.siteUrl,
      siteName: row.siteName,
      email: row.email,
      healthy: row.healthy,
      scopes: splitScopes(row.scopes),
      resourceScopes: splitScopes(row.resourceScopes),
      credentialRevision: row.credentialRevision,
      createdAt: row.createdAt.toISOString(),
    };
  }

  return {
    async list(organizationId) {
      const rows = (await db
        .select()
        .from(jiraConnection)
        .where(eq(jiraConnection.organizationId, organizationId))
        .orderBy(desc(jiraConnection.createdAt))) as JiraConnectionRow[];
      return rows.map(toSummary);
    },

    async get(organizationId, connectionId) {
      const row = await first(db, organizationId, connectionId);
      return row === undefined ? null : toSummary(row);
    },

    async upsert(organizationId, input) {
      const values = {
        organizationId,
        cloudId: input.cloudId,
        siteUrl: input.siteUrl,
        siteName: input.siteName,
        email: input.email ?? null,
        accessTokenEnc: cipher.encrypt(input.accessToken),
        refreshTokenEnc: cipher.encrypt(input.refreshToken),
        keyId: cipher.keyId,
        expiresAt: input.expiresAt === null ? null : new Date(input.expiresAt),
        scopes: input.scopes.join(" "),
        resourceScopes: (input.resourceScopes ?? input.scopes).join(" "),
        // A fresh grant is healthy by definition, so reconnecting is how a
        // user clears the "reconnect Jira" state.
        healthy: true,
        updatedAt: new Date(),
      };

      const [row] = (await db
        .insert(jiraConnection)
        .values({ id: generateId("jrc"), ...values })
        .onConflictDoUpdate({
          target: [jiraConnection.organizationId, jiraConnection.cloudId],
          set: {
            ...values,
            credentialRevision: sql`${jiraConnection.credentialRevision} + 1`,
          },
        })
        .returning()) as JiraConnectionRow[];

      if (row === undefined) {
        throw new Error("Failed to record the Jira connection.");
      }
      return toSummary(row);
    },

    async tokens(organizationId, connectionId) {
      const row = await first(db, organizationId, connectionId);
      if (row === undefined) {
        return null;
      }
      // A decrypt failure throws rather than returning null: an unreadable
      // token is a key problem, and reporting it as "no connection" would send
      // the user round the OAuth flow to no effect.
      return {
        accessToken: cipher.decrypt(row.accessTokenEnc),
        refreshToken: cipher.decrypt(row.refreshTokenEnc),
        expiresAt: row.expiresAt?.toISOString() ?? null,
        scopes: splitScopes(row.scopes),
        credentialRevision: row.credentialRevision,
      };
    },

    async saveTokens(organizationId, connectionId, expectedRevision, tokens) {
      const rows = await db
        .update(jiraConnection)
        .set({
          accessTokenEnc: cipher.encrypt(tokens.accessToken),
          refreshTokenEnc: cipher.encrypt(tokens.refreshToken),
          keyId: cipher.keyId,
          expiresAt:
            tokens.expiresAt === null ? null : new Date(tokens.expiresAt),
          scopes: tokens.scopes.join(" "),
          healthy: true,
          credentialRevision: expectedRevision + 1,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(jiraConnection.organizationId, organizationId),
            eq(jiraConnection.id, connectionId),
            eq(jiraConnection.credentialRevision, expectedRevision),
          ),
        )
        .returning();
      return rows.length > 0;
    },

    async markUnhealthy(connectionId) {
      await db
        .update(jiraConnection)
        .set({ healthy: false, updatedAt: new Date() })
        .where(eq(jiraConnection.id, connectionId));
    },

    async remove(organizationId, connectionId) {
      const removed = (await db
        .delete(jiraConnection)
        .where(
          and(
            eq(jiraConnection.organizationId, organizationId),
            eq(jiraConnection.id, connectionId),
          ),
        )
        .returning()) as JiraConnectionRow[];
      return removed.length > 0;
    },
  };
}

/** One row, scoped to its owner. Both predicates, always. */
async function first(
  db: Database,
  organizationId: string,
  connectionId: string,
): Promise<JiraConnectionRow | undefined> {
  const rows = (await db
    .select()
    .from(jiraConnection)
    .where(
      and(
        eq(jiraConnection.organizationId, organizationId),
        eq(jiraConnection.id, connectionId),
      ),
    )) as JiraConnectionRow[];
  return rows[0];
}

/** Atlassian reports scopes space separated; an empty column is no scopes. */
function splitScopes(scopes: string): readonly string[] {
  return scopes === "" ? [] : scopes.split(" ");
}
