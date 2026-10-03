/**
 * Tickets: the organization's own work items, written here or imported from
 * Jira. Every method takes the owner first and filters on it, like every
 * other store; another organization's ticket is not found.
 */

import type {
  BountyComplexity,
  TicketContent,
  TicketOrigin,
} from "sandbox-factory";
import { clampTicketTitle, ticketKey } from "sandbox-factory";
import { and, desc, eq, or, sql } from "drizzle-orm";

import {
  isForeignKeyViolation,
  isUniqueViolation,
  type Database,
} from "./errors.js";
import { generateId } from "./mapping.js";
import {
  bountyProposal,
  bountyRun,
  githubRepo,
  jiraBoard,
  jiraConnection,
  jiraIssue,
  sandboxTicket,
  ticket,
} from "./schema.js";
import type { TicketRow } from "./schema.js";

/** A ticket's Jira issue, while it has one. */
export interface TicketJiraLink {
  /** The platform's pointer to the issue. */
  readonly issueId: string;
  readonly boardId: string;
  readonly connectionId: string;
  /** Jira's numeric issue id. */
  readonly externalId: string;
  readonly key: string;
  /** `https://acme.atlassian.net`, which `browse/` links hang from. */
  readonly siteUrl: string;
  /** When Jira stopped returning the issue; the ticket keeps its text. */
  readonly removedAt: string | null;
}

