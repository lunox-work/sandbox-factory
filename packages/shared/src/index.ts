/**
 * The wire contract. The API parses with these schemas on the way out and the
 * client on the way in, so a shape change breaks the build, not a consumer at
 * runtime.
 *
 * Depends on zod only, so the extension and the browser can both bundle it.
 */

import {
  TITLE_MAX_LENGTH,
  TODO_FILTERS,
  normalizeHandle,
} from "sandbox-factory";
import { z } from "zod";

/** Derived from the core constants, so a cap changed in core applies here. */
export const titleSchema = z
  .string()
  .trim()
  .min(1, "A todo needs a title.")
  .max(
    TITLE_MAX_LENGTH,
    `Titles are capped at ${TITLE_MAX_LENGTH} characters.`,
  );

export const todoFilterSchema = z.enum(TODO_FILTERS);

/**
 * A public handle: a username or an organization slug. Refines rather than
 * restates, so the core rules are the only definition, and transforms to the
 * stored (lowercase) form so a handler never sees the raw casing.
 *
 * The message is core's, which is subject-free ("Must be between…"): callers
 * that report the field name separately read correctly, and zod prefixes the
 * path itself in a fielded error.
 */
export const handleSchema = z
  .string()
  .transform((raw) => normalizeHandle(raw))
  .superRefine((result, ctx) => {
    if (result.status === "invalid") {
      ctx.addIssue({ code: "custom", message: result.reason });
    }
  })
  // Unreachable when invalid: `superRefine` has already failed the parse, so
  // this only ever runs on the `ok` branch. The fallback keeps the type
  // narrow without an assertion.
  .transform((result) => (result.status === "ok" ? result.handle : ""));

export const todoSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  done: z.boolean(),
  createdAt: z.iso.datetime(),
});

export const todoListSchema = z.object({
  todos: z.array(todoSchema),
});

/** Body for `POST /api/v1/todos`. */
export const createTodoSchema = z.object({
  title: titleSchema,
});

/**
 * Body for `PATCH /api/v1/todos/:id`. Both fields are optional, but an empty
 * body is rejected: it almost always means the caller sent the wrong shape.
 */
export const updateTodoSchema = z
  .object({
    title: titleSchema.optional(),
    done: z.boolean().optional(),
  })
  .refine((body) => body.title !== undefined || body.done !== undefined, {
    message: "Provide a title, a done flag, or both.",
  });

/**
 * Organizations. The membership shape the sidebar and the account page read;
 * `role` is the plugin's, one of owner, admin or member.
 */
export const ORGANIZATION_ROLES = ["owner", "admin", "member"] as const;

export const organizationRoleSchema = z.enum(ORGANIZATION_ROLES);

export const organizationSummarySchema = z.object({
  /** Permanent. What anything durable references. */
  id: z.string().min(1),
  name: z.string().min(1),
  /** The public handle. Unique but renameable: never a foreign key. */
  slug: z.string().min(1),
});

export const membershipSchema = organizationSummarySchema.extend({
  role: organizationRoleSchema,
});

export const membershipListSchema = z.object({
  organizations: z.array(membershipSchema),
});

/** A member of one organization, joined with the handle the user shows. */
export const organizationMemberSchema = z.object({
  /** The `member` row id, which is what remove and role changes take. */
  id: z.string().min(1),
  userId: z.string().min(1),
  role: organizationRoleSchema,
  name: z.string(),
  username: z.string().nullable(),
  image: z.string().nullable(),
});

export const organizationMemberListSchema = z.object({
  members: z.array(organizationMemberSchema),
});

/** A pending invitation, as its recipient sees it. */
export const pendingInvitationSchema = z.object({
  id: z.string().min(1),
  organization: organizationSummarySchema,
  role: organizationRoleSchema,
  expiresAt: z.iso.datetime(),
});

export const pendingInvitationListSchema = z.object({
  invitations: z.array(pendingInvitationSchema),
});

/**
 * Body for `POST /api/v1/orgs/:orgId/invitations`. Exactly one of `handle` or
 * `email`: inviting by handle is the common case inside the product, and by
 * address is how someone with no account yet is reached.
 */
export const inviteMemberSchema = z
  .object({
    handle: handleSchema.optional(),
    email: z.email().optional(),
    role: organizationRoleSchema.default("member"),
  })
  .refine(
    (body) => (body.handle === undefined) !== (body.email === undefined),
    { message: "Provide either a handle or an email address, not both." },
  );

export const errorSchema = z.object({
  error: z.string(),
});

export type TodoDto = z.infer<typeof todoSchema>;
export type TodoListDto = z.infer<typeof todoListSchema>;
export type CreateTodoInput = z.infer<typeof createTodoSchema>;
export type UpdateTodoInput = z.infer<typeof updateTodoSchema>;
export type ErrorDto = z.infer<typeof errorSchema>;
export type OrganizationRole = z.infer<typeof organizationRoleSchema>;
export type OrganizationSummaryDto = z.infer<typeof organizationSummarySchema>;
export type MembershipDto = z.infer<typeof membershipSchema>;
export type MembershipListDto = z.infer<typeof membershipListSchema>;
export type OrganizationMemberDto = z.infer<typeof organizationMemberSchema>;
export type PendingInvitationDto = z.infer<typeof pendingInvitationSchema>;
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;

/** Build provenance: describes the artifact, not the data it serves. */
export * from "./build-info.js";
