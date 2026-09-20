/**
 * The organization store: the reads the API needs and Better Auth's plugin
 * does not provide.
 *
 * The plugin owns every *write* to `organization`, `member` and `invitation`
 * — creation, rename, membership and invitations all go through its endpoints
 * — so nothing here inserts or deletes. What it does not offer is the reads
 * this product's routes need: a user's memberships in one query, a
 * membership check that does not depend on the session's active organization,
 * and a member list carrying the handle each person is known by.
 *
 * `touch` is the one exception, and only because 1.7.5 declares no
 * `updatedAt` on `organization`.
 */

import { and, eq } from "drizzle-orm";

import { invitation, member, organization, user } from "./schema.js";
import type { Database } from "./store.js";

/** An organization as every surface lists it: two names and nothing else. */
export interface OrganizationSummary {
  readonly id: string;
  readonly name: string;
  /** The public handle. Renameable, so never a foreign key. */
  readonly slug: string;
}

/** One of the caller's organizations, with the role they hold in it. */
export interface Membership extends OrganizationSummary {
  readonly role: string;
}

/** A member of one organization, joined with what the person is called. */
export interface OrganizationMember {
  /** The `member` row id, which is what the plugin's write endpoints take. */
  readonly id: string;
  readonly userId: string;
  readonly role: string;
  readonly name: string;
  readonly username: string | null;
  readonly image: string | null;
}

/** A pending invitation, as its recipient sees it. */
export interface PendingInvitation {
  readonly id: string;
  readonly organization: OrganizationSummary;
  readonly role: string;
  readonly expiresAt: Date;
}

export interface OrganizationStore {
  /**
   * Organizations the user belongs to, oldest membership first. The sidebar
   * switcher and the account page read this.
   */
  listForUser(userId: string): Promise<Membership[]>;
  /**
   * The caller's role in one organization, or undefined when they are not a
   * member. The membership check every organization-scoped route makes; a
   * miss becomes a 404, never a 403.
   */
  roleOf(userId: string, organizationId: string): Promise<string | undefined>;
  /** One organization by id, whoever is asking. Undefined when unknown. */
  get(organizationId: string): Promise<OrganizationSummary | undefined>;
  /** One organization by handle, for public pages. */
  findBySlug(slug: string): Promise<OrganizationSummary | undefined>;
  /**
   * The id of the organization holding a handle, or undefined when it is
   * free. `exceptId` excludes one organization, so re-saving your own handle
   * in different casing is a rename rather than a collision.
   */
  slugOwner(slug: string, exceptId?: string): Promise<string | undefined>;
  /** Members, with the handle each is known by. Oldest first. */
  listMembers(organizationId: string): Promise<OrganizationMember[]>;
  /** Pending invitations addressed to `email`, newest first. */
  pendingFor(email: string): Promise<PendingInvitation[]>;
  /**
   * The user holding a handle, with the address an invitation to them must
   * be addressed to. Undefined when nobody holds it.
   *
   * The *primary* address, because that is what Better Auth compares against
   * the invitation on accept; a proven secondary would produce an invitation
   * its recipient could not take up.
   */
  findUserByHandle(
    handle: string,
  ): Promise<{ id: string; email: string } | undefined>;
  /** Bumps `updatedAt`; the plugin does not maintain it. */
  touch(organizationId: string): Promise<void>;
}

export function createOrganizationStore(db: Database): OrganizationStore {
  return {
    async listForUser(userId) {
      const rows = await db
        .select({
          id: organization.id,
          name: organization.name,
          slug: organization.slug,
          role: member.role,
          joinedAt: member.createdAt,
        })
        .from(member)
        .innerJoin(organization, eq(member.organizationId, organization.id))
        .where(eq(member.userId, userId));

      // Oldest first, so the list does not reshuffle when a role changes.
      // Sorted here rather than in SQL because the fake database used by the
      // tests does not interpret `orderBy`.
      return rows
        .slice()
        .sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime())
        .map(({ id, name, slug, role }) => ({ id, name, slug, role }));
    },

    async roleOf(userId, organizationId) {
      const [row] = await db
        .select({ role: member.role })
        .from(member)
        .where(
          and(
            eq(member.userId, userId),
            eq(member.organizationId, organizationId),
          ),
        )
        .limit(1);
      return row?.role;
    },

    async get(organizationId) {
      const [row] = await db
        .select({
          id: organization.id,
          name: organization.name,
          slug: organization.slug,
        })
        .from(organization)
        .where(eq(organization.id, organizationId))
        .limit(1);
      return row;
    },

    async findBySlug(slug) {
      const [row] = await db
        .select({
          id: organization.id,
          name: organization.name,
          slug: organization.slug,
        })
        .from(organization)
        .where(eq(organization.slug, slug.trim().toLowerCase()))
        .limit(1);
      return row;
    },

    async slugOwner(slug, exceptId) {
      const found = await this.findBySlug(slug);
      if (found === undefined || found.id === exceptId) {
        return undefined;
      }
      return found.id;
    },

    async listMembers(organizationId) {
      const rows = await db
        .select({
          id: member.id,
          userId: member.userId,
          role: member.role,
          joinedAt: member.createdAt,
          name: user.name,
          username: user.username,
          image: user.image,
        })
        .from(member)
        .innerJoin(user, eq(member.userId, user.id))
        .where(eq(member.organizationId, organizationId));

      return rows
        .slice()
        .sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime())
        .map(({ id, userId, role, name, username, image }) => ({
          id,
          userId,
          role,
          name,
          username,
          image,
        }));
    },

    async pendingFor(email) {
      const rows = await db
        .select({
          id: invitation.id,
          role: invitation.role,
          expiresAt: invitation.expiresAt,
          createdAt: invitation.createdAt,
          organizationId: organization.id,
          name: organization.name,
          slug: organization.slug,
        })
        .from(invitation)
        .innerJoin(organization, eq(invitation.organizationId, organization.id))
        .where(
          and(
            eq(invitation.email, email.trim().toLowerCase()),
            eq(invitation.status, "pending"),
          ),
        );

      const now = Date.now();
      return (
        rows
          .slice()
          // An expired invitation stays `pending` in the table — nothing sweeps
          // it — so hide it here rather than offer an accept that would fail.
          .filter((row) => row.expiresAt.getTime() > now)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .map((row) => ({
            id: row.id,
            role: row.role,
            expiresAt: row.expiresAt,
            organization: {
              id: row.organizationId,
              name: row.name,
              slug: row.slug,
            },
          }))
      );
    },

    async findUserByHandle(handle) {
      const [row] = await db
        .select({ id: user.id, email: user.email })
        .from(user)
        .where(eq(user.username, handle.trim().toLowerCase()))
        .limit(1);
      return row;
    },

    async touch(organizationId) {
      await db
        .update(organization)
        .set({ updatedAt: new Date() })
        .where(eq(organization.id, organizationId));
    },
  };
}
