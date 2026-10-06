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
import { clampBountyTitle, overviewApproved } from "sandbox-factory";
import { and, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";

import {
  isForeignKeyViolation,
  type Database,
  type QueryExecutor,
} from "./errors.js";
import { generateId } from "./mapping.js";
import {
  bounty,
  bountyProposal,
  bountyRun,
  bountyVersion,
  githubRepo,
  jiraBoard,
  jiraConnection,
  jiraIssue,
  sandbox,
  sandboxSource,
  sandboxVersion,
  sandboxVersionSource,
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
  /** The overview's version: moved by each change to its title or text. */
  readonly version: number;
  /**
   * The overview version approved, by whom and when; null until one is.
   * The overview is approved while this is its version (`overviewApproved`).
   */
  readonly approval: BountyApproval | null;
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
  /** When its publication lapses; null while it has none. */
  readonly expiresAt: string | null;
  /** Null until a repository is linked, which cutting a version needs. */
  readonly sourceRepoId: string | null;
  /**
   * The version contributors get, or the latest while none is published,
   * and the bounty version it was built on (null for one built before that
   * was kept). Null while it has no version.
   */
  readonly build: {
    readonly versionId: string;
    readonly version: number;
    readonly bountyVersion: number | null;
  } | null;
}

/** An overview version an owner or admin approved. */
export interface BountyApproval {
  readonly version: number;
  /** Null for a person since removed. */
  readonly approvedBy: string | null;
  readonly approvedAt: string;
}

/** One version of a bounty's overview: its text from then until the next. */
export interface StoredBountyVersion {
  readonly version: number;
  readonly title: string;
  readonly description: string;
  readonly createdBy: string | null;
  readonly createdAt: string;
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
       * repository the organization does not have. `overview-approved`: a
       * change to an overview that stands approved, which is unapproved
       * first.
       */
      readonly reason:
        | "not-found"
        | "changed"
        | "jira-owned"
        | "repo-not-found"
        | "overview-approved";
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
  /**
   * A change, against the revision the editor saw. A change to the title
   * or the description is a new version of the overview, by `editedBy`.
   */
  update(
    organizationId: string,
    bountyId: string,
    expectedRevision: number,
    change: BountyChange,
    editedBy?: string | null,
  ): Promise<BountyMutationResult>;
  /**
   * Approves the overview at the version it is at, against the revision
   * the approver saw, which locks it until it is unapproved. Approving one
   * already approved at its version is no change.
   */
  approve(
    organizationId: string,
    bountyId: string,
    expectedRevision: number,
    approvedBy: string,
  ): Promise<BountyMutationResult>;
  /** Takes the overview's approval back, against the revision seen. */
  unapprove(
    organizationId: string,
    bountyId: string,
    expectedRevision: number,
  ): Promise<BountyMutationResult>;
  /** Its overview's versions, newest first; null for a bounty not found. */
  versions(
    organizationId: string,
    bountyId: string,
  ): Promise<StoredBountyVersion[] | null>;
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
 * repository it is cut from when it has one, and the version it is built
 * as: its published one, or its latest.
 */
const sandboxColumns = {
  sandboxId: sandbox.id,
  sandboxStatus: sandbox.status,
  sandboxVersionId: sandbox.currentVersionId,
  sandboxExpiresAt: sandbox.expiresAt,
  sandboxSourceRepoId: sandboxSource.sourceRepoId,
  buildVersionId: sandboxVersion.id,
  buildVersion: sandboxVersion.version,
  buildBountyVersion: sandboxVersionSource.proposalVersion,
};

interface SandboxFields {
  readonly sandboxId: string | null;
  readonly sandboxStatus: SandboxStatus | null;
  readonly sandboxVersionId: string | null;
  readonly sandboxExpiresAt: Date | null;
  readonly sandboxSourceRepoId: string | null;
  readonly buildVersionId: string | null;
  readonly buildVersion: number | null;
  readonly buildBountyVersion: number | null;
}

const NO_SANDBOX: SandboxFields = {
  sandboxId: null,
  sandboxStatus: null,
  sandboxVersionId: null,
  sandboxExpiresAt: null,
  sandboxSourceRepoId: null,
  buildVersionId: null,
  buildVersion: null,
  buildBountyVersion: null,
};

/** The sandbox's published version, or else its latest. */
const buildVersionId = sql`coalesce(${sandbox.currentVersionId}, (select ${sandboxVersion.id} from ${sandboxVersion} where ${sandboxVersion.sandboxId} = ${sandbox.id} order by ${sandboxVersion.version} desc limit 1))`;

function toSandboxSummary(fields: SandboxFields): BountySandboxSummary | null {
  return fields.sandboxId === null || fields.sandboxStatus === null
    ? null
    : {
        id: fields.sandboxId,
        status: fields.sandboxStatus,
        currentVersionId: fields.sandboxVersionId,
        expiresAt: fields.sandboxExpiresAt?.toISOString() ?? null,
        sourceRepoId: fields.sandboxSourceRepoId,
        build:
          fields.buildVersionId == null || fields.buildVersion == null
            ? null
            : {
                versionId: fields.buildVersionId,
                version: fields.buildVersion,
                bountyVersion: fields.buildBountyVersion ?? null,
              },
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

function toApproval(
  row: Pick<BountyRow, "approvedVersion" | "approvedBy" | "approvedAt">,
): BountyApproval | null {
  return row.approvedVersion == null || row.approvedAt == null
    ? null
    : {
        version: row.approvedVersion,
        approvedBy: row.approvedBy ?? null,
        approvedAt: row.approvedAt.toISOString(),
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
    version: row.version,
    approval: toApproval(row),
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

/**
 * Keeps the overview as the row now says it, as the row's version. Written
 * beside the change that made the version, by whoever made it.
 */
async function keepVersion(
  db: QueryExecutor,
  row: BountyRow,
  createdBy: string | null,
): Promise<void> {
  await db.insert(bountyVersion).values({
    bountyId: row.id,
    version: row.version,
    title: row.title,
    description: row.description,
    createdBy,
    createdAt: row.updatedAt,
  });
}

/**
 * Inserts a bounty in the organization, under a new id, as its overview's
 * version 1. Called inside a transaction, so the two land together.
 */
export async function insertBounty(
  db: QueryExecutor,
  organizationId: string,
  values: Omit<
    typeof bounty.$inferInsert,
    "id" | "organizationId" | "revision" | "version"
  >,
): Promise<BountyRow> {
  const rows = (await db
    .insert(bounty)
    .values({ ...values, id: generateId("bty"), organizationId })
    .returning()) as BountyRow[];
  const created = rows[0];
  if (created === undefined) throw new Error("Bounty insert returned no row.");
  await keepVersion(db, created, created.createdBy);
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

/** Whether a change says something new in the overview's title or text. */
function changesText(
  current: Pick<BountyRow, "title" | "description">,
  change: { readonly title?: unknown; readonly description?: unknown },
): boolean {
  return (
    (change.title !== undefined && change.title !== current.title) ||
    (change.description !== undefined &&
      change.description !== current.description)
  );
}

/**
 * Writes Jira's text over the bounty's, when it differs, against the
 * revision it was read at. A bounty changed in between is left for the next
 * read, which compares again. New words are a new overview version, which
 * nobody here wrote; a change of components alone is not. Called inside a
 * transaction, so the version is kept with the change.
 */
export async function refreshBounty(
  db: QueryExecutor,
  organizationId: string,
  current: BountyRow,
  content: BountyContent,
): Promise<boolean> {
  const change = jiraContentChange(current, content);
  if (change === null) return false;
  const versioned = changesText(current, change);
  const rows = (await db
    .update(bounty)
    .set({
      ...change,
      revision: current.revision + 1,
      ...(versioned ? { version: current.version + 1 } : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(bounty.organizationId, organizationId),
        eq(bounty.id, current.id),
        eq(bounty.revision, current.revision),
      ),
    )
    .returning()) as BountyRow[];
  const updated = rows[0];
  if (updated === undefined) return false;
  if (versioned) await keepVersion(db, updated, null);
  return true;
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
    .leftJoin(sandboxVersion, eq(sandboxVersion.id, buildVersionId))
    .leftJoin(
      sandboxVersionSource,
      eq(sandboxVersionSource.sandboxVersionId, sandboxVersion.id),
    )
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
      version: bounty.version,
      approvedVersion: bounty.approvedVersion,
      approvedBy: bounty.approvedBy,
      approvedAt: bounty.approvedAt,
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
    .leftJoin(sandboxVersion, eq(sandboxVersion.id, buildVersionId))
    .leftJoin(
      sandboxVersionSource,
      eq(sandboxVersionSource.sandboxVersionId, sandboxVersion.id),
    )
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

/**
 * Approves the overview at its version (`approvedBy` given) or takes the
 * approval back (null), against the revision the decider saw. Asking for
 * what already stands is no change, and keeps the revision.
 */
async function decide(
  db: Database,
  organizationId: string,
  bountyId: string,
  expectedRevision: number,
  approvedBy: string | null,
): Promise<BountyMutationResult> {
  const current = await readBounty(db, organizationId, bountyId);
  if (current === null) return { ok: false, reason: "not-found" };
  if (current.revision !== expectedRevision) {
    return { ok: false, reason: "changed", current };
  }
  if (overviewApproved(current) === (approvedBy !== null)) {
    return { ok: true, bounty: current };
  }
  const now = new Date();
  const rows = (await db
    .update(bounty)
    .set({
      approvedVersion: approvedBy === null ? null : current.version,
      approvedBy,
      approvedAt: approvedBy === null ? null : now,
      revision: expectedRevision + 1,
      updatedAt: now,
    })
    .where(
      and(
        eq(bounty.organizationId, organizationId),
        eq(bounty.id, bountyId),
        eq(bounty.revision, expectedRevision),
      ),
    )
    .returning()) as BountyRow[];
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
        row = await db.transaction((tx) =>
          insertBounty(tx, organizationId, {
            title: input.title,
            description: input.description,
            origin: "manual",
            repoId: input.repoId,
            stack: [...input.stack],
            createdBy,
          }),
        );
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

    async update(
      organizationId,
      bountyId,
      expectedRevision,
      change,
      editedBy = null,
    ) {
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
      // Approved, the overview is held as it is until it is unapproved.
      if (overviewApproved(current)) {
        return { ok: false, reason: "overview-approved", current };
      }
      if (
        repoId !== undefined &&
        repoId !== null &&
        repoId !== current.repoId &&
        !(await ownsRepo(db, organizationId, repoId))
      ) {
        return { ok: false, reason: "repo-not-found" };
      }
      // New words are the overview's next version; a repository or a
      // stack is not what a proposal is sized from, so moves none.
      const versioned = changesText(current, change);
      let rows: BountyRow[];
      try {
        rows = await db.transaction(async (tx) => {
          const written = (await tx
            .update(bounty)
            .set({
              ...(change.title === undefined ? {} : { title: change.title }),
              ...(change.description === undefined
                ? {}
                : { description: change.description }),
              ...(repoId === undefined ? {} : { repoId }),
              ...(stack === undefined ? {} : { stack: [...stack] }),
              revision: expectedRevision + 1,
              ...(versioned ? { version: current.version + 1 } : {}),
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
          const updated = written[0];
          if (updated !== undefined && versioned)
            await keepVersion(tx, updated, editedBy);
          return written;
        });
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

    approve: (organizationId, bountyId, expectedRevision, approvedBy) =>
      decide(db, organizationId, bountyId, expectedRevision, approvedBy),

    unapprove: (organizationId, bountyId, expectedRevision) =>
      decide(db, organizationId, bountyId, expectedRevision, null),

    async versions(organizationId, bountyId) {
      const rows = (await db
        .select({ version: bountyVersion })
        .from(bountyVersion)
        .innerJoin(bounty, eq(bounty.id, bountyVersion.bountyId))
        .where(
          and(
            eq(bounty.organizationId, organizationId),
            eq(bounty.id, bountyId),
          ),
        )
        .orderBy(desc(bountyVersion.version))) as {
        version: typeof bountyVersion.$inferSelect;
      }[];
      // Every bounty has its first version, so none is a bounty not found.
      if (rows.length === 0) return null;
      return rows.map(({ version: row }) => ({
        version: row.version,
        title: row.title,
        description: row.description,
        createdBy: row.createdBy,
        createdAt: row.createdAt.toISOString(),
      }));
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
        : db.transaction((tx) =>
            refreshBounty(tx, organizationId, current, content),
          );
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
  | "version"
  | "approvedVersion"
  | "approvedBy"
  | "approvedAt"
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
    version: row.version,
    approval: toApproval(row),
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
