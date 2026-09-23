import { and, eq } from "drizzle-orm";

import type { Database } from "./errors.js";
import { generateId } from "./mapping.js";
import { jiraBoard, jiraIssue } from "./schema.js";
import type { JiraIssueRow } from "./schema.js";

export interface JiraIssuePointer {
  readonly id: string;
  readonly boardId: string;
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
  upsert(
    organizationId: string,
    boardId: string,
    input: JiraIssueInput,
  ): Promise<JiraIssuePointer | null>;
  markRemoved(
    organizationId: string,
    issueId: string,
    at?: Date,
  ): Promise<boolean>;
}

function toPointer(row: JiraIssueRow): JiraIssuePointer {
  return {
    id: row.id,
    boardId: row.boardId,
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

    async upsert(organizationId, boardId, input) {
      const owned = await db
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
      const rows = (await db
        .insert(jiraIssue)
        .values({
          id: generateId("jri"),
          organizationId,
          boardId,
          externalId: input.externalId,
          ...facts,
        })
        .onConflictDoUpdate({
          target: [jiraIssue.boardId, jiraIssue.externalId],
          set: facts,
        })
        .returning()) as JiraIssueRow[];
      return rows[0] === undefined ? null : toPointer(rows[0]);
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
  };
}
