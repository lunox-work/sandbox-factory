/**
 * The board store: which boards an organization has registered, and the
 * settings that decide which of their backlog tickets a run prices.
 *
 * Ownership works as everywhere else in this package: the organization id is
 * the first argument of every method and is in the `WHERE` clause, so a board
 * belonging to another organization is a miss rather than a row.
 *
 * No ticket ever lands here. A board row is a pointer plus settings; the
 * tickets are read from Jira when a run needs them.
 */

import { and, desc, eq } from "drizzle-orm";

import { generateId } from "./mapping.js";
import { jiraBoard, jiraConnection } from "./schema.js";
import type { JiraBoardRow } from "./schema.js";
import type { Database } from "./errors.js";

/** The selection settings, as stored. Validated by Zod at the HTTP edge. */
export interface StoredBoardSelection {
  readonly maxTickets?: number;
  readonly excludeAssigned?: boolean;
  readonly issueTypes?: readonly string[];
  readonly minAgeDays?: number;
  readonly maxAgeDays?: number | null;
  readonly minSpecChars?: number;
}

export interface JiraBoardSummary {
  readonly id: string;
  readonly connectionId: string;
  readonly externalId: string;
  readonly name: string;
  readonly boardType: string;
  readonly projectKey: string | null;
  readonly selection: StoredBoardSelection;
  readonly writebackEnabled: boolean;
  readonly createdAt: string;
}

/** What registering a board records. Everything but the settings is Jira's. */
export interface RegisterBoardInput {
  readonly connectionId: string;
  readonly externalId: string;
  readonly name: string;
  readonly boardType: string;
  readonly projectKey?: string | null;
  readonly selection?: StoredBoardSelection;
}

/**
 * What a sync records: Jira's facts about a board, and nothing of ours.
 *
 * `selection` is absent by construction rather than optional — a sync has no
 * settings to offer, and a type that let it pass some would make the
 * distinction from `register` a convention instead of a rule.
 */
export type SyncBoardInput = Omit<RegisterBoardInput, "selection">;

export interface UpdateBoardInput {
  readonly selection?: StoredBoardSelection;
  readonly writebackEnabled?: boolean;
}

export interface JiraBoardStore {
  list(organizationId: string): Promise<JiraBoardSummary[]>;
  get(
    organizationId: string,
    boardId: string,
  ): Promise<JiraBoardSummary | null>;
  /**
   * Registers a board, or updates the one already registered for that
   * connection and board id.
   *
   * An upsert rather than an insert: registering the same board twice is a
   * user correcting its settings, not a request for a second row that would
   * price every ticket twice.
   */
  register(
    organizationId: string,
    input: RegisterBoardInput,
  ): Promise<JiraBoardSummary>;
  /**
   * Records a board Jira reports, without touching how it is configured.
   *
   * What `register` is not. Every board on a connected site is recorded
   * automatically, on connect and again whenever the site is opened, so this
   * runs against boards a person has already configured. It refreshes only
   * what is Jira's to state — the name, the type, the project a board was
   * moved to — and leaves `selection` and `writebackEnabled` as they were.
   *
   * `register` overwrites the selection because a caller passing one is asking
   * for it. A sync passes none and means none.
   */
  sync(
    organizationId: string,
    input: SyncBoardInput,
  ): Promise<JiraBoardSummary>;
  /**
   * Edits the settings. A selection update is **merged**, not replaced, so
   * changing one setting cannot silently reset the others.
   */
  update(
    organizationId: string,
    boardId: string,
    input: UpdateBoardInput,
  ): Promise<JiraBoardSummary | null>;
  remove(organizationId: string, boardId: string): Promise<boolean>;
  /**
   * The board with the connection it reads through, for a run.
   *
   * One query rather than two, because a run needs both and a board whose
   * connection has been deleted is not runnable — the cascade means such a
   * row cannot exist, and the join says so rather than assuming it.
   */
  forRun(
    organizationId: string,
    boardId: string,
  ): Promise<{
    board: JiraBoardSummary;
    connectionId: string;
    cloudId: string;
    siteUrl: string;
  } | null>;
}

