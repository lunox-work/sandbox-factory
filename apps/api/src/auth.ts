/**
 * Better Auth configuration, built by a factory so it is testable without a
 * database or `process.env`.
 *
 * Email and password sign-in is deliberately off: `emailAndPassword` is never
 * enabled, so its endpoints refuse every request (pinned in `auth.test.ts`).
 * Google, GitHub and Atlassian are the only ways in.
 */

import { defineRequestState } from "@better-auth/core/context";
import {
  authSchema,
  type EmailStore,
  type OrganizationStore,
} from "@sandbox-factory/db";
import { APIError, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer, organization } from "better-auth/plugins";
import { normalizeHandle } from "sandbox-factory";

import { admitsPicture, type AvatarKind } from "./avatars/keys.js";

/**
 * The address a provider asserted during this request, keyed by provider id.
 * Hands it from `validateUserInfo`, the only callback that sees the provider's
 * email, to the account-create hook, which knows the user id but not the email.
 *
 * Must stay request-scoped. A module-level `Map` is shared by every in-flight
 * sign-in, so two concurrent Google sign-ins overwrite each other, and keying
 * by user id is impossible because the user row does not exist yet. The slot
 * is defined once at module scope; its values are per request.
 */
const provenEmails = defineRequestState<Map<string, string>>(() => new Map());

/**
 * The per-request map, or `undefined` outside a request context, where
 * `provenEmails.get()` throws. Bookkeeping must not fail a sign-in that has
 * already succeeded, so callers fall back to `lookupEmail`.
 */
async function capturedEmails(): Promise<Map<string, string> | undefined> {
  try {
    return await provenEmails.get();
  } catch {
    return undefined;
  }
}

/** Whatever the Drizzle adapter accepts; this file is driver-agnostic. */
type AuthDatabase = Parameters<typeof drizzleAdapter>[0];

export interface AuthOptions {
  db: AuthDatabase;
  /** Records addresses proven by a provider link. Optional for tests. */
  emails?: EmailStore | undefined;
  /**
   * Reads a user's current primary email. The account-create hook's fallback:
   * the account row carries no email and the hook gets no OAuth profile.
   */
  lookupEmail?: ((userId: string) => Promise<string | undefined>) | undefined;
  /** Proposes a free handle for a new account. Optional for tests. */
  handles?: { suggest(email: string): Promise<string> } | undefined;
  /**
   * Organization reads, for the plugin hooks below. Optional for tests:
   * without it a handle is still validated and lowercased, only the
   * case-insensitive "already taken" check is skipped, which the database's
   * unique constraint then catches.
   */
  organizations?: OrganizationStore | undefined;
  /** Public origin of the API itself, e.g. `https://api.lunox.work`. */
  baseUrl: string;
  /**
   * Public origin of the web app, e.g. `https://app.lunox.work`. Failed
   * sign-ins are sent here; see `onAPIError` below.
   */
  appUrl: string;
  /** Origins allowed to complete a sign-in redirect. */
  trustedOrigins: readonly string[];
  /** Signing secret for session tokens. */
  secret: string;
  google: OAuthCredentials;
  github: OAuthCredentials;
  /** Trusted on a weaker basis than the other two; see `trustedProviders`. */
  atlassian: OAuthCredentials;
  /** Set when the API and web app are on different subdomains; see below. */
  crossSubDomainCookies?: { domain: string } | undefined;
}

export interface OAuthCredentials {
  clientId: string;
  clientSecret: string;
}

export type Auth = ReturnType<typeof createAuth>;

/**
 * Refuses a picture value a client may not write: anything but null or that
 * same owner's own avatar path. See `admitsPicture`.
 *
 * Both picture columns used to take any string — Better Auth's `update-user`
 * for `user.image`, the plugin for `organization.logo` — so one account could
 * aim everyone's browser at a URL of its choosing. With this in front of
 * both, what the columns hold is safe to render.
 */
function requireOwnPicture(
  value: unknown,
  owner: { kind: AvatarKind; id: string },
): void {
  if (!admitsPicture(value, owner)) {
    throw new APIError("BAD_REQUEST", {
      code: "INVALID_IMAGE",
      message: "Upload a picture instead of linking one.",
    });
  }
}

