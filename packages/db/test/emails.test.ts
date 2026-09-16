import assert from "node:assert/strict";
import { test } from "node:test";

import { createEmailStore } from "../src/emails.js";
import { createFakeEmailDb, type EmailRow } from "./fake-email-db.js";

function row(over: Partial<EmailRow> = {}): EmailRow {
  return {
    id: "email_1",
    userId: "user_1",
    email: "first@example.test",
    providerId: "google",
    isPrimary: true,
    createdAt: new Date("2026-09-16T00:00:00.000Z"),
    ...over,
  };
}

test("the first address a user proves becomes primary", async () => {
  // Otherwise `user.email` would be backed by no row here, and the settings
  // page would show an account with no primary address.
  const fake = createFakeEmailDb();
  const store = createEmailStore(fake.db);

  const added = await store.record({
    userId: "user_1",
    email: "first@example.test",
    providerId: "google",
  });

  assert.equal(added?.isPrimary, true);
});

test("a second address is recorded but not primary", async () => {
  const fake = createFakeEmailDb({ emails: [row()] });
  const store = createEmailStore(fake.db);

  const added = await store.record({
    userId: "user_1",
    email: "second@example.test",
    providerId: "github",
  });

  assert.equal(added?.isPrimary, false);
  assert.deepEqual(added?.providers, ["github"]);
});

test("recording the same address and provider twice is idempotent", async () => {
  // Signing in again re-runs the hook every time; it must not duplicate.
  const fake = createFakeEmailDb({ emails: [row()] });
  const store = createEmailStore(fake.db);

  await store.record({
    userId: "user_1",
    email: "first@example.test",
    providerId: "google",
  });

  assert.equal(fake.emails.length, 1);
  assert.equal(fake.emails[0]?.providerId, "google");
});

test("a second provider proving the same address is added to it", async () => {
  // The common case, not an edge case: one inbox registered at both Google
  // and GitHub. Keeping only the first would make the settings page claim
  // GitHub had proved nothing.
  const fake = createFakeEmailDb({ emails: [row()] });
  const store = createEmailStore(fake.db);

  const added = await store.record({
    userId: "user_1",
    email: "first@example.test",
    providerId: "github",
  });

  assert.equal(fake.emails.length, 1, "must not create a duplicate row");
  assert.deepEqual(added?.providers, ["google", "github"]);
});

test("addresses are normalized to lowercase", async () => {
  // Providers differ on casing, and two rows for one inbox would let the same
  // address prove two identities.
  const fake = createFakeEmailDb();
  const store = createEmailStore(fake.db);

  const added = await store.record({
    userId: "user_1",
    email: "  Mixed.Case@Example.TEST  ",
    providerId: "google",
  });

  assert.equal(added?.email, "mixed.case@example.test");
});

test("an address already proven by someone else is refused", async () => {
  // The security property: one inbox proves at most one identity, so a second
  // person linking it cannot quietly take it over.
  const fake = createFakeEmailDb({
    emails: [row({ userId: "user_other" })],
  });
  const store = createEmailStore(fake.db);

  const added = await store.record({
    userId: "user_1",
    email: "first@example.test",
    providerId: "github",
  });

  assert.equal(added, null);
  assert.equal(fake.emails.length, 1);
});

test("setPrimary moves the flag and mirrors onto user.email", async () => {
  // The mirror is the point: `user.email` is what Better Auth reads, so a
  // primary that disagreed with it would be a split brain.
  const fake = createFakeEmailDb({
    emails: [
      row(),
      row({ id: "email_2", email: "second@example.test", isPrimary: false }),
    ],
    users: [
      {
        id: "user_1",
        email: "first@example.test",
        updatedAt: new Date("2026-09-16T00:00:00.000Z"),
      },
    ],
  });
  const store = createEmailStore(fake.db);

  const updated = await store.setPrimary("user_1", "email_2");

  assert.equal(updated?.email, "second@example.test");
  assert.equal(updated?.isPrimary, true);
  assert.equal(fake.users[0]?.email, "second@example.test");
});

test("setPrimary on an address the user does not own returns undefined", async () => {
  const fake = createFakeEmailDb({ emails: [row({ userId: "user_other" })] });
  const store = createEmailStore(fake.db);

  assert.equal(await store.setPrimary("user_1", "email_1"), undefined);
});

test("remove deletes a secondary address", async () => {
  const fake = createFakeEmailDb({
    emails: [
      row(),
      row({ id: "email_2", email: "second@example.test", isPrimary: false }),
    ],
  });
  const store = createEmailStore(fake.db);

  assert.equal(await store.remove("user_1", "email_2"), "removed");
  assert.equal(fake.emails.length, 1);
});

