/**
 * Specs posted with their bounties (`bountyPostedSpec`), organization-scoped.
 * Written with the bounty (`BountyStore.create`, `NewBounty.postedSpec`), in
 * the same transaction, so a bounty posted with a spec never exists
 * without it; read by sizing, which takes it instead of drafting, and by
 * the bounty's page.
 */

import type { SpecDraft } from "sandbox-factory";
import { and, eq } from "drizzle-orm";

import {
  decisionCredentialOf,
  type DecisionConfirmationCredential,
} from "./decision-confirmations.js";
import type { Database, QueryExecutor } from "./errors.js";
import { bountyPostedSpec } from "./schema.js";
import type { BountyPostedSpecRow } from "./schema.js";

/** A spec to post with a new bounty. */
export interface NewPostedSpec {
  readonly document: string;
  readonly draft: SpecDraft;
  /** `duediligence@<version>`. */
  readonly source: string;
  /** The new bounty's title and text, hashed as a proposal hashes them. */
  readonly specHash: string;
  readonly specHashVersion: number;
  /** The poster, when they posted its decisions as confirmed. */
  readonly confirmedBy: string | null;
  /**
   * The credential that posted them confirmed; null with `confirmedBy`.
   * Absent: none recorded.
   */
  readonly confirmedCredential?: DecisionConfirmationCredential | null;
}

export interface StoredPostedSpec {
  readonly bountyId: string;
  readonly organizationId: string;
  readonly document: string;
  readonly draft: SpecDraft;
  readonly source: string;
  readonly specHash: string;
  readonly specHashVersion: number;
  readonly confirmedBy: string | null;
  readonly confirmedCredential: DecisionConfirmationCredential | null;
  readonly createdBy: string | null;
  readonly createdAt: string;
}

export interface BountyPostedSpecStore {
  /** The spec posted with a bounty, or null for one posted without. */
  get(
    organizationId: string,
    bountyId: string,
  ): Promise<StoredPostedSpec | null>;
}

const toStored = (row: BountyPostedSpecRow): StoredPostedSpec => ({
  bountyId: row.bountyId,
  organizationId: row.organizationId,
  document: row.document,
  draft: row.draft,
  source: row.source,
  specHash: row.specHash,
  specHashVersion: row.specHashVersion,
  confirmedBy: row.confirmedBy,
  confirmedCredential: decisionCredentialOf(row.confirmedCredential),
  createdBy: row.createdBy,
  createdAt: row.createdAt.toISOString(),
});

/** Writes a new bounty's posted spec, inside the bounty's transaction. */
export async function insertPostedSpec(
  db: QueryExecutor,
  organizationId: string,
  bountyId: string,
  createdBy: string | null,
  spec: NewPostedSpec,
): Promise<void> {
  await db.insert(bountyPostedSpec).values({
    bountyId,
    organizationId,
    document: spec.document,
    draft: spec.draft,
    source: spec.source,
    specHash: spec.specHash,
    specHashVersion: spec.specHashVersion,
    confirmedBy: spec.confirmedBy,
    confirmedCredential:
      spec.confirmedBy === null ? null : (spec.confirmedCredential ?? null),
    createdBy,
  });
}

export function createBountyPostedSpecStore(
  db: Database,
): BountyPostedSpecStore {
  return {
    async get(organizationId, bountyId) {
      const [row] = await db
        .select()
        .from(bountyPostedSpec)
        .where(
          and(
            eq(bountyPostedSpec.organizationId, organizationId),
            eq(bountyPostedSpec.bountyId, bountyId),
          ),
        )
        .limit(1);
      return row === undefined ? null : toStored(row);
    },
  };
}
