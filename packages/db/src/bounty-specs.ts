import { countScenarios, type SpecDraft } from "sandbox-factory";
import { and, desc, eq, lte } from "drizzle-orm";

import type { Database, Transaction } from "./errors.js";
import { generateId } from "./mapping.js";
import { bountySpec } from "./schema.js";
import type { BountySpecOrigin, BountySpecRow } from "./schema.js";

/**
 * A spec a run drafted or changed, handed over with the proposal it
 * belongs to.
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
  /** The model and prompt that wrote it; null for a trim, which asks none. */
  readonly actualModel: string | null;
  readonly promptVersion: string | null;
  /** What the reviewer asked for, for a revision that came from a request. */
  readonly instruction?: string | null;
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
  readonly instruction: string | null;
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
  /**
   * The revision a proposal's size was set against: the newest drafted one
   * (`origin` draft) at or before `atRevision`. Every sizing drafts one and
   * a reviewer's change never does, so it is what the scenario step counts
   * from. Null when there is none.
   */
  sizedRevision(
    organizationId: string,
    proposalId: string,
    atRevision: number,
  ): Promise<StoredBountySpec | null>;
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
 * both places a later revision is written, a re-price and a spec change.
 * The table's unique constraint on proposal and revision is what holds if
 * that ever stops being true.
 */
export async function nextSpecRevision(
  db: Transaction,
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
  db: Transaction,
  organizationId: string,
  target: {
    readonly proposalId: string;
    readonly runId: string;
    readonly revision: number;
    /** The person whose request made it; absent when a run drafted it. */
    readonly createdBy?: string | null;
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
    instruction: spec.instruction ?? null,
    createdBy: target.createdBy ?? null,
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
        instruction: row.instruction,
        scenarioCount: countScenarios(row.draft).total,
        openQuestionCount: row.draft.openQuestions.length,
        createdBy: row.createdBy,
        createdAt: row.createdAt.toISOString(),
      }));
    },

    async sizedRevision(organizationId, proposalId, atRevision) {
      const rows = (await db
        .select()
        .from(bountySpec)
        .where(
          and(
            eq(bountySpec.organizationId, organizationId),
            eq(bountySpec.proposalId, proposalId),
            eq(bountySpec.origin, "draft"),
            lte(bountySpec.revision, atRevision),
          ),
        )
        .orderBy(desc(bountySpec.revision))
        .limit(1)) as BountySpecRow[];
      return rows[0] === undefined ? null : toDto(rows[0]);
    },
  };
}
