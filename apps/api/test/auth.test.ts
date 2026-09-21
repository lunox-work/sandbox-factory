import assert from "node:assert/strict";
import { test } from "node:test";

import { runWithRequestState } from "@better-auth/core/context";
import type { OrganizationStore } from "@sandbox-factory/db";

import { createAuth, type AuthOptions } from "../src/auth.js";

/**
 * These build a real Better Auth instance and inspect its configuration. No
 * database is touched, so the suite runs with Docker stopped. They prove
 * configuration, not a working sign-in; the provider round trip is verified by
 * hand.
 */

/** A stand-in for the Drizzle handle; nothing here issues a query. */
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
  // Better Auth's own error page would strand the user on the API origin.
  const auth = createAuth(options);

  assert.equal(
    (auth.options as { onAPIError?: { errorURL?: string } }).onAPIError
      ?.errorURL,
    "http://localhost:5173",
  );
});

test("createAuth exposes a request handler and a session reader", () => {
  const auth = createAuth(options);

  // The two members routes.ts depends on, pinned against an upgrade.
  assert.equal(typeof auth.handler, "function");
  assert.equal(typeof auth.api.getSession, "function");
});

test("createAuth enables social sign-in", () => {
  const auth = createAuth(options);

  assert.equal(typeof auth.api.signInSocial, "function");
});

test("email and password sign-up is rejected", async () => {
  const auth = createAuth(options);

  // Assert on the response, not the shape of `auth.api`: Better Auth defines
  // `signUpEmail` even when the feature is off.
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
  // Exercises the branch that builds `advanced.crossSubDomainCookies`.
  const auth = createAuth({
    ...options,
    crossSubDomainCookies: { domain: ".lunox.work" },
  });

  assert.equal(typeof auth.handler, "function");
});

test("an unauthenticated getSession returns null rather than throwing", async () => {
  const auth = createAuth(options);

  // The guard in routes.ts branches on null; a throw would turn every
  // signed-out request into a 500 instead of a 401.
  const session = await auth.api.getSession({ headers: new Headers() });

  assert.equal(session, null);
});

// ---- account linking ------------------------------------------------------

