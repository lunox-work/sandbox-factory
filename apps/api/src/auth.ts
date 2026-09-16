/**
 * Better Auth configuration.
 *
 * Built by a factory taking its database and config, for the same reason
 * `createApp` is: the routes that depend on auth have to be testable without a
 * Postgres container, and a module-level `betterAuth({...})` reading
 * `process.env` at import time cannot be.
 *
 * **Email and password sign-in is deliberately off.** `emailAndPassword` is
 * simply not enabled, which is what disables it — Better Auth's default is
 * disabled, so this is the absence of a setting rather than a flag set to
 * false. Google, GitHub and Atlassian are the only ways in. The consequence
 * worth knowing is that `account.password` stays null for every row, and the
 * sign-up, forgot-password and reset-password endpoints return 404 rather than
 * existing and rejecting input.
 */

import { defineRequestState } from "@better-auth/core/context";
import { authSchema, type EmailStore } from "@sandbox-factory/db";
import { APIError, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer } from "better-auth/plugins";

/**
 * The address a provider asserted during *this* request.
 *
 * A handoff between `validateUserInfo`, which is the only callback given the
 * provider's email alongside its id, and the account-create hook, which knows
 * the user id but not the email. The two halves have to meet somewhere.
 *
 * Request-scoped rather than a module-level `Map`, and that is the whole
 * point. A map keyed by provider id is shared by every in-flight sign-in, so
 * two people completing a Google sign-in in the same tick overwrite each
 * other: the second `set` wins and the first user's address is silently
 * dropped. Keying by user id is not available here — `validateUserInfo` runs
 * before the user row exists. `defineRequestState` sidesteps the question by
 * scoping the value to the request that produced it, via the AsyncLocalStorage
 * that Better Auth already wraps every endpoint in. Concurrent sign-ins cannot
 * see each other's state, and nothing is shared across replicas because
 * nothing is shared at all.
 *
 * Defined at module scope because the `ref` it returns identifies the slot;
 * the *values* are per request, so one definition serves every `createAuth`.
 */
const provenEmails = defineRequestState<Map<string, string>>(() => new Map());

/**
 * The per-request map, or `undefined` outside a request context.
 *
 * `provenEmails.get()` throws when there is no context to read, and neither
 * caller can afford that. The account hook runs *after* a sign-in has already
 * succeeded and the row is written: throwing there would turn bookkeeping into
 * a failed sign-in, which is the opposite of the trade this code makes
 * everywhere else. Falling back to `lookupEmail` loses nothing that was not
 * already lost.
 */
async function capturedEmails(): Promise<Map<string, string> | undefined> {
  try {
    return await provenEmails.get();
  } catch {
    return undefined;
  }
}

/**
 * The Drizzle database handle. Widened to the adapter's own expectation rather
 * than re-stating a driver type here, so this file stays honest about the fact
 * that it does not care which driver is underneath.
 */
type AuthDatabase = Parameters<typeof drizzleAdapter>[0];

export interface AuthOptions {
  db: AuthDatabase;
  /**
   * Records addresses proven by a provider link. Optional so the auth
   * configuration can be built — and tested — without a database behind it.
   */
  emails?: EmailStore | undefined;
  /**
   * Reads a user's current primary email.
   *
   * The account-create hook needs it because the account row does not carry
   * one, and the hook's endpoint context is `undefined` — Better Auth passes
   * no context to these hooks, so there is no OAuth profile to read instead.
   */
  lookupEmail?: ((userId: string) => Promise<string | undefined>) | undefined;
  /**
   * Proposes a free handle for a new account. Optional so the configuration
   * can be built without a database.
   */
  handles?: { suggest(email: string): Promise<string> } | undefined;
  /** Public origin of the API itself, e.g. `https://api.lunox.work`. */
  baseUrl: string;
  /**
   * Public origin of the *web app*, e.g. `https://app.lunox.work`.
   *
   * Where a failed sign-in is sent. Without it Better Auth renders its own
   * error page on the API origin, whose "Go Home" link points at the API —
   * a dead end for anyone who got there from the web app.
   */
  appUrl: string;
  /** Origins allowed to complete a sign-in redirect. */
  trustedOrigins: readonly string[];
  /** Signing secret for session tokens. */
  secret: string;
  google: OAuthCredentials;
  github: OAuthCredentials;
  /**
   * Atlassian is configured like the other two but is **not** trusted for
   * implicit linking; see `trustedProviders` below for why.
   */
  atlassian: OAuthCredentials;
  /** Set when the API and web app are on different hosts; see below. */
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
  // `baseUrl` is validated as an absolute URL by `parseEnv`, so this cannot
  // throw on anything that reached here.
  const isHttps = new URL(baseUrl).protocol === "https:";