export interface StoredTicket extends TicketContent {
  readonly id: string;
  readonly organizationId: string;
  readonly number: number;
  /** Its Jira key while it has one, `T-<number>` otherwise. */
  readonly key: string;
  readonly origin: TicketOrigin;
  readonly repoId: string | null;
  readonly createdBy: string | null;
  readonly revision: number;
  readonly jira: TicketJiraLink | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A ticket's live proposal, in brief. */
export interface TicketProposalSummary {
  readonly id: string;
  readonly status: "proposed" | "approved";
  readonly complexity: BountyComplexity;
  readonly amountMinor: number | null;
  readonly currency: string | null;
}

/** A ticket as a list shows it: without its longer text, with its proposal. */
export type ListedTicket = Omit<
  StoredTicket,
  "description" | "components" | "inputTruncated" | "createdBy"
> & { readonly proposal: TicketProposalSummary | null };

/** A ticket written here. */
export interface NewTicket {
  readonly title: string;
  readonly description: string;
  readonly issueType: string;
  readonly priority: string | null;
  readonly labels: readonly string[];
  readonly repoId: string | null;
}

/** A change to a ticket; an absent field is left as it is. */
export interface TicketChange {
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly issueType?: string | undefined;
  readonly priority?: string | null | undefined;
  readonly labels?: readonly string[] | undefined;
  readonly repoId?: string | null | undefined;
}

export type TicketMutationResult =
  | { readonly ok: true; readonly ticket: StoredTicket }
  | {
      readonly ok: false;
      /**
       * `jira-owned`: a change to the text of a ticket whose Jira issue is
       * still there, which is Jira's to change. `repo-not-found`: a
       * repository the organization does not have.
       */
      readonly reason:
        "not-found" | "changed" | "jira-owned" | "repo-not-found";
      readonly current?: StoredTicket;
    };

export interface TicketStore {
  create(
    organizationId: string,
    createdBy: string,
    input: NewTicket,
  ): Promise<
    | { readonly ok: true; readonly ticket: StoredTicket }
    | { readonly ok: false; readonly reason: "repo-not-found" }
  >;
  get(organizationId: string, ticketId: string): Promise<StoredTicket | null>;
  /** Newest first, a page at a time. */
  list(
    organizationId: string,
    options?: {
      cursor?: { readonly createdAt: string; readonly id: string };
      limit?: number;
    },
  ): Promise<ListedTicket[]>;
  /** A change, against the revision the editor saw. */
  update(
    organizationId: string,
    ticketId: string,
    expectedRevision: number,
    change: TicketChange,
  ): Promise<TicketMutationResult>;
  /**
   * Deletes a ticket nothing has been built on: no proposal, live or
   * otherwise, no sandbox, and no run sizing it now. `in-use` otherwise,
   * and the ticket stays.
   */
  remove(
    organizationId: string,
    ticketId: string,
  ): Promise<"removed" | "not-found" | "in-use">;
  /**
   * The ticket's text as its Jira issue says it now. Written only when it
   * differs, so a read that finds nothing new does not bump the revision.
   * False when nothing was written.
   */
  refreshFromJira(
    organizationId: string,
    ticketId: string,
    content: TicketContent,
  ): Promise<boolean>;
}

/** The link's columns, flat: a left join that misses leaves them all null. */
const linkColumns = {
  issueId: jiraIssue.id,
  boardId: jiraIssue.boardId,
  externalId: jiraIssue.externalId,
  jiraKey: jiraIssue.key,
  removedAt: jiraIssue.removedAt,
  connectionId: jiraBoard.connectionId,
  siteUrl: jiraConnection.siteUrl,
};

interface LinkFields {
  readonly issueId: string | null;
  readonly boardId: string | null;
  readonly externalId: string | null;
  readonly jiraKey: string | null;
  readonly removedAt: Date | null;
  readonly connectionId: string | null;
  readonly siteUrl: string | null;
}

const NO_LINK: LinkFields = {
  issueId: null,
  boardId: null,
  externalId: null,
  jiraKey: null,
  removedAt: null,
  connectionId: null,
  siteUrl: null,
};

function toLink(fields: LinkFields): TicketJiraLink | null {
  if (
    fields.issueId === null ||
    fields.boardId === null ||
    fields.externalId === null ||
    fields.jiraKey === null ||
    fields.connectionId === null ||
    fields.siteUrl === null
  ) {
    return null;
  }
  return {
    issueId: fields.issueId,
    boardId: fields.boardId,
    connectionId: fields.connectionId,
    externalId: fields.externalId,
    key: fields.jiraKey,
    siteUrl: fields.siteUrl,
    removedAt: fields.removedAt?.toISOString() ?? null,
  };
}

function toTicket(row: TicketRow, fields: LinkFields): StoredTicket {
  const jira = toLink(fields);
  return {
    id: row.id,
    organizationId: row.organizationId,
    number: row.number,
    key: ticketKey({ number: row.number, jiraKey: jira?.key }),
    title: row.title,
    description: row.description,
    issueType: row.issueType,
    priority: row.priority,
    labels: row.labels,
    components: row.components,
    inputTruncated: row.inputTruncated,
    origin: row.origin,
    repoId: row.repoId,
    createdBy: row.createdBy,
    revision: row.revision,
    jira,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * When a ticket was created, to the millisecond. A page's cursor carries its
 * last row's time as an ISO string, which holds milliseconds, while Postgres
 * stores microseconds; ordered and compared at the cursor's precision, a
 * ticket made in the same millisecond as the last row is not skipped.
 */
const createdMs = sql`date_trunc('milliseconds', ${ticket.createdAt})`;

/** Whether the ticket's text is its Jira issue's to change. */
export function followsJira(stored: Pick<StoredTicket, "jira">): boolean {
  return stored.jira !== null && stored.jira.removedAt === null;
}

/**
 * How many times a ticket's number is retried. Each retry follows a ticket
 * that took the number first, so it only runs out when that many were
 * created in the same organization at the same instant.
 */
const NUMBER_ATTEMPTS = 8;

/**
 * Inserts a ticket as the organization's next number.
 *
 * The next number is read in the insert itself, and a concurrent insert that
 * took it first is a unique violation, retried. Each attempt is its own
 * savepoint, so a lost race leaves an enclosing transaction usable.
 */
export async function insertTicket(
  db: Database,
  organizationId: string,
  values: Omit<
    typeof ticket.$inferInsert,
    "id" | "organizationId" | "number" | "revision"
  >,
): Promise<TicketRow> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await db.transaction(async (transaction) => {
        const tx = transaction as unknown as Database;
        const rows = (await tx
          .insert(ticket)
          .values({
            ...values,
            id: generateId("tkt"),
            organizationId,
            number: sql`(select coalesce(max(${ticket.number}), 0) + 1 from ${ticket} where ${ticket.organizationId} = ${organizationId})`,
          })
          .returning()) as TicketRow[];
        const created = rows[0];
        if (created === undefined)
          throw new Error("Ticket insert returned no row.");
        return created;
      });
    } catch (error) {
      if (!isUniqueViolation(error) || attempt >= NUMBER_ATTEMPTS) throw error;
    }
  }
}

