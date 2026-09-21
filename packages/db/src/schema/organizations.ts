/**
 * Organizations: the second principal, beside `user`.
 *
 * Shaped after Better Auth's organization plugin, which resolves these by
 * string exactly as it does the four core tables — so the same two naming
 * rules apply (singular const, camelCase keys), and breaking either fails at
 * runtime rather than compile time.
 *
 * Like a user, an organization has two names: `id` is permanent and is what
 * anything durable references, `slug` is the public handle and may be renamed
 * at any time.
 *
 * **This module and `auth.ts` import each other**: `session` points at
 * `organization`, and `member` and `invitation` point at `user`. That is safe
 * because every Drizzle foreign key is a `() => table.column` thunk, evaluated
 * when the schema is first read rather than while the modules are still
 * loading. Referencing a table from the other module *outside* a thunk would
 * not be.
 */

import { index, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";

import { user } from "./auth.js";

/**
 * What an organization is: one person's own account, or a team.
 *
 * `personal` exists so that everything ownable has a single non-null
 * `organization_id` rather than a nullable user/organization pair. A personal
 * organization is a real row with one `owner` member, minted at signup — what
 * GitHub and Vercel do. Nothing below the API boundary branches on this: a
 * store method takes an organization id and does not care which kind it is.
 */
export const ORGANIZATION_KINDS = ["personal", "team"] as const;

export type OrganizationKind = (typeof ORGANIZATION_KINDS)[number];

export const organization = pgTable("organization", {
  id: text("id").primaryKey(),
  /** Display name. Free text, unlike the handle. */
  name: text("name").notNull(),
  /**
   * The public handle. Unique, and stored lowercase by the plugin hooks in
   * `apps/api/src/auth.ts`, which is what makes this plain `.unique()`
   * case-insensitive in effect. The hooks are the only writer, so the
   * functional index used for `user.email` would be belt and braces here.
   *
   * Renameable: never store it as a foreign key.
   */
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  /** JSON as a string; the plugin declares this field as `string`. */
  metadata: text("metadata"),
  /**
   * `personal` or `team`. Defaults to `team`: the plugin's own create
   * endpoint writes no `kind`, and self-serve creation is always a team.
   * Only the signup hook writes `personal`.
   */
  kind: text("kind").notNull().default("team"),
  /**
   * The user whose personal organization this is, and null for every team.
   *
   * Unique, so one user cannot end up with two — which a handle lookup could
   * not prevent, since handles are renameable. It gives "find my personal
   * organization" a foreign key rather than a guess, and cascades so deleting
   * a user takes their personal organization with it.
   */
  personalUserId: text("personal_user_id")
    .unique()
    .references(() => user.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  /**
   * Ours, not the plugin's: 1.7.5 declares `updatedAt` only for its team and
   * role tables. The `afterUpdateOrganization` hook sets it, so an
   * organization renamed through the plugin still reports when it changed.
   */
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * The many-to-many between users and organizations, carrying the role. A user
 * is in any number of organizations; an organization has any number of
 * members.
 */
export const member = pgTable(
  "member",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /**
     * `owner`, `admin` or `member`. Comma-separated if one member ever holds
     * several: the plugin splits on `,` when it checks permissions, so the
     * column is deliberately not an enum.
     */
    role: text("role").notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // One membership per person per organization. The plugin checks before it
    // inserts but assumes the invariant afterwards, so a duplicate would show
    // up as a member who cannot be removed rather than as an error.
    unique("member_organization_user_unique").on(
      table.organizationId,
      table.userId,
    ),
    // Serves "which organizations is this user in", read on every page load.
    index("member_user_id_idx").on(table.userId),
  ],
);

/**
 * An invitation to join an organization, addressed to an email rather than a
 * user: the invitee may not have an account yet.
 *
 * Nothing is emailed — `sendInvitationEmail` is left unset, because this
 * codebase sends no mail. The invitee finds it on their account page, which
 * is what `invitation_email_status_idx` serves.
 */
export const invitation = pgTable(
  "invitation",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /**
     * Stored lowercase by the `beforeCreateInvitation` hook. The plugin
     * compares it to the session's email case-insensitively on accept, so
     * this only keeps the stored data consistent.
     */
    email: text("email").notNull(),
    role: text("role").notNull().default("member"),
    /** pending | accepted | rejected | canceled */
    status: text("status").notNull().default("pending"),
    inviterId: text("inviter_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // The invitee's inbox: `where email = $1 and status = 'pending'`.
    index("invitation_email_status_idx").on(table.email, table.status),
    // The organization's own pending list, on its settings page.
    index("invitation_organization_id_idx").on(table.organizationId),
  ],
);

export type OrganizationRow = typeof organization.$inferSelect;
export type NewOrganizationRow = typeof organization.$inferInsert;
export type MemberRow = typeof member.$inferSelect;
export type NewMemberRow = typeof member.$inferInsert;
export type InvitationRow = typeof invitation.$inferSelect;