/**
 * The `update-user` picture guard, apart from the database hook that calls it
 * so it can be tested without a database behind a session.
 *
 * Runs on every user update Better Auth makes, so it looks only at updates
 * that carry `image` and come from the `update-user` endpoint — sign-in and
 * account linking have their own reasons to touch the row and are left alone.
 *
 * It runs inside the endpoint, after its session middleware, which is why it
 * is a database hook and not a request hook: a request hook runs before the
 * bearer plugin has turned an `Authorization` header into a session, and
 * would see none. For the same reason a missing session fails closed here —
 * only null gets through — rather than deferring to anything later.
 */
export function guardUserPicture(
  update: Record<string, unknown>,
  context: { path?: string | undefined; sessionUserId?: string | undefined },
): void {
  // `update-user` hands the adapter `{ name, image, ... }` whatever the client
  // sent, so an untouched picture arrives as a present key holding undefined.
  if (update["image"] === undefined || context.path !== "/update-user") {
    return;
  }
  requireOwnPicture(update["image"], {
    kind: "user",
    // No session: an id no avatar path can carry, so only null is admitted.
    id: context.sessionUserId ?? "",
  });
}

export function createAuth({
  db,
  emails,
  lookupEmail,
  handles,
  organizations,
  baseUrl,
  appUrl,
  trustedOrigins,
  secret,
  google,
  github,
  atlassian,
  crossSubDomainCookies,
}: AuthOptions) {
  // `parseEnv` has already validated `baseUrl` as an absolute URL.
  const isHttps = new URL(baseUrl).protocol === "https:";

  /**
   * The stored form of an organization handle, or an `APIError` naming the
   * reason. The one place the core handle rules become an HTTP response, so
   * create and rename cannot disagree about what a handle is.
   *
   * `exceptId` is the organization being renamed, which must not collide
   * with itself.
   */
  async function requireFreeHandle(
    raw: string | undefined,
    exceptId: string | undefined,
  ): Promise<string> {
    const normalized = normalizeHandle(raw ?? "");
    if (normalized.status === "invalid") {
      throw new APIError("BAD_REQUEST", {
        code: "INVALID_ORGANIZATION_SLUG",
        message: `Workspace handle: ${normalized.reason}`,
      });
    }
    if (organizations !== undefined) {
      const owner = await organizations.slugOwner(normalized.handle, exceptId);
      if (owner !== undefined) {
        throw new APIError("BAD_REQUEST", {
          code: "ORGANIZATION_SLUG_ALREADY_TAKEN",
          message: "That workspace handle is taken.",
        });
      }
    }
    return normalized.handle;
  }

  /**
   * Why a personal organization's handle cannot be edited, and where to go
   * instead. It is its owner's username and follows it (migration 0030), so
   * the one handle a person manages is on their account.
   */
  const HANDLE_IS_USERNAME =
    "A personal workspace's handle is your username. " +
    "Change your username in Account settings to change it.";

  /** The one message these refusals share, and the remedy with it. */
  const NOT_SHAREABLE =
    "A personal workspace cannot have other members. " +
    "Create a team workspace to share with someone.";

  /** Raised by the two guards below. */
  function personalRefusal(message: string): APIError {
    return new APIError("FORBIDDEN", {
      code: "PERSONAL_ORGANIZATION",
      message,
    });
  }

  /**
   * Whether an organization is somebody's personal one, read from the row the
   * hook was handed.
   *
   * The plugin types its own fields and widens the rest to `any`, so `kind`
   * arrives untyped and is compared as a string rather than asserted.
   */
  function isPersonal(candidate: Record<string, unknown> | null): boolean {
    return candidate?.["kind"] === "personal";
  }

  /**
   * The same question when only an id is in hand, which is the invitation
   * hook's case.
   *
   * A no-op without the store, like the handle checks above: tests construct
   * an auth with no organization store, and failing closed instead would
   * refuse every organization write in them.
   */
  async function refusePersonalById(
    organizationId: string,
    message: string,
  ): Promise<void> {
    if (organizations === undefined) {
      return;
    }
    const found = await organizations.get(organizationId);
    if (found?.kind === "personal") {
      throw personalRefusal(message);
    }
  }

  /** Why a personal organization has no picture of its own. */
  const PICTURE_IS_OWNERS =
    "A personal workspace wears your picture. " +
    "Change it in Account settings.";

  return betterAuth({
    database: drizzleAdapter(db, {
      provider: "pg",
      // The auth models only; the adapter has no business with this
      // product's own tables.
      schema: authSchema,
    }),
    baseURL: baseUrl,
    secret,
    /**
     * Send failed sign-ins to the web app. Better Auth's own error page is
     * served from the API origin, and its "Go Home" link strands the user
     * there. `SignIn.tsx` reads the appended `error` and `error_description`.
     */
    onAPIError: { errorURL: appUrl },
    // After a provider callback Better Auth redirects only to these, which
    // stops `?callbackURL=https://evil.example` from receiving the session.
    trustedOrigins: [...trustedOrigins],
    socialProviders: {
      google: {
        clientId: google.clientId,
        clientSecret: google.clientSecret,
      },
      github: {
        clientId: github.clientId,
        clientSecret: github.clientSecret,
      },
      atlassian: {
        clientId: atlassian.clientId,
        clientSecret: atlassian.clientSecret,
        /**
         * Sign-in asks for identity only. The provider appends `scope` to its
         * defaults (`read:jira-user`, `offline_access`), so
         * `disableDefaultScope` is the only way to drop `read:jira-user`: it
         * reads a whole Jira site's directory and drags site selection into
         * the consent screen. Request Jira data separately, not on the login
         * grant.
         *
         * `read:me` is required: without it `/me` returns no email and Better
         * Auth refuses the sign-in.
         */
        disableDefaultScope: true,
        scope: ["read:me", "offline_access"],
        /**
         * Asserts that the address `/me` returned is verified. The provider
         * hardcodes `emailVerified: false`, and both the sign-in callback and
         * the link route gate on
         * `!trustedProviders.includes(id) && !emailVerified`.
         *
         * Atlassian sends no `email_verified` claim, so this asserts what the
         * provider does not state. The basis: `read:me` returns the account's
         * own address, which Atlassian confirms before the account is usable.
         * Weaker than Google's explicit claim; see `trustedProviders`.
         */
        mapProfileToUser: () => ({ emailVerified: true }),
      },
    },
    user: {
      /**
       * Registers our columns with Better Auth. Without this the adapter
       * silently drops them and `username` stays null, with no error.
       * `input: true` lets the create hook supply a value; they are never
       * user-submitted here (`/api/v1/me/username` validates changes).
       */
      additionalFields: {
        username: { type: "string", required: false, input: true },
        displayUsername: { type: "string", required: false, input: true },
      },
      /**
       * Captures the address a provider asserts, for the account-create hook.
       * Runs for both `create-user` and `link-account`. Never rejects, hence
       * the bare return.
       */
      validateUserInfo: async ({ user: incoming, source }) => {
        const providerId = source.oauth?.providerId;
        if (providerId !== undefined && typeof incoming.email === "string") {
          // Keyed by provider so a create-user and a link-account pass in one
          // request cannot overwrite each other.
          (await capturedEmails())?.set(
            providerId,
            incoming.email.toLowerCase(),
          );
        }
        return;
      },
    },
    session: {
      // Most requests answer from a signed cookie instead of a SELECT on
      // `session`. Revocation lags by up to this window, so keep it small.
      cookieCache: { enabled: true, maxAge: 5 * 60 },
    },

    account: {
      accountLinking: {
        enabled: true,
        /**
         * Implicit linking is deliberately on: signing in with a provider
         * whose verified email already belongs to an account merges into it,
         * so one person with Google and GitHub on one inbox gets one account.
         *
         * Only `trustedProviders` makes this safe. The accepted risk: whoever
         * can hold an address at a trusted provider reaches the account using
         * it.
         */
        disableImplicitLinking: false,
        /**
         * The providers allowed to merge into an existing account on sign-in.
         * **Adding to this list is a security decision**: a provider belongs
         * here only if it verifies address ownership before reporting it.
         *
         * Google and GitHub send an explicit `email_verified` claim. Atlassian
         * does not; `mapProfileToUser` above asserts it, a deliberate and
         * weaker basis. Leaving Atlassian off is not an option: the same guard
         * gates the link route, so it could not be connected at all. If
         * Atlassian ever stops confirming addresses, remove this entry.
         *
         * `auth.test.ts` pins this list.
         */
        trustedProviders: ["google", "github", "atlassian"],
        /**
         * Refuses a merge into a local account whose address was never
         * verified, so a pre-registered unverified account cannot capture an
         * OAuth identity. Better Auth's default, stated so it stays put.
         */
        requireLocalEmailVerified: true,
        /**
         * Lets a signed-in user link a provider with a different email, which
         * is how "add an email" proves an address. Better Auth warns about
         * takeover, but the caller is already authenticated: linking adds an
         * address to an account they hold, not access to one they do not.
         */
        allowDifferentEmails: true,
        /** A newly linked provider must not overwrite the display name. */
        updateUserInfoOnLink: false,
      },
    },
    advanced: {
      // Only for the split-subdomain deploy; see AUTH_COOKIE_DOMAIN in env.ts.
      ...(crossSubDomainCookies === undefined
        ? {}
        : {
            crossSubDomainCookies: {
              enabled: true,
              domain: crossSubDomainCookies.domain,
            },
          }),
      /**
       * Derived from the URL scheme, not `NODE_ENV`, so an https deploy gets
       * `Secure` cookies even if `NODE_ENV=production` is forgotten, and http
       * localhost does not, where `Secure` would break the cookie.
       */
      useSecureCookies: isHttps,
      defaultCookieAttributes: {
        /**
         * Must stay `Lax`: `Strict` breaks OAuth sign-in in every deploy
         * shape, localhost included. These attributes land on every auth
         * cookie, including the `state` cookie of an in-progress sign-in. The
         * provider returns by a cross-site navigation, on which a `Strict`
         * cookie is withheld, so the callback ends in `state_mismatch`.
         *
         * `Lax` is upstream's default, stated so it stays put. CSRF on
         * state-changing requests is covered by the origin check.
         */
        sameSite: "lax",
        // Keeps the session out of reach of page scripts, which is why the
        // web client sends no bearer token.
        httpOnly: true,
        path: "/",
      },
    },
    databaseHooks: {
      user: {
        /**
         * `update-user` accepts any `image` string from the client. Only null
         * or the caller's own avatar path gets through; the upload route
         * writes through this same endpoint and passes because its value is
         * exactly that. See `guardUserPicture`.
         */
        update: {
          before: async (update, context) => {
            guardUserPicture(update, {
              path: context?.path,
              sessionUserId: (
                context?.context as { session?: { user?: { id?: string } } }
              )?.session?.user?.id,
            });
          },
        },
        create: {
          /**
           * Gives every new account a handle, derived from its email and made
           * unique by the store, so nothing has to cope with a null handle.
           */
          before: async (createdUser) => {
            /**
             * Refuse a signup whose address someone else already holds.
             * Otherwise a refused merge falls through to creating a duplicate
             * user with no recordable address. The database trigger from
             * migration 0007 is the second layer.
             *
             * `ownerOf` checks both `user.email` and `user_email.email`, whose
             * unique constraints do not see each other. Throw an `APIError`,
             * not `false`: a bare `false` aborts with no error code.
             */
            if (emails !== undefined) {
              const owner = await emails.ownerOf(createdUser.email);
              if (owner !== undefined) {
                throw new APIError("UNPROCESSABLE_ENTITY", {
                  code: "EMAIL_ALREADY_HELD",
                  message:
                    "That email address already belongs to another account. " +
                    "Sign in with a provider you have already connected, then " +
                    "connect this one from your account page.",
                });
              }
            }
            if (handles === undefined) {
              return;
            }
            const username = await handles.suggest(createdUser.email);
            return {
              data: {
                ...createdUser,
                username,
                displayUsername: username,
              },
            };
          },
          /**
           * Gives every new account its personal organization.
           *
           * This is what lets everything ownable take a single non-null
           * `organization_id` rather than a nullable user/organization pair:
           * "my own account" is a real organization row with one `owner`
           * member. Users who predate this hook were given theirs by
           * migration 0015.
           *
           * `after`, not `before`: the membership references `user.id`, which
           * does not exist until the row is written.
           *
           * A failure here is logged rather than thrown. Throwing would abort
           * a signup whose user row is already committed, leaving an account
           * that cannot be created again because its address is taken;
           * `createPersonal` is idempotent, so the next sign-in repairs it.
           */
          after: async (createdUser) => {
            if (organizations === undefined) {
              return;
            }
            try {
              // Its handle is the username `before` just assigned, which the
              // store reads back rather than taking from here: the database
              // accepts nothing else for a personal organization.
              await organizations.createPersonal({
                userId: createdUser.id,
                // Their own name, which is what the switcher shows for it.
                name: createdUser.name,
              });
            } catch (error) {
              console.error(
                "Failed to create the personal organization",
                error,
              );
            }
          },
        },
      },
      account: {
        create: {
          /**
           * Records the address the provider just proved, as captured by
           * `validateUserInfo`. Do not read `user.email` instead: on a second
           * link that is the first provider's address.
           */
          after: async (createdAccount) => {
            if (emails === undefined) {
              return;
            }
            const captured = await capturedEmails();
            const proven =
              captured?.get(createdAccount.providerId) ??
              (lookupEmail === undefined
                ? undefined
                : await lookupEmail(createdAccount.userId));
            captured?.delete(createdAccount.providerId);
            if (proven === undefined) {
              return;
            }
            try {
              const recorded = await emails.record({
                userId: createdAccount.userId,
                email: proven,
                providerId: createdAccount.providerId,
              });
              if (recorded === null) {
                // `record` returns null, without throwing, when someone else
                // holds the address. The sign-in succeeded but the user is
                // missing an address they expect, so say so.
                console.warn(
                  "Proven email not recorded: already held by another account",
                  {
                    userId: createdAccount.userId,
                    providerId: createdAccount.providerId,
                  },
                );
              }
            } catch (error) {
              // Bookkeeping must not break a sign-in that already succeeded.
              console.error("Failed to record proven email", error);
            }
          },
        },
        delete: {
          /**
           * Withdraw the proof when a provider is unlinked, so the settings
           * page stops showing a provider that no longer vouches for it.
           */
          after: async (deletedAccount) => {
            if (emails === undefined) {
              return;
            }
            try {
              await emails.revokeProvider(
                deletedAccount.userId,
                deletedAccount.providerId,
              );
            } catch (error) {
              console.error("Failed to revoke proven email", error);
            }
          },
        },
      },
    },
    plugins: [
      // Accepts `Authorization: Bearer <token>` in place of the cookie, for
      // the VS Code extension, which has no cookie jar.
      bearer(),
      /**
       * Organizations: the second principal. The plugin owns every write to
       * `organization`, `member` and `invitation`, and serves them under
       * `/api/auth/organization/*`; `OrganizationStore` covers the reads it
       * does not offer.
       */
      organization({
        /** Stated rather than left to the default, since the tests pin it. */
        creatorRole: "owner",
        /**
         * Anyone signed in may create an organization.
         *
         * This is Better Auth's default, stated so it is a decision rather
         * than an omission: onboarding is self-serve, and a client who signs
         * up makes their own workspace without anyone provisioning it. The
         * cap below is what bounds the cost of that.
         *
         * Gating it later — to an allowlist, a plan, or an invitation — means
         * replacing this with a function of the user; the web app's create
         * action should then be hidden in the same change, or it offers
         * something the server refuses.
         */
        allowUserToCreateOrganization: true,
        /**
         * Counts the user's memberships, not what they created, which is the
         * intent: twenty workspaces is already well past normal use, and the
         * cap exists to bound an automated signup rather than to price a
         * plan.
         */
        organizationLimit: 20,
        organizationHooks: {
          /**
           * A handle is validated and lowercased before it is stored, because
           * the plugin accepts any non-empty string. Without this, `MyOrg`
           * and `myorg` would be two organizations, and `Acme Corp` would be
           * a handle no URL could carry.
           */
          beforeCreateOrganization: async ({ organization: incoming }) => {
            // A new organization has no id yet, so no avatar path can be its
            // own: a picture comes after, through the upload route.
            if (incoming.logo !== undefined && incoming.logo !== null) {
              requireOwnPicture(incoming.logo, {
                kind: "organization",
                id: "",
              });
            }
            const slug = await requireFreeHandle(incoming.slug, undefined);
            return { data: { ...incoming, slug } };
          },
          /**
           * The same rules on rename.
           *
           * The taken check is repeated here rather than left to the plugin,
           * which runs its own on the **raw** body before this hook
           * lowercases it: `MyOrg` while `myorg` exists passes the plugin's
           * byte-exact lookup and would then fail on the unique constraint as
           * a 500. Excluding the organization's own id keeps re-saving your
           * handle in another casing a rename, as `setUsername` does.
           */
          beforeUpdateOrganization: async ({
            organization: incoming,
            member,
          }) => {
            /*
             * The picture: null, or this organization's own avatar path, and
             * never a picture at all on a personal one, which wears its
             * owner's. The upload route writes through the store instead, so
             * this binds clients only.
             */
            if (incoming.logo !== undefined) {
              requireOwnPicture(incoming.logo, {
                kind: "organization",
                id: member.organizationId,
              });
              if (incoming.logo !== null) {
                await refusePersonalById(
                  member.organizationId,
                  PICTURE_IS_OWNERS,
                );
              }
            }
            if (incoming.slug === undefined) {
              return;
            }
            // Refused here with the remedy, rather than left to the database
            // trigger, which would refuse it too but as a 500.
            await refusePersonalById(member.organizationId, HANDLE_IS_USERNAME);
            const slug = await requireFreeHandle(
              incoming.slug,
              member.organizationId,
            );
            return { data: { ...incoming, slug } };
          },
          /**
           * `updatedAt` is ours: 1.7.5 declares one only for the plugin's
           * team and role tables, so without this a renamed organization
           * would report its creation time forever.
           */
          afterUpdateOrganization: async ({ organization: updated }) => {
            if (organizations === undefined || updated === null) {
              return;
            }
            try {
              await organizations.touch(updated.id);
            } catch (error) {
              // Bookkeeping must not fail a rename that already succeeded.
              console.error("Failed to stamp organization updatedAt", error);
            }
          },
          /**
           * Addresses are stored lowercase, as `user_email` does. The plugin
           * compares case-insensitively on accept, so this only keeps the
           * stored data consistent with the rest of the schema.
           */
          beforeCreateInvitation: async ({ invitation: incoming }) => {
            // Only an id here, so this one asks the store.
            await refusePersonalById(incoming.organizationId, NOT_SHAREABLE);
            return {
              data: {
                ...incoming,
                email: incoming.email.trim().toLowerCase(),
              },
            };
          },
          /**
           * A personal organization is not the user's to delete: it is minted
           * at signup and every account is expected to have one, so removing
           * it would leave them owning nothing with no way to get it back. It
           * goes when the user does, by the cascade on `personal_user_id`.
           */
          beforeDeleteOrganization: async ({ organization: target }) => {
            if (isPersonal(target)) {
              throw personalRefusal(
                "Your personal workspace cannot be deleted. " +
                  "It is removed with your account.",
              );
            }
          },
          /**
           * Adding a member directly, which bypasses the invitation above.
           * Refused for the same reason: "personal" has to stay a claim about
           * the organization, not a label on a two-person one.
           */
          beforeAddMember: async ({ organization: target }) => {
            if (isPersonal(target)) {
              throw personalRefusal(NOT_SHAREABLE);
            }
          },
        },
      }),
    ],
  });
}
