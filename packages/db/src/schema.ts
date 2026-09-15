/**
 * Drizzle schema.
 *
 * The column types are chosen to round-trip `Todo` from `sandbox-factory`
 * exactly, because the API's `TodoStore` contract is defined in terms of that
 * type and callers must not be able to tell which implementation they hold:
 *
 * - `id` is `text`, not a serial or uuid. The in-memory store hands out
 *   `todo_1`-style ids and the published domain type declares `id: string`;
 *   a numeric key would change the shape of the public API.
 * - `created_at` is `timestamptz`. It is mapped back to an ISO string at the
 *   store boundary rather than stored as text, so the database can sort and
 *   range-query it. Storing an ISO string in a text column would sort
 *   correctly by luck of the format and index badly.
 */

import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const todos = pgTable("todos", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  done: boolean("done").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type TodoRow = typeof todos.$inferSelect;
export type NewTodoRow = typeof todos.$inferInsert;
