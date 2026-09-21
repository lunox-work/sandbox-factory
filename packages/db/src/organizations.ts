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

import { generateId } from "./mapping.js";
import { invitation, member, organization, user } from "./schema.js";
import type { OrganizationKind } from "./schema.js";
import type { Database } from "./errors.js";

/** An organization as every surface lists it: two names and its kind. */
export interface OrganizationSummary {
  readonly id: string;
  readonly name: string;
  /** The public handle. Renameable, so never a foreign key. */
  readonly slug: string;
  /**
   * `personal` or `team`. Carried so a surface can present someone's own
   * account differently — first in the switcher, no members page. No store
   * method branches on it; authorization is the membership, whatever the
   * kind.
   */
  readonly kind: OrganizationKind;
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
   * Creates the user's personal organization and their `owner` membership of
   * it, or returns the existing one.
   *
   * The one write in this store the plugin does not own, and deliberately so:
   * the plugin's create endpoint is a user action, whereas this runs from the
   * signup hook so that no account can exist without a personal organization.
   * Everything ownable then takes a single non-null `organization_id`, whether
   * it belongs to a person or to a team.
   *
   * `preferredSlug` is the user's own handle. A team may already hold it —
   * both draw from one namespace — so a taken handle gets a numeric suffix,
   * matching what migration 0015 does for users who predate this hook.
   */
  createPersonal(input: {
    userId: string;
    name: string;
    preferredSlug: string;
  }): Promise<OrganizationSummary>;
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

/**
 * Narrows the `kind` column, which Postgres stores as `text`.
 *
 * One place rather than a cast at each call site: an unrecognised value reads
 * as `team`, so a row written by hand cannot make a surface treat a team as
 * somebody's personal account.
 */
function toSummary(row: {
  id: string;
  name: string;
  slug: string;
  kind: string;
}): OrganizationSummary {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    kind: row.kind === "personal" ? "personal" : "team",
  };
}

export function createOrganizationStore(db: Database): OrganizationStore {
  return {
    async listForUser(userId) {
      const rows = await db
        .select({
          id: organization.id,
          name: organization.name,
          slug: organization.slug,
          kind: organization.kind,
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
        .map(({ role, ...row }) => ({ ...toSummary(row), role }));
    },

    async createPersonal({ userId, name, preferredSlug }) {
      // Already has one: the hook can run again for the same user (a retried
      // signup), and two would break the unique constraint rather than being
      // caught here.
      const [existing] = await db
        .select({
          id: organization.id,
          name: organization.name,
          slug: organization.slug,
          kind: organization.kind,
        })
        .from(organization)
        .where(eq(organization.personalUserId, userId))
        .limit(1);
      if (existing !== undefined) {
        return toSummary(existing);
      }

      const slug = await freeSlug(db, preferredSlug);
      const id = generateId("org");
      const [created] = await db
        .insert(organization)
        .values({
          id,
          name,
          slug,
          kind: "personal",
          personalUserId: userId,
        })
        .returning({
          id: organization.id,
          name: organization.name,
          slug: organization.slug,
          kind: organization.kind,
        });
      if (created === undefined) {
        throw new Error("Failed to create the personal organization.");
      }

      // Sole member, as owner. Separate insert rather than a transaction
      // because the adapter hands this store a plain connection; a personal
      // organization with no membership would be invisible to `listForUser`,
      // so the membership is written immediately after and is idempotent.
      await db
        .insert(member)
        .values({
          id: generateId("mbr"),
          organizationId: id,
          userId,
          role: "owner",
        })
        .onConflictDoNothing();

      return toSummary(created);
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
          kind: organization.kind,
        })
        .from(organization)
        .where(eq(organization.id, organizationId))
        .limit(1);
      return row === undefined ? undefined : toSummary(row);
    },

    async findBySlug(slug) {
      const [row] = await db
        .select({
          id: organization.id,
          name: organization.name,
          slug: organization.slug,
          kind: organization.kind,
        })
        .from(organization)
        .where(eq(organization.slug, slug.trim().toLowerCase()))
        .limit(1);
      return row === undefined ? undefined : toSummary(row);
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
          kind: organization.kind,
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
            organization: toSummary({
              id: row.organizationId,
              name: row.name,
              slug: row.slug,
              kind: row.kind,
            }),
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

/**
 * The first free handle: `preferred`, then `preferred-2`, `-3` and so on.
 *
 * A loop of point lookups rather than one clever query, because it runs once
 * per signup and the first candidate is almost always free. The bound stops a
 * pathological case from looping forever; reaching it means that many
 * organizations already hold the same stem, and failing loudly is better than
 * spinning.
 */
async function freeSlug(db: Database, preferred: string): Promise<string> {
  const stem = preferred.trim().toLowerCase();
  for (let suffix = 1; suffix <= 1000; suffix += 1) {
    const candidate = suffix === 1 ? stem : `${stem}-${suffix}`;
    const [taken] = await db
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.slug, candidate))
      .limit(1);
    if (taken === undefined) {
      return candidate;
    }
  }
  throw new Error(`No handle available for "${stem}".`);
}
