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
     * The owner. Every read and write in `TodoStore` is filtered on this, and
     * that filter — not the session check at the HTTP edge — is what makes a
     * todo private.
     *
     * The distinction matters: authenticating a request only proves *who* is
     * asking. Without this column the routes were behind a session and still
     * served every user the whole table, which is a worse failure than no auth
     * at all because it looks protected. `user_id` is the thing that makes the
     * answer depend on the asker.
     *
     * Cascades on delete, like `user_email`: a deleted account leaves no rows
     * pointing at an id that no longer exists.
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
    // Every query the store issues is `where user_id = $1`, most of them also
    // ordering by `created_at desc`. The composite index serves both halves,
    // so the common list read never sorts.
    index("todos_user_id_created_at_idx").on(
      table.userId,
      desc(table.createdAt),
    ),
  ],
);

export type TodoRow = typeof todos.$inferSelect;
export type NewTodoRow = typeof todos.$inferInsert;

/**
 * Better Auth tables.
 *
 * These four models — user, session, account, verification — are Better Auth's
 * core schema, not ours to design. The shapes below were taken from
 * `getAuthTables()` in `better-auth/db` rather than from documentation, so they
 * match what the adapter actually queries.
 *
 * Two naming rules are load-bearing, and both come from how the Drizzle adapter
 * resolves a model:
 *
 * - **The exported const names are singular** (`user`, not `users`). The adapter
 *   looks up `schema[model]` with Better Auth's own model names, which are
 *   singular unless `usePlural` is set. `todos` above is plural because it is
 *   ours and nothing looks it up by name; these are not.
 * - **The property keys are camelCase** (`emailVerified`, `userId`). The adapter
 *   indexes the table object by field name — `schemaModel[fieldName]` — so the
 *   *property* must be camelCase even though the *column* it maps to is
 *   snake_case. Renaming a property breaks queries at runtime, not at compile
 *   time; renaming the column string inside it is safe.
 *
 * `id` is `text` here for the same reason it is on `todos`: Better Auth
 * generates its own string ids, so a serial or uuid column would reject them.
 *
 * Session and account rows cascade on user delete. Better Auth declares those
 * references with `onDelete: "cascade"`, and leaving them to be cleaned up by
 * hand would strand live sessions for a user who no longer exists.
 */

export const user = pgTable(
  "user",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /**
     * The primary email, and the only one Better Auth itself knows about.
     *
     * Still unique, but it is no longer *the* identity — `id` is. Every other
     * address this person has proven belongs to them lives in `userEmail` below,
     * and this column holds whichever of those is currently primary.
     *
     * Uniqueness is a case-insensitive index on `lower(email)` (migration 0011),
     * not Drizzle's `.unique()`. A byte-exact constraint allowed two separate
     * accounts on one address differing only in case, each able to sign in. See
     * `userEmail.email` below for the other half of the rule.
     */
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    /**
     * The public handle, e.g. `feversoul`.
     *
     * **Not null**: every account has one from the moment it is created. It is
     * generated at signup from the provider's email rather than asked for, so
     * there is no window in which a user exists without a handle and no other
     * part of the app has to cope with a null one. The person can change it
     * afterwards.
     *
     * Stored lowercase and unique so `@Alice` and `@alice` cannot both exist;
     * `displayUsername` keeps the casing the person actually typed.
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
    /**
     * The primary address, unique case-insensitively — see `email` above.
     *
     * Over `lower(email)`, which a column-level `.unique()` cannot express.
     * Created by migration 0011.
     */
    uniqueIndex("user_email_lower_unique").on(sql`lower(${table.email})`),
  ],
);

/**
 * Every email address a person has proven they control.
 *
 * **Proof is an OAuth link, not a token in an inbox.** A row appears here only
 * because the person signed in to a provider that reported this address as
 * verified, so the provider has done the verification for us. That is why this
 * table has no token, no expiry, and why the app sends no mail at all.
 *
 * `provider_id` records which link vouched for the address. If that account is
 * unlinked the proof is gone, so the row goes with it — enforced by the
 * cascade, not by application code that might forget.
 *
 * Uniqueness is global, not per user: an address may prove at most one
 * identity, or two people could both claim the same inbox. It is enforced
 * case-insensitively and across both this table and `user.email` — see the
 * `email` column below for how, and why it takes two mechanisms.
 */
export const userEmail = pgTable(
  "user_email",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /**
     * One address, one account — enforced in the database, in two halves.
     *
     * *Within this table*, by a case-insensitive unique index on
     * `lower(email)` (migration 0011). Drizzle's `.unique()` is deliberately
     * **not** used: it generates a byte-exact constraint, which let
     * `alice@x` and `ALICE@x` both be stored against different users. The
     * index replaces it rather than joining it.
     *
     * *Across `user.email` and this column*, by a trigger pair (migrations
     * 0007-0009). No constraint or index can express uniqueness over the union
     * of two tables, which is the only reason that half is a trigger. It
     * compares case-insensitively and takes an advisory lock on the address so
     * two concurrent sign-ins cannot both pass the check.
     *
     * The `otherOwner` checks in `record` and `setPrimary` in `emails.ts` now
     * duplicate this rather than solely providing it. Keep them anyway: they
     * turn a would-be constraint violation into the `null` those functions
     * promise, so callers get a decision to act on instead of a 500.
     */
    email: text("email").notNull(),
    /**
     * Which providers vouched for this address, comma separated.
     *
     * A list rather than a single value because one inbox is commonly
     * registered at several providers — a Google account and a GitHub account
     * on the same address is the normal case, not an edge case. Storing only
     * the first would make the settings page claim GitHub had proved nothing.
     *
     * Comma separated rather than a join table: this is a short display-only
     * list that is always read whole, never queried across.
     */
    providerId: text("provider_id").notNull(),
    /**
     * Mirrors `user.email`. Kept here too so this table alone answers "which is
     * primary" without a join back to `user`.
     */
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /**
     * The address a user currently presents as primary.
     *
     * A partial unique index, not a plain constraint: it applies only to rows
     * where `is_primary` is true, so a user has at most one primary address
     * while still holding any number of secondary ones.
     */
    uniqueIndex("user_email_one_primary")
      .on(table.userId)
      .where(sql`${table.isPrimary}`),
    /**
     * One address, one account, case-insensitively — see `email` above.
     *
     * Declared here rather than as `.unique()` on the column because the
     * uniqueness is over `lower(email)`, which a column-level constraint
     * cannot express. Created by migration 0011.
     */
    uniqueIndex("user_email_email_lower_unique").on(sql`lower(${table.email})`),
  ],
);

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  // Unique: the token is the session lookup key on every authenticated
  // request, so a duplicate would make "which session is this" ambiguous.
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
    // The user's id *at the provider*, distinct from `userId` below, which is
    // ours. Google and GitHub each have their own namespace, so uniqueness is
    // only meaningful per (providerId, accountId) — see the constraint below.
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
    // Part of Better Auth's schema and deliberately never written: email and
    // password sign-in is disabled, so no credential ever reaches this column.
    // It stays because the adapter expects the field to exist.
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /**
     * One provider identity belongs to exactly one user.
     *
     * Better Auth already refuses to link an account that another user holds,
     * on all three paths — sign-in, the OAuth redirect, and the link API — so
     * this is not what stops the normal case. It is here because the library
     * *assumes* the invariant rather than tolerating a breach: its
     * `findAccountByKey` throws "Multiple accounts match the same accountId"
     * when two rows collide, which breaks sign-in for both users at once.
     *
     * A bad migration, a manual insert or a future bug could otherwise create
     * that state silently. With this, the write fails loudly instead.
     */
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
