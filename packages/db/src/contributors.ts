/**
 * Contributors: people outside a workspace invited to work on one of its
 * published versions, before there is a marketplace. See
 * `contributor_invite` and `contributor_assignment` in `schema/sandbox.ts`.
 *
 * Owner first, as every store: the invite and assignment management a
 * workspace does takes the organization and puts it in its `WHERE`. Three
 * methods are the contributor's side and take none, because they are what
 * establishes it, as `findByHash` does for API tokens and `roleOf` for a
 * membership: `findInvite` (the hash of a high-entropy secret is the
 * capability), and `assignmentFor`/`assignmentsOf`, which answer only the
 * signed-in person's own live assignments. `claim` takes the organization
 * `findInvite` named.
 */

import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { isUniqueViolation, type Database } from "./errors.js";
import { generateId } from "./mapping.js";
import {
  contributorAssignment,
  contributorInvite,
  sandbox,
  sandboxVersion,
  user,
} from "./schema.js";
import type { ContributorInviteRow } from "./schema.js";

export interface StoredContributorInvite {
  readonly id: string;
  readonly organizationId: string;
  readonly sandboxVersionId: string;
  /** Null once the inviter's account is gone. */
  readonly createdBy: { readonly id: string; readonly name: string } | null;
  readonly emailHint: string | null;
  readonly label: string | null;
  /** The secret's hash: compared at claim, never answered. */
  readonly tokenSha256: string;
  readonly expiresAt: Date;
  readonly maxClaims: number;
  readonly claims: number;
  readonly revokedAt: Date | null;
  readonly claimedBy: string | null;
  readonly claimedAt: Date | null;
  readonly createdAt: Date;
}

export interface StoredContributorAssignment {
  readonly id: string;
  readonly organizationId: string;
  readonly sandboxVersionId: string;
  readonly user: {
    readonly id: string;
    readonly name: string;
    readonly email: string;
  };
  /** The invite it was claimed with; null once that invite is gone. */
  readonly inviteId: string | null;
  readonly createdAt: Date;
  readonly revokedAt: Date | null;
}

export interface NewContributorInvite {
  readonly sandboxVersionId: string;
  readonly createdBy: string;
  readonly emailHint: string | null;
  readonly label: string | null;
  /** Hex SHA-256 of the secret. The secret itself never reaches the store. */
  readonly tokenSha256: string;
  readonly expiresAt: Date;
  readonly maxClaims: number;
}

export type ClaimInviteResult =
  | {
      readonly ok: true;
      readonly assignment: StoredContributorAssignment;
      /** False when the person already held a live assignment there. */
      readonly created: boolean;
    }
  /**
   * Revoked, expired, claimed as often as it may be, or gone: one reason,
   * so a caller cannot tell a stranger which.
   */
  | { readonly ok: false; readonly reason: "unavailable" };

export interface ContributorStore {
  /** Null when the organization has no such version. */
  createInvite(
    organizationId: string,
    input: NewContributorInvite,
  ): Promise<StoredContributorInvite | null>;
  /** A version's invites, revoked and spent ones too, newest first. */
  listInvites(
    organizationId: string,
    sandboxVersionId: string,
  ): Promise<StoredContributorInvite[]>;
  /** Stops an invite admitting claims; a second revoke keeps the first time. */
  revokeInvite(
    organizationId: string,
    inviteId: string,
    at: Date,
  ): Promise<StoredContributorInvite | null>;
  /** A version's assignments, revoked ones too, newest first. */
  listAssignments(
    organizationId: string,
    sandboxVersionId: string,
  ): Promise<StoredContributorAssignment[]>;
  /** Ends a contributor's access; a second revoke keeps the first time. */
  revokeAssignment(
    organizationId: string,
    assignmentId: string,
    at: Date,
  ): Promise<StoredContributorAssignment | null>;
  /** The invite whose secret hashes to this, whatever its state. */
  findInvite(tokenSha256: string): Promise<StoredContributorInvite | null>;
  /**
   * Claims an invite for `userId` at `at`, under the invite's lock: a live
   * assignment they already hold on its version is answered as it is;
   * otherwise an unrevoked, unexpired invite with a claim left makes one.
   */
  claim(
    organizationId: string,
    inviteId: string,
    userId: string,
    at: Date,
  ): Promise<ClaimInviteResult>;
  /** The person's live assignment to a version, or null. */
  assignmentFor(
    userId: string,
    sandboxVersionId: string,
  ): Promise<StoredContributorAssignment | null>;
  /** The person's live assignments, newest first. */
  assignmentsOf(userId: string): Promise<StoredContributorAssignment[]>;
}

/** At most this many listed: more is a leak, not a list. */
const LIST_LIMIT = 200;

const inviteColumns = {
  invite: contributorInvite,
  createdByName: user.name,
};

