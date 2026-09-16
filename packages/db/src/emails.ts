/**
 * The proven-email store.
 *
 * Every row in `user_email` exists because a provider told us this person's
 * account carries that address. There is no token and no expiry here because
 * there is no mail to send: linking a Google or GitHub account *is* the
 * verification, so the proof is the row in `account` that the cascade ties
 * this to.
 *
 * Kept out of `store.ts` because that file is the todo store and this is not
 * about todos; both are Postgres-backed but they answer to different callers.
 */

import { and, eq, ne } from "drizzle-orm";

import { user, userEmail } from "./schema.js";
import type { Database } from "./store.js";

export interface ProvenEmail {
  readonly id: string;
  readonly email: string;
  /**
   * Every provider that has vouched for this address.
   *
   * Usually one, but the same inbox is often registered at both Google and
   * GitHub — in which case both prove it and both should say so.
   */
  readonly providers: readonly string[];
  readonly isPrimary: boolean;
}

export interface EmailStore {
  /** The user's current primary address, or undefined if there is no such user. */
  primaryFor(userId: string): Promise<string | undefined>;
  /** Every address this person has proven, primary first. */
  list(userId: string): Promise<ProvenEmail[]>;
  /**
   * Records an address proven by a provider link.
   *
   * Idempotent: signing in again with the same provider re-runs this, and a
   * person may legitimately hold one address across two providers. Neither
   * should fail or duplicate.
   *
   * Returns null when the address already belongs to a *different* user —
   * the caller decides whether that is an error worth surfacing, because the
   * honest reading is "someone else already proved this inbox".
   */
  record(input: {
    userId: string;
    email: string;
    providerId: string;
  }): Promise<ProvenEmail | null>;
  /**
   * Promotes an address to primary, and mirrors it onto `user.email`.
   *
   * Both writes happen in one transaction: a `user.email` that disagrees with
   * the `is_primary` row is the kind of split-brain that only shows up later,
   * in whichever of the two some other query happened to read.
   */
  setPrimary(userId: string, emailId: string): Promise<ProvenEmail | undefined>;
  /**
   * Withdraws a provider's proof of every address it vouched for.
   *
   * Called when an account is unlinked. An address proved *only* by that
   * provider has lost its proof entirely and the row goes; one that another
   * linked provider also proved stays, minus the withdrawn claim.
   *
   * The primary address is kept even when its last proof is gone: `user.email`
   * is `not null` and points at it, so deleting it would leave the account
   * with no address at all. It simply stops claiming a provider vouches for
   * it.
   */
  revokeProvider(userId: string, providerId: string): Promise<void>;
  /**
   * Forgets an address.
   *
   * Refuses to remove the primary: the account would be left with no address
   * to contact, and `user.email` is `not null`. Callers should promote another
   * address first.
   */
  remove(
    userId: string,
    emailId: string,
  ): Promise<"removed" | "not-found" | "is-primary">;
  /**
   * The id of the user who currently holds an address, or undefined.
   *
   * Exists for the sign-in pre-flight, which has to answer "would creating a
   * user with this address collide?" *before* the row is written. `record`
   * answers the same question but only after the fact, which is one step too
   * late to stop a duplicate account being created.
   *
   * Checks both places an address can live. `user.email` and `user_email` are
   * each unique on their own, but neither constraint sees the other, so an
   * address free in one can still be taken in the other.
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
      // Oldest first, and *not* primary-first: promoting an address should
      // change its badge, not make the list jump around under the cursor.
      // `created_at` is stable, so the order a person learns stays the order
      // they see.
      return rows
        .slice()
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map(toProvenEmail);
    },

    /**
     * In a transaction because every branch below is a check followed by a
     * write, and the check is only worth anything if nothing can slip between
     * the two. Two providers proving the same address concurrently — the same
     * person completing a Google and a GitHub sign-in at once, or two people
     * racing for one inbox — otherwise both read "free" and both proceed. The
     * unique constraint on `email` catches the duplicate insert, but as a
     * thrown constraint violation the caller has to swallow rather than the
     * `null` this contract promises, and the `user.email` check has no
     * constraint behind it at all.
     */
    async record({ userId, email, providerId }) {
      const normalized = email.trim().toLowerCase();

      return db.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(userEmail)
          .where(eq(userEmail.email, normalized));

        // `user.email` is a second place an address can live, and it is not
        // covered by the unique constraint on this table. Without this check a
        // provider could prove an address that another account already carries
        // as its primary — which later blows up as a 500 the moment anything
        // tries to write that address onto `user.email`.
        const [otherOwner] = await tx
          .select({ id: user.id })
          .from(user)
          .where(eq(user.email, normalized))
          .limit(1);
        if (otherOwner !== undefined && otherOwner.id !== userId) {
          return null;
        }

        if (existing !== undefined) {
          // Already someone else's: say so rather than silently moving an
          // address between accounts.
          if (existing.userId !== userId) {
            return null;
          }
          // Already ours. If a *different* provider has now proved the same
          // address — the common case of one inbox registered at both Google
          // and GitHub — add it rather than discarding the fact.
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

        // The first address a user proves becomes primary, because an account
        // with none would leave `user.email` unbacked by any row here.
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

      // Refuse rather than let the `user.email` write throw. A constraint
      // violation surfaces as a 500, which tells the person nothing; this
      // path is reachable whenever another account holds the address.
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
        // Mirror onto the column Better Auth itself reads.
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
        // No proof left, so the address is released — nobody can demonstrate
        // ownership of it any more and it must not stay reserved.
        if (!row.isPrimary) {
          await db.delete(userEmail).where(eq(userEmail.id, row.id));
          continue;
        }

        // It is the primary, and `user.email` points at it and is not
        // nullable. Hand that role to another address this user has *still*
        // proved, then release this one.
        const successor = rows.find(
          (candidate) =>
            candidate.id !== row.id &&
            splitProviders(candidate.providerId).some(
              (entry) => entry !== providerId,
            ),
        );
        if (successor === undefined) {
          // Nothing left to promote. Keeping the row is the least-bad option:
          // dropping it would violate `user.email`'s not-null reference, and
          // the account has no sign-in method left anyway. The API refuses to
          // unlink a last provider precisely so this is unreachable in
          // practice — see `remove` and the route that guards it.
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

/**
 * Ids are generated here rather than by the database, matching how `todos`
 * does it. The prefix is local because `generateId` in `mapping.ts` is the
 * todo generator and hardcodes its own — widening that to take a prefix would
 * mean touching todo code for no benefit to todos.
 */
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
 * Username rules.
 *
 * Deliberately narrow: lowercase letters, digits, hyphen and underscore. That
 * is the intersection of what GitHub, npm and most handles allow, which keeps
 * a handle usable in a URL, a mention and a slug without escaping.
 */
export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 30;
const USERNAME_PATTERN = /^[a-z0-9_-]+$/;

export type UsernameResult =
  | { status: "ok"; username: string; displayUsername: string }
  | { status: "invalid"; reason: string }
  | { status: "taken" };

export interface UserProfileStore {
  /**
   * The handle. Never null for an existing user — the column is `not null`
   * and one is generated at signup — so `undefined` means no such user.
   */
  get(userId: string): Promise<{ username: string } | undefined>;
  /**
   * A free handle derived from an email address, for a brand new account.
   *
   * Every account gets one at signup rather than being asked, so no part of
   * the app has to handle a user without a handle. Collisions are resolved by
   * appending a counter — `dana`, `dana2`, `dana3` — which is what
   * GitHub and Slack do and is more guessable for the person than a random
   * suffix.
   */
  suggest(email: string): Promise<string>;
  /**
   * Claims or changes a handle.
   *
   * Stored lowercase and unique so `@Alice` and `@alice` cannot both exist,
   * while `displayUsername` keeps the casing the person typed.
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
      // Bounded rather than unbounded: after a handful of collisions a random
      // suffix is likelier to terminate than counting upward past a popular
      // name, and the person can rename anyway.
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
      // Re-claiming your own handle with different casing is a rename, not a
      // collision.
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
 * Strips leading and trailing hyphens in linear time.
 *
 * The obvious `replace(/^-+|-+$/g, "")` is a polynomial ReDoS: on a local part
 * that is a long run of hyphens, the `-+$` alternative retries from every
 * offset before failing, which is quadratic in the length of the run. The
 * input here is the local part of a provider-supplied address, so it is not
 * ours to bound — and the truncation to `USERNAME_MAX_LENGTH` happens after
 * this runs, not before, so it does not cap the work either.
 *
 * Index arithmetic has no such failure mode and the behaviour is identical,
 * including returning "" for an all-hyphen string.
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
 * Turns an email address into a usable handle stem.
 *
 * Only the local part is used — the domain says where someone works, not who
 * they are — and anything outside the allowed character set becomes a hyphen
 * so the result is always valid by construction.
 */
function toHandleBase(email: string): string {
  const local = email.split("@")[0] ?? "user";
  const cleaned = trimHyphens(
    local.toLowerCase().replace(/[^a-z0-9_-]+/g, "-"),
  ).slice(0, USERNAME_MAX_LENGTH);
  // Pad a too-short stem rather than reject it: "jo@example.com" is a real
  // address and must still produce a valid handle.
  return cleaned.length >= USERNAME_MIN_LENGTH ? cleaned : `${cleaned}-user`;
}