test("linking requires a session", async () => {
  const auth = createAuth(options);

  // Linking is reachable only after proving you hold the account.
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
 * Captures what the hooks record. The hooks are invoked directly, because an
 * OAuth callback would need a live provider.
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
      // Undefined means nobody holds the address: the ordinary signup.
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

function userCreateAfterHook(auth: ReturnType<typeof createAuth>) {
  const after = (hooks(auth).user?.create as { after?: unknown } | undefined)
    ?.after;
  assert.equal(typeof after, "function", "expected a user create after hook");
  return after as (user: {
    id: string;
    name: string;
    username?: string;
  }) => Promise<void>;
}

/**
 * Runs `fn` inside a fresh request context, as Better Auth does for every
 * endpoint. The email handoff between `validateUserInfo` and the
 * account-create hook is scoped to it.
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
  // Regression: reading `user.email` returns what the first provider proved,
  // so a second link never recorded its own address.
  const emails = recordingEmails("first@example.test");
  const auth = createAuth({
    ...options,
    emails: emails.store,
    lookupEmail: emails.store.primaryFor,
  });

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
  // Regression: a module-level Map keyed by provider id let two simultaneous
  // Google sign-ins overwrite each other. See `provenEmails` in auth.ts.
  const emails = recordingEmails();
  const auth = createAuth({ ...options, emails: emails.store });

  async function signIn(userId: string, email: string) {
    await inRequest(async () => {
      await validateUserInfoHook(auth)({
        user: { email },
        source: { method: "oauth", oauth: { providerId: "google" } },
      });
      // Yield so both requests capture before either records. Without it
      // the test would pass even with a shared map.
      await new Promise((resolve) => setImmediate(resolve));
      await accountCreateHook(auth)({ userId, providerId: "google" });
    });
  }

  await Promise.all([
    signIn("user_1", "alice@example.test"),
    signIn("user_2", "bob@example.test"),
  ]);

  // Each user gets their own address, not whichever was captured last.
  assert.deepEqual(
    [...emails.recorded].sort((a, b) => a.userId.localeCompare(b.userId)),
    [
      { userId: "user_1", email: "alice@example.test", providerId: "google" },
      { userId: "user_2", email: "bob@example.test", providerId: "google" },
    ],
  );
});

test("the account hook survives running outside a request context", async () => {
  // `provenEmails.get()` throws with no context. The hook must fall back to
  // `lookupEmail` rather than fail a sign-in that already succeeded.
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
  // Without `additionalFields` the adapter silently drops them and the
  // column stays null, with no error.
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
  // Hooked on account creation because only that payload carries
  // `providerId`. A new signup creates its account in the same transaction,
  // so this covers it too.
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
  // Recording is bookkeeping; the person is still legitimately signed in.
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
  // Otherwise the settings page keeps showing a provider no longer linked.
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
 * These pin the account-linking policy. Implicit linking is on, so the trusted
 * list is the security boundary; widening it must be a conscious act. See
 * `trustedProviders` in auth.ts.
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
  // If this fails because a provider was added: it must confirm address
  // ownership before reporting an email, or whoever controls an account there
  // reaches the account already using that address. Read the comment on
  // `trustedProviders` in auth.ts before widening this.
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

  // Upstream hardcodes `emailVerified: false`, and the sign-in callback and
  // link route both gate on it. Pinned because dropping the override only
  // shows up at the provider callback.
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

  // Without `read:me` the profile has no address and the sign-in fails at
  // the callback.
  assert.ok(atlassian?.scope?.includes("read:me"));

  // The provider appends `scope` to its defaults, so without the flag it
  // silently keeps requesting Jira access, visible only on the consent screen.
  assert.equal(atlassian?.disableDefaultScope, true);
  assert.ok(
    !atlassian?.scope?.includes("read:jira-user"),
    "login should not request site-scoped Jira access",
  );
});

test("implicit linking is enabled deliberately", () => {
  // Turning this off is a UX decision; having it on without a vetted trusted
  // list is a security bug.
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
// The cookie is the credential for every browser request, so its three
// attributes are pinned rather than inherited.

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
  assert.equal(cookieAttributes(createAuth(options))["httpOnly"], true);
});

test("Secure follows the URL scheme, not NODE_ENV", () => {
  // Better Auth's default follows NODE_ENV, so a container that forgets it
  // would drop `Secure`. Off on http localhost, where it breaks the cookie.
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
  // Regression: `Strict` withholds the `state` cookie on the provider's
  // cross-site return, so every sign-in dies at `state_mismatch`. See the
  // comment on `sameSite` in auth.ts. Both deploy shapes are asserted because
  // same-origin looks like it could afford Strict, and it cannot.
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
// The application half of a two-layer guard; migration 0007 is the other. See
// the user create hook in auth.ts.

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

  // So the guard above cannot be satisfied by refusing everything.
  const result = await userCreateBeforeHook(auth)({
    id: "user_new",
    email: "free@example.test",
  });

  assert.equal(
    (result as { data?: { username?: string } })?.data?.username,
    "new-handle",
  );
});

// ---- organizations ---------------------------------------------------------
//
// The plugin owns every write to `organization`, `member` and `invitation`.
// What is pinned here is the configuration it runs under, and the hooks that
// close the two gaps it leaves: a slug it would accept in any shape, and a
// byte-exact "already taken" check.

/** A store that answers a handle lookup, for the hooks under test. */
function fakeOrganizations(held: Record<string, string> = {}) {
  const store = {
    createPersonal: () =>
      Promise.resolve({
        id: "org_personal",
        name: "Dana",
        slug: "dana",
        kind: "personal" as const,
      }),
    renamePersonal: () => Promise.resolve(),
    listForUser: () => Promise.resolve([]),
    roleOf: () => Promise.resolve(undefined),
    get: () => Promise.resolve(undefined),
    findBySlug: () => Promise.resolve(undefined),
    slugOwner: (slug: string, exceptId?: string) => {
      const owner = held[slug];
      return Promise.resolve(owner === exceptId ? undefined : owner);
    },
    listMembers: () => Promise.resolve([]),
    pendingFor: () => Promise.resolve([]),
    findUserByHandle: () => Promise.resolve(undefined),
    touched: [] as string[],
    touch(id: string) {
      store.touched.push(id);
      return Promise.resolve();
    },
  };
  return store;
}

/** The organization plugin's options, as configured. */
function orgOptions(auth: ReturnType<typeof createAuth>) {
  const plugins = (auth.options as { plugins?: Array<{ id?: string }> })
    .plugins;
  const plugin = plugins?.find((candidate) => candidate.id === "organization");
  assert.notEqual(plugin, undefined, "expected the organization plugin");
  return (plugin as { options?: Record<string, unknown> }).options ?? {};
}

type OrganizationHooks = {
  beforeCreateOrganization?: (data: {
    organization: { slug?: string; name?: string };
  }) => Promise<{ data: { slug: string } } | void>;
  beforeUpdateOrganization?: (data: {
    organization: { slug?: string };
    member: { organizationId: string };
  }) => Promise<{ data: { slug: string } } | void>;
  afterUpdateOrganization?: (data: {
    organization: { id: string } | null;
  }) => Promise<void>;
  beforeCreateInvitation?: (data: {
    invitation: { email: string; organizationId?: string };
  }) => Promise<{ data: { email: string } }>;
  beforeDeleteOrganization?: (data: {
    organization: Record<string, unknown>;
  }) => Promise<void>;
  beforeAddMember?: (data: {
    organization: Record<string, unknown>;
  }) => Promise<void>;
};

function orgHooks(auth: ReturnType<typeof createAuth>): OrganizationHooks {
  return (orgOptions(auth)["organizationHooks"] ?? {}) as OrganizationHooks;
}

test("the organization plugin is mounted", () => {
  // Without it nothing under /api/auth/organization/* exists.
  const auth = createAuth(options);

  assert.equal(typeof orgOptions(auth), "object");
});

test("the creator of an organization is its owner", () => {
  // Every organization must have an owner from the moment it exists.
  assert.equal(orgOptions(createAuth(options))["creatorRole"], "owner");
});

test("no invitation email is sent", () => {
  // This codebase has no mailer. Invitations are delivered in-app, on the
  // account page; setting this would silently start requiring one.
  assert.equal(
    orgOptions(createAuth(options))["sendInvitationEmail"],
    undefined,
  );
});

test("organization deletion stays enabled for owners", () => {
  assert.notEqual(
    orgOptions(createAuth(options))["disableOrganizationDeletion"],
    true,
  );
});

test("a new organization's handle is stored lowercase", async () => {
  // The plugin accepts any non-empty string, so `MyOrg` and `myorg` would
  // otherwise be two organizations.
  const auth = createAuth({ ...options, organizations: fakeOrganizations() });

  const result = await orgHooks(auth).beforeCreateOrganization?.({
    organization: { slug: "  MyOrg  ", name: "My Org" },
  });

  assert.equal(result?.data.slug, "myorg");
});

test("a handle that would break a URL is refused", async () => {
  const auth = createAuth({ ...options, organizations: fakeOrganizations() });

  await assert.rejects(
    () =>
      Promise.resolve(
        orgHooks(auth).beforeCreateOrganization?.({
          organization: { slug: "my org", name: "My Org" },
        }),
      ).then((value) => value),
    (error: { body?: { code?: string } }) =>
      error.body?.code === "INVALID_ORGANIZATION_SLUG",
  );
});

test("a handle that is too short is refused", async () => {
  const auth = createAuth({ ...options, organizations: fakeOrganizations() });

  await assert.rejects(
    async () =>
      orgHooks(auth).beforeCreateOrganization?.({
        organization: { slug: "no" },
      }),
    (error: { body?: { message?: string } }) =>
      /between 3 and 30 characters/.test(error.body?.message ?? ""),
  );
});

test("a handle another organization holds is refused", async () => {
  const auth = createAuth({
    ...options,
    organizations: fakeOrganizations({ acme: "org_1" }),
  });

  await assert.rejects(
    async () =>
      orgHooks(auth).beforeCreateOrganization?.({
        organization: { slug: "acme" },
      }),
    (error: { body?: { code?: string } }) =>
      error.body?.code === "ORGANIZATION_SLUG_ALREADY_TAKEN",
  );
});

test("a taken handle is caught whatever case it is typed in", async () => {
  // The plugin's own check runs on the raw body, before this hook lowercases
  // it: `ACME` while `acme` exists passes it and would hit the unique
  // constraint as a 500.
  const auth = createAuth({
    ...options,
    organizations: fakeOrganizations({ acme: "org_1" }),
  });

  await assert.rejects(
    async () =>
      orgHooks(auth).beforeCreateOrganization?.({
        organization: { slug: "ACME" },
      }),
    (error: { body?: { code?: string } }) =>
      error.body?.code === "ORGANIZATION_SLUG_ALREADY_TAKEN",
  );
});

test("renaming to your own handle in another case is allowed", async () => {
  // A rename, not a collision — the rule `setUsername` applies to a user.
  const auth = createAuth({
    ...options,
    organizations: fakeOrganizations({ acme: "org_1" }),
  });

  const result = await orgHooks(auth).beforeUpdateOrganization?.({
    organization: { slug: "ACME" },
    member: { organizationId: "org_1" },
  });

  assert.equal(result?.data.slug, "acme");
});

test("renaming to a handle someone else holds is refused", async () => {
  const auth = createAuth({
    ...options,
    organizations: fakeOrganizations({ acme: "org_1" }),
  });

  await assert.rejects(
    async () =>
      orgHooks(auth).beforeUpdateOrganization?.({
        organization: { slug: "acme" },
        member: { organizationId: "org_2" },
      }),
    (error: { body?: { code?: string } }) =>
      error.body?.code === "ORGANIZATION_SLUG_ALREADY_TAKEN",
  );
});

test("an update that does not touch the handle passes through", async () => {
  // Renaming the display name must not require a slug.
  const auth = createAuth({ ...options, organizations: fakeOrganizations() });

  const result = await orgHooks(auth).beforeUpdateOrganization?.({
    organization: {},
    member: { organizationId: "org_1" },
  });

  assert.equal(result, undefined);
});

test("a renamed organization is stamped as updated", async () => {
  // 1.7.5 declares no `updatedAt` on `organization`, so without this it
  // would report its creation time forever.
  const organizations = fakeOrganizations();
  const auth = createAuth({ ...options, organizations });

  await orgHooks(auth).afterUpdateOrganization?.({
    organization: { id: "org_1" },
  });

  assert.deepEqual(organizations.touched, ["org_1"]);
});

test("a stamp that fails does not fail the rename", async () => {
  // The rename already succeeded; bookkeeping must not undo it.
  const organizations = {
    ...fakeOrganizations(),
    touch: () => Promise.reject(new Error("database down")),
  };
  const auth = createAuth({ ...options, organizations });

  await assert.doesNotReject(async () =>
    orgHooks(auth).afterUpdateOrganization?.({
      organization: { id: "org_1" },
    }),
  );
});

test("an invitation address is stored lowercase", async () => {
  // As `user_email` does, so the stored data is consistent.
  const auth = createAuth(options);

  const result = await orgHooks(auth).beforeCreateInvitation?.({
    invitation: { email: "  Dana@Example.TEST " },
  });

  assert.equal(result?.data.email, "dana@example.test");
});

test("organization membership is capped", () => {
  // Bounds an automated signup rather than pricing a plan.
  assert.equal(orgOptions(createAuth(options))["organizationLimit"], 20);
});

test("a handle is still validated when no store is configured", async () => {
  // `organizations` is optional, as `emails` is, so a test can build an auth
  // instance with no database. That must weaken only the uniqueness check —
  // the shape rules are local and have no excuse to be skipped, or a deploy
  // that forgot the wiring would accept `my org` as a handle.
  const auth = createAuth(options);

  await assert.rejects(
    async () =>
      orgHooks(auth).beforeCreateOrganization?.({
        organization: { slug: "my org" },
      }),
    (error: { body?: { code?: string } }) =>
      error.body?.code === "INVALID_ORGANIZATION_SLUG",
  );
});

test("a valid handle is accepted when no store is configured", async () => {
  // So the test above cannot pass by refusing everything.
  const auth = createAuth(options);

  const result = await orgHooks(auth).beforeCreateOrganization?.({
    organization: { slug: "MyOrg" },
  });

  assert.equal(result?.data.slug, "myorg");
});

test("a missing handle is refused rather than stored empty", async () => {
  // The plugin's own body schema requires a slug, but the hook must not be
  // the thing that turns a missing one into `""`.
  const auth = createAuth({ ...options, organizations: fakeOrganizations() });

  await assert.rejects(
    async () => orgHooks(auth).beforeCreateOrganization?.({ organization: {} }),
    (error: { body?: { code?: string } }) =>
      error.body?.code === "INVALID_ORGANIZATION_SLUG",
  );
});

test("any signed-in user may create an organization", () => {
  // Onboarding is self-serve: a client who signs up makes their own workspace
  // without anyone provisioning it. Gating this means replacing the option
  // with a function of the user *and* hiding the web app's create action, so
  // the two cannot drift into offering what the server refuses.
  assert.equal(
    orgOptions(createAuth(options))["allowUserToCreateOrganization"],
    true,
  );
});

// ---- personal organizations -----------------------------------------------
//
// Every account gets one at signup, which is the invariant that lets anything
// ownable take a single non-null `organization_id`. If this hook stops firing,
// nothing fails loudly — new users simply own nothing — so it is pinned here.

/** Records what `createPersonal` was asked for. */
function recordingOrganizations(onCreate?: () => Promise<never>): {
  store: OrganizationStore;
  created: Array<{ userId: string; name: string; preferredSlug: string }>;
} {
  const created: Array<{
    userId: string;
    name: string;
    preferredSlug: string;
  }> = [];
  const store = {
    ...fakeOrganizations(),
    createPersonal: (input: {
      userId: string;
      name: string;
      preferredSlug: string;
    }) => {
      created.push(input);
      if (onCreate !== undefined) {
        return onCreate();
      }
      return Promise.resolve({
        id: "org_personal",
        name: input.name,
        slug: input.preferredSlug,
        kind: "personal" as const,
      });
    },
  };
  return { store, created };
}

test("a new user gets a personal organization named after them", async () => {
  const { store, created } = recordingOrganizations();
  const auth = createAuth({ ...options, organizations: store });

  await userCreateAfterHook(auth)({
    id: "user_1",
    name: "Dana",
    username: "dana",
  });

  assert.deepEqual(created, [
    { userId: "user_1", name: "Dana", preferredSlug: "dana" },
  ]);
});

test("the personal organization takes the handle assigned at signup", async () => {
  // `before` assigns the handle; this runs after, so it is already set.
  const { store, created } = recordingOrganizations();
  const auth = createAuth({ ...options, organizations: store });

  await userCreateAfterHook(auth)({
    id: "user_2",
    name: "Sam Smith",
    username: "sam",
  });

  assert.equal(created[0]?.preferredSlug, "sam");
});

test("a user with no handle falls back to their id", async () => {
  // Not reachable while `before` always assigns one, but a slug is required
  // and an empty one would make an unreachable URL.
  const { store, created } = recordingOrganizations();
  const auth = createAuth({ ...options, organizations: store });

  await userCreateAfterHook(auth)({ id: "user_3", name: "Nameless" });

  assert.equal(created[0]?.preferredSlug, "user_3");
});

test("a failure to create the personal organization does not fail the signup", async () => {
  // The user row is already committed when this runs. Throwing would abort a
  // signup that cannot be retried, because the address is now taken.
  const { store } = recordingOrganizations(() =>
    Promise.reject(new Error("database is down")),
  );
  const auth = createAuth({ ...options, organizations: store });

  await assert.doesNotReject(() =>
    userCreateAfterHook(auth)({
      id: "user_4",
      name: "Dana",
      username: "dana",
    }),
  );
});

test("without an organization store the hook is a no-op", async () => {
  // Tests construct an auth with no organization store; it must not throw.
  const auth = createAuth({ ...options });

  await assert.doesNotReject(() =>
    userCreateAfterHook(auth)({
      id: "user_5",
      name: "Dana",
      username: "dana",
    }),
  );
});

// ---- personal organizations are not shareable -----------------------------
//
// "Personal" has to stay a claim about the organization rather than a label on
// a two-person one, and it must not be deletable: it is minted at signup and
// every account is expected to have one. The three ways in are guarded here.

/** A store reporting one organization of the given kind. */
function organizationsOfKind(kind: "personal" | "team"): OrganizationStore {
  return {
    ...fakeOrganizations(),
    get: () =>
      Promise.resolve({
        id: "org_1",
        name: "Dana",
        slug: "dana",
        kind,
      }),
  };
}

test("inviting someone to a personal organization is refused", async () => {
  const auth = createAuth({
    ...options,
    organizations: organizationsOfKind("personal"),
  });

  await assert.rejects(
    () =>
      orgHooks(auth).beforeCreateInvitation?.({
        invitation: { email: "sam@example.test", organizationId: "org_1" },
      }) ?? Promise.resolve(),
    (error: unknown) => {
      assert.match(String(error), /cannot have other members/);
      return true;
    },
  );
});

test("inviting someone to a team organization still works", async () => {
  // The guard must be specific: this is the ordinary case it sits in front of.
  const auth = createAuth({
    ...options,
    organizations: organizationsOfKind("team"),
  });

  const result = await orgHooks(auth).beforeCreateInvitation?.({
    invitation: { email: "  Sam@Example.test  ", organizationId: "org_1" },
  });

  assert.equal(result?.data.email, "sam@example.test");
});

test("deleting a personal organization is refused", async () => {
  // It goes with the account, by the cascade on `personal_user_id`. Deleting
  // it directly would leave someone owning nothing and no way back.
  const auth = createAuth({ ...options, organizations: fakeOrganizations() });

  await assert.rejects(
    () =>
      orgHooks(auth).beforeDeleteOrganization?.({
        organization: { id: "org_1", kind: "personal" },
      }) ?? Promise.resolve(),
    (error: unknown) => {
      assert.match(String(error), /cannot be deleted/);
      return true;
    },
  );
});

test("deleting a team organization is allowed", async () => {
  const auth = createAuth({ ...options, organizations: fakeOrganizations() });

  await assert.doesNotReject(
    () =>
      orgHooks(auth).beforeDeleteOrganization?.({
        organization: { id: "org_1", kind: "team" },
      }) ?? Promise.resolve(),
  );
});

test("adding a member to a personal organization is refused", async () => {
  // The invitation hook is not the only way in: `addMember` bypasses it.
  const auth = createAuth({ ...options, organizations: fakeOrganizations() });

  await assert.rejects(
    () =>
      orgHooks(auth).beforeAddMember?.({
        organization: { id: "org_1", kind: "personal" },
      }) ?? Promise.resolve(),
    (error: unknown) => {
      assert.match(String(error), /cannot have other members/);
      return true;
    },
  );
});

test("adding a member to a team organization is allowed", async () => {
  const auth = createAuth({ ...options, organizations: fakeOrganizations() });

  await assert.doesNotReject(
    () =>
      orgHooks(auth).beforeAddMember?.({
        organization: { id: "org_1", kind: "team" },
      }) ?? Promise.resolve(),
  );
});