const toInvite = ({
  invite,
  createdByName,
}: {
  invite: ContributorInviteRow;
  createdByName: string | null;
}): StoredContributorInvite => ({
  id: invite.id,
  organizationId: invite.organizationId,
  sandboxVersionId: invite.sandboxVersionId,
  createdBy:
    invite.createdBy === null || createdByName === null
      ? null
      : { id: invite.createdBy, name: createdByName },
  emailHint: invite.emailHint,
  label: invite.label,
  tokenSha256: invite.tokenSha256,
  expiresAt: invite.expiresAt,
  maxClaims: invite.maxClaims,
  claims: invite.claims,
  revokedAt: invite.revokedAt,
  claimedBy: invite.claimedBy,
  claimedAt: invite.claimedAt,
  createdAt: invite.createdAt,
});

const assignmentColumns = {
  id: contributorAssignment.id,
  organizationId: contributorAssignment.organizationId,
  sandboxVersionId: contributorAssignment.sandboxVersionId,
  userId: contributorAssignment.userId,
  userName: user.name,
  userEmail: user.email,
  inviteId: contributorAssignment.inviteId,
  createdAt: contributorAssignment.createdAt,
  revokedAt: contributorAssignment.revokedAt,
};

type AssignmentRow = {
  id: string;
  organizationId: string;
  sandboxVersionId: string;
  userId: string;
  userName: string;
  userEmail: string;
  inviteId: string | null;
  createdAt: Date;
  revokedAt: Date | null;
};

const toAssignment = ({
  userId,
  userName,
  userEmail,
  ...row
}: AssignmentRow): StoredContributorAssignment => ({
  ...row,
  user: { id: userId, name: userName, email: userEmail },
});