/** The columns Jira's text writes, or null when the ticket already says it. */
export function jiraContentChange(
  current: TicketRow,
  content: TicketContent,
): Partial<typeof ticket.$inferInsert> | null {
  const values = {
    // An issue with no summary keeps the title it has: a ticket has one.
    title:
      content.title.trim() === ""
        ? current.title
        : clampTicketTitle(content.title),
    description: content.description,
    issueType: content.issueType,
    priority: content.priority,
    labels: [...content.labels],
    components: [...content.components],
    inputTruncated: content.inputTruncated,
  };
  const same =
    values.title === current.title &&
    values.description === current.description &&
    values.issueType === current.issueType &&
    values.priority === current.priority &&
    JSON.stringify(values.labels) === JSON.stringify(current.labels) &&
    JSON.stringify(values.components) === JSON.stringify(current.components) &&
    values.inputTruncated === current.inputTruncated;
  return same ? null : values;
}

/**
 * Writes Jira's text over the ticket's, when it differs, against the
 * revision it was read at. A ticket changed in between is left for the next
 * read, which compares again.
 */
export async function refreshTicket(
  db: Database,
  organizationId: string,
  current: TicketRow,
  content: TicketContent,
): Promise<boolean> {
  const change = jiraContentChange(current, content);
  if (change === null) return false;
  const rows = await db
    .update(ticket)
    .set({
      ...change,
      revision: current.revision + 1,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(ticket.organizationId, organizationId),
        eq(ticket.id, current.id),
        eq(ticket.revision, current.revision),
      ),
    )
    .returning({ id: ticket.id });
  return rows.length > 0;
}

async function ownsRepo(
  db: Database,
  organizationId: string,
  repoId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: githubRepo.id })
    .from(githubRepo)
    .where(
      and(
        eq(githubRepo.organizationId, organizationId),
        eq(githubRepo.id, repoId),
      ),
    );
  return rows[0] !== undefined;
}

async function readTicket(
  db: Database,
  organizationId: string,
  ticketId: string,
): Promise<StoredTicket | null> {
  const rows = (await db
    .select({ row: ticket, ...linkColumns })
    .from(ticket)
    .leftJoin(jiraIssue, eq(jiraIssue.ticketId, ticket.id))
    .leftJoin(jiraBoard, eq(jiraBoard.id, jiraIssue.boardId))
    .leftJoin(jiraConnection, eq(jiraConnection.id, jiraBoard.connectionId))
    .where(
      and(eq(ticket.organizationId, organizationId), eq(ticket.id, ticketId)),
    )) as ({ row: TicketRow } & LinkFields)[];
  const found = rows[0];
  return found === undefined ? null : toTicket(found.row, found);
}