export function createJiraBoardStore(db: Database): JiraBoardStore {
  function toSummary(row: JiraBoardRow): JiraBoardSummary {
    return {
      id: row.id,
      connectionId: row.connectionId,
      externalId: row.externalId,
      name: row.name,
      boardType: row.boardType,
      projectKey: row.projectKey,
      selection: (row.selection ?? {}) as StoredBoardSelection,
      writebackEnabled: row.writebackEnabled,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async function first(
    organizationId: string,
    boardId: string,
  ): Promise<JiraBoardRow | undefined> {
    const rows = (await db
      .select()
      .from(jiraBoard)
      .where(
        and(
          eq(jiraBoard.organizationId, organizationId),
          eq(jiraBoard.id, boardId),
        ),
      )) as JiraBoardRow[];
    return rows[0];
  }

  return {
    async list(organizationId) {
      const rows = (await db
        .select()
        .from(jiraBoard)
        .where(eq(jiraBoard.organizationId, organizationId))
        .orderBy(desc(jiraBoard.createdAt))) as JiraBoardRow[];
      return rows.map(toSummary);
    },

    async get(organizationId, boardId) {
      const row = await first(organizationId, boardId);
      return row === undefined ? null : toSummary(row);
    },

    async register(organizationId, input) {
      const values = {
        organizationId,
        connectionId: input.connectionId,
        externalId: input.externalId,
        name: input.name,
        boardType: input.boardType,
        projectKey: input.projectKey ?? null,
        selection: input.selection ?? {},
        updatedAt: new Date(),
      };

      const [row] = (await db
        .insert(jiraBoard)
        .values({ id: generateId("jrb"), ...values })
        .onConflictDoUpdate({
          target: [jiraBoard.connectionId, jiraBoard.externalId],
          // `writebackEnabled` is deliberately absent: re-registering a board
          // must not silently turn write-back back on, or off.
          set: values,
        })
        .returning()) as JiraBoardRow[];

      if (row === undefined) {
        throw new Error("Failed to register the Jira board.");
      }
      return toSummary(row);
    },

    async sync(organizationId, input) {
      // The same insert, with `selection` absent from the conflict branch: a
      // board already registered keeps the settings someone chose for it,
      // while a board seen for the first time still gets a row with the
      // empty selection the route's schema fills in with defaults.
      const jiraFacts = {
        name: input.name,
        boardType: input.boardType,
        projectKey: input.projectKey ?? null,
        updatedAt: new Date(),
      };

      const [row] = (await db
        .insert(jiraBoard)
        .values({
          id: generateId("jrb"),
          organizationId,
          connectionId: input.connectionId,
          externalId: input.externalId,
          selection: {},
          ...jiraFacts,
        })
        .onConflictDoUpdate({
          target: [jiraBoard.connectionId, jiraBoard.externalId],
          set: jiraFacts,
        })
        .returning()) as JiraBoardRow[];

      if (row === undefined) {
        throw new Error("Failed to record the Jira board.");
      }
      return toSummary(row);
    },

    async update(organizationId, boardId, input) {
      const existing = await first(organizationId, boardId);
      if (existing === undefined) {
        return null;
      }

      // Merged, not replaced: a caller editing `maxTickets` alone would
      // otherwise reset every other setting to its default.
      const selection =
        input.selection === undefined
          ? (existing.selection as StoredBoardSelection)
          : {
              ...(existing.selection as StoredBoardSelection),
              ...input.selection,
            };

      const [row] = (await db
        .update(jiraBoard)
        .set({
          selection,
          ...(input.writebackEnabled === undefined
            ? {}
            : { writebackEnabled: input.writebackEnabled }),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(jiraBoard.organizationId, organizationId),
            eq(jiraBoard.id, boardId),
          ),
        )
        .returning()) as JiraBoardRow[];

      return row === undefined ? null : toSummary(row);
    },

    async remove(organizationId, boardId) {
      const removed = (await db
        .delete(jiraBoard)
        .where(
          and(
            eq(jiraBoard.organizationId, organizationId),
            eq(jiraBoard.id, boardId),
          ),
        )
        .returning()) as JiraBoardRow[];
      return removed.length > 0;
    },

    async forRun(organizationId, boardId) {
      const rows = (await db
        .select()
        .from(jiraBoard)
        .innerJoin(
          jiraConnection,
          eq(jiraBoard.connectionId, jiraConnection.id),
        )
        .where(
          and(
            eq(jiraBoard.organizationId, organizationId),
            eq(jiraBoard.id, boardId),
          ),
        )) as {
        jira_board: JiraBoardRow;
        jira_connection: { id: string; cloudId: string; siteUrl: string };
      }[];

      const joined = rows[0];
      if (joined === undefined) {
        return null;
      }
      return {
        board: toSummary(joined.jira_board),
        connectionId: joined.jira_connection.id,
        cloudId: joined.jira_connection.cloudId,
        siteUrl: joined.jira_connection.siteUrl,
      };
    },
  };
}
