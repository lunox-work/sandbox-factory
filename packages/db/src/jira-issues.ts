import type { BountyContent } from "sandbox-factory";
import { clampBountyTitle } from "sandbox-factory";
import { and, eq, inArray } from "drizzle-orm";

import type { Database } from "./errors.js";
import { generateId } from "./mapping.js";
import { bounty, jiraBoard, jiraIssue } from "./schema.js";
import type { JiraIssueRow, BountyRow } from "./schema.js";
import { insertBounty, refreshBounty } from "./bounties.js";

export interface JiraIssuePointer {
  readonly id: string;
  readonly boardId: string;
  /** The bounty the issue is imported as. */
  readonly bountyId: string;
  readonly externalId: string;
  readonly key: string;
  readonly statusCategory: string;
  readonly remoteCreatedAt: string;
  readonly remoteUpdatedAt: string;
  readonly removedAt: string | null;
}

export interface JiraIssueInput {
  readonly externalId: string;
  readonly key: string;
  readonly statusCategory: string;
  readonly remoteCreatedAt: string;
  readonly remoteUpdatedAt: string;
}

export type JiraIssueLinkResult =
  | { readonly ok: true; readonly pointer: JiraIssuePointer }
  | { readonly ok: false; readonly reason: "not-found" }
  | {
      readonly ok: false;
      /** The issue is already `bountyId`'s. */
      readonly reason: "issue-linked";
      readonly bountyId: string;
    };

export interface JiraIssueStore {
  get(
    organizationId: string,
    issueId: string,
  ): Promise<JiraIssuePointer | null>;
  /**
   * Imports an issue a run has read: its pointer, and the bounty it stands
   * for with the text Jira gave. The first read makes the bounty; every one
   * after refreshes both. Null when the board is not the organization's.
   */
  upsert(
    organizationId: string,
    boardId: string,
    input: JiraIssueInput,
    content: BountyContent,
  ): Promise<JiraIssuePointer | null>;
  /**
   * Links a bounty that exists to an issue someone picked for it, in place
   * of any issue it was linked to before. From then on the bounty follows
   * the issue, so Jira's text is written over its own now. Refused when the
   * board or the bounty is not the organization's, and when the issue is
   * already another bounty's: an issue is one bounty's, as importing holds.
   */
  link(
    organizationId: string,
    boardId: string,
    bountyId: string,
    input: JiraIssueInput,
    content: BountyContent,
  ): Promise<JiraIssueLinkResult>;
  /**
   * Takes the bounty's issue from it. The bounty keeps the text it has and
   * is the platform's to change again. False when it had no issue.
   */
  unlink(organizationId: string, bountyId: string): Promise<boolean>;
  /**
   * Which of a board's issues, by Jira's id, are imported or linked, and
   * the bounty each one is.
   */
  bountiesFor(
    organizationId: string,
    boardId: string,
    externalIds: readonly string[],
  ): Promise<Map<string, string>>;
  markRemoved(
    organizationId: string,
    issueId: string,
    at?: Date,
  ): Promise<boolean>;
  /**
   * The same, for an issue known by Jira's id: one a run could not read,
   * which it may or may not have imported before. False when it had not.
   */
  markRemovedByExternal(
    organizationId: string,
    boardId: string,
    externalId: string,
    at?: Date,
  ): Promise<boolean>;
}

function toPointer(row: JiraIssueRow): JiraIssuePointer {
  return {
    id: row.id,
    boardId: row.boardId,
    bountyId: row.bountyId,
    externalId: row.externalId,
    key: row.key,
    statusCategory: row.statusCategory,
    remoteCreatedAt: row.remoteCreatedAt.toISOString(),
    remoteUpdatedAt: row.remoteUpdatedAt.toISOString(),
    removedAt: row.removedAt?.toISOString() ?? null,
  };
}

