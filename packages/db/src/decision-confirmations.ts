/**
 * Confirmations of a spec revision's decisions (`decisionConfirmation`),
 * organization-scoped. One per proposal and revision: confirming again
 * keeps the first, and a confirmation for a hash other than the one asked
 * about answers as none, so a changed decision list is never shown as
 * confirmed.
 */

import { and, eq } from "drizzle-orm";

import type { Database } from "./errors.js";
import { generateId } from "./mapping.js";
import { decisionConfirmation, user } from "./schema.js";

/** Where a confirmation made outside the Price step came from. */
export type DecisionConfirmationSource = "duediligence";

/** The credential a confirmation was made with, acting as its person. */
export type DecisionConfirmationCredential = "session" | "token" | "oauth";

const CREDENTIALS: readonly string[] = [
  "session",
  "token",
  "oauth",
] satisfies readonly DecisionConfirmationCredential[];

/** A stored credential kind, or null for one not recorded. */
export const decisionCredentialOf = (
  value: string | null,
): DecisionConfirmationCredential | null =>
  value !== null && CREDENTIALS.includes(value)
    ? (value as DecisionConfirmationCredential)
    : null;

export interface StoredDecisionConfirmation {
  readonly id: string;
  readonly proposalId: string;
  readonly specRevision: number;
  readonly decisionsSha256: string;
  readonly confirmedBy: string;
  /** Their name, to say who; null when the person cannot be read. */
  readonly confirmedByName: string | null;
  /** Null for one made on the Price step. */
  readonly via: DecisionConfirmationSource | null;
  /** The credential it was made with; null for one made before it was kept. */
  readonly credential: DecisionConfirmationCredential | null;
  readonly confirmedAt: string;
}

export interface DecisionConfirmationStore {
  /** The confirmation of these decisions, or null when none matches. */
  get(
    organizationId: string,
    proposalId: string,
    specRevision: number,
    decisionsSha256: string,
  ): Promise<StoredDecisionConfirmation | null>;
  /**
   * Records a confirmation; the one already there for the revision when a
   * person confirmed first. Null when that one names other decisions.
   */
  confirm(input: {
    readonly organizationId: string;
    readonly proposalId: string;
    readonly specRevision: number;
    readonly decisionsSha256: string;
    readonly confirmedBy: string;
    readonly credential: DecisionConfirmationCredential;
  }): Promise<StoredDecisionConfirmation | null>;
}

type Row = typeof decisionConfirmation.$inferSelect;
const toStored = (
  row: Row,
  name: string | null,
): StoredDecisionConfirmation => ({
  id: row.id,
  proposalId: row.proposalId,
  specRevision: row.specRevision,
  decisionsSha256: row.decisionsSha256,
  confirmedBy: row.confirmedBy,
  confirmedByName: name,
  via: row.via === "duediligence" ? "duediligence" : null,
  credential: decisionCredentialOf(row.credential),
  confirmedAt: row.confirmedAt.toISOString(),
});

export function createDecisionConfirmationStore(
  db: Database,
): DecisionConfirmationStore {
  const read = async (
    organizationId: string,
    proposalId: string,
    specRevision: number,
  ) => {
    const [row] = await db
      .select({ confirmation: decisionConfirmation, name: user.name })
      .from(decisionConfirmation)
      .leftJoin(user, eq(user.id, decisionConfirmation.confirmedBy))
      .where(
        and(
          eq(decisionConfirmation.organizationId, organizationId),
          eq(decisionConfirmation.proposalId, proposalId),
          eq(decisionConfirmation.specRevision, specRevision),
        ),
      )
      .limit(1);
    return row === undefined ? null : toStored(row.confirmation, row.name);
  };
  return {
    async get(organizationId, proposalId, specRevision, decisionsSha256) {
      const found = await read(organizationId, proposalId, specRevision);
      return found !== null && found.decisionsSha256 === decisionsSha256
        ? found
        : null;
    },
    async confirm(input) {
      const [row] = await db
        .insert(decisionConfirmation)
        .values({ id: generateId("dcf"), ...input })
        .onConflictDoNothing({
          target: [
            decisionConfirmation.proposalId,
            decisionConfirmation.specRevision,
          ],
        })
        .returning();
      if (row !== undefined) return toStored(row, null);
      const found = await read(
        input.organizationId,
        input.proposalId,
        input.specRevision,
      );
      return found !== null && found.decisionsSha256 === input.decisionsSha256
        ? found
        : null;
    },
  };
}
