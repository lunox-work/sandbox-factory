import assert from "node:assert/strict";
import { test } from "node:test";

import { runWithRequestState } from "@better-auth/core/context";

import { createAuth, type AuthOptions } from "../src/auth.js";

/**
 * These tests build a real Better Auth instance and inspect what it exposes.
 *
 * No database is touched: `createAuth` only *configures* the adapter, and the
 * assertions below are about which endpoints exist and which do not, which is
 * decided at construction. That is deliberate — it keeps the suite runnable
 * with Docker stopped, as this repo requires — and it does mean these tests
 * prove configuration, not a working sign-in. The provider round trip is
 * verified by hand against a live database.
 */

/**
 * A stand-in for the Drizzle handle. `createAuth` passes it straight to the
 * adapter and nothing in these tests issues a query, so it is never called.
 */
const db = {} as AuthOptions["db"];

const options: AuthOptions = {
  db,
  baseUrl: "http://localhost:4000",
  appUrl: "http://localhost:5173",
  trustedOrigins: ["http://localhost:5173"],
  secret: "0123456789abcdef0123456789abcdef",
  google: { clientId: "google-id", clientSecret: "google-secret" },
  github: { clientId: "github-id", clientSecret: "github-secret" },
  atlassian: { clientId: "atlassian-id", clientSecret: "atlassian-secret" },
};

test("a failed sign-in is redirected to the web app, not the API", () => {
  // Better Auth's own error page is served from the API origin, and its "Go
  // Home" link points there — which serves no UI, so the user lands on :4000
  // with no way back. Pointing errorURL at the app keeps the failure where the
  // person actually is.
  const auth = createAuth(options);

  assert.equal(
    (auth.options as { onAPIError?: { errorURL?: string } }).onAPIError
      ?.errorURL,
    "http://localhost:5173",
  );
});

test("createAuth exposes a request handler and a session reader", () => {
  const auth = createAuth(options);

  // The two members routes.ts depends on. If either disappears in an upgrade,
  // the mount and the guard break together, so assert them explicitly.
  assert.equal(typeof auth.handler, "function");
  assert.equal(typeof auth.api.getSession, "function");
});

test("createAuth enables social sign-in", () => {
  const auth = createAuth(options);

  assert.equal(typeof auth.api.signInSocial, "function");
});

test("email and password sign-up is rejected", async () => {
  const auth = createAuth(options);

  // Worth asserting on the response rather than on the shape of `auth.api`:
  // Better Auth still *defines* `signUpEmail` when the feature is off, so
  // checking that the property is missing passes for the wrong reason and
  // would keep passing if the feature were switched on. What matters is that
  // a real request cannot create an account.
  const res = await auth.handler(
    new Request("http://localhost:4000/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "nobody@example.test",
        password: "a-perfectly-valid-password",
        name: "Nobody",
      }),
    }),
  );

  assert.equal(res.status, 400);
  assert.equal(
    ((await res.json()) as { code: string }).code,
    "EMAIL_PASSWORD_SIGN_UP_DISABLED",
  );
});

test("email and password sign-in is rejected", async () => {
  const auth = createAuth(options);

  const res = await auth.handler(
    new Request("http://localhost:4000/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "nobody@example.test",
        password: "a-perfectly-valid-password",
      }),
    }),
  );

  assert.equal(res.status, 400);
  assert.equal(
    ((await res.json()) as { code: string }).code,
    "EMAIL_PASSWORD_DISABLED",
  );
});

test("createAuth accepts a cookie domain for cross-subdomain deploys", () => {
  // Exercises the branch that builds the advanced.crossSubDomainCookies block;
  // the same call with it omitted is covered by every other test here.
  const auth = createAuth({
    ...options,
    crossSubDomainCookies: { domain: ".lunox.work" },
  });

  assert.equal(typeof auth.handler, "function");
});

