import { countScenarios, type SpecDraft } from "sandbox-factory";
import { and, desc, eq } from "drizzle-orm";

import type { Database } from "./errors.js";
import { generateId } from "./mapping.js";
import { bountySpec } from "./schema.js";
import type { BountySpecOrigin, BountySpecRow } from "./schema.js";

/**
 * A spec a run drafted, handed over with the proposal it belongs to.
 *
 * It carries no proposal id and no revision: the proposal store decides
 * both inside the transaction that writes the proposal, so a spec is never
 * stored for a proposal that was not.
 */
export interface NewBountySpec {
  /** The ticket it was drafted from, hashed as the proposal hashes it. */
  readonly specHash: string;
  readonly specHashVersion: number;
  readonly draft: SpecDraft;
  readonly origin: BountySpecOrigin;
  readonly actualModel: string;
  readonly promptVersion: string;
}

export interface StoredBountySpec {
  readonly id: string;
  readonly organizationId: string;
  readonly proposalId: string;
  readonly revision: number;
  readonly specHash: string;
  readonly specHashVersion: number;
  readonly draft: SpecDraft;
  readonly origin: BountySpecOrigin;
  readonly instruction: string | null;
  readonly createdBy: string | null;
  readonly runId: string | null;
  readonly actualModel: string | null;
  readonly promptVersion: string | null;
  readonly createdAt: string;
}

/** A revision without its scenarios, for listing a spec's history. */
export interface StoredBountySpecRevision {
  readonly revision: number;
  readonly origin: BountySpecOrigin;
  readonly scenarioCount: number;
  readonly openQuestionCount: number;
  readonly createdBy: string | null;
  readonly createdAt: string;
}

export interface BountySpecStore {
  /** One revision of a proposal's spec, or null when there is none. */
  get(
    organizationId: string,
    proposalId: string,
    revision: number,
  ): Promise<StoredBountySpec | null>;
  /** Every revision a proposal's spec has had, newest first. */
  listRevisions(
    organizationId: string,
    proposalId: string,
  ): Promise<StoredBountySpecRevision[]>;
}

function toDto(row: BountySpecRow): StoredBountySpec {
  return {
    id: row.id,
    organizationId: row.organizationId,
    proposalId: row.proposalId,
    revision: row.revision,
    specHash: row.specHash,
    specHashVersion: row.specHashVersion,
    draft: row.draft,
    origin: row.origin as BountySpecOrigin,
    instruction: row.instruction,
    createdBy: row.createdBy,
    runId: row.runId,
    actualModel: row.actualModel,
    promptVersion: row.promptVersion,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The revision a proposal's next spec takes: one past its latest, or 1.
 *
 * Only safe where the proposal row is already locked, which is the case in
 * the one place a second revision is written, a re-price. The table's
 * unique constraint on proposal and revision is what holds if that ever
 * stops being true.
 */
export async function nextSpecRevision(
  db: Database,
  organizationId: string,
  proposalId: string,
): Promise<number> {
  const latest = await db
    .select({ revision: bountySpec.revision })
    .from(bountySpec)
    .where(
      and(
        eq(bountySpec.organizationId, organizationId),
        eq(bountySpec.proposalId, proposalId),
      ),
    )
    .orderBy(desc(bountySpec.revision))
    .limit(1);
  return (latest[0]?.revision ?? 0) + 1;
}

/**
 * Writes one revision. For the proposal store, inside the transaction that
 * writes the proposal and under the run lease it has already checked.
 */
export async function insertSpecRevision(
  db: Database,
  organizationId: string,
  target: {
    readonly proposalId: string;
    readonly runId: string;
    readonly revision: number;
  },
  spec: NewBountySpec,
): Promise<void> {
  await db.insert(bountySpec).values({
    id: generateId("bsp"),
    organizationId,
    proposalId: target.proposalId,
    revision: target.revision,
    specHash: spec.specHash,
    specHashVersion: spec.specHashVersion,
    draft: spec.draft,
    origin: spec.origin,
    runId: target.runId,
    actualModel: spec.actualModel,
    promptVersion: spec.promptVersion,
  });
}

export function createBountySpecStore(db: Database): BountySpecStore {
  return {
    async get(organizationId, proposalId, revision) {
      const rows = (await db
        .select()
        .from(bountySpec)
        .where(
          and(
            eq(bountySpec.organizationId, organizationId),
            eq(bountySpec.proposalId, proposalId),
            eq(bountySpec.revision, revision),
          ),
        )) as BountySpecRow[];
      return rows[0] === undefined ? null : toDto(rows[0]);
    },

    async listRevisions(organizationId, proposalId) {
      const rows = (await db
        .select()
        .from(bountySpec)
        .where(
          and(
            eq(bountySpec.organizationId, organizationId),
            eq(bountySpec.proposalId, proposalId),
          ),
        )
        .orderBy(desc(bountySpec.revision))) as BountySpecRow[];
      return rows.map((row) => ({
        revision: row.revision,
        origin: row.origin as BountySpecOrigin,
        scenarioCount: countScenarios(row.draft).total,
        openQuestionCount: row.draft.openQuestions.length,
        createdBy: row.createdBy,
        createdAt: row.createdAt.toISOString(),
      }));
    },
  };
}
