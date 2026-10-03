/**
 * The ticket: the organization's own record of a piece of work, and what a
 * proposal prices and a sandbox is cut for.
 *
 * **Held here, not in a tracker.** A ticket is written on the platform or
 * imported from Jira, and either way this row is what a run sizes from. A
 * Jira link (`jira_issue.ticket_id`) enriches it: each time a run reads the
 * issue the text here follows it, and when the issue goes the ticket keeps
 * what it last said. This reverses the earlier rule that ticket text lived
 * only in Jira and was read live; a ticket nobody wrote in Jira has nowhere
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
  unique,
} from "drizzle-orm/pg-core";

import { user } from "./auth.js";
import { githubRepo } from "./github.js";
import { organization } from "./organizations.js";

const ts = (name: string) => timestamp(name, { withTimezone: true });

export const ticket = pgTable(
  "ticket",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /**
     * The organization's own count, from 1: what `T-12` names. Taken as
     * the next after the organization's highest, so it is never reused
     * while that ticket stands; the unique constraint settles a race.
     */
    number: integer("number").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    issueType: text("issue_type").notNull().default("Task"),
    priority: text("priority"),
    labels: jsonb("labels").$type<string[]>().notNull().default([]),
    /** Jira's components, by name. Empty for a ticket written here. */
    components: jsonb("components").$type<string[]>().notNull().default([]),
    /** Jira's description was longer than a ticket keeps. */
    inputTruncated: boolean("input_truncated").notNull().default(false),
    /** `manual` or `jira`: where the text came from when it was made. */
    origin: text("origin").notNull().default("manual"),
    /**
     * The repository the ticket is about, named for it. Null leaves a Jira
     * ticket with its board's repository, and a ticket written here with
     * none; removing the repository clears it.
     */
    repoId: text("repo_id").references(() => githubRepo.id, {
      onDelete: "set null",
    }),
    createdBy: text("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    /** Bumped by every change to the ticket, for an editor's stale check. */
    revision: integer("revision").notNull().default(1),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("ticket_organization_number_unique").on(
      table.organizationId,
      table.number,
    ),
    index("ticket_organization_created_idx").on(
      table.organizationId,
      table.createdAt,
    ),
    // Removing a repository clears this column; without it that is a scan.
    index("ticket_repo_id_idx").on(table.repoId),
    check("ticket_number_check", sql`${table.number} > 0`),
    check(
      "ticket_title_check",
      sql`char_length(${table.title}) between 1 and 255`,
    ),
    check("ticket_origin_check", sql`${table.origin} in ('manual', 'jira')`),
    check("ticket_revision_check", sql`${table.revision} > 0`),
  ],
);

export type TicketRow = typeof ticket.$inferSelect;
export type NewTicketRow = typeof ticket.$inferInsert;
