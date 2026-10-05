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
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type { BountyOrigin } from "sandbox-factory";

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
  ],
);

export type BountyRow = typeof bounty.$inferSelect;
export type NewBountyRow = typeof bounty.$inferInsert;
