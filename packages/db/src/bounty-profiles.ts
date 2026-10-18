import type {
  AnalysisErrorCode,
  ComplexityProfile,
  ProfileErrorCode,
  ProfileStatus,
  ProfileTransitionTime,
} from "sandbox-factory";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  sql,
  type SQL,
} from "drizzle-orm";

import { snapshotForWrite } from "./snapshot-write.js";
import type { Database } from "./errors.js";
import { generateId } from "./mapping.js";
import { announceChange } from "./run-events.js";
import {
  bountyProfile,
  bountyProposal,
  githubRepo,
  repoSnapshot,
  workspaceSetting,
} from "./schema.js";
import type { BountyProfileRow } from "./schema.js";

/** The statuses a sweep still has work for. */
export const PENDING_PROFILE_STATUSES: readonly ProfileStatus[] = [
  "queued",
  "scoping",
  "slicing",
];

/**
 * A ready profile with no preparation, of an approved proposal's current
 * spec revision, in a workspace that has not turned preparation off: what
 * `unprepared` lists. Joined to `bounty_proposal`.
 */
const UNPREPARED = and(
  eq(bountyProfile.status, "ready"),
  isNull(bountyProfile.preparedRunId),
  isNotNull(bountyProfile.sliceRunId),
  eq(bountyProposal.status, "approved"),
  eq(bountyProposal.specRevision, bountyProfile.specRevision),
  sql`not exists (select 1 from ${workspaceSetting} where ${workspaceSetting.organizationId} = ${bountyProfile.organizationId} and not ${workspaceSetting.prepareSandboxes})`,
);

export interface StoredBountyProfile {
  readonly id: string;
  readonly organizationId: string;
  readonly proposalId: string;
  readonly specRevision: number;
  readonly specHash: string;
  readonly snapshotId: string | null;
  /**
   * The full name of the repository the snapshot is of, as it is called
   * now; null once the snapshot is gone.
   */
  readonly repository: string | null;
  readonly status: ProfileStatus;
  readonly errorCode: ProfileErrorCode | null;
  readonly runErrorCode: AnalysisErrorCode | null;
  readonly scopeRunId: string | null;
  readonly sliceRunId: string | null;
  /** The sandbox's preparation run, once one is queued. */
  readonly preparedRunId: string | null;
  readonly profile: ComplexityProfile | null;
  /**
   * When an owner or admin approved its slice, one wider than the profiler
   * cuts unasked; null for a slice within those limits.
   */
  readonly sliceApprovedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * What a sizing asks to be profiled: one spec revision, beside one
 * snapshot, of one of the repositories its work touches.
 */
export interface NewBountyProfile {
  readonly proposalId: string;
  readonly specRevision: number;
  readonly specHash: string;
  readonly snapshotId: string;
}

/** The one step a sweep takes a row: each status says what it carries. */
export type ProfileTransition =
  | { readonly status: "scoping"; readonly scopeRunId: string }
  | { readonly status: "slicing"; readonly sliceRunId: string }
  /**
   * Measured, so its price goes on, but its slice is wider than is cut
   * unasked: nothing is cut or prepared from it until `approveSlice`.
   */
  | {
      readonly status: "awaiting_approval";
      readonly profile: ComplexityProfile;
    }
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
  /**
   * The profiles of a proposal's newest profiled spec revision, one per
   * repository its work touches, in name order; empty for none.
   */
  latest(
    organizationId: string,
    proposalId: string,
  ): Promise<StoredBountyProfile[]>;
  /** The profiles of one spec revision, one per repository, in name order. */
  forRevision(
    organizationId: string,
    proposalId: string,
    specRevision: number,
  ): Promise<StoredBountyProfile[]>;
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
  /**
   * Approves the slice a measured profile waits on, as the person who
   * looked at it: `awaiting_approval` becomes `ready`, and a `ready` one
   * measured before approvals were asked for is marked approved. Asking
   * again for the same slice run is true and keeps the first approval, so
   * a retry after the approval committed still goes on. False when the
   * profile is not measured from that slice run, so an approval of what
   * was shown cannot pass for another.
   */
  approveSlice(
    organizationId: string,
    profileId: string,
    sliceRunId: string,
    approvedBy: string,
  ): Promise<boolean>;
  /**
   * Ready profiles with no preparation yet, of an approved proposal's
   * current spec revision, in a workspace that prepares its sandboxes,
   * least recently moved first.
   */
  unprepared(
    organizationId: string,
    limit?: number,
  ): Promise<StoredBountyProfile[]>;
  /** Privileged discovery for `unprepared`, followed by owner-scoped reads. */
  organizationsWithUnprepared(): Promise<string[]>;
  /**
   * Names a ready profile's preparation run. False when it has one, or is
   * not ready, so two passes cannot both queue one.
   */
  recordPrepared(
    organizationId: string,
    profileId: string,
    runId: string,
  ): Promise<boolean>;
  /** The preparation run of the profile a slice run was cut for, if any. */
  preparationFor(
    organizationId: string,
    sliceRunId: string,
  ): Promise<string | null>;
}

