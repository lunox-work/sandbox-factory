import type { BountyContent } from "sandbox-factory";
import { clampBountyTitle } from "sandbox-factory";
import { and, eq } from "drizzle-orm";

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

        const facts = {
          key: input.key,
          statusCategory: input.statusCategory,
          remoteCreatedAt: new Date(input.remoteCreatedAt),
          remoteUpdatedAt: new Date(input.remoteUpdatedAt),
          lastSeenAt: new Date(),
          removedAt: null,
        };
        const where = and(
          eq(jiraIssue.organizationId, organizationId),
          eq(jiraIssue.boardId, boardId),
          eq(jiraIssue.externalId, input.externalId),
        );

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

/** What an imported bounty is made with: Jira's text, its key for a title. */
function importedText(content: BountyContent, key: string) {
  return {
    title: clampBountyTitle(content.title.trim() === "" ? key : content.title),
    description: content.description,
    issueType: content.issueType,
    priority: content.priority,
    labels: [...content.labels],
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
