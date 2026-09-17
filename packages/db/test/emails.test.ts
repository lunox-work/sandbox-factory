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
  // Otherwise `user.email` would be backed by no row here.
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
  // The common case: one inbox registered at both Google and GitHub.
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
  // Providers differ on casing; two rows would let one inbox prove two
  // identities.
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
  // The security property: one inbox proves at most one identity.
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
  // `user.email` is what Better Auth reads, so the two must agree.
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
  // `user.email` is not null, so the account must keep a primary.
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
  // Promoting an address changes its badge, not the list order.
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
  // The account-create hook has no endpoint context and the account row no
  // email, so this is how it learns which address to record.
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
  // Unlinking Google when GitHub also proved the address.
  const fake = createFakeEmailDb({
    emails: [row({ providerId: "google,github" })],
  });
  const store = createEmailStore(fake.db);

  await store.revokeProvider("user_1", "google");

  assert.equal(fake.emails.length, 1);
  assert.equal(fake.emails[0]?.providerId, "github");
});

test("revokeProvider keeps the primary address even with no proof left", async () => {
  // `user.email` is not null and points at the primary.
  const fake = createFakeEmailDb({ emails: [row({ providerId: "google" })] });
  const store = createEmailStore(fake.db);

  await store.revokeProvider("user_1", "google");

  assert.equal(fake.emails.length, 1);
  assert.equal(fake.emails[0]?.providerId, "");
});

test("revokeProvider deletes a secondary address that has lost its proof", async () => {
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
  // Unlinking must not leave the old primary address reserved forever.
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
  // Least-bad fallback. The API refuses to unlink a last provider, so this
  // is unreachable in practice.
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
  // `user.email` is a second place an address can live, with no row in
  // `user_email`.
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
  // Returns undefined (a 404 at the route) rather than letting the
  // `user.email` write throw.
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
// The sign-in pre-flight lookup. It must consult both `user_email` and
// `user.email`; missing either lets a duplicate account through.

test("ownerOf finds a holder in user_email", async () => {
  const fake = createFakeEmailDb({ emails: [row({ userId: "user_1" })] });
  const store = createEmailStore(fake.db);

  assert.equal(await store.ownerOf("first@example.test"), "user_1");
});

test("ownerOf finds a holder whose only claim is user.email", async () => {
  // No `user_email` row at all, yet the address is taken.
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
  // Providers report any casing; rows are stored lowercased.
  const fake = createFakeEmailDb({ emails: [row({ userId: "user_1" })] });
  const store = createEmailStore(fake.db);

  assert.equal(await store.ownerOf("  FIRST@Example.TEST  "), "user_1");
});
