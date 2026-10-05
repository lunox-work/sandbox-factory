/**
 * Bounties: the organization's own work items, written here or imported from
 * Jira. Every method takes the owner first and filters on it, like every
 * other store; another organization's bounty is not found.
 */

import type {
  BountyComplexity,
  BountyContent,
  BountyOrigin,
  SandboxStatus,
} from "sandbox-factory";
import { clampBountyTitle } from "sandbox-factory";
import { and, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";

import { isForeignKeyViolation, type Database } from "./errors.js";
import { generateId } from "./mapping.js";
import {
  bounty,
  bountyProposal,
  bountyRun,
  githubRepo,
  jiraBoard,
  jiraConnection,
  jiraIssue,
  sandbox,
  sandboxSource,
} from "./schema.js";
import type { BountyRow } from "./schema.js";

/** A bounty's Jira issue, while it has one. */
export interface BountyJiraLink {
  /** The platform's pointer to the issue. */
  readonly issueId: string;
  readonly boardId: string;
  readonly connectionId: string;
  /** Jira's numeric issue id. */
  readonly externalId: string;
  readonly key: string;
  /** `https://acme.atlassian.net`, which `browse/` links hang from. */
  readonly siteUrl: string;
  /** When Jira stopped returning the issue; the bounty keeps its text. */
  readonly removedAt: string | null;
}

export interface StoredBounty extends BountyContent {
  readonly id: string;
  readonly organizationId: string;
  readonly origin: BountyOrigin;
  readonly repoId: string | null;
  /** What the bounty adds to its repository's detected stack. */
  readonly stack: readonly string[];
  readonly createdBy: string | null;
  readonly revision: number;
  readonly jira: BountyJiraLink | null;
  /** The bounty's sandbox, in brief, once it has one. */
  readonly sandbox: BountySandboxSummary | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A bounty's sandbox, in brief: whether there is one, and how far it got. */
export interface BountySandboxSummary {
  readonly id: string;
  readonly status: SandboxStatus;
  readonly currentVersionId: string | null;
  /** Null until a repository is linked, which cutting a version needs. */
  readonly sourceRepoId: string | null;
}

/** A bounty's live proposal, in brief. */
export interface BountyProposalSummary {
  readonly id: string;
  readonly status: "proposed" | "approved";
  readonly complexity: BountyComplexity;
  readonly amountMinor: number | null;
  readonly currency: string | null;
}

/** A bounty as a list shows it: without its longer text, with its proposal. */
export type ListedBounty = Omit<
  StoredBounty,
  "description" | "components" | "inputTruncated" | "createdBy"
> & { readonly proposal: BountyProposalSummary | null };

/** A bounty written here. */
export interface NewBounty {
  readonly title: string;
  readonly description: string;
  readonly repoId: string | null;
  readonly stack: readonly string[];
}

/** A change to a bounty; an absent field is left as it is. */
export interface BountyChange {
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly repoId?: string | null | undefined;
  readonly stack?: readonly string[] | undefined;
}

export type BountyMutationResult =
  | { readonly ok: true; readonly bounty: StoredBounty }
  | {
      readonly ok: false;
      /**
       * `jira-owned`: a change to the text of a bounty whose Jira issue is
       * still there, which is Jira's to change. `repo-not-found`: a
       * repository the organization does not have.
       */
      readonly reason:
        "not-found" | "changed" | "jira-owned" | "repo-not-found";
      readonly current?: StoredBounty;
    };

export interface BountyStore {
  create(
    organizationId: string,
    createdBy: string,
    input: NewBounty,
  ): Promise<
    | { readonly ok: true; readonly bounty: StoredBounty }
    | { readonly ok: false; readonly reason: "repo-not-found" }
  >;
  get(organizationId: string, bountyId: string): Promise<StoredBounty | null>;
  /** Newest first, a page at a time. */
  list(
    organizationId: string,
    options?: {
      cursor?: { readonly createdAt: string; readonly id: string };
      limit?: number;
    },
  ): Promise<ListedBounty[]>;
  /**
   * The same list across several organizations at once, interleaved by age:
   * the caller's own, for a page that shows all of their work. The caller
   * names the organizations; the store never works out whose they are.
   */
  listAcross(
    organizationIds: readonly string[],
    options?: Parameters<BountyStore["list"]>[1],
  ): Promise<ListedBounty[]>;
  /** A change, against the revision the editor saw. */
  update(
    organizationId: string,
    bountyId: string,
    expectedRevision: number,
    change: BountyChange,
  ): Promise<BountyMutationResult>;
  /**
   * Deletes a bounty nothing has been built on: no proposal, live or
   * otherwise, no sandbox, and no run sizing it now. `in-use` otherwise,
   * and the bounty stays.
   */
  remove(
    organizationId: string,
    bountyId: string,
  ): Promise<"removed" | "not-found" | "in-use">;
  /**
   * The bounty's text as its Jira issue says it now. Written only when it
   * differs, so a read that finds nothing new does not bump the revision.
   * False when nothing was written.
   */
  refreshFromJira(
    organizationId: string,
    bountyId: string,
    content: BountyContent,
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

/**
 * The bounty's sandbox, joined on the one-per-bounty key, with the
 * repository it is cut from when it has one.
 */
const sandboxColumns = {
  sandboxId: sandbox.id,
  sandboxStatus: sandbox.status,
  sandboxVersionId: sandbox.currentVersionId,
  sandboxSourceRepoId: sandboxSource.sourceRepoId,
};

interface SandboxFields {
  readonly sandboxId: string | null;
  readonly sandboxStatus: SandboxStatus | null;
  readonly sandboxVersionId: string | null;
  readonly sandboxSourceRepoId: string | null;
}

const NO_SANDBOX: SandboxFields = {
  sandboxId: null,
  sandboxStatus: null,
  sandboxVersionId: null,
  sandboxSourceRepoId: null,
};

function toSandboxSummary(fields: SandboxFields): BountySandboxSummary | null {
  return fields.sandboxId === null || fields.sandboxStatus === null
    ? null
    : {
        id: fields.sandboxId,
        status: fields.sandboxStatus,
        currentVersionId: fields.sandboxVersionId,
        sourceRepoId: fields.sandboxSourceRepoId,
      };
}

function toLink(fields: LinkFields): BountyJiraLink | null {
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

function toBounty(
  row: BountyRow,
  fields: LinkFields,
  joined: SandboxFields = NO_SANDBOX,
): StoredBounty {
  const jira = toLink(fields);
  return {
    id: row.id,
    organizationId: row.organizationId,
    title: row.title,
    description: row.description,
    components: row.components,
    inputTruncated: row.inputTruncated,
    origin: row.origin,
    repoId: row.repoId,
    stack: row.stack,
    createdBy: row.createdBy,
    revision: row.revision,
    jira,
    sandbox: toSandboxSummary(joined),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * When a bounty was created, to the millisecond. A page's cursor carries its
 * last row's time as an ISO string, which holds milliseconds, while Postgres
 * stores microseconds; ordered and compared at the cursor's precision, a
 * bounty made in the same millisecond as the last row is not skipped.
 */
const createdMs = sql`date_trunc('milliseconds', ${bounty.createdAt})`;

/** Whether the bounty's text is its Jira issue's to change. */
export function followsJira(stored: Pick<StoredBounty, "jira">): boolean {
  return stored.jira !== null && stored.jira.removedAt === null;
}

/** Inserts a bounty in the organization, under a new id. */
export async function insertBounty(
  db: Database,
  organizationId: string,
  values: Omit<
    typeof bounty.$inferInsert,
    "id" | "organizationId" | "revision"
  >,
): Promise<BountyRow> {
  const rows = (await db
    .insert(bounty)
    .values({ ...values, id: generateId("bty"), organizationId })
    .returning()) as BountyRow[];
  const created = rows[0];
  if (created === undefined) throw new Error("Bounty insert returned no row.");
  return created;
}

/** The columns Jira's text writes, or null when the bounty already says it. */
export function jiraContentChange(
  current: BountyRow,
  content: BountyContent,
): Partial<typeof bounty.$inferInsert> | null {
  const values = {
    // An issue with no summary keeps the title it has: a bounty has one.
    title:
      content.title.trim() === ""
        ? current.title
        : clampBountyTitle(content.title),
    description: content.description,
    components: [...content.components],
    inputTruncated: content.inputTruncated,
  };
  const same =
    values.title === current.title &&
    values.description === current.description &&
    JSON.stringify(values.components) === JSON.stringify(current.components) &&
    values.inputTruncated === current.inputTruncated;
  return same ? null : values;
}

/**
 * Writes Jira's text over the bounty's, when it differs, against the
 * revision it was read at. A bounty changed in between is left for the next
 * read, which compares again.
 */
export async function refreshBounty(
  db: Database,
  organizationId: string,
  current: BountyRow,
  content: BountyContent,
): Promise<boolean> {
  const change = jiraContentChange(current, content);
  if (change === null) return false;
  const rows = await db
    .update(bounty)
    .set({
      ...change,
      revision: current.revision + 1,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(bounty.organizationId, organizationId),
        eq(bounty.id, current.id),
        eq(bounty.revision, current.revision),
      ),
    )
    .returning({ id: bounty.id });
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

async function readBounty(
  db: Database,
  organizationId: string,
  bountyId: string,
): Promise<StoredBounty | null> {
  const rows = (await db
    .select({ row: bounty, ...linkColumns, ...sandboxColumns })
    .from(bounty)
    .leftJoin(jiraIssue, eq(jiraIssue.bountyId, bounty.id))
    .leftJoin(jiraBoard, eq(jiraBoard.id, jiraIssue.boardId))
    .leftJoin(jiraConnection, eq(jiraConnection.id, jiraBoard.connectionId))
    .leftJoin(sandbox, eq(sandbox.bountyId, bounty.id))
    .leftJoin(sandboxSource, eq(sandboxSource.sandboxId, sandbox.id))
    .where(
      and(eq(bounty.organizationId, organizationId), eq(bounty.id, bountyId)),
    )) as ({ row: BountyRow } & LinkFields & SandboxFields)[];
  const found = rows[0];
  return found === undefined ? null : toBounty(found.row, found, found);
}

/**
 * Newest first, a page at a time, each with its live proposal. `owner` is
 * the organization filter, which every caller supplies: one organization's
 * list, or the list across the caller's own.
 */
async function listBounties(
  db: Database,
  owner: SQL,
  options: Parameters<BountyStore["list"]>[1] = {},
): Promise<ListedBounty[]> {
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 50);
  const rows = (await db
    .select({
      id: bounty.id,
      organizationId: bounty.organizationId,
      title: bounty.title,
      origin: bounty.origin,
      repoId: bounty.repoId,
      stack: bounty.stack,
      revision: bounty.revision,
      createdAt: bounty.createdAt,
      updatedAt: bounty.updatedAt,
      ...linkColumns,
      ...sandboxColumns,
      proposalId: bountyProposal.id,
      proposalStatus: bountyProposal.status,
      proposalComplexity: bountyProposal.complexity,
      proposalAmountMinor: bountyProposal.amountMinor,
      proposalCurrency: bountyProposal.currency,
    })
    .from(bounty)
    .leftJoin(jiraIssue, eq(jiraIssue.bountyId, bounty.id))
    .leftJoin(jiraBoard, eq(jiraBoard.id, jiraIssue.boardId))
    .leftJoin(jiraConnection, eq(jiraConnection.id, jiraBoard.connectionId))
    .leftJoin(sandbox, eq(sandbox.bountyId, bounty.id))
    .leftJoin(sandboxSource, eq(sandboxSource.sandboxId, sandbox.id))
    // The live one only, of which there is at most one per bounty.
    .leftJoin(
      bountyProposal,
      and(
        eq(bountyProposal.bountyId, bounty.id),
        or(
          eq(bountyProposal.status, "proposed"),
          eq(bountyProposal.status, "approved"),
        ),
      ),
    )
    .where(
      and(
        owner,
        options.cursor === undefined
          ? undefined
          : sql`(${createdMs}, ${bounty.id}) < (${options.cursor.createdAt}::timestamptz, ${options.cursor.id})`,
      ),
    )
    .orderBy(desc(createdMs), desc(bounty.id))
    .limit(limit)) as ListedRow[];
  return rows.map(toListed);
}

export function createBountyStore(db: Database): BountyStore {
  return {
    async create(organizationId, createdBy, input) {
      if (
        input.repoId !== null &&
        !(await ownsRepo(db, organizationId, input.repoId))
      ) {
        return { ok: false, reason: "repo-not-found" };
      }
      let row: BountyRow;
      try {
        row = await insertBounty(db, organizationId, {
          title: input.title,
          description: input.description,
          origin: "manual",
          repoId: input.repoId,
          stack: [...input.stack],
          createdBy,
        });
      } catch (error) {
        // The repository was removed between the check and the insert.
        if (input.repoId !== null && isForeignKeyViolation(error)) {
          return { ok: false, reason: "repo-not-found" };
        }
        throw error;
      }
      return { ok: true, bounty: toBounty(row, NO_LINK) };
    },

    get: (organizationId, bountyId) => readBounty(db, organizationId, bountyId),

    list: (organizationId, options = {}) =>
      listBounties(db, eq(bounty.organizationId, organizationId), options),

    // None at all is no query: there is nothing they could own.
    listAcross: async (organizationIds, options = {}) =>
      organizationIds.length === 0
        ? []
        : listBounties(
            db,
            inArray(bounty.organizationId, [...organizationIds]),
            options,
          ),

    async update(organizationId, bountyId, expectedRevision, change) {
      const current = await readBounty(db, organizationId, bountyId);
      if (current === null) return { ok: false, reason: "not-found" };
      if (current.revision !== expectedRevision) {
        return { ok: false, reason: "changed", current };
      }
      // The repository and the stack are the workspace's to set, even on
      // a bounty whose text is Jira's.
      const { repoId, stack, ...text } = change;
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
        (repoId === undefined || repoId === current.repoId) &&
        (stack === undefined ||
          JSON.stringify(stack) === JSON.stringify(current.stack));
      if (same) return { ok: true, bounty: current };
      if (
        repoId !== undefined &&
        repoId !== null &&
        repoId !== current.repoId &&
        !(await ownsRepo(db, organizationId, repoId))
      ) {
        return { ok: false, reason: "repo-not-found" };
      }
      let rows: BountyRow[];
      try {
        rows = (await db
          .update(bounty)
          .set({
            ...(change.title === undefined ? {} : { title: change.title }),
            ...(change.description === undefined
              ? {}
              : { description: change.description }),
            ...(repoId === undefined ? {} : { repoId }),
            ...(stack === undefined ? {} : { stack: [...stack] }),
            revision: expectedRevision + 1,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(bounty.organizationId, organizationId),
              eq(bounty.id, bountyId),
              eq(bounty.revision, expectedRevision),
            ),
          )
          .returning()) as BountyRow[];
      } catch (error) {
        // The repository was removed between the check and the write.
        if (repoId != null && isForeignKeyViolation(error)) {
          return { ok: false, reason: "repo-not-found" };
        }
        throw error;
      }
      const updated = rows[0];
      if (updated === undefined) {
        const latest = await readBounty(db, organizationId, bountyId);
        return latest === null
          ? { ok: false, reason: "not-found" }
          : { ok: false, reason: "changed", current: latest };
      }
      return {
        ok: true,
        bounty: {
          ...toBounty(updated, NO_LINK),
          jira: current.jira,
          sandbox: current.sandbox,
        },
      };
    },

    remove(organizationId, bountyId) {
      return db.transaction(
        async (transaction): Promise<"removed" | "not-found" | "in-use"> => {
          const tx = transaction;
          const owned = and(
            eq(bounty.organizationId, organizationId),
            eq(bounty.id, bountyId),
          );
          /*
            Locked before the check. A proposal, sandbox link or run being
            written for the bounty holds a key-share lock on it until it
            commits, so this waits for it, and the delete — a statement of
            its own, with a fresh snapshot — then sees it. Checked in the
            delete alone, a row committed while the delete waited would pass
            the check and go with the bounty's cascade.
          */
          const locked = await tx
            .select({ id: bounty.id })
            .from(bounty)
            .where(owned)
            .for("update");
          if (locked[0] === undefined) return "not-found";
          const rows = await tx
            .delete(bounty)
            .where(
              and(
                owned,
                // A proposal's history, and a sandbox's provenance, are kept.
                sql`not exists (select 1 from ${bountyProposal} where ${bountyProposal.bountyId} = ${bounty.id})`,
                sql`not exists (select 1 from ${sandbox} where ${sandbox.bountyId} = ${bounty.id})`,
                // A run sizing it is let finish.
                sql`not exists (select 1 from ${bountyRun} where ${bountyRun.bountyId} = ${bounty.id} and ${bountyRun.status} in ('queued', 'running'))`,
              ),
            )
            .returning({ id: bounty.id });
          return rows[0] === undefined ? "in-use" : "removed";
        },
      );
    },

    async refreshFromJira(organizationId, bountyId, content) {
      const rows = (await db
        .select()
        .from(bounty)
        .where(
          and(
            eq(bounty.organizationId, organizationId),
            eq(bounty.id, bountyId),
          ),
        )) as BountyRow[];
      const current = rows[0];
      return current === undefined
        ? false
        : refreshBounty(db, organizationId, current, content);
    },
  };
}

type ListedRow = Pick<
  BountyRow,
  | "id"
  | "organizationId"
  | "title"
  | "origin"
  | "repoId"
  | "stack"
  | "revision"
  | "createdAt"
  | "updatedAt"
> &
  LinkFields &
  SandboxFields & {
    readonly proposalId: string | null;
    readonly proposalStatus: string | null;
    readonly proposalComplexity: string | null;
    readonly proposalAmountMinor: number | null;
    readonly proposalCurrency: string | null;
  };

function toListed(row: ListedRow): ListedBounty {
  const jira = toLink(row);
  return {
    id: row.id,
    organizationId: row.organizationId,
    title: row.title,
    origin: row.origin,
    repoId: row.repoId,
    stack: row.stack,
    revision: row.revision,
    jira,
    sandbox: toSandboxSummary(row),
    proposal:
      row.proposalId === null ||
      row.proposalStatus === null ||
      row.proposalComplexity === null
        ? null
        : {
            id: row.proposalId,
            status: row.proposalStatus as BountyProposalSummary["status"],
            complexity: row.proposalComplexity as BountyComplexity,
            amountMinor: row.proposalAmountMinor,
            currency: row.proposalCurrency,
          },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