test("an unauthenticated getSession returns null rather than throwing", async () => {
  const auth = createAuth(options);

  // The guard in routes.ts branches on null. A throw instead would surface as
  // a 500 on every signed-out request rather than a 401.
  const session = await auth.api.getSession({ headers: new Headers() });

  assert.equal(session, null);
});

// ---- account linking ------------------------------------------------------

test("linking requires a session", async () => {
  const auth = createAuth(options);

  // The heart of the takeover fix: linking is only reachable once you have
  // proven you hold the account you are attaching a provider to.
  const res = await auth.handler(
    new Request("http://localhost:4000/api/auth/link-social", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "github" }),
    }),
  );

  assert.equal(res.status, 401);
});

test("listing linked accounts requires a session", async () => {
  const auth = createAuth(options);

  const res = await auth.handler(
    new Request("http://localhost:4000/api/auth/list-accounts"),
  );

  assert.equal(res.status, 401);
});

// ---- proven-email recording ----------------------------------------------

/**
 * Captures what the hooks record.
 *
 * The hooks are invoked directly rather than through an OAuth callback: doing
 * it for real needs a live provider, which no test here may depend on.
 */
function recordingEmails(primary?: string, ownerOf?: string) {
  const recorded: Array<{
    userId: string;
    email: string;
    providerId: string;
  }> = [];
  return {
    recorded,
    store: {
      primaryFor: () => Promise.resolve(primary),
      // Undefined by default: "nobody holds this address", which is the
      // ordinary signup and keeps the pre-flight out of every other test.
      ownerOf: () => Promise.resolve(ownerOf),
      list: () => Promise.resolve([]),
      record: (input: {
        userId: string;
        email: string;
        providerId: string;
      }) => {
        recorded.push(input);
        return Promise.resolve(null);
      },
      revokeProvider: () => Promise.resolve(),
      setPrimary: () => Promise.resolve(undefined),
      remove: () => Promise.resolve("not-found" as const),
    },
  };
}

type Hooks = {
  user?: { create?: { after?: unknown } };
  account?: { create?: { after?: unknown } };
};

function hooks(auth: ReturnType<typeof createAuth>): Hooks {
  return (auth.options as { databaseHooks?: Hooks }).databaseHooks ?? {};
}

function userCreateBeforeHook(auth: ReturnType<typeof createAuth>) {
  const before = (hooks(auth).user?.create as { before?: unknown } | undefined)
    ?.before;
  assert.equal(typeof before, "function", "expected a user create hook");
  return before as (user: {
    id: string;
    email: string;
  }) => Promise<{ data: { username?: string } } | void>;
}

/**
 * Runs `fn` inside a fresh request context.
 *
 * Better Auth wraps every endpoint in one of these, and the email handoff
 * between `validateUserInfo` and the account-create hook is scoped to it. The
 * hooks are called directly here rather than through an OAuth callback — that
 * would need a live provider — so the context has to be established by hand,
 * and each call gets its own, exactly as two real requests would.
 */
async function inRequest<T>(fn: () => Promise<T>): Promise<T> {
  return await runWithRequestState(new WeakMap(), fn);
}

function validateUserInfoHook(auth: ReturnType<typeof createAuth>) {
  const validate = (
    auth.options as unknown as {
      user?: {
        validateUserInfo?: (data: {
          user: { email: string };
          source: { method: string; oauth?: { providerId: string } };
        }) => Promise<void>;
      };
    }
  ).user?.validateUserInfo;
  assert.equal(typeof validate, "function", "expected validateUserInfo");
  return validate as (data: {
    user: { email: string };
    source: { method: string; oauth?: { providerId: string } };
  }) => Promise<void>;
}

function accountCreateHook(auth: ReturnType<typeof createAuth>) {
  const after = hooks(auth).account?.create?.after;
  assert.equal(typeof after, "function", "expected an account create hook");
  return after as (account: {
    userId: string;
    providerId: string;
  }) => Promise<void>;
}

