/**
 * The todo domain. Round-trips `Todo` from `sandbox-factory` exactly: `id` is
 * `text` because the domain type declares `id: string`, and `created_at` is
 * `timestamptz` (mapped to an ISO string at the store boundary) so the
 * database can sort and range-query it.
 *
 * This is the reference surface, not part of the sandbox product — it stays
 * user-owned while the new tables are organization-owned.
 */

import { desc } from "drizzle-orm";
import { boolean, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { user } from "./auth.js";

export const todos = pgTable(
  "todos",
  {
    id: text("id").primaryKey(),
    /**
     * The owner. Every `TodoStore` read and write filters on this; that
     * filter, not the session check at the HTTP edge, is what makes a todo
     * private. Cascades on user delete.
     */
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    done: boolean("done").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Serves `where user_id = $1 order by created_at desc` without a sort.
    index("todos_user_id_created_at_idx").on(
      table.userId,
      desc(table.createdAt),
    ),
  ],
);

export type TodoRow = typeof todos.$inferSelect;
export type NewTodoRow = typeof todos.$inferInsert;