export function createJiraIssueStore(db: Database): JiraIssueStore {
  return {
    async get(organizationId, issueId) {
      const rows = (await db
        .select()
        .from(jiraIssue)
        .where(
          and(
            eq(jiraIssue.organizationId, organizationId),
            eq(jiraIssue.id, issueId),
          ),
        )) as JiraIssueRow[];
      return rows[0] === undefined ? null : toPointer(rows[0]);
    },

    async upsert(organizationId, boardId, input, content) {
      return db.transaction(async (transaction) => {
        const tx = transaction;
        const owned = await tx
          .select({ id: jiraBoard.id })
          .from(jiraBoard)
          .where(
            and(
              eq(jiraBoard.organizationId, organizationId),
              eq(jiraBoard.id, boardId),
            ),
          );
        if (owned[0] === undefined) return null;

        const facts = factsOf(input);
        const where = issueWhere(organizationId, boardId, input.externalId);

        // Seen before: the pointer's facts and the bounty's text, together,
        // with the pointer locked so two runs refresh one at a time.
        const known = (await tx
          .update(jiraIssue)
          .set(facts)
          .where(where)
          .returning()) as JiraIssueRow[];
        if (known[0] !== undefined) {
          await refreshImported(tx, organizationId, known[0].bountyId, content);
          return toPointer(known[0]);
        }

        // New: the bounty first, which the pointer names.
        const created = await insertBounty(tx, organizationId, {
          ...importedText(content, input.key),
          origin: "jira",
        });
        const inserted = (await tx
          .insert(jiraIssue)
          .values({
            id: generateId("jri"),
            organizationId,
            boardId,
            externalId: input.externalId,
            bountyId: created.id,
            ...facts,
          })
          .onConflictDoNothing()
          .returning()) as JiraIssueRow[];
        if (inserted[0] !== undefined) return toPointer(inserted[0]);

        // Another run imported it in between: its bounty stands, and this
        // one goes. The text is refreshed onto the one that stands.
        await tx
          .delete(bounty)
          .where(
            and(
              eq(bounty.organizationId, organizationId),
              eq(bounty.id, created.id),
            ),
          );
        const raced = (await tx
          .update(jiraIssue)
          .set(facts)
          .where(where)
          .returning()) as JiraIssueRow[];
        if (raced[0] === undefined) return null;
        await refreshImported(tx, organizationId, raced[0].bountyId, content);
        return toPointer(raced[0]);
      });
    },

    async link(organizationId, boardId, bountyId, input, content) {
      return db.transaction(async (tx): Promise<JiraIssueLinkResult> => {
        const owned = await tx
          .select({ id: jiraBoard.id })
          .from(jiraBoard)
          .where(
            and(
              eq(jiraBoard.organizationId, organizationId),
              eq(jiraBoard.id, boardId),
            ),
          );
        if (owned[0] === undefined) return { ok: false, reason: "not-found" };
        // Locked, so the text written below is over the revision read here.
        const bounties = (await tx
          .select()
          .from(bounty)
          .where(
            and(
              eq(bounty.organizationId, organizationId),
              eq(bounty.id, bountyId),
            ),
          )
          .for("update")) as BountyRow[];
        const current = bounties[0];
        if (current === undefined) return { ok: false, reason: "not-found" };

        const facts = factsOf(input);
        const where = issueWhere(organizationId, boardId, input.externalId);
        const known = (await tx
          .select({ bountyId: jiraIssue.bountyId })
          .from(jiraIssue)
          .where(where)) as { bountyId: string }[];
        const owner = known[0]?.bountyId;
        if (owner !== undefined && owner !== bountyId) {
          return { ok: false, reason: "issue-linked", bountyId: owner };
        }

        let linked: JiraIssueRow | undefined;
        if (owner === bountyId) {
          // Already this bounty's: picked again, it is read again.
          linked = (
            (await tx
              .update(jiraIssue)
              .set(facts)
              .where(where)
              .returning()) as JiraIssueRow[]
          )[0];
        } else {
          // The issue it followed before, if any, is let go first: a bounty
          // has one issue.
          await tx
            .delete(jiraIssue)
            .where(
              and(
                eq(jiraIssue.organizationId, organizationId),
                eq(jiraIssue.bountyId, bountyId),
              ),
            );
          linked = (
            (await tx
              .insert(jiraIssue)
              .values({
                id: generateId("jri"),
                organizationId,
                boardId,
                externalId: input.externalId,
                bountyId,
                ...facts,
              })
              .onConflictDoNothing()
              .returning()) as JiraIssueRow[]
          )[0];
          if (linked === undefined) {
            // A run imported it in between, as a bounty of its own.
            const raced = (await tx
              .select({ bountyId: jiraIssue.bountyId })
              .from(jiraIssue)
              .where(where)) as { bountyId: string }[];
            return raced[0] === undefined
              ? { ok: false, reason: "not-found" }
              : {
                  ok: false,
                  reason: "issue-linked",
                  bountyId: raced[0].bountyId,
                };
          }
        }
        if (linked === undefined) return { ok: false, reason: "not-found" };
        await refreshBounty(tx, organizationId, current, content);
        return { ok: true, pointer: toPointer(linked) };
      });
    },

    async unlink(organizationId, bountyId) {
      const rows = await db
        .delete(jiraIssue)
        .where(
          and(
            eq(jiraIssue.organizationId, organizationId),
            eq(jiraIssue.bountyId, bountyId),
          ),
        )
        .returning({ id: jiraIssue.id });
      return rows.length > 0;
    },

    async bountiesFor(organizationId, boardId, externalIds) {
      if (externalIds.length === 0) return new Map();
      const rows = (await db
        .select({
          externalId: jiraIssue.externalId,
          bountyId: jiraIssue.bountyId,
        })
        .from(jiraIssue)
        .where(
          and(
            eq(jiraIssue.organizationId, organizationId),
            eq(jiraIssue.boardId, boardId),
            inArray(jiraIssue.externalId, [...externalIds]),
          ),
        )) as { externalId: string; bountyId: string }[];
      return new Map(rows.map((row) => [row.externalId, row.bountyId]));
    },

    async markRemoved(organizationId, issueId, at = new Date()) {
      const rows = (await db
        .update(jiraIssue)
        .set({ removedAt: at })
        .where(
          and(
            eq(jiraIssue.organizationId, organizationId),
            eq(jiraIssue.id, issueId),
          ),
        )
        .returning()) as JiraIssueRow[];
      return rows.length > 0;
    },

    async markRemovedByExternal(
      organizationId,
      boardId,
      externalId,
      at = new Date(),
    ) {
      const rows = (await db
        .update(jiraIssue)
        .set({ removedAt: at })
        .where(
          and(
            eq(jiraIssue.organizationId, organizationId),
            eq(jiraIssue.boardId, boardId),
            eq(jiraIssue.externalId, externalId),
          ),
        )
        .returning()) as JiraIssueRow[];
      return rows.length > 0;
    },
  };
}