test("a new account is given a generated handle", async () => {
  // Generated rather than asked for, so no part of the app has to cope with a
  // user that has no handle.
  const auth = createAuth({
    ...options,
    handles: { suggest: () => Promise.resolve("dana") },
  });

  const result = await userCreateBeforeHook(auth)({
    id: "user_1",
    email: "dana@example.test",
  });

  assert.equal(result?.data.username, "dana");
});

test("each provider's own address is recorded, not the account's", async () => {
  // The bug this covers: reading `user.email` returns whatever the *first*
  // provider proved, so a second link recorded a duplicate and GitHub's own
  // address never appeared.
  const emails = recordingEmails("first@example.test");
  const auth = createAuth({
    ...options,
    emails: emails.store,
    lookupEmail: emails.store.primaryFor,
  });

  // Inside one request context, because that is where the handoff between the
  // two hooks lives — see `inRequest` for why that matters.
  await inRequest(async () => {
    // What Better Auth does on a GitHub link: it asserts GitHub's address.
    await validateUserInfoHook(auth)({
      user: { email: "work@example.test" },
      source: { method: "oauth", oauth: { providerId: "github" } },
    });
    await accountCreateHook(auth)({ userId: "user_1", providerId: "github" });
  });

  assert.deepEqual(emails.recorded, [
    { userId: "user_1", email: "work@example.test", providerId: "github" },
  ]);
});

test("two concurrent sign-ins do not cross their addresses", async () => {
  // The regression this pins: the handoff used to be a module-level Map keyed
  // by provider id, shared by every request. Two people completing a Google
  // sign-in at once overwrote each other, and whichever hook read first won —
  // so one user's address was silently dropped and the other's was recorded
  // twice. Request-scoped state makes the two runs invisible to each other.
  const emails = recordingEmails();
  const auth = createAuth({ ...options, emails: emails.store });

  async function signIn(userId: string, email: string) {
    await inRequest(async () => {
      await validateUserInfoHook(auth)({
        user: { email },
        source: { method: "oauth", oauth: { providerId: "google" } },
      });
      // Yield between the two halves, so the interleaving this guards against
      // is the one that actually happens: both requests capture, then both
      // record. A sequential test would pass even with the shared map.
      await new Promise((resolve) => setImmediate(resolve));
      await accountCreateHook(auth)({ userId, providerId: "google" });
    });
  }

  await Promise.all([
    signIn("user_1", "alice@example.test"),
    signIn("user_2", "bob@example.test"),
  ]);

  // Each user got their own address, not whichever one was captured last.
  assert.deepEqual(
    [...emails.recorded].sort((a, b) => a.userId.localeCompare(b.userId)),
    [
      { userId: "user_1", email: "alice@example.test", providerId: "google" },
      { userId: "user_2", email: "bob@example.test", providerId: "google" },
    ],
  );
});

test("the account hook survives running outside a request context", async () => {
  // `provenEmails.get()` throws when there is no context. This hook runs after
  // a sign-in has already succeeded, so a throw here would turn bookkeeping
  // into a failed sign-in. It must fall back to `lookupEmail` instead.
  const emails = recordingEmails("fallback@example.test");
  const auth = createAuth({
    ...options,
    emails: emails.store,
    lookupEmail: emails.store.primaryFor,
  });

  await accountCreateHook(auth)({ userId: "user_1", providerId: "google" });

  assert.deepEqual(emails.recorded, [
    { userId: "user_1", email: "fallback@example.test", providerId: "google" },
  ]);
});

test("the handle columns are registered with Better Auth", () => {
  // Without `additionalFields` the adapter silently drops them: it only
  // iterates the fields it knows, so a username set by the create hook never
  // reaches the insert and the column stays null. No error, just a gap.
  const auth = createAuth(options);
  const fields = (
    auth.options as {
      user?: { additionalFields?: Record<string, unknown> };
    }
  ).user?.additionalFields;

  assert.ok(fields?.["username"], "username must be registered");
  assert.ok(fields?.["displayUsername"], "displayUsername must be registered");
});