test("remove refuses to delete the primary address", async () => {
  // `user.email` is not null, so removing the primary would leave the account
  // with no address to contact.
  const fake = createFakeEmailDb({ emails: [row()] });
  const store = createEmailStore(fake.db);

  assert.equal(await store.remove("user_1", "email_1"), "is-primary");
  assert.equal(fake.emails.length, 1);
});

test("remove reports not-found for an unknown id", async () => {
  const fake = createFakeEmailDb({ emails: [row()] });
  const store = createEmailStore(fake.db);

  assert.equal(await store.remove("user_1", "email_nope"), "not-found");
});

test("list keeps a stable order rather than floating the primary", async () => {
  // Promoting an address should change its badge, not make the list jump
  // around under the cursor — so order is by creation, not by primary.
  const fake = createFakeEmailDb({
    emails: [
      row({
        id: "email_2",
        email: "second@example.test",
        isPrimary: false,
        createdAt: new Date("2026-09-16T01:00:00.000Z"),
      }),
      row({ createdAt: new Date("2026-09-16T00:00:00.000Z") }),
    ],
  });
  const store = createEmailStore(fake.db);

  const listed = await store.list("user_1");

  assert.deepEqual(
    listed.map((e) => e.email),
    ["first@example.test", "second@example.test"],
  );
});

test("primaryFor reads the address the account hook needs", async () => {
  // The account-create hook has no endpoint context and the account row has no
  // email, so this lookup is the only way it learns which address to record.
  const fake = createFakeEmailDb({
    users: [
      {
        id: "user_1",
        email: "first@example.test",
        updatedAt: new Date("2026-09-16T00:00:00.000Z"),
      },
    ],
  });
  const store = createEmailStore(fake.db);

  assert.equal(await store.primaryFor("user_1"), "first@example.test");
});

test("primaryFor returns undefined for an unknown user", async () => {
  const fake = createFakeEmailDb();
  const store = createEmailStore(fake.db);

  assert.equal(await store.primaryFor("user_nope"), undefined);
});

// ---- unlinking ------------------------------------------------------------

test("revokeProvider drops one provider's claim but keeps the address", async () => {
  // Unlinking Google when GitHub also proved the address: the address is still
  // proven, just by one fewer provider.
  const fake = createFakeEmailDb({
    emails: [row({ providerId: "google,github" })],
  });
  const store = createEmailStore(fake.db);

  await store.revokeProvider("user_1", "google");

  assert.equal(fake.emails.length, 1);
  assert.equal(fake.emails[0]?.providerId, "github");
});

test("revokeProvider keeps the primary address even with no proof left", async () => {
  // `user.email` is not null and points at the primary, so deleting it would
  // leave the account with no address at all.
  const fake = createFakeEmailDb({ emails: [row({ providerId: "google" })] });
  const store = createEmailStore(fake.db);

  await store.revokeProvider("user_1", "google");

  assert.equal(fake.emails.length, 1);
  assert.equal(fake.emails[0]?.providerId, "");
});

test("revokeProvider deletes a secondary address that has lost its proof", async () => {
  // Nothing vouches for it any more and nothing depends on it, so it goes.
  const fake = createFakeEmailDb({
    emails: [
      row(),
      row({
        id: "email_2",
        email: "second@example.test",
        providerId: "github",
        isPrimary: false,
      }),
    ],
  });
  const store = createEmailStore(fake.db);

  await store.revokeProvider("user_1", "github");

  assert.deepEqual(
    fake.emails.map((entry) => entry.email),
    ["first@example.test"],
  );
});

test("revokeProvider leaves addresses that provider never proved", async () => {
  const fake = createFakeEmailDb({ emails: [row({ providerId: "google" })] });
  const store = createEmailStore(fake.db);

  await store.revokeProvider("user_1", "github");

  assert.equal(fake.emails[0]?.providerId, "google");
});

