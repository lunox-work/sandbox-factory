/**
 * The proven-email store. A `user_email` row exists because a linked provider
 * reported the address; linking is the verification, so there is no token,
 * expiry or mail. Also holds the username (profile) store.
 */

import { and, eq, ne } from "drizzle-orm";

import { user, userEmail } from "./schema.js";
import type { Database } from "./store.js";

export interface ProvenEmail {
  readonly id: string;
  readonly email: string;
  /** Every provider that has vouched for this address; often more than one. */
  readonly providers: readonly string[];
  readonly isPrimary: boolean;
}

export interface EmailStore {
  /** The user's primary address, or undefined if there is no such user. */
  primaryFor(userId: string): Promise<string | undefined>;
  /** Every address this person has proven, oldest first. */
  list(userId: string): Promise<ProvenEmail[]>;
  /**
   * Records an address proven by a provider link. Idempotent: a repeat
   * sign-in, or a second provider proving the same address, neither fails nor
   * duplicates. Returns null when the address belongs to a different user;
   * the caller decides whether to surface that.
   */
  record(input: {
    userId: string;
    email: string;
    providerId: string;
  }): Promise<ProvenEmail | null>;
  /**
   * Promotes an address to primary and mirrors it onto `user.email`, in one
   * transaction so the two cannot disagree. Returns undefined when the address
   * is not this user's or another account holds it.
   */
  setPrimary(userId: string, emailId: string): Promise<ProvenEmail | undefined>;
  /**
   * Withdraws a provider's proof when its account is unlinked. An address
   * proved only by that provider is deleted; one another provider also proved
   * stays, minus the claim. A primary that loses its last proof hands the role
   * to a still-proven address, or is kept with no providers if there is none,
   * because `user.email` is `not null`.
   */
  revokeProvider(userId: string, providerId: string): Promise<void>;
  /**
   * Forgets an address. Refuses the primary, since `user.email` is `not null`;
   * promote another address first.
   */
  remove(
    userId: string,
    emailId: string,
  ): Promise<"removed" | "not-found" | "is-primary">;
  /**
   * The id of the user who holds an address, or undefined. For the sign-in
   * pre-flight, which must know about a collision before the user row is
   * written; `record` only answers afterwards. Checks both `user_email` and
   * `user.email`.
   */
  ownerOf(email: string): Promise<string | undefined>;
}

