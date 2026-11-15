/**
 * Reviewers' resizes kept as human labels (`proposalSizeLabel`), the
 * dataset sizing is calibrated against later. One is appended, inside the
 * resize's transaction, from the proposal as the reviewer saw it
 * (`sizeLabelValues`, called by `BountyProposalStore.resize`); this store
 * only reads them back, organization-scoped, oldest first.
 */

import { and, asc, eq } from "drizzle-orm";
import type {
  BountyComplexity,
  ModelComplexity,
  PricedComplexity,
  SizingConfidence,
} from "sandbox-factory";

import type { Database } from "./errors.js";
import { generateId } from "./mapping.js";
import { proposalSizeLabel } from "./schema.js";
import type { BountyProposalRow } from "./schema.js";

export interface StoredProposalSizeLabel {
  readonly id: string;
  readonly proposalId: string;
  /** The proposal revision resized, and the spec revision it sized. */
  readonly proposalRevision: number;
  readonly specRevision: number | null;
  readonly modelComplexity: ModelComplexity;
  readonly modelConfidence: SizingConfidence;
  /** The rubric's band then; null without an assessment or a band. */
  readonly rubricComplexity: PricedComplexity | null;
  /** The size and price before, and what had set them. */
  readonly fromComplexity: BountyComplexity;
  readonly fromSizedBy: "model" | "rubric" | "reviewer";
  readonly fromAmountMinor: number | null;
  /** What the resize came to. */
  readonly complexity: BountyComplexity;
  readonly amountMinor: number;
  readonly currency: string;
  /** The reviewer; null once their account is gone. */
  readonly resizedBy: string | null;
  readonly resizedAt: string;
}

export interface ProposalSizeLabelStore {
  /** A proposal's labels, oldest first; none for another workspace's. */
  list(
    organizationId: string,
    proposalId: string,
  ): Promise<StoredProposalSizeLabel[]>;
}

type Row = typeof proposalSizeLabel.$inferSelect;

/** The label a resize of `before` to `complexity` records. */
export function sizeLabelValues(
  before: BountyProposalRow,
  resize: {
    readonly complexity: BountyComplexity;
    readonly amountMinor: number;
    readonly currency: string;
    readonly resizedBy: string;
    readonly resizedAt: Date;
  },
): typeof proposalSizeLabel.$inferInsert {
  return {
    id: generateId("psl"),
    organizationId: before.organizationId,
    proposalId: before.id,
    proposalRevision: before.revision,
    specRevision: before.specRevision,
    modelComplexity: before.modelComplexity,
    modelConfidence: before.modelConfidence,
    rubricComplexity: before.rubric?.size ?? null,
    rubric: before.rubric ?? null,
    fromComplexity: before.complexity,
    fromSizedBy: before.sizedBy,
    fromAmountMinor: before.amountMinor,
    complexity: resize.complexity,
    amountMinor: resize.amountMinor,
    currency: resize.currency,
    resizedBy: resize.resizedBy,
    resizedAt: resize.resizedAt,
  };
}

const toLabel = (row: Row): StoredProposalSizeLabel => ({
  id: row.id,
  proposalId: row.proposalId,
  proposalRevision: row.proposalRevision,
  specRevision: row.specRevision,
  modelComplexity: row.modelComplexity as ModelComplexity,
  modelConfidence: row.modelConfidence as SizingConfidence,
  rubricComplexity: row.rubricComplexity as PricedComplexity | null,
  fromComplexity: row.fromComplexity as BountyComplexity,
  fromSizedBy: row.fromSizedBy as StoredProposalSizeLabel["fromSizedBy"],
  fromAmountMinor: row.fromAmountMinor,
  complexity: row.complexity as BountyComplexity,
  amountMinor: row.amountMinor,
  currency: row.currency,
  resizedBy: row.resizedBy,
  resizedAt: row.resizedAt.toISOString(),
});

export function createProposalSizeLabelStore(
  db: Database,
): ProposalSizeLabelStore {
  return {
    async list(organizationId, proposalId) {
      const rows = (await db
        .select()
        .from(proposalSizeLabel)
        .where(
          and(
            eq(proposalSizeLabel.organizationId, organizationId),
            eq(proposalSizeLabel.proposalId, proposalId),
          ),
        )
        .orderBy(
          asc(proposalSizeLabel.resizedAt),
          asc(proposalSizeLabel.id),
        )) as Row[];
      return rows.map(toLabel);
    },
  };
}