/** The pointer's columns that say what Jira said, as of now. */
function factsOf(input: JiraIssueInput) {
  return {
    key: input.key,
    statusCategory: input.statusCategory,
    remoteCreatedAt: new Date(input.remoteCreatedAt),
    remoteUpdatedAt: new Date(input.remoteUpdatedAt),
    lastSeenAt: new Date(),
    removedAt: null,
  };
}

/** One issue on one of the organization's boards. */
function issueWhere(
  organizationId: string,
  boardId: string,
  externalId: string,
) {
  return and(
    eq(jiraIssue.organizationId, organizationId),
    eq(jiraIssue.boardId, boardId),
    eq(jiraIssue.externalId, externalId),
  );
}

/** What an imported bounty is made with: Jira's text, its key for a title. */
function importedText(content: BountyContent, key: string) {
  return {
    title: clampBountyTitle(content.title.trim() === "" ? key : content.title),
    description: content.description,
    components: [...content.components],
    inputTruncated: content.inputTruncated,
  };
}

async function refreshImported(
  tx: Database,
  organizationId: string,
  bountyId: string,
  content: BountyContent,
): Promise<void> {
  const rows = (await tx
    .select()
    .from(bounty)
    .where(
      and(eq(bounty.organizationId, organizationId), eq(bounty.id, bountyId)),
    )
    .for("update")) as BountyRow[];
  if (rows[0] !== undefined) {
    await refreshBounty(tx, organizationId, rows[0], content);
  }
}