test("revokeProvider hands primary to a still-proven address and releases the old one", async () => {
  // The release path: unlinking the provider that proved the primary address
  // must not leave that address reserved forever. Another proven address takes
  // over as primary and the old one is freed for whoever can prove it next.
  const fake = createFakeEmailDb({
    emails: [
      row({ providerId: "google" }),
      row({
        id: "email_2",
        email: "second@example.test",
        providerId: "github",
        isPrimary: false,
      }),
    ],
    users: [
      {
        id: "user_1",
        email: "first@example.test",
        updatedAt: new Date("2026-09-16T00:00:00.000Z"),
      },
    ],
  });
  const store = createEmailStore(fake.db);

  await store.revokeProvider("user_1", "google");

  assert.deepEqual(
    fake.emails.map((entry) => entry.email),
    ["second@example.test"],
    "the unproven address must be released",
  );
  assert.equal(fake.emails[0]?.isPrimary, true);
  assert.equal(
    fake.users[0]?.email,
    "second@example.test",
    "user.email must follow the new primary",
  );
});

test("revokeProvider keeps an unprovable primary when nothing can replace it", async () => {
  // Least-bad fallback: `user.email` is not null and points at this row, and
  // an account with no sign-in method left is unreachable anyway. The API
  // refuses to unlink a last provider so this stays unreachable in practice.
  const fake = createFakeEmailDb({
    emails: [row({ providerId: "google" })],
    users: [
      {
        id: "user_1",
        email: "first@example.test",
        updatedAt: new Date("2026-09-16T00:00:00.000Z"),
      },
    ],
  });
  const store = createEmailStore(fake.db);

  await store.revokeProvider("user_1", "google");

  assert.equal(fake.emails.length, 1);
  assert.equal(fake.emails[0]?.providerId, "");
});

test("record refuses an address another account carries as its primary", async () => {
  // `user.email` is a second place an address can live and the unique
  // constraint on `user_email` does not see it. Without this check a provider
  // could prove an address another account already holds, which later fails as
  // a 500 the moment anything writes it onto `user.email`.
  const fake = createFakeEmailDb({
    users: [
      {
        id: "user_other",
        email: "taken@example.test",
        updatedAt: new Date("2026-09-16T00:00:00.000Z"),
      },
    ],
  });
  const store = createEmailStore(fake.db);

  const added = await store.record({
    userId: "user_1",
    email: "taken@example.test",
    providerId: "google",
  });

  assert.equal(added, null);
  assert.equal(fake.emails.length, 0);
});

test("setPrimary refuses when another account holds that address", async () => {
  // Returns undefined — a 404 at the route — rather than letting the
  // `user.email` write throw a constraint violation the caller cannot read.
  const fake = createFakeEmailDb({
    emails: [
      row({ id: "email_2", email: "taken@example.test", isPrimary: false }),
    ],
    users: [
      {
        id: "user_1",
        email: "first@example.test",
        updatedAt: new Date("2026-09-16T00:00:00.000Z"),
      },
      {
        id: "user_other",
        email: "taken@example.test",
        updatedAt: new Date("2026-09-16T00:00:00.000Z"),
      },
    ],
  });
  const store = createEmailStore(fake.db);

  assert.equal(await store.setPrimary("user_1", "email_2"), undefined);
});

// ---- ownerOf ---------------------------------------------------------------
//
// The lookup behind the sign-in pre-flight. It has to consult both tables:
// `user.email` and `user_email.email` are each unique, but neither constraint
// sees the other, so an address free in one can be taken in the other. Missing
// either branch would let the duplicate-account case through.

test("ownerOf finds a holder in user_email", async () => {
  const fake = createFakeEmailDb({ emails: [row({ userId: "user_1" })] });
  const store = createEmailStore(fake.db);

  assert.equal(await store.ownerOf("first@example.test"), "user_1");
});

test("ownerOf finds a holder whose only claim is user.email", async () => {
  // The branch that matters: no `user_email` row at all, yet the address is
  // taken. Checking only `user_email` would call this address free and let a
  // duplicate account be created on it.
  const fake = createFakeEmailDb({
    users: [
      {
        id: "user_2",
        email: "primary@example.test",
        updatedAt: new Date("2026-09-16T00:00:00.000Z"),
      },
    ],
  });
  const store = createEmailStore(fake.db);

  assert.equal(await store.ownerOf("primary@example.test"), "user_2");
});

test("ownerOf returns undefined for a free address", async () => {
  const fake = createFakeEmailDb();
  const store = createEmailStore(fake.db);

  assert.equal(await store.ownerOf("nobody@example.test"), undefined);
});

test("ownerOf normalizes the address before looking it up", async () => {
  // Signup addresses arrive from a provider in whatever case it reports, and
  // the rows are stored lowercased; without this the pre-flight would miss.
  const fake = createFakeEmailDb({ emails: [row({ userId: "user_1" })] });
  const store = createEmailStore(fake.db);

  assert.equal(await store.ownerOf("  FIRST@Example.TEST  "), "user_1");
});
