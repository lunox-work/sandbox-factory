/**
 * A bounty's synced context: what each of its sources said beyond its text
 * when a person last synced it, one version per change (`bounty_context`).
 * Every method takes the owner first and reaches the rows through the
 * bounty, so another organization's bounty has no context here.
 */

import type {
  ContextSource,
  GithubContext,
  JiraContext,
} from "sandbox-factory";
import { and, desc, eq } from "drizzle-orm";

import type { Database } from "./errors.js";
import { bounty, bountyContext } from "./schema.js";
import type { BountyContextRow } from "./schema.js";

/** One version of what a source said, as a sync kept it. */
export type StoredBountyContext =
  | (StoredContextBase & {
      readonly source: "jira";
      readonly content: JiraContext;
    })
  | (StoredContextBase & {
      readonly source: "github";
      readonly content: GithubContext;
    });

interface StoredContextBase {
  readonly version: number;
  readonly ref: string;
  readonly refId: string;
  readonly revision: string;
  readonly contentHash: string;
  readonly syncedBy: string | null;
  readonly createdAt: string;
  readonly checkedAt: string;
}

/** The latest version from each source; null for one never synced. */
export interface LatestBountyContext {
  readonly jira: Extract<StoredBountyContext, { source: "jira" }> | null;
  readonly github: Extract<StoredBountyContext, { source: "github" }> | null;
}

/** What one sync read from a source. */
export type NewBountyContext =
  | (NewContextBase & {
      readonly source: "jira";
      readonly content: JiraContext;
    })
  | (NewContextBase & {
      readonly source: "github";
      readonly content: GithubContext;
    });

interface NewContextBase {
  readonly ref: string;
  readonly refId: string;
  readonly revision: string;
  readonly contentHash: string;
}

export interface BountyContextStore {
  /** The latest version from each source; null for a bounty not found. */
  latest(
    organizationId: string,
    bountyId: string,
  ): Promise<LatestBountyContext | null>;
  /**
   * Keeps what a sync read. Content the latest version from the same
   * source already holds is that version, read again at a later revision:
   * its `revision` and `checkedAt` move and `changed` is false. Anything
   * else is the next version. Serialized per bounty, so two syncs at once
   * do not both take one number.
   */
  record(
    organizationId: string,
    bountyId: string,
    input: NewBountyContext,
    syncedBy: string | null,
  ): Promise<
    | {
        readonly ok: true;
        readonly context: StoredBountyContext;
        readonly changed: boolean;
      }
    | { readonly ok: false; readonly reason: "not-found" }
  >;
}

function toStored(row: BountyContextRow): StoredBountyContext {
  const base: StoredContextBase = {
    version: row.version,
    ref: row.ref,
    refId: row.refId,
    revision: row.revision,
    contentHash: row.contentHash,
    syncedBy: row.syncedBy,
    createdAt: row.createdAt.toISOString(),
    checkedAt: row.checkedAt.toISOString(),
  };
  return row.source === "jira"
    ? { ...base, source: "jira", content: row.content as JiraContext }
    : { ...base, source: "github", content: row.content as GithubContext };
}

export function createBountyContextStore(db: Database): BountyContextStore {
  return {
    async latest(organizationId, bountyId) {
      const owned = (await db
        .select({ id: bounty.id })
        .from(bounty)
        .where(
          and(
            eq(bounty.organizationId, organizationId),
            eq(bounty.id, bountyId),
          ),
        )) as { id: string }[];
      if (owned[0] === undefined) return null;
      // A bounty syncs a handful of times, so every version is read and
      // the newest of each source kept.
      const rows = (await db
        .select({ row: bountyContext })
        .from(bountyContext)
        .innerJoin(bounty, eq(bounty.id, bountyContext.bountyId))
        .where(
          and(
            eq(bounty.organizationId, organizationId),
            eq(bountyContext.bountyId, bountyId),
          ),
        )
        .orderBy(desc(bountyContext.version))) as {
        row: BountyContextRow;
      }[];
      let jira: LatestBountyContext["jira"] = null;
      let github: LatestBountyContext["github"] = null;
      for (const { row } of rows) {
        const stored = toStored(row);
        if (stored.source === "jira") {
          if (jira === null || stored.version > jira.version) jira = stored;
        } else if (github === null || stored.version > github.version) {
          github = stored;
        }
      }
      return { jira, github };
    },

    record(organizationId, bountyId, input, syncedBy) {
      return db.transaction(async (tx) => {
        // The bounty's row lock is what serializes its syncs.
        const locked = await tx
          .select({ id: bounty.id })
          .from(bounty)
          .where(
            and(
              eq(bounty.organizationId, organizationId),
              eq(bounty.id, bountyId),
            ),
          )
          .for("update");
        if (locked[0] === undefined) {
          return { ok: false as const, reason: "not-found" as const };
        }
        const source: ContextSource = input.source;
        const latestRows = (await tx
          .select()
          .from(bountyContext)
          .where(
            and(
              eq(bountyContext.bountyId, bountyId),
              eq(bountyContext.source, source),
            ),
          )
          .orderBy(desc(bountyContext.version))
          .limit(1)) as BountyContextRow[];
        const latest = latestRows[0];
        const now = new Date();
        if (
          latest !== undefined &&
          latest.refId === input.refId &&
          latest.contentHash === input.contentHash
        ) {
          const rows = (await tx
            .update(bountyContext)
            .set({ ref: input.ref, revision: input.revision, checkedAt: now })
            .where(
              and(
                eq(bountyContext.bountyId, bountyId),
                eq(bountyContext.source, source),
                eq(bountyContext.version, latest.version),
              ),
            )
            .returning()) as BountyContextRow[];
          const updated = rows[0] ?? latest;
          return {
            ok: true as const,
            context: toStored(updated),
            changed: false,
          };
        }
        const rows = (await tx
          .insert(bountyContext)
          .values({
            bountyId,
            source,
            version: (latest?.version ?? 0) + 1,
            ref: input.ref,
            refId: input.refId,
            revision: input.revision,
            content: input.content,
            contentHash: input.contentHash,
            syncedBy,
            createdAt: now,
            checkedAt: now,
          })
          .returning()) as BountyContextRow[];
        const created = rows[0];
        if (created === undefined) {
          throw new Error("Bounty context insert returned no row.");
        }
        return { ok: true as const, context: toStored(created), changed: true };
      });
    },
  };
}