test("signing up records the address against the provider that proved it", async () => {
  // Hooked on account creation, not user creation: only that payload carries
  // `providerId`, and the settings page shows which provider vouched for
  // which address. Better Auth creates the account in the same transaction as
  // the user, so this covers a brand new signup too.
  const emails = recordingEmails("first@example.test");
  const auth = createAuth({
    ...options,
    emails: emails.store,
    lookupEmail: emails.store.primaryFor,
  });

  await accountCreateHook(auth)({ userId: "user_1", providerId: "google" });

  assert.deepEqual(emails.recorded, [
    { userId: "user_1", email: "first@example.test", providerId: "google" },
  ]);
});

test("linking an account records the address against that provider", async () => {
  const emails = recordingEmails("first@example.test");
  const auth = createAuth({
    ...options,
    emails: emails.store,
    lookupEmail: emails.store.primaryFor,
  });

  await accountCreateHook(auth)({ userId: "user_1", providerId: "github" });

  assert.deepEqual(emails.recorded, [
    { userId: "user_1", email: "first@example.test", providerId: "github" },
  ]);
});

test("a user with no resolvable address records nothing", async () => {
  const emails = recordingEmails(undefined);
  const auth = createAuth({
    ...options,
    emails: emails.store,
    lookupEmail: emails.store.primaryFor,
  });

  await accountCreateHook(auth)({ userId: "user_1", providerId: "github" });

  assert.deepEqual(emails.recorded, []);
});

test("the account hook is a no-op without a lookup", async () => {
  const emails = recordingEmails("first@example.test");
  const auth = createAuth({ ...options, emails: emails.store });

  await accountCreateHook(auth)({ userId: "user_1", providerId: "github" });

  assert.deepEqual(emails.recorded, []);
});

test("a failure to record does not break the sign-in", async () => {
  // Recording an address is bookkeeping. If it fails the person is still
  // legitimately signed in and must not be shown an error.
  const auth = createAuth({
    ...options,
    emails: {
      primaryFor: () => Promise.resolve("first@example.test"),
      ownerOf: () => Promise.resolve(undefined),
      list: () => Promise.resolve([]),
      record: () => Promise.reject(new Error("database down")),
      revokeProvider: () => Promise.resolve(),
      setPrimary: () => Promise.resolve(undefined),
      remove: () => Promise.resolve("not-found" as const),
    },
  });

  await assert.doesNotReject(() =>
    accountCreateHook(auth)({ userId: "user_1", providerId: "google" }),
  );
});

test("the hooks are no-ops when nothing is configured", async () => {
  const auth = createAuth(options);

  await assert.doesNotReject(() =>
    accountCreateHook(auth)({ userId: "user_1", providerId: "google" }),
  );
  await assert.doesNotReject(async () => {
    const result = await userCreateBeforeHook(auth)({
      id: "user_1",
      email: "first@example.test",
    });
    assert.equal(result, undefined);
  });
});

test("unlinking a provider withdraws its proof", async () => {
  // Without this the address keeps claiming that provider vouched for it, and
  // the settings page renders a row for a provider that is no longer linked.
  const revoked: Array<{ userId: string; providerId: string }> = [];
  const auth = createAuth({
    ...options,
    emails: {
      primaryFor: () => Promise.resolve("first@example.test"),
      ownerOf: () => Promise.resolve(undefined),
      list: () => Promise.resolve([]),
      record: () => Promise.resolve(null),
      revokeProvider: (userId: string, providerId: string) => {
        revoked.push({ userId, providerId });
        return Promise.resolve();
      },
      setPrimary: () => Promise.resolve(undefined),
      remove: () => Promise.resolve("not-found" as const),
    },
  });

  const after = (
    hooks(auth).account as { delete?: { after?: unknown } } | undefined
  )?.delete?.after as (account: {
    userId: string;
    providerId: string;
  }) => Promise<void>;
  assert.equal(typeof after, "function", "expected an account delete hook");

  await after({ userId: "user_1", providerId: "google" });

  assert.deepEqual(revoked, [{ userId: "user_1", providerId: "google" }]);
});