export function createEmailStore(db: Database): EmailStore {
  return {
    async ownerOf(email) {
      const normalized = email.trim().toLowerCase();
      const [claimed] = await db
        .select({ userId: userEmail.userId })
        .from(userEmail)
        .where(eq(userEmail.email, normalized))
        .limit(1);
      if (claimed !== undefined) {
        return claimed.userId;
      }
      const [primary] = await db
        .select({ id: user.id })
        .from(user)
        .where(eq(user.email, normalized))
        .limit(1);
      return primary?.id;
    },

    async primaryFor(userId) {
      const [row] = await db
        .select({ email: user.email })
        .from(user)
        .where(eq(user.id, userId))
        .limit(1);
      return row?.email;
    },

    async list(userId) {
      const rows = await db
        .select()
        .from(userEmail)
        .where(eq(userEmail.userId, userId));
      // Oldest first, not primary first: promoting an address changes its
      // badge without reordering the list.
      return rows
        .slice()
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map(toProvenEmail);
    },

    // In a transaction because every branch is a check then a write. The
    // database also enforces single ownership (see `userEmail.email` in
    // schema.ts), but as a thrown violation rather than the promised `null`.
    async record({ userId, email, providerId }) {
      const normalized = email.trim().toLowerCase();

      return db.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(userEmail)
          .where(eq(userEmail.email, normalized));

        // Another account may carry the address as its `user.email` without a
        // row here.
        const [otherOwner] = await tx
          .select({ id: user.id })
          .from(user)
          .where(eq(user.email, normalized))
          .limit(1);
        if (otherOwner !== undefined && otherOwner.id !== userId) {
          return null;
        }

        if (existing !== undefined) {
          // Someone else's: never move an address between accounts.
          if (existing.userId !== userId) {
            return null;
          }
          // Ours. Add the provider if it is a new one.
          const providers = splitProviders(existing.providerId);
          if (providers.includes(providerId)) {
            return toProvenEmail(existing);
          }
          const merged = [...providers, providerId];
          await tx
            .update(userEmail)
            .set({ providerId: merged.join(",") })
            .where(eq(userEmail.id, existing.id));
          return toProvenEmail({ ...existing, providerId: merged.join(",") });
        }

        // The first proven address becomes primary, so `user.email` is always
        // backed by a row here.
        const [current] = await tx
          .select({ id: userEmail.id })
          .from(userEmail)
          .where(eq(userEmail.userId, userId))
          .limit(1);

        const [inserted] = await tx
          .insert(userEmail)
          .values({
            id: newEmailId(),
            userId,
            email: normalized,
            providerId,
            isPrimary: current === undefined,
          })
          .returning();

        return inserted === undefined ? null : toProvenEmail(inserted);
      });
    },

    async setPrimary(userId, emailId) {
      const [target] = await db
        .select()
        .from(userEmail)
        .where(and(eq(userEmail.id, emailId), eq(userEmail.userId, userId)));
      if (target === undefined) {
        return undefined;
      }

      // Refuse rather than let the `user.email` write throw a 500 when
      // another account holds the address.
      const [otherOwner] = await db
        .select({ id: user.id })
        .from(user)
        .where(eq(user.email, target.email))
        .limit(1);
      if (otherOwner !== undefined && otherOwner.id !== userId) {
        return undefined;
      }

      await db.transaction(async (tx) => {
        await tx
          .update(userEmail)
          .set({ isPrimary: false })
          .where(and(eq(userEmail.userId, userId), ne(userEmail.id, emailId)));
        await tx
          .update(userEmail)
          .set({ isPrimary: true })
          .where(eq(userEmail.id, emailId));
        // Mirror onto the column Better Auth reads.
        await tx
          .update(user)
          .set({ email: target.email, updatedAt: new Date() })
          .where(eq(user.id, userId));
      });

      return { ...toProvenEmail(target), isPrimary: true };
    },

    async revokeProvider(userId, providerId) {
      const rows = await db
        .select()
        .from(userEmail)
        .where(eq(userEmail.userId, userId));

      for (const row of rows) {
        const remaining = splitProviders(row.providerId).filter(
          (entry) => entry !== providerId,
        );
        if (remaining.length === splitProviders(row.providerId).length) {
          continue;
        }
        if (remaining.length > 0) {
          await db
            .update(userEmail)
            .set({ providerId: remaining.join(",") })
            .where(eq(userEmail.id, row.id));
          continue;
        }
        // No proof left: release the address rather than keep it reserved.
        if (!row.isPrimary) {
          await db.delete(userEmail).where(eq(userEmail.id, row.id));
          continue;
        }

        // Primary: `user.email` is not nullable, so hand the role to an
        // address still proved by another provider, then release this one.
        const successor = rows.find(
          (candidate) =>
            candidate.id !== row.id &&
            splitProviders(candidate.providerId).some(
              (entry) => entry !== providerId,
            ),
        );
        if (successor === undefined) {
          // Nothing to promote, so keep the row with no providers. Unreachable
          // in practice: the API refuses to unlink a last provider.
          await db
            .update(userEmail)
            .set({ providerId: "" })
            .where(eq(userEmail.id, row.id));
          continue;
        }

        await db.transaction(async (tx) => {
          await tx
            .update(userEmail)
            .set({ isPrimary: false })
            .where(eq(userEmail.id, row.id));
          await tx
            .update(userEmail)
            .set({ isPrimary: true })
            .where(eq(userEmail.id, successor.id));
          await tx
            .update(user)
            .set({ email: successor.email, updatedAt: new Date() })
            .where(eq(user.id, userId));
          await tx.delete(userEmail).where(eq(userEmail.id, row.id));
        });
      }
    },

    async remove(userId, emailId) {
      const [target] = await db
        .select()
        .from(userEmail)
        .where(and(eq(userEmail.id, emailId), eq(userEmail.userId, userId)));
      if (target === undefined) {
        return "not-found";
      }
      if (target.isPrimary) {
        return "is-primary";
      }
      await db.delete(userEmail).where(eq(userEmail.id, emailId));
      return "removed";
    },
  };
}

/** Generated here, not by the database, as `todos` ids are. */
function newEmailId(): string {
  return `email_${crypto.randomUUID()}`;
}

