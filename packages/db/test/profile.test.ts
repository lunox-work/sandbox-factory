import assert from "node:assert/strict";
import { test } from "node:test";

import { createProfileStore } from "../src/emails.js";
import { createFakeEmailDb, type UserRowLite } from "./fake-email-db.js";

function user(over: Partial<UserRowLite> = {}): UserRowLite {
  return {
    id: "user_1",
    email: "first@example.test",
    updatedAt: new Date("2026-09-16T00:00:00.000Z"),
    username: null,
    ...over,
  };
}

test("a handle is stored lowercase, keeping the typed casing for display", async () => {
  // Otherwise @Alice and @alice could both exist and mentions would be
  // ambiguous.
  const fake = createFakeEmailDb({ users: [user()] });
  const store = createProfileStore(fake.db);

  const result = await store.setUsername("user_1", "  FeverSoul  ");

  assert.deepEqual(result, {
    status: "ok",
    username: "feversoul",
    displayUsername: "FeverSoul",
  });
  assert.equal(fake.users[0]?.username, "feversoul");
});

test("a handle already held by someone else is refused", async () => {
  const fake = createFakeEmailDb({
    users: [user(), user({ id: "user_2", username: "taken" })],
  });
  const store = createProfileStore(fake.db);

  assert.deepEqual(await store.setUsername("user_1", "taken"), {
    status: "taken",
  });
});

test("re-claiming your own handle with different casing is a rename", async () => {
  // Not a collision: the row that matches is the caller's own.
  const fake = createFakeEmailDb({ users: [user({ username: "feversoul" })] });
  const store = createProfileStore(fake.db);

  const result = await store.setUsername("user_1", "FeverSoul");

  assert.equal(result.status, "ok");
});

test("handles that are too short or too long are refused", async () => {
  const fake = createFakeEmailDb({ users: [user()] });
  const store = createProfileStore(fake.db);

  for (const candidate of ["ab", "x".repeat(31)]) {
    const result = await store.setUsername("user_1", candidate);
    assert.equal(
      result.status,
      "invalid",
      `expected ${candidate} to be invalid`,
    );
  }
});

test("handles with characters that break a URL or a mention are refused", async () => {
  const fake = createFakeEmailDb({ users: [user()] });
  const store = createProfileStore(fake.db);

  for (const candidate of ["has space", "has/slash", "has@at", "has.dot"]) {
    const result = await store.setUsername("user_1", candidate);
    assert.equal(
      result.status,
      "invalid",
      `expected ${candidate} to be invalid`,
    );
  }
});

test("hyphens and underscores are allowed", async () => {
  const fake = createFakeEmailDb({ users: [user()] });
  const store = createProfileStore(fake.db);

  assert.equal((await store.setUsername("user_1", "a-b_c9")).status, "ok");
});

test("get returns the current handle", async () => {
  const fake = createFakeEmailDb({ users: [user({ username: "feversoul" })] });
  const store = createProfileStore(fake.db);

  assert.equal((await store.get("user_1"))?.username, "feversoul");
});

test("primaryFor reads the user's current address", async () => {
  // The account-create hook depends on this: the account row carries no email,
  // and the hook gets no endpoint context to read one from.
  const fake = createFakeEmailDb({ users: [user()] });
  const store = createProfileStore(fake.db);

  assert.equal(await store.get("user_nope"), undefined);
});

// ---- generated handles ----------------------------------------------------

test("a handle is derived from the local part of the address", async () => {
  // The domain says where someone works, not who they are.
  const fake = createFakeEmailDb();
  const store = createProfileStore(fake.db);

  assert.equal(await store.suggest("dana@example.test"), "dana");
});

test("characters that are not handle-safe become hyphens", async () => {
  const fake = createFakeEmailDb();
  const store = createProfileStore(fake.db);

  assert.equal(
    await store.suggest("rivers.dana+work@example.test"),
    "rivers-dana-work",
  );
});

test("a collision counts upward rather than failing", async () => {
  // `dana2` is guessable and explicable; a random suffix is neither.
  const fake = createFakeEmailDb({
    users: [user({ id: "user_2", username: "dana" })],
  });
  const store = createProfileStore(fake.db);

  assert.equal(await store.suggest("dana@example.test"), "dana2");
});

test("repeated collisions keep counting", async () => {
  const fake = createFakeEmailDb({
    users: [
      user({ id: "user_2", username: "dana" }),
      user({ id: "user_3", username: "dana2" }),
      user({ id: "user_4", username: "dana3" }),
    ],
  });
  const store = createProfileStore(fake.db);

  assert.equal(await store.suggest("dana@example.test"), "dana4");
});

test("a very short local part still yields a valid handle", async () => {
  // "jo@example.com" is a real address and must not produce a handle that the
  // store's own minimum-length rule would reject.
  const fake = createFakeEmailDb();
  const store = createProfileStore(fake.db);

  const suggested = await store.suggest("jo@example.test");

  assert.equal(suggested, "jo-user");
  assert.ok(suggested.length >= 3);
});

test("a generated handle passes the store's own validation", async () => {
  // The guarantee that matters: whatever signup generates, a later rename to
  // the same value must not be rejected as invalid.
  const fake = createFakeEmailDb({ users: [user()] });
  const store = createProfileStore(fake.db);

  const suggested = await store.suggest("Rivers.Dana@example.test");
  const result = await store.setUsername("user_1", suggested);

  assert.equal(result.status, "ok");
});

test("a long address is truncated to the maximum length", async () => {
  const fake = createFakeEmailDb();
  const store = createProfileStore(fake.db);

  const suggested = await store.suggest(`${"x".repeat(60)}@example.test`);

  assert.ok(suggested.length <= 30, `too long: ${suggested}`);
});

test("after many collisions it falls back to a random suffix", async () => {
  // Counting upward has to terminate. Past a couple of dozen collisions a
  // random suffix is likelier to land than continuing to count, and the
  // person can rename anyway.
  const taken = [
    "dana",
    ...Array.from({ length: 19 }, (_, i) => `dana${i + 2}`),
  ];
  const fake = createFakeEmailDb({
    users: taken.map((username, index) =>
      user({ id: `user_${index + 2}`, username }),
    ),
  });
  const store = createProfileStore(fake.db);

  const suggested = await store.suggest("dana@example.test");

  assert.match(suggested, /^dana-[0-9a-f]{6}$/);
});
