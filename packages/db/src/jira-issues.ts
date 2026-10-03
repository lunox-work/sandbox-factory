import type { TicketContent } from "sandbox-factory";
import { clampTicketTitle } from "sandbox-factory";
import { and, eq } from "drizzle-orm";

import type { Database } from "./errors.js";
import { generateId } from "./mapping.js";
import { jiraBoard, jiraIssue, ticket } from "./schema.js";
import type { JiraIssueRow, TicketRow } from "./schema.js";
import { insertTicket, refreshTicket } from "./tickets.js";

export interface JiraIssuePointer {
  readonly id: string;
  readonly boardId: string;
  /** The ticket the issue is imported as. */
  readonly ticketId: string;
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
   * Imports an issue a run has read: its pointer, and the ticket it stands
   * for with the text Jira gave. The first read makes the ticket; every one
   * after refreshes both. Null when the board is not the organization's.
   */
  upsert(
    organizationId: string,
    boardId: string,
    input: JiraIssueInput,
    content: TicketContent,
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
    ticketId: row.ticketId,
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
        const tx = transaction as unknown as Database;
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

        // Seen before: the pointer's facts and the ticket's text, together,
        // with the pointer locked so two runs refresh one at a time.
        const known = (await tx
          .update(jiraIssue)
          .set(facts)
          .where(where)
          .returning()) as JiraIssueRow[];
        if (known[0] !== undefined) {
          await refreshImported(tx, organizationId, known[0].ticketId, content);
          return toPointer(known[0]);
        }

        // New: the ticket first, which the pointer names.
        const created = await insertTicket(tx, organizationId, {
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
            ticketId: created.id,
            ...facts,
          })
          .onConflictDoNothing()
          .returning()) as JiraIssueRow[];
        if (inserted[0] !== undefined) return toPointer(inserted[0]);

        // Another run imported it in between: its ticket stands, and this
        // one goes. The text is refreshed onto the one that stands.
        await tx
          .delete(ticket)
          .where(
            and(
              eq(ticket.organizationId, organizationId),
              eq(ticket.id, created.id),
            ),
          );
        const raced = (await tx
          .update(jiraIssue)
          .set(facts)
          .where(where)
          .returning()) as JiraIssueRow[];
        if (raced[0] === undefined) return null;
        await refreshImported(tx, organizationId, raced[0].ticketId, content);
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

/** What an imported ticket is made with: Jira's text, its key for a title. */
function importedText(content: TicketContent, key: string) {
  return {
    title: clampTicketTitle(content.title.trim() === "" ? key : content.title),
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
  ticketId: string,
  content: TicketContent,
): Promise<void> {
  const rows = (await tx
    .select()
    .from(ticket)
    .where(
      and(eq(ticket.organizationId, organizationId), eq(ticket.id, ticketId)),
    )
    .for("update")) as TicketRow[];
  if (rows[0] !== undefined) {
    await refreshTicket(tx, organizationId, rows[0], content);
  }
}
