/**
 * The bounty: the organization's own record of a piece of work, and what a
 * proposal prices and a sandbox is cut for.
 *
 * **Held here, not in a tracker.** A bounty is written on the platform or
 * imported from Jira, and either way this row is what a run sizes from. A
 * Jira link (`jira_issue.bounty_id`) enriches it: each time a run reads the
 * issue the text here follows it, and when the issue goes the bounty keeps
 * what it last said. This reverses the earlier rule that bounty text lived
 * only in Jira and was read live; a bounty nobody wrote in Jira has nowhere
 * else to live, and one proposal path for both is the point.
 *
 * Private to the organization, as the proposals made from it are.
 */

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type {
  BountyOrigin,
  ContextSource,
  GithubContext,
  JiraContext,
} from "sandbox-factory";

import { user } from "./auth.js";
import { githubRepo } from "./github.js";
import { organization } from "./organizations.js";

const ts = (name: string) => timestamp(name, { withTimezone: true });

export const bounty = pgTable(
  "bounty",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    /** Jira's components, by name. Empty for a bounty written here. */
    components: jsonb("components").$type<string[]>().notNull().default([]),
    /** Jira's description was longer than a bounty keeps. */
    inputTruncated: boolean("input_truncated").notNull().default(false),
    /** `manual` or `jira`: where the text came from when it was made. */
    origin: text("origin").$type<BountyOrigin>().notNull().default("manual"),
    /**
     * The repository the bounty is about, named for it. Null leaves a Jira
     * bounty with its board's repository, and a bounty written here with
     * none; removing the repository clears it.
     */
    repoId: text("repo_id").references(() => githubRepo.id, {
      onDelete: "set null",
    }),
    /**
     * Technologies the bounty adds to its repository's detected stack, by
     * name. The repository's own are not copied here: they follow it.
     */
    stack: jsonb("stack").$type<string[]>().notNull().default([]),
    createdBy: text("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    /** Bumped by every change to the bounty, for an editor's stale check. */
    revision: integer("revision").notNull().default(1),
    /**
     * The overview's version: moved only by a change to the title or the
     * description, which is what a proposal is sized from. Each one is kept
     * in `bounty_version`.
     */
    version: integer("version").notNull().default(1),
    /**
     * The overview version an owner or admin approved, and who and when.
     * While it is `version` the overview is approved, and its title, text,
     * repository and stack are not changed until it is unapproved. A new
     * version (from Jira, which no approval holds back) leaves it behind,
     * and the overview reads as unapproved again.
     */
    approvedVersion: integer("approved_version"),
    approvedBy: text("approved_by").references(() => user.id, {
      onDelete: "set null",
    }),
    approvedAt: ts("approved_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("bounty_organization_created_idx").on(
      table.organizationId,
      table.createdAt,
    ),
    // Removing a repository clears this column; without it that is a scan.
    index("bounty_repo_id_idx").on(table.repoId),
    check(
      "bounty_title_check",
      sql`char_length(${table.title}) between 1 and 255`,
    ),
    check("bounty_origin_check", sql`${table.origin} in ('manual', 'jira')`),
    check("bounty_revision_check", sql`${table.revision} > 0`),
    check("bounty_version_check", sql`${table.version} > 0`),
    check(
      "bounty_approved_version_check",
      sql`(${table.approvedVersion} IS NULL AND ${table.approvedAt} IS NULL) OR (${table.approvedVersion} BETWEEN 1 AND ${table.version} AND ${table.approvedAt} IS NOT NULL)`,
    ),
  ],
);

export type BountyRow = typeof bounty.$inferSelect;
export type NewBountyRow = typeof bounty.$inferInsert;

/**
 * A bounty's overview, one row per version: its title and description as
 * they stood from that version until the next. Never edited: a change is a
 * new row, as a proposal's spec revision is. A proposal is matched to the
 * version it was sized from by the hash of this text, so nothing here
 * points at a proposal.
 */
export const bountyVersion = pgTable(
  "bounty_version",
  {
    bountyId: text("bounty_id")
      .notNull()
      .references(() => bounty.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    /** Who wrote it; null for Jira's text, or a person since removed. */
    createdBy: text("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.bountyId, table.version] }),
    check("bounty_version_version_check", sql`${table.version} > 0`),
  ],
);

export type BountyVersionRow = typeof bountyVersion.$inferSelect;

/**
 * The context a bounty's sources added to it, one row per version per
 * source: what its Jira issue said beyond its text, or what its
 * repository's documents said, as a sync read them. A sync that finds
 * what the latest version already holds moves only that version's
 * `revision` and `checked_at`; one that finds something new is a new
 * version. Sizing and generation record the versions they were made with
 * (`bounty_proposal` and `sandbox_version_source`), so nothing here points
 * at them.
 *
 * The documents are a repository's own Markdown, cut to the caps in
 * `packages/core/src/sources.ts`; never its code. Private to the
 * organization, as the bounty is.
 */
export const bountyContext = pgTable(
  "bounty_context",
  {
    bountyId: text("bounty_id")
      .notNull()
      .references(() => bounty.id, { onDelete: "cascade" }),
    /** `jira` or `github`. */
    source: text("source").$type<ContextSource>().notNull(),
    version: integer("version").notNull(),
    /** What the source is called: the issue's key, the repository's name. */
    ref: text("ref").notNull(),
    /**
     * What the source is, which survives a rename: Jira's issue id, the
     * platform's repository id. A sync of another one is a new version.
     */
    refId: text("ref_id").notNull(),
    /**
     * Where the source stood when it was last read: Jira's `updated`, the
     * commit the documents were read at. A source past it is ahead.
     */
    revision: text("revision").notNull(),
    content: jsonb("content").$type<JiraContext | GithubContext>().notNull(),
    /** SHA-256 of the content, so a sync with nothing new is no version. */
    contentHash: text("content_hash").notNull(),
    syncedBy: text("synced_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: ts("created_at").notNull().defaultNow(),
    /** The last sync that found this version still what the source says. */
    checkedAt: ts("checked_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.bountyId, table.source, table.version] }),
    check(
      "bounty_context_source_check",
      sql`${table.source} in ('jira', 'github')`,
    ),
    check("bounty_context_version_check", sql`${table.version} > 0`),
  ],
);

export type BountyContextRow = typeof bountyContext.$inferSelect;
