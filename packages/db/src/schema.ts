/**
 * Drizzle schema. `todos` round-trips `Todo` from `sandbox-factory` exactly:
 * `id` is `text` because the domain type declares `id: string`, and
 * `created_at` is `timestamptz` (mapped to an ISO string at the store boundary)
 * so the database can sort and range-query it.
 */

import { desc, sql } from "drizzle-orm";
import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";

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

/**
 * Better Auth's core tables (user, session, account, verification), shaped
 * after `getAuthTables()` in `better-auth/db`.
 *
 * The Drizzle adapter resolves names by string, so two naming rules are
 * load-bearing; breaking either fails at runtime, not compile time:
 *
 * - Exported const names are singular (`user`): the adapter looks up
 *   `schema[model]` by Better Auth's model name.
 * - Property keys are camelCase (`emailVerified`): the adapter indexes
 *   `schemaModel[fieldName]`. Renaming the snake_case column string is safe.
 *
 * Ids are `text` because Better Auth generates string ids. Session and account
 * rows cascade on user delete, as Better Auth declares.
 */

export const user = pgTable(
  "user",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /**
     * The primary email, and the only one Better Auth knows about. The
     * identity is `id`; every proven address lives in `userEmail`, and this
     * holds whichever is primary. Unique on `lower(email)` via the index
     * below — see `userEmail.email` for the full rule.
     */
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    /**
     * The public handle. Not null: generated at signup from the provider's
     * email, so no user ever exists without one. Stored lowercase and unique;
     * `displayUsername` keeps the casing the person typed.
     */
    username: text("username").notNull().unique(),
    displayUsername: text("display_username").notNull(),
    image: text("image"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Case-insensitive uniqueness, which `.unique()` cannot express
    // (migration 0011).
    uniqueIndex("user_email_lower_unique").on(sql`lower(${table.email})`),
  ],
);

/**
 * Every email address a person has proven they control.
 *
 * Proof is an OAuth link, not a token in an inbox: a row exists only because
 * a provider reported the address as verified. Hence no token, no expiry, and
 * no mail sent. `provider_id` records which link vouched for it.
 *
 * Uniqueness is global, not per user — see `email` below.
 */
export const userEmail = pgTable(
  "user_email",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /**
     * One address, one account, enforced in the database in two halves:
     *
     * - Within this table, a unique index on `lower(email)` (migration 0011).
     *   Do not use `.unique()`: it is byte-exact, so `alice@x` and `ALICE@x`
     *   could belong to different users.
     * - Across `user.email` and this column, a trigger pair (migrations
     *   0007-0009), since no index spans two tables. It compares
     *   case-insensitively and takes an advisory lock on the address so
     *   concurrent sign-ins cannot both pass.
     *
     * The `otherOwner` checks in `emails.ts` duplicate this. Keep them: they
     * turn a constraint violation into the `null` callers are promised.
     */
    email: text("email").notNull(),
    /**
     * Providers that vouched for this address, comma separated. A list
     * because one inbox at both Google and GitHub is the normal case; not a
     * join table because it is display-only and always read whole.
     */
    providerId: text("provider_id").notNull(),
    /** Mirrors `user.email`, so "which is primary" needs no join. */
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Partial: at most one primary per user, any number of secondaries.
    uniqueIndex("user_email_one_primary")
      .on(table.userId)
      .where(sql`${table.isPrimary}`),
    // See `email` above (migration 0011).
    uniqueIndex("user_email_email_lower_unique").on(sql`lower(${table.email})`),
  ],
);

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  // Unique: the lookup key on every authenticated request.
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    // The user's id at the provider, not ours. Only unique per
    // (providerId, accountId) — see the constraint below.
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
    }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      withTimezone: true,
    }),
    scope: text("scope"),
    // Never written (password sign-in is disabled); the adapter expects the
    // field to exist.
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // One provider identity, one user. Better Auth already refuses the link
    // on every path, but it assumes the invariant: `findAccountByKey` throws
    // on a collision and breaks sign-in for both users. This makes a bad
    // migration or manual insert fail loudly instead.
    unique("account_provider_identity_unique").on(
      table.providerId,
      table.accountId,
    ),
  ],
);

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type UserRow = typeof user.$inferSelect;
export type UserEmailRow = typeof userEmail.$inferSelect;
export type NewUserEmailRow = typeof userEmail.$inferInsert;
export type SessionRow = typeof session.$inferSelect;
export type AccountRow = typeof account.$inferSelect;
export type VerificationRow = typeof verification.$inferSelect;