// ---- linking policy -------------------------------------------------------

/**
 * These pin the account-linking policy.
 *
 * Implicit linking is on, which means a provider on the trusted list can merge
 * into an existing account on sign-in. That is a deliberate trade: it serves
 * the ordinary case of one person holding a Google and a GitHub account on the
 * same inbox. It is safe only because the trusted list is short and every
 * provider on it verifies address ownership.
 *
 * So the list is the security boundary, and these tests exist to make widening
 * it a conscious act rather than a quiet one.
 */

function accountLinking(auth: ReturnType<typeof createAuth>) {
  return (
    auth.options as {
      account?: {
        accountLinking?: {
          disableImplicitLinking?: boolean;
          trustedProviders?: string[];
          allowDifferentEmails?: boolean;
          requireLocalEmailVerified?: boolean;
        };
      };
    }
  ).account?.accountLinking;
}

test("the trusted-provider list is exactly the reviewed one", () => {
  // If this fails because a provider was added, that provider must confirm
  // address ownership before reporting an email — otherwise whoever controls
  // an account there reaches the account already using that address.
  //
  // Atlassian is on this list on a weaker basis than the other two: it returns
  // no `email_verified` claim, and the provider config asserts one. See the
  // comment on `trustedProviders` in auth.ts before widening this further.
  assert.deepEqual(accountLinking(createAuth(options))?.trustedProviders, [
    "google",
    "github",
    "atlassian",
  ]);
});

test("Atlassian asserts the verification Better Auth's provider withholds", () => {
  const auth = createAuth(options);
  const atlassian = (
    auth.options as {
      socialProviders?: {
        atlassian?: { mapProfileToUser?: () => { emailVerified?: boolean } };
      };
    }
  ).socialProviders?.atlassian;

  assert.ok(atlassian, "Atlassian should be configured");

  // The upstream provider hardcodes `emailVerified: false`, and both the
  // sign-in callback and the link route gate on
  // `!trusted && !emailVerified`. Without this override every path is refused:
  // signing in silently creates a duplicate account and Connect fails with
  // `unable_to_link_account`. Pinned because dropping it breaks linking in a
  // way that only shows up at the provider callback.
  assert.equal(atlassian?.mapProfileToUser?.().emailVerified, true);
});

test("Atlassian asks for identity and nothing else", () => {
  const auth = createAuth(options);

  const atlassian = (
    auth.options as {
      socialProviders?: {
        atlassian?: { scope?: string[]; disableDefaultScope?: boolean };
      };
    }
  ).socialProviders?.atlassian;

  // Required: without `read:me` the profile comes back with no address and
  // Better Auth cannot create a user, so the sign-in fails at the callback
  // rather than anywhere near this configuration.
  assert.ok(atlassian?.scope?.includes("read:me"));

  // The provider appends `scope` to its defaults, so dropping the site-scoped
  // `read:jira-user` takes both of these. Asserted together because setting
  // the scope list without the flag silently keeps requesting Jira access —
  // the failure is invisible in config and only shows on the consent screen.
  assert.equal(atlassian?.disableDefaultScope, true);
  assert.ok(
    !atlassian?.scope?.includes("read:jira-user"),
    "login should not request site-scoped Jira access",
  );
});

test("implicit linking is enabled deliberately", () => {
  // On by choice, not by default: a trusted provider asserting a verified
  // address merges rather than being refused. Turning this off is a UX
  // decision; turning it on without a vetted trusted list is a security bug.
  assert.equal(
    accountLinking(createAuth(options))?.disableImplicitLinking,
    false,
  );
});

test("a merge still requires the local address to be verified", () => {
  // Stops an account pre-registered at someone else's address from capturing
  // that person's OAuth identity on their first sign-in.
  assert.equal(
    accountLinking(createAuth(options))?.requireLocalEmailVerified,
    true,
  );
});

