import type {
  AnalysisErrorCode,
  ComplexityProfile,
  ProfileErrorCode,
  ProfileStatus,
  ProfileTicket,
} from "sandbox-factory";
import { and, asc, desc, eq, inArray } from "drizzle-orm";

import { snapshotForWrite } from "./bounty-proposals.js";
import type { Database } from "./errors.js";
import { generateId } from "./mapping.js";
import { bountyProfile, bountyProposal } from "./schema.js";
import type { BountyProfileRow } from "./schema.js";

/** The statuses a sweep still has work for. */
export const PENDING_PROFILE_STATUSES: readonly ProfileStatus[] = [
  "queued",
  "scoping",
  "slicing",
];

export interface StoredBountyProfile {
  readonly id: string;
  readonly organizationId: string;
  readonly proposalId: string;
  readonly specRevision: number;
  readonly specHash: string;
  readonly snapshotId: string | null;
  readonly ticket: ProfileTicket;
  readonly status: ProfileStatus;
  readonly errorCode: ProfileErrorCode | null;
  readonly runErrorCode: AnalysisErrorCode | null;
  readonly scopeRunId: string | null;
  readonly sliceRunId: string | null;
  readonly profile: ComplexityProfile | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** What a sizing asks to be profiled: one spec revision, beside one snapshot. */
export interface NewBountyProfile {
  readonly proposalId: string;
  readonly specRevision: number;
  readonly specHash: string;
  readonly snapshotId: string;
  readonly ticket: ProfileTicket;
}

/** The one step a sweep takes a row: each status says what it carries. */
export type ProfileTransition =
  | { readonly status: "scoping"; readonly scopeRunId: string }
  | { readonly status: "slicing"; readonly sliceRunId: string }
  | { readonly status: "ready"; readonly profile: ComplexityProfile }
  | {
      readonly status: "failed";
      readonly errorCode: ProfileErrorCode;
      readonly runErrorCode?: AnalysisErrorCode | null;
    };

export interface BountyProfileStore {
  /**
   * Asks for a spec revision's profile. Asking again for the same revision
   * changes nothing and returns the row there is. Null when the proposal is
   * not the organization's.
   */
  request(
    organizationId: string,
    input: NewBountyProfile,
  ): Promise<StoredBountyProfile | null>;
  /** The profile of a proposal's newest profiled spec revision, or null. */
  latest(
    organizationId: string,
    proposalId: string,
  ): Promise<StoredBountyProfile | null>;
  /** Rows a sweep still has work for, least recently moved first. */
  pending(
    organizationId: string,
    limit?: number,
  ): Promise<StoredBountyProfile[]>;
  /** Privileged sweep discovery, followed by owner-scoped reads and writes. */
  organizationsWithPending(): Promise<string[]>;
  /**
   * Moves a row on from the status it was read in. False when it has moved
   * since, so two sweeps cannot both take the same step.
   */
  advance(
    organizationId: string,
    profileId: string,
    from: ProfileStatus,
    to: ProfileTransition,
  ): Promise<boolean>;
}

function toStored(row: BountyProfileRow): StoredBountyProfile {
  return {
    id: row.id,
    organizationId: row.organizationId,
    proposalId: row.proposalId,
    specRevision: row.specRevision,
    specHash: row.specHash,
    snapshotId: row.snapshotId,
    ticket: row.ticket,
    status: row.status,
    errorCode: row.errorCode,
    runErrorCode: row.runErrorCode,
    scopeRunId: row.scopeRunId,
    sliceRunId: row.sliceRunId,
    profile: row.profile,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function createBountyProfileStore(db: Database): BountyProfileStore {
  const revisionOf = (owner: string, proposalId: string, revision: number) =>
    and(
      eq(bountyProfile.organizationId, owner),
      eq(bountyProfile.proposalId, proposalId),
      eq(bountyProfile.specRevision, revision),
    );
  return {
    async request(owner, input) {
      return db.transaction(async (transaction) => {
        const tx = transaction as unknown as Database;
        // The proposal id comes from a run, but the owner boundary is still
        // checked here rather than trusted: another organization's proposal
        // is not profiled.
        const owned = await tx
          .select({ id: bountyProposal.id })
          .from(bountyProposal)
          .where(
            and(
              eq(bountyProposal.organizationId, owner),
              eq(bountyProposal.id, input.proposalId),
            ),
          )
          .limit(1);
        if (owned.length === 0) return null;
        // And so is the snapshot's: a profile measures the owner's code only.
        const snapshotId = await snapshotForWrite(tx, owner, input.snapshotId);
        if (snapshotId === null) return null;
        await tx
          .insert(bountyProfile)
          .values({
            id: generateId("bpf"),
            organizationId: owner,
            proposalId: input.proposalId,
            specRevision: input.specRevision,
            specHash: input.specHash,
            snapshotId,
            ticket: input.ticket,
          })
          .onConflictDoNothing();
        const rows = (await tx
          .select()
          .from(bountyProfile)
          .where(revisionOf(owner, input.proposalId, input.specRevision))
          .limit(1)) as BountyProfileRow[];
        const row = rows[0];
        return row === undefined ? null : toStored(row);
      });
    },
    async latest(owner, proposalId) {
      const rows = (await db
        .select()
        .from(bountyProfile)
        .where(
          and(
            eq(bountyProfile.organizationId, owner),
            eq(bountyProfile.proposalId, proposalId),
          ),
        )
        .orderBy(desc(bountyProfile.specRevision))
        .limit(1)) as BountyProfileRow[];
      const row = rows[0];
      return row === undefined ? null : toStored(row);
    },
    async pending(owner, limit = 50) {
      const rows = (await db
        .select()
        .from(bountyProfile)
        .where(
          and(
            eq(bountyProfile.organizationId, owner),
            inArray(bountyProfile.status, [...PENDING_PROFILE_STATUSES]),
          ),
        )
        .orderBy(asc(bountyProfile.updatedAt), asc(bountyProfile.id))
        .limit(Math.min(200, Math.max(1, limit)))) as BountyProfileRow[];
      return rows.map(toStored);
    },
    async organizationsWithPending() {
      const rows = (await db
        .select({ organizationId: bountyProfile.organizationId })
        .from(bountyProfile)
        .where(
          inArray(bountyProfile.status, [...PENDING_PROFILE_STATUSES]),
        )) as { organizationId: string }[];
      return [...new Set(rows.map((row) => row.organizationId))];
    },
    async advance(owner, profileId, from, to) {
      const rows = await db
        .update(bountyProfile)
        .set({
          status: to.status,
          ...(to.status === "scoping" ? { scopeRunId: to.scopeRunId } : {}),
          ...(to.status === "slicing" ? { sliceRunId: to.sliceRunId } : {}),
          ...(to.status === "ready" ? { profile: to.profile } : {}),
          ...(to.status === "failed"
            ? { errorCode: to.errorCode, runErrorCode: to.runErrorCode ?? null }
            : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(bountyProfile.organizationId, owner),
            eq(bountyProfile.id, profileId),
            eq(bountyProfile.status, from),
          ),
        )
        .returning({ id: bountyProfile.id });
      return rows.length > 0;
    },
  };
}