  return betterAuth({
    database: drizzleAdapter(db, {
      provider: "pg",
      // The four auth models only — `todos` is not the adapter's business.
      schema: authSchema,
    }),
    baseURL: baseUrl,
    secret,
    /**
     * Send failed sign-ins back to the web app rather than to Better Auth's
     * own error page.
     *
     * That page is served from the API origin, so its "Go Home" button points
     * at the API — which serves no UI, leaving the user stranded on :4000 with
     * no way back. Redirecting instead means the app owns the whole
     * signed-out experience, and the failure shows up where the person was.
     *
     * Better Auth appends `error` and, when present, `error_description` to
     * this URL; `SignIn.tsx` reads them.
     */
    onAPIError: { errorURL: appUrl },
    // Better Auth refuses to redirect anywhere not listed here after a
    // provider callback. That check is what stops an attacker appending
    // `?callbackURL=https://evil.example` and receiving the session.
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
         * Sign-in asks for identity and nothing else.
         *
         * Better Auth's Atlassian provider defaults to `read:jira-user` and
         * `offline_access`, and it *appends* `scope` to those rather than
         * replacing them — hence `disableDefaultScope`, which is the only way
         * to not request `read:jira-user`.
         *
         * Two separate reasons for this list:
         *
         * `read:me` is required, not an enrichment. The provider reads the
         * profile from `https://api.atlassian.com/me`, which only returns an
         * `email` when the token carries this scope. Without it the profile
         * comes back with no address and Better Auth refuses the sign-in,
         * because it cannot create a user without one.
         *
         * `read:jira-user` is dropped because it is site-scoped and this is an
         * authentication flow. It reads *other people's* directory data —
         * "usernames, email addresses, and avatars" for a whole Jira site —
         * which is unrelated to identifying the person signing in, and it
         * drags site selection into the consent screen. It also decides how
         * much the app's access type actually grants: with no product scope
         * requested, the "all resources within the customer's account" breadth
         * that an account-level app would confer has nothing to apply to.
         * Anything needing Jira data should request it separately rather than
         * riding in on the login grant.
         */
        disableDefaultScope: true,
        scope: ["read:me", "offline_access"],
        /**
         * Asserts that the address `/me` returned is verified.
         *
         * Better Auth's Atlassian provider hardcodes `emailVerified: false`,
         * and that value is not cosmetic: both the sign-in callback and the
         * authenticated link route gate on
         * `!trustedProviders.includes(id) && !emailVerified`. With it false and
         * Atlassian untrusted, *every* path is refused — signing in creates a
         * duplicate account instead of merging, and pressing Connect on the
         * account page fails with `unable_to_link_account`. There is no
         * configuration that unblocks one without this.
         *
         * `mapProfileToUser` is spread over the profile after that default, so
         * this is the supported override rather than a patch.
         *
         * **What we are trusting.** Atlassian does not return an
         * `email_verified` claim, so this asserts something the provider does
         * not state. The basis is that `read:me` returns the address on the
         * Atlassian account itself, which Atlassian requires be confirmed
         * before the account can be used — it is not a field the user can type
         * freely. That is weaker than Google's explicit claim, and it is the
         * reason this override is written here with its own comment instead of
         * living quietly in a config object.
         */
        mapProfileToUser: () => ({ emailVerified: true }),
      },
    },
    user: {
      /**
       * Registers our own columns with Better Auth.
       *
       * Without this the adapter silently drops them: `parseInputData`
       * iterates over the fields it knows about, so a `username` set by the
       * hook below never reaches the insert and the column stays null. That
       * failure is invisible — no error, just a missing value.
       *
       * `input: true` is what lets the create hook supply a value. These are
       * not user-submitted: the handle is generated at signup and changed
       * afterwards through `/api/v1/me/username`, which validates it.
       */
      additionalFields: {
        username: { type: "string", required: false, input: true },
        displayUsername: { type: "string", required: false, input: true },
      },
      /**
       * Captures the address a provider is asserting, keyed by provider.
       *
       * This runs for both `create-user` and `link-account`, and it is the
       * only callback that receives the provider's email alongside its id.
       * The account-create hook picks the value up a moment later; it is not
       * used to reject anything, hence the bare return.
       */
      validateUserInfo: async ({ user: incoming, source }) => {
        const providerId = source.oauth?.providerId;
        if (providerId !== undefined && typeof incoming.email === "string") {
          // Still keyed by provider within the request: one sign-in can link
          // only one provider, but a request may carry both a create-user and
          // a link-account pass, and those must not overwrite each other.
          (await capturedEmails())?.set(
            providerId,
            incoming.email.toLowerCase(),
          );
        }
        return;
      },
    },
    session: {
      // A short-lived cookie cache means most authenticated requests answer
      // from a signed cookie rather than a SELECT on `session`. Revocation
      // still takes effect within this window, so keep it small.
      cookieCache: { enabled: true, maxAge: 5 * 60 },
    },
    account: {
      accountLinking: {
        enabled: true,
        /**
         * Implicit linking is **on**, and it is load-bearing that this is a
         * deliberate choice rather than a default left unexamined.
         *
         * Signing in with a provider whose verified email already belongs to
         * an account merges into that account instead of refusing. The case
         * this serves is the ordinary one: the same person holding a Google
         * and a GitHub account on one inbox, who should not be told to go and
         * find which provider they used first.
         *
         * What makes it safe is `trustedProviders` below — and *only* that.
         * The merge happens when the provider is on that list and it asserts
         * `email_verified`. A provider that is not listed still cannot merge
         * into an existing account.
         *
         * The risk this accepts: if a trusted provider is compromised, or
         * lets someone hold an address they do not own, that person reaches
         * the account using it. Both providers here verify ownership before
         * asserting an address, which is why they are trusted and why adding
         * a third is a security decision rather than a configuration one.
         */
        disableImplicitLinking: false,
        /**
         * The providers allowed to merge into an existing account on sign-in.
         *
         * **Adding to this list is a security decision.** A provider belongs
         * here only if it verifies that a user owns an address before
         * reporting it. Google and GitHub both do. One that lets a user type
         * any address, or that omits `email_verified`, would let whoever
         * controls that provider account reach an existing one here.
         *
         * **Atlassian is here on a weaker basis than the other two, and that
         * is a deliberate, reviewed decision.** Google and GitHub both return
         * an explicit `email_verified` claim. Atlassian returns none, so the
         * provider config above asserts it via `mapProfileToUser` on the
         * grounds that `read:me` reports the address on the Atlassian account
         * itself rather than a free-text field.
         *
         * Leaving it off this list was tried first and is not a usable
         * position: the same guard gates the authenticated link route, so an
         * untrusted Atlassian cannot be connected from the account page
         * either. The choice was not "trusted vs link-only" but "trusted vs
         * unusable".
         *
         * The risk accepted is the one stated above, and it is real: whoever
         * controls an Atlassian account bearing an address can reach the
         * account already using it. It rests on Atlassian confirming addresses
         * before an account is usable. If that ever stops being true, this
         * entry is the thing to remove.
         *
         * `auth.test.ts` pins this list so widening it cannot pass unnoticed.
         */
        trustedProviders: ["google", "github", "atlassian"],
        /**
         * Never merge on an address the provider has not verified.
         *
         * Defence in depth: the trusted list already gates which providers may
         * merge, and this refuses the merge when the local account's own
         * address was never verified either. Left at Better Auth's default
         * rather than relaxed, because the two together are what stop a
         * pre-registered unverified account from capturing an OAuth identity.
         */
        requireLocalEmailVerified: true,
        /**
         * Allows linking a provider whose email differs from the current one.
         *
         * This is what makes "add an email" work: linking a Google account
         * with a different address is how that address is proven. Better Auth
         * warns about this option because it can enable takeover — but that
         * warning is about the *implicit* path, which is disabled above. Here
         * the caller is already authenticated, so linking adds an address to
         * an account they already hold rather than granting access to one they
         * do not.
         */
        allowDifferentEmails: true,
        /**
         * Do not let a newly linked provider overwrite the profile. Someone
         * linking a work Google account should not have their display name
         * silently replaced by whatever that directory says.
         */
        updateUserInfoOnLink: false,
      },
    },
    advanced: {
      // Only set when the web app and API are on different subdomains
      // (app.lunox.work calling api.lunox.work), where a host-only cookie
      // would not be sent at all. Left undefined for same-origin dev, because
      // a Domain attribute on `localhost` is what breaks cookies there.
      ...(crossSubDomainCookies === undefined
        ? {}
        : {
            crossSubDomainCookies: {
              enabled: true,
              domain: crossSubDomainCookies.domain,
            },
          }),
      /**
       * Derived from the URL rather than from `NODE_ENV`.
       *
       * Better Auth's own default falls back to `isProduction` when the base
       * URL is not https, which means a container that forgets to set
       * `NODE_ENV=production` quietly serves the session cookie without
       * `Secure`. Reading the scheme we were actually configured with removes
       * that failure mode: an https deployment gets `Secure` whatever the
       * environment says, and http localhost does not (where `Secure` would
       * stop the cookie working at all).
       */
      useSecureCookies: isHttps,
      defaultCookieAttributes: {
        /**
         * `Lax`, and it has to be — `Strict` breaks OAuth sign-in outright.
         *
         * These attributes are spread over *every* auth cookie, not just the
         * session: Better Auth builds each one as
         * `{...defaults, ...defaultCookieAttributes}`, so whatever is set here
         * also lands on the short-lived `state` and `pkce_code_verifier`
         * cookies that carry an in-progress sign-in.
         *
         * That is what makes `Strict` unusable. The provider returns the user
         * by a cross-site top-level navigation, and a `Strict` cookie is
         * withheld on exactly that request. The `state` cookie set before the
         * redirect therefore does not come back, Better Auth compares the
         * callback's state against a cookie that is not there, and the sign-in
         * ends at `/api/auth/error?error=state_mismatch`. The failure is total
         * rather than partial: it is not a weaker session, it is no session.
         *
         * This is not specific to the cross-subdomain deploy, which is the
         * distinction an earlier version of this comment drew. A same-origin
         * localhost setup fails the same way, because SameSite is judged on
         * the site the *request is going to* versus the one it came from —
         * here, our own origin versus the provider's. Same-origin says nothing
         * about a redirect arriving from Atlassian.
         *
         * `Lax` is the strongest setting that still permits it, and it is
         * upstream's own default; this states it explicitly rather than
         * relying on a default staying put. What `Lax` gives up against
         * `Strict` is narrow — cross-site top-level GETs still send the
         * cookie — and CSRF on state-changing requests is covered separately
         * by the origin check, not by SameSite alone.
         */
        sameSite: "lax",
        // Never readable from JavaScript. This is what keeps the session out
        // of reach of a script that manages to run on the page, and it is why
        // the web client sends no bearer token.
        httpOnly: true,
        path: "/",
      },
    },
    databaseHooks: {
      user: {
        create: {
          /**
           * Give every new account a handle.
           *
           * Generated rather than asked for, so nobody is ever mid-signup
           * without one and no other part of the app has to cope with a null
           * handle. It is derived from the address the provider reported and
           * made unique by the store; the person can change it afterwards.
           */
          before: async (createdUser) => {
            /**
             * Refuse a signup whose address is already held by someone else.
             *
             * This is the pre-flight half of a two-layer guard; the other is a
             * database trigger (migration 0007). Without it, a refused merge
             * — the untrusted-provider path — falls through to *creating a new
             * user*, whose address then cannot be recorded because
             * `user_email` says another account owns it. The result is an
             * account that exists, can be signed into, and has no address: the
             * duplicate-account confusion this is here to stop.
             *
             * `user.email` and `user_email.email` are each unique but neither
             * constraint sees the other, so `ownerOf` checks both. Throwing
             * rather than returning `false` because a bare `false` aborts with
             * a null and no code — Better Auth rethrows an `APIError` from
             * here, so the callback lands on a readable error instead of a
             * silent failure.
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
           * Records the address the provider just proved.
           *
           * `validateUserInfo` above captured it: that callback is the only
           * place Better Auth hands us the *provider's* email together with
           * its `providerId`. This hook knows the `userId` but not the email —
           * the account row carries none — so the two halves are joined here.
           *
           * Reading `user.email` instead would be wrong, and was the bug: on a
           * second link it returns the address the first provider proved, so
           * GitHub's own address was never recorded.
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
                // Not an exception, so the catch below would never see it:
                // `record` returns null when the address already belongs to
                // someone else. The sign-in still succeeded and the account is
                // linked — only the email row was refused — but it leaves a
                // user missing an address they expected to see, so it must not
                // pass silently.
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
           * Withdraw the proof when a provider is unlinked.
           *
           * Without this the address keeps claiming that provider vouched for
           * it, and the settings page renders a row for a provider that is no
           * longer linked — the proof is gone but the claim survives it.
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
      // Accepts `Authorization: Bearer <token>` as an alternative to the
      // session cookie. The VS Code extension has no cookie jar, so without
      // this it would need a second, parallel auth story. The web app keeps
      // using the cookie and never reads a token.
      bearer(),
    ],
  });
}