export function createContributorStore(db: Database): ContributorStore {
  type Executor = Pick<Database, "select">;
  const inviteOf = async (exec: Executor, owner: string, id: string) => {
    const [row] = await exec
      .select(inviteColumns)
      .from(contributorInvite)
      .leftJoin(user, eq(user.id, contributorInvite.createdBy))
      .where(
        and(
          eq(contributorInvite.organizationId, owner),
          eq(contributorInvite.id, id),
        ),
      )
      .limit(1);
    return row === undefined ? null : toInvite(row);
  };
  const assignmentOf = async (exec: Executor, owner: string, id: string) => {
    const [row] = (await exec
      .select(assignmentColumns)
      .from(contributorAssignment)
      .innerJoin(user, eq(user.id, contributorAssignment.userId))
      .where(
        and(
          eq(contributorAssignment.organizationId, owner),
          eq(contributorAssignment.id, id),
        ),
      )
      .limit(1)) as AssignmentRow[];
    return row === undefined ? null : toAssignment(row);
  };
  /** A person's live assignment to a version in `owner`, by its id. */
  const liveIn = async (
    exec: Executor,
    owner: string,
    versionId: string,
    userId: string,
  ) =>
    (
      await exec
        .select({ id: contributorAssignment.id })
        .from(contributorAssignment)
        .where(
          and(
            eq(contributorAssignment.organizationId, owner),
            eq(contributorAssignment.sandboxVersionId, versionId),
            eq(contributorAssignment.userId, userId),
            isNull(contributorAssignment.revokedAt),
          ),
        )
        .limit(1)
    )[0];

  return {
    async createInvite(owner, input) {
      // The version is the owner's, through its sandbox.
      const [version] = await db
        .select({ id: sandboxVersion.id })
        .from(sandboxVersion)
        .innerJoin(sandbox, eq(sandbox.id, sandboxVersion.sandboxId))
        .where(
          and(
            eq(sandbox.organizationId, owner),
            eq(sandboxVersion.id, input.sandboxVersionId),
          ),
        )
        .limit(1);
      if (version === undefined) return null;
      const id = generateId("cin");
      await db.insert(contributorInvite).values({
        id,
        organizationId: owner,
        sandboxVersionId: input.sandboxVersionId,
        createdBy: input.createdBy,
        emailHint: input.emailHint,
        label: input.label,
        tokenSha256: input.tokenSha256,
        expiresAt: input.expiresAt,
        maxClaims: input.maxClaims,
      });
      const created = await inviteOf(db, owner, id);
      if (created === null) throw new Error("Invite insert left no row.");
      return created;
    },

    async listInvites(owner, versionId) {
      const rows = await db
        .select(inviteColumns)
        .from(contributorInvite)
        .leftJoin(user, eq(user.id, contributorInvite.createdBy))
        .where(
          and(
            eq(contributorInvite.organizationId, owner),
            eq(contributorInvite.sandboxVersionId, versionId),
          ),
        )
        .orderBy(desc(contributorInvite.createdAt), desc(contributorInvite.id))
        .limit(LIST_LIMIT);
      return rows.map(toInvite);
    },

    async revokeInvite(owner, id, at) {
      const updated = await db
        .update(contributorInvite)
        .set({
          revokedAt: sql`coalesce(${contributorInvite.revokedAt}, ${at.toISOString()}::timestamptz)`,
        })
        .where(
          and(
            eq(contributorInvite.organizationId, owner),
            eq(contributorInvite.id, id),
          ),
        )
        .returning({ id: contributorInvite.id });
      return updated.length === 0 ? null : inviteOf(db, owner, id);
    },

    async listAssignments(owner, versionId) {
      const rows = (await db
        .select(assignmentColumns)
        .from(contributorAssignment)
        .innerJoin(user, eq(user.id, contributorAssignment.userId))
        .where(
          and(
            eq(contributorAssignment.organizationId, owner),
            eq(contributorAssignment.sandboxVersionId, versionId),
          ),
        )
        .orderBy(
          desc(contributorAssignment.createdAt),
          desc(contributorAssignment.id),
        )
        .limit(LIST_LIMIT)) as AssignmentRow[];
      return rows.map(toAssignment);
    },

    async revokeAssignment(owner, id, at) {
      const updated = await db
        .update(contributorAssignment)
        .set({
          revokedAt: sql`coalesce(${contributorAssignment.revokedAt}, ${at.toISOString()}::timestamptz)`,
        })
        .where(
          and(
            eq(contributorAssignment.organizationId, owner),
            eq(contributorAssignment.id, id),
          ),
        )
        .returning({ id: contributorAssignment.id });
      return updated.length === 0 ? null : assignmentOf(db, owner, id);
    },

    async findInvite(tokenSha256) {
      const [row] = await db
        .select(inviteColumns)
        .from(contributorInvite)
        .leftJoin(user, eq(user.id, contributorInvite.createdBy))
        .where(eq(contributorInvite.tokenSha256, tokenSha256))
        .limit(1);
      return row === undefined ? null : toInvite(row);
    },

    async claim(owner, inviteId, userId, at) {
      const unavailable = { ok: false, reason: "unavailable" } as const;
      try {
        return await db.transaction(async (tx): Promise<ClaimInviteResult> => {
          // Locked, so two claims of a one-claim invite never both land.
          const [invite] = await tx
            .select()
            .from(contributorInvite)
            .where(
              and(
                eq(contributorInvite.organizationId, owner),
                eq(contributorInvite.id, inviteId),
              ),
            )
            .limit(1)
            .for("update");
          if (invite === undefined) return unavailable;
          const live = await liveIn(tx, owner, invite.sandboxVersionId, userId);
          if (live !== undefined) {
            const held = await assignmentOf(tx, owner, live.id);
            return held === null
              ? unavailable
              : { ok: true, assignment: held, created: false };
          }
          if (
            invite.revokedAt !== null ||
            invite.expiresAt.getTime() <= at.getTime() ||
            invite.claims >= invite.maxClaims
          )
            return unavailable;
          const id = generateId("cas");
          await tx.insert(contributorAssignment).values({
            id,
            organizationId: owner,
            sandboxVersionId: invite.sandboxVersionId,
            userId,
            inviteId: invite.id,
            createdAt: at,
          });
          await tx
            .update(contributorInvite)
            .set({
              claims: sql`${contributorInvite.claims} + 1`,
              claimedBy: sql`coalesce(${contributorInvite.claimedBy}, ${userId})`,
              claimedAt: sql`coalesce(${contributorInvite.claimedAt}, ${at.toISOString()}::timestamptz)`,
            })
            .where(
              and(
                eq(contributorInvite.organizationId, owner),
                eq(contributorInvite.id, invite.id),
              ),
            );
          const made = await assignmentOf(tx, owner, id);
          if (made === null) throw new Error("Assignment insert left no row.");
          return { ok: true, assignment: made, created: true };
        });
      } catch (error) {
        // The same person claiming twice at once: the second finds the first.
        if (!isUniqueViolation(error)) throw error;
        const invite = await inviteOf(db, owner, inviteId);
        const live =
          invite === null
            ? undefined
            : await liveIn(db, owner, invite.sandboxVersionId, userId);
        const held =
          live === undefined ? null : await assignmentOf(db, owner, live.id);
        return held === null
          ? unavailable
          : { ok: true, assignment: held, created: false };
      }
    },

    async assignmentFor(userId, versionId) {
      const [row] = (await db
        .select(assignmentColumns)
        .from(contributorAssignment)
        .innerJoin(user, eq(user.id, contributorAssignment.userId))
        .where(
          and(
            eq(contributorAssignment.userId, userId),
            eq(contributorAssignment.sandboxVersionId, versionId),
            isNull(contributorAssignment.revokedAt),
          ),
        )
        .limit(1)) as AssignmentRow[];
      return row === undefined ? null : toAssignment(row);
    },

    async assignmentsOf(userId) {
      const rows = (await db
        .select(assignmentColumns)
        .from(contributorAssignment)
        .innerJoin(user, eq(user.id, contributorAssignment.userId))
        .where(
          and(
            eq(contributorAssignment.userId, userId),
            isNull(contributorAssignment.revokedAt),
          ),
        )
        .orderBy(
          desc(contributorAssignment.createdAt),
          desc(contributorAssignment.id),
        )
        .limit(LIST_LIMIT)) as AssignmentRow[];
      return rows.map(toAssignment);
    },
  };
}