function toStored(
  row: BountyProfileRow,
  repository: string | null,
): StoredBountyProfile {
  return {
    id: row.id,
    organizationId: row.organizationId,
    proposalId: row.proposalId,
    specRevision: row.specRevision,
    specHash: row.specHash,
    snapshotId: row.snapshotId,
    repository,
    status: row.status,
    errorCode: row.errorCode,
    runErrorCode: row.runErrorCode,
    scopeRunId: row.scopeRunId,
    sliceRunId: row.sliceRunId,
    preparedRunId: row.preparedRunId,
    profile: row.profile,
    sliceApprovedAt: row.sliceApprovedAt?.toISOString() ?? null,
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
  /** Rows with the repository each one's snapshot is of, in name order. */
  const named = async (where: SQL | undefined) =>
    (
      (await db
        .select({ row: bountyProfile, repository: githubRepo.fullName })
        .from(bountyProfile)
        .leftJoin(repoSnapshot, eq(repoSnapshot.id, bountyProfile.snapshotId))
        .leftJoin(githubRepo, eq(githubRepo.id, repoSnapshot.repoId))
        .where(where)
        .orderBy(asc(githubRepo.fullName), asc(bountyProfile.id))) as {
        row: BountyProfileRow;
        repository: string | null;
      }[]
    ).map(({ row, repository }) => toStored(row, repository));
  return {
    async request(owner, input) {
      return db.transaction(async (transaction) => {
        const tx = transaction;
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
          })
          .onConflictDoNothing();
        const rows = (await tx
          .select({ row: bountyProfile, repository: githubRepo.fullName })
          .from(bountyProfile)
          .leftJoin(repoSnapshot, eq(repoSnapshot.id, bountyProfile.snapshotId))
          .leftJoin(githubRepo, eq(githubRepo.id, repoSnapshot.repoId))
          .where(
            and(
              revisionOf(owner, input.proposalId, input.specRevision),
              eq(bountyProfile.snapshotId, snapshotId),
            ),
          )
          .limit(1)) as {
          row: BountyProfileRow;
          repository: string | null;
        }[];
        const found = rows[0];
        return found === undefined
          ? null
          : toStored(found.row, found.repository);
      });
    },
    async latest(owner, proposalId) {
      const newest = (await db
        .select({ specRevision: bountyProfile.specRevision })
        .from(bountyProfile)
        .where(
          and(
            eq(bountyProfile.organizationId, owner),
            eq(bountyProfile.proposalId, proposalId),
          ),
        )
        .orderBy(desc(bountyProfile.specRevision))
        .limit(1)) as { specRevision: number }[];
      const revision = newest[0]?.specRevision;
      return revision === undefined
        ? []
        : named(revisionOf(owner, proposalId, revision));
    },
    forRevision: (owner, proposalId, specRevision) =>
      named(revisionOf(owner, proposalId, specRevision)),
    async pending(owner, limit = 50) {
      const rows = (await db
        .select({ row: bountyProfile, repository: githubRepo.fullName })
        .from(bountyProfile)
        .leftJoin(repoSnapshot, eq(repoSnapshot.id, bountyProfile.snapshotId))
        .leftJoin(githubRepo, eq(githubRepo.id, repoSnapshot.repoId))
        .where(
          and(
            eq(bountyProfile.organizationId, owner),
            inArray(bountyProfile.status, [...PENDING_PROFILE_STATUSES]),
          ),
        )
        .orderBy(asc(bountyProfile.updatedAt), asc(bountyProfile.id))
        .limit(Math.min(200, Math.max(1, limit)))) as {
        row: BountyProfileRow;
        repository: string | null;
      }[];
      return rows.map(({ row, repository }) => toStored(row, repository));
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
    async unprepared(owner, limit = 50) {
      const rows = (await db
        .select({ row: bountyProfile, repository: githubRepo.fullName })
        .from(bountyProfile)
        .innerJoin(
          bountyProposal,
          eq(bountyProposal.id, bountyProfile.proposalId),
        )
        .leftJoin(repoSnapshot, eq(repoSnapshot.id, bountyProfile.snapshotId))
        .leftJoin(githubRepo, eq(githubRepo.id, repoSnapshot.repoId))
        .where(and(eq(bountyProfile.organizationId, owner), UNPREPARED))
        .orderBy(asc(bountyProfile.updatedAt), asc(bountyProfile.id))
        .limit(Math.min(200, Math.max(1, limit)))) as {
        row: BountyProfileRow;
        repository: string | null;
      }[];
      return rows.map(({ row, repository }) => toStored(row, repository));
    },
    async organizationsWithUnprepared() {
      const rows = (await db
        .select({ organizationId: bountyProfile.organizationId })
        .from(bountyProfile)
        .innerJoin(
          bountyProposal,
          eq(bountyProposal.id, bountyProfile.proposalId),
        )
        .where(UNPREPARED)) as { organizationId: string }[];
      return [...new Set(rows.map((row) => row.organizationId))];
    },
    async recordPrepared(owner, profileId, runId) {
      const rows = await db
        .update(bountyProfile)
        .set({ preparedRunId: runId })
        .where(
          and(
            eq(bountyProfile.organizationId, owner),
            eq(bountyProfile.id, profileId),
            eq(bountyProfile.status, "ready"),
            isNull(bountyProfile.preparedRunId),
          ),
        )
        .returning({ id: bountyProfile.id });
      return rows.length > 0;
    },
    async preparationFor(owner, sliceRunId) {
      const rows = (await db
        .select({ preparedRunId: bountyProfile.preparedRunId })
        .from(bountyProfile)
        .where(
          and(
            eq(bountyProfile.organizationId, owner),
            eq(bountyProfile.sliceRunId, sliceRunId),
            isNotNull(bountyProfile.preparedRunId),
          ),
        )
        .orderBy(desc(bountyProfile.specRevision), desc(bountyProfile.id))
        .limit(1)) as { preparedRunId: string | null }[];
      return rows[0]?.preparedRunId ?? null;
    },
    async approveSlice(owner, profileId, sliceRunId, approvedBy) {
      const now = new Date();
      const moved: ProfileTransitionTime = {
        status: "ready",
        at: now.toISOString(),
      };
      const rows = await db
        .update(bountyProfile)
        .set({
          status: "ready",
          // The first approval stands; a retry only finds it there.
          sliceApprovedBy: sql`case when ${bountyProfile.sliceApprovedAt} is null then ${approvedBy} else ${bountyProfile.sliceApprovedBy} end`,
          sliceApprovedAt: sql`coalesce(${bountyProfile.sliceApprovedAt}, ${now.toISOString()}::timestamptz)`,
          transitions: sql`${bountyProfile.transitions} || case when ${bountyProfile.status} = 'awaiting_approval' then ${JSON.stringify([moved])}::jsonb else '[]'::jsonb end`,
          updatedAt: now,
        })
        .where(
          and(
            eq(bountyProfile.organizationId, owner),
            eq(bountyProfile.id, profileId),
            inArray(bountyProfile.status, ["awaiting_approval", "ready"]),
            isNotNull(bountyProfile.profile),
            eq(bountyProfile.sliceRunId, sliceRunId),
          ),
        )
        .returning({ proposalId: bountyProfile.proposalId });
      const proposalId = rows[0]?.proposalId;
      if (proposalId === undefined) return false;
      await announceChange(db, {
        organizationId: owner,
        kind: "profile",
        id: proposalId,
      });
      return true;
    },
    async advance(owner, profileId, from, to) {
      const now = new Date();
      const moved: ProfileTransitionTime = {
        status: to.status,
        at: now.toISOString(),
      };
      const rows = await db
        .update(bountyProfile)
        .set({
          status: to.status,
          ...(to.status === "scoping" ? { scopeRunId: to.scopeRunId } : {}),
          ...(to.status === "slicing" ? { sliceRunId: to.sliceRunId } : {}),
          ...(to.status === "ready" || to.status === "awaiting_approval"
            ? { profile: to.profile }
            : {}),
          ...(to.status === "failed"
            ? { errorCode: to.errorCode, runErrorCode: to.runErrorCode ?? null }
            : {}),
          transitions: sql`${bountyProfile.transitions} || ${JSON.stringify([moved])}::jsonb`,
          updatedAt: now,
        })
        .where(
          and(
            eq(bountyProfile.organizationId, owner),
            eq(bountyProfile.id, profileId),
            eq(bountyProfile.status, from),
          ),
        )
        .returning({ proposalId: bountyProfile.proposalId });
      const proposalId = rows[0]?.proposalId;
      if (proposalId === undefined) return false;
      // A page reads a proposal's profiles together, so names the proposal.
      await announceChange(db, {
        organizationId: owner,
        kind: "profile",
        id: proposalId,
      });
      return true;
    },
  };
}
