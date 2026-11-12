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
import { decisionConfirmation } from "./schema.js";

export interface StoredDecisionConfirmation {
  readonly id: string;
  readonly proposalId: string;
  readonly specRevision: number;
  readonly decisionsSha256: string;
  readonly confirmedBy: string;
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
  }): Promise<StoredDecisionConfirmation | null>;
}

type Row = typeof decisionConfirmation.$inferSelect;
const toStored = (row: Row): StoredDecisionConfirmation => ({
  id: row.id,
  proposalId: row.proposalId,
  specRevision: row.specRevision,
  decisionsSha256: row.decisionsSha256,
  confirmedBy: row.confirmedBy,
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
      .select()
      .from(decisionConfirmation)
      .where(
        and(
          eq(decisionConfirmation.organizationId, organizationId),
          eq(decisionConfirmation.proposalId, proposalId),
          eq(decisionConfirmation.specRevision, specRevision),
        ),
      )
      .limit(1);
    return row === undefined ? null : toStored(row);
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
      if (row !== undefined) return toStored(row);
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