export function createTicketStore(db: Database): TicketStore {
  return {
    async create(organizationId, createdBy, input) {
      if (
        input.repoId !== null &&
        !(await ownsRepo(db, organizationId, input.repoId))
      ) {
        return { ok: false, reason: "repo-not-found" };
      }
      let row: TicketRow;
      try {
        row = await insertTicket(db, organizationId, {
          title: input.title,
          description: input.description,
          issueType: input.issueType,
          priority: input.priority,
          labels: [...input.labels],
          origin: "manual",
          repoId: input.repoId,
          createdBy,
        });
      } catch (error) {
        // The repository was removed between the check and the insert.
        if (input.repoId !== null && isForeignKeyViolation(error)) {
          return { ok: false, reason: "repo-not-found" };
        }
        throw error;
      }
      return { ok: true, ticket: toTicket(row, NO_LINK) };
    },

    get: (organizationId, ticketId) => readTicket(db, organizationId, ticketId),

    async list(organizationId, options = {}) {
      const limit = Math.min(Math.max(options.limit ?? 25, 1), 50);
      const rows = (await db
        .select({
          id: ticket.id,
          organizationId: ticket.organizationId,
          number: ticket.number,
          title: ticket.title,
          issueType: ticket.issueType,
          priority: ticket.priority,
          labels: ticket.labels,
          origin: ticket.origin,
          repoId: ticket.repoId,
          revision: ticket.revision,
          createdAt: ticket.createdAt,
          updatedAt: ticket.updatedAt,
          ...linkColumns,
          proposalId: bountyProposal.id,
          proposalStatus: bountyProposal.status,
          proposalComplexity: bountyProposal.complexity,
          proposalAmountMinor: bountyProposal.amountMinor,
          proposalCurrency: bountyProposal.currency,
        })
        .from(ticket)
        .leftJoin(jiraIssue, eq(jiraIssue.ticketId, ticket.id))
        .leftJoin(jiraBoard, eq(jiraBoard.id, jiraIssue.boardId))
        .leftJoin(jiraConnection, eq(jiraConnection.id, jiraBoard.connectionId))
        // The live one only, of which there is at most one per ticket.
        .leftJoin(
          bountyProposal,
          and(
            eq(bountyProposal.ticketId, ticket.id),
            or(
              eq(bountyProposal.status, "proposed"),
              eq(bountyProposal.status, "approved"),
            ),
          ),
        )
        .where(
          and(
            eq(ticket.organizationId, organizationId),
            options.cursor === undefined
              ? undefined
              : sql`(${createdMs}, ${ticket.id}) < (${options.cursor.createdAt}::timestamptz, ${options.cursor.id})`,
          ),
        )
        .orderBy(desc(createdMs), desc(ticket.id))
        .limit(limit)) as ListedRow[];
      return rows.map(toListed);
    },

    async update(organizationId, ticketId, expectedRevision, change) {
      const current = await readTicket(db, organizationId, ticketId);
      if (current === null) return { ok: false, reason: "not-found" };
      if (current.revision !== expectedRevision) {
        return { ok: false, reason: "changed", current };
      }
      const { repoId, ...text } = change;
      if (
        Object.values(text).some((value) => value !== undefined) &&
        followsJira(current)
      ) {
        return { ok: false, reason: "jira-owned", current };
      }
      // A change to what it already says is no change, and keeps the revision.
      const same =
        (change.title === undefined || change.title === current.title) &&
        (change.description === undefined ||
          change.description === current.description) &&
        (change.issueType === undefined ||
          change.issueType === current.issueType) &&
        (change.priority === undefined ||
          change.priority === current.priority) &&
        (change.labels === undefined ||
          JSON.stringify(change.labels) === JSON.stringify(current.labels)) &&
        (repoId === undefined || repoId === current.repoId);
      if (same) return { ok: true, ticket: current };
      if (
        repoId !== undefined &&
        repoId !== null &&
        repoId !== current.repoId &&
        !(await ownsRepo(db, organizationId, repoId))
      ) {
        return { ok: false, reason: "repo-not-found" };
      }
      let rows: TicketRow[];
      try {
        rows = (await db
          .update(ticket)
          .set({
            ...(change.title === undefined ? {} : { title: change.title }),
            ...(change.description === undefined
              ? {}
              : { description: change.description }),
            ...(change.issueType === undefined
              ? {}
              : { issueType: change.issueType }),
            ...(change.priority === undefined
              ? {}
              : { priority: change.priority }),
            ...(change.labels === undefined
              ? {}
              : { labels: [...change.labels] }),
            ...(repoId === undefined ? {} : { repoId }),
            revision: expectedRevision + 1,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(ticket.organizationId, organizationId),
              eq(ticket.id, ticketId),
              eq(ticket.revision, expectedRevision),
            ),
          )
          .returning()) as TicketRow[];
      } catch (error) {
        // The repository was removed between the check and the write.
        if (repoId != null && isForeignKeyViolation(error)) {
          return { ok: false, reason: "repo-not-found" };
        }
        throw error;
      }
      const updated = rows[0];
      if (updated === undefined) {
        const latest = await readTicket(db, organizationId, ticketId);
        return latest === null
          ? { ok: false, reason: "not-found" }
          : { ok: false, reason: "changed", current: latest };
      }
      return {
        ok: true,
        ticket: {
          ...toTicket(updated, NO_LINK),
          key: current.key,
          jira: current.jira,
        },
      };
    },

    remove(organizationId, ticketId) {
      return db.transaction(
        async (transaction): Promise<"removed" | "not-found" | "in-use"> => {
          const tx = transaction as unknown as Database;
          const owned = and(
            eq(ticket.organizationId, organizationId),
            eq(ticket.id, ticketId),
          );
          /*
            Locked before the check. A proposal, sandbox link or run being
            written for the ticket holds a key-share lock on it until it
            commits, so this waits for it, and the delete — a statement of
            its own, with a fresh snapshot — then sees it. Checked in the
            delete alone, a row committed while the delete waited would pass
            the check and go with the ticket's cascade.
          */
          const locked = await tx
            .select({ id: ticket.id })
            .from(ticket)
            .where(owned)
            .for("update");
          if (locked[0] === undefined) return "not-found";
          const rows = await tx
            .delete(ticket)
            .where(
              and(
                owned,
                // A proposal's history, and a sandbox's provenance, are kept.
                sql`not exists (select 1 from ${bountyProposal} where ${bountyProposal.ticketId} = ${ticket.id})`,
                sql`not exists (select 1 from ${sandboxTicket} where ${sandboxTicket.ticketId} = ${ticket.id})`,
                // A run sizing it is let finish.
                sql`not exists (select 1 from ${bountyRun} where ${bountyRun.ticketId} = ${ticket.id} and ${bountyRun.status} in ('queued', 'running'))`,
              ),
            )
            .returning({ id: ticket.id });
          return rows[0] === undefined ? "in-use" : "removed";
        },
      );
    },

    async refreshFromJira(organizationId, ticketId, content) {
      const rows = (await db
        .select()
        .from(ticket)
        .where(
          and(
            eq(ticket.organizationId, organizationId),
            eq(ticket.id, ticketId),
          ),
        )) as TicketRow[];
      const current = rows[0];
      return current === undefined
        ? false
        : refreshTicket(db, organizationId, current, content);
    },
  };
}