// ---- session cookie -------------------------------------------------------
//
// The session cookie is the credential for every authenticated browser
// request, so its attributes are a security decision rather than a default
// worth inheriting quietly. These pin all three.

function cookieAttributes(
  auth: ReturnType<typeof createAuth>,
): Record<string, unknown> {
  const advanced = (
    auth.options as {
      advanced?: {
        useSecureCookies?: boolean;
        defaultCookieAttributes?: Record<string, unknown>;
      };
    }
  ).advanced;
  return {
    useSecureCookies: advanced?.useSecureCookies,
    ...advanced?.defaultCookieAttributes,
  };
}

test("the session cookie is never readable from JavaScript", () => {
  // What keeps the session out of reach of a script running on the page, and
  // why the web client sends no bearer token of its own.
  assert.equal(cookieAttributes(createAuth(options))["httpOnly"], true);
});

test("Secure follows the URL scheme, not NODE_ENV", () => {
  // Better Auth's own default falls back to `isProduction` when the base URL
  // is not https, so a container that forgets NODE_ENV would serve the session
  // cookie without `Secure`. Deriving it from the configured scheme removes
  // that failure mode — and keeps it off on http localhost, where `Secure`
  // would stop the cookie working at all.
  assert.equal(
    cookieAttributes(createAuth(options))["useSecureCookies"],
    false,
  );
  assert.equal(
    cookieAttributes(
      createAuth({ ...options, baseUrl: "https://api.lunox.work" }),
    )["useSecureCookies"],
    true,
  );
});

test("SameSite is Lax on every deployment, because OAuth requires it", () => {
  // Regression test for a real sign-in failure, so it is worth stating what
  // breaks rather than just pinning a string.
  //
  // These attributes are spread over every auth cookie, including the `state`
  // cookie that carries an in-progress sign-in. The provider returns the user
  // by a cross-site top-level navigation, and a Strict cookie is withheld on
  // exactly that request — so `state` never comes back and the callback dies
  // at `error=state_mismatch`. Strict here is not a stricter session; it is no
  // session at all.
  //
  // Both deployment shapes are asserted because the same-origin one is the
  // trap: it looks like it could afford Strict, and it cannot. SameSite is
  // judged against the provider's origin, which is cross-site either way.
  assert.equal(cookieAttributes(createAuth(options))["sameSite"], "lax");

  assert.equal(
    cookieAttributes(
      createAuth({
        ...options,
        baseUrl: "https://api.lunox.work",
        crossSubDomainCookies: { domain: ".lunox.work" },
      }),
    )["sameSite"],
    "lax",
  );
});

// ---- duplicate-account pre-flight ------------------------------------------
//
// The application half of a two-layer guard; migration 0007 is the other. Both
// exist because `user.email` and `user_email.email` are each unique while
// neither constraint sees the other, so an address free in one table can be
// taken in the other — and a refused merge used to fall through to creating a
// user in exactly that unrepresentable state.

test("a signup is refused when the address is already held", async () => {
  const emails = recordingEmails(undefined, "someone-else");
  const auth = createAuth({ ...options, emails: emails.store });

  await assert.rejects(
    () =>
      userCreateBeforeHook(auth)({
        id: "user_new",
        email: "taken@example.test",
      }),
    (error: { body?: { code?: string } }) =>
      error.body?.code === "EMAIL_ALREADY_HELD",
    "a held address must abort the signup, not create a second account",
  );
});

test("a signup proceeds when nobody holds the address", async () => {
  const emails = recordingEmails();
  const auth = createAuth({
    ...options,
    emails: emails.store,
    handles: { suggest: () => Promise.resolve("new-handle") },
  });

  // The ordinary path, asserted so the guard above cannot be satisfied by
  // refusing everything.
  const result = await userCreateBeforeHook(auth)({
    id: "user_new",
    email: "free@example.test",
  });

  assert.equal(
    (result as { data?: { username?: string } })?.data?.username,
    "new-handle",
  );
});
