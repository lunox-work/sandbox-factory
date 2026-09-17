/**
 * Better Auth configuration, built by a factory so it is testable without a
 * database or `process.env`.
 *
 * Email and password sign-in is deliberately off: `emailAndPassword` is never
 * enabled, so its endpoints refuse every request (pinned in `auth.test.ts`).
 * Google, GitHub and Atlassian are the only ways in.
 */

import { defineRequestState } from "@better-auth/core/context";
import { authSchema, type EmailStore } from "@sandbox-factory/db";
import { APIError, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer } from "better-auth/plugins";

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

export function createAuth({
  db,
  emails,
  lookupEmail,
  handles,
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

  return betterAuth({
    database: drizzleAdapter(db, {
      provider: "pg",
      // The four auth models only; the adapter has no business with `todos`.
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
    ],
  });
}