type ListedRow = Pick<
  TicketRow,
  | "id"
  | "organizationId"
  | "number"
  | "title"
  | "issueType"
  | "priority"
  | "labels"
  | "origin"
  | "repoId"
  | "revision"
  | "createdAt"
  | "updatedAt"
> &
  LinkFields & {
    readonly proposalId: string | null;
    readonly proposalStatus: string | null;
    readonly proposalComplexity: string | null;
    readonly proposalAmountMinor: number | null;
    readonly proposalCurrency: string | null;
  };

function toListed(row: ListedRow): ListedTicket {
  const jira = toLink(row);
  return {
    id: row.id,
    organizationId: row.organizationId,
    number: row.number,
    key: ticketKey({ number: row.number, jiraKey: jira?.key }),
    title: row.title,
    issueType: row.issueType,
    priority: row.priority,
    labels: row.labels,
    origin: row.origin,
    repoId: row.repoId,
    revision: row.revision,
    jira,
    proposal:
      row.proposalId === null ||
      row.proposalStatus === null ||
      row.proposalComplexity === null
        ? null
        : {
            id: row.proposalId,
            status: row.proposalStatus as TicketProposalSummary["status"],
            complexity: row.proposalComplexity as BountyComplexity,
            amountMinor: row.proposalAmountMinor,
            currency: row.proposalCurrency,
          },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