function splitProviders(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

function toProvenEmail(row: {
  id: string;
  email: string;
  providerId: string;
  isPrimary: boolean;
}): ProvenEmail {
  return {
    id: row.id,
    email: row.email,
    providers: splitProviders(row.providerId),
    isPrimary: row.isPrimary,
  };
}

/**
 * Username rules. Deliberately narrow (lowercase letters, digits, hyphen,
 * underscore) so a handle works in a URL, mention or slug without escaping.
 */
export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 30;
const USERNAME_PATTERN = /^[a-z0-9_-]+$/;

export type UsernameResult =
  | { status: "ok"; username: string; displayUsername: string }
  | { status: "invalid"; reason: string }
  | { status: "taken" };

export interface UserProfileStore {
  /** The handle. The column is `not null`, so undefined means no such user. */
  get(userId: string): Promise<{ username: string } | undefined>;
  /**
   * A free handle derived from an email address, for a new account.
   * Collisions append a counter: `dana`, `dana2`, `dana3`.
   */
  suggest(email: string): Promise<string>;
  /**
   * Claims or changes a handle. Stored lowercase and unique;
   * `displayUsername` keeps the casing the person typed.
   */
  setUsername(userId: string, raw: string): Promise<UsernameResult>;
}

export function createProfileStore(db: Database): UserProfileStore {
  async function isTaken(candidate: string): Promise<boolean> {
    const [row] = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.username, candidate))
      .limit(1);
    return row !== undefined;
  }

  return {
    async suggest(email) {
      const base = toHandleBase(email);
      if (!(await isTaken(base))) {
        return base;
      }
      // Bounded: past a popular name a random suffix terminates sooner than
      // counting, and the person can rename anyway.
      for (let suffix = 2; suffix <= 20; suffix += 1) {
        const candidate = `${base}${suffix}`.slice(0, USERNAME_MAX_LENGTH);
        if (!(await isTaken(candidate))) {
          return candidate;
        }
      }
      return `${base.slice(0, USERNAME_MAX_LENGTH - 7)}-${crypto
        .randomUUID()
        .slice(0, 6)}`;
    },

    async get(userId) {
      const [row] = await db
        .select({ username: user.username })
        .from(user)
        .where(eq(user.id, userId))
        .limit(1);
      return row;
    },

    async setUsername(userId, raw) {
      const displayUsername = raw.trim();
      const username = displayUsername.toLowerCase();

      if (
        username.length < USERNAME_MIN_LENGTH ||
        username.length > USERNAME_MAX_LENGTH
      ) {
        return {
          status: "invalid",
          reason: `Username must be between ${USERNAME_MIN_LENGTH} and ${USERNAME_MAX_LENGTH} characters.`,
        };
      }
      if (!USERNAME_PATTERN.test(username)) {
        return {
          status: "invalid",
          reason:
            "Username can use letters, numbers, hyphens and underscores only.",
        };
      }

      const [existing] = await db
        .select({ id: user.id })
        .from(user)
        .where(eq(user.username, username))
        .limit(1);
      // Re-claiming your own handle in different casing is a rename.
      if (existing !== undefined && existing.id !== userId) {
        return { status: "taken" };
      }

      await db
        .update(user)
        .set({ username, displayUsername, updatedAt: new Date() })
        .where(eq(user.id, userId));

      return { status: "ok", username, displayUsername };
    },
  };
}

/**
 * Strips leading and trailing hyphens in linear time. Do not simplify to
 * `replace(/^-+|-+$/g, "")`: that is quadratic on a long run of hyphens, and
 * the input is a provider-supplied local part that is truncated only after
 * this runs.
 */
function trimHyphens(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === "-") {
    start += 1;
  }
  while (end > start && value[end - 1] === "-") {
    end -= 1;
  }
  return value.slice(start, end);
}

/**
 * Turns an email address into a handle stem. Uses only the local part, and
 * replaces disallowed characters with hyphens so the result is always valid.
 */
function toHandleBase(email: string): string {
  const local = email.split("@")[0] ?? "user";
  const cleaned = trimHyphens(
    local.toLowerCase().replace(/[^a-z0-9_-]+/g, "-"),
  ).slice(0, USERNAME_MAX_LENGTH);
  // Pad a too-short stem: "jo@example.com" must still produce a valid handle.
  return cleaned.length >= USERNAME_MIN_LENGTH ? cleaned : `${cleaned}-user`;
}
