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
  // Otherwise @Alice and @alice could both exist.
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

test("a team's handle is as taken as a person's", async () => {
  // Users and organizations share one namespace: `/o/acme` cannot mean a
  // team and a person at once.
  const fake = createFakeEmailDb({
    users: [user()],
    teams: [{ handle: "acme", organizationId: "org_acme" }],
  });
  const store = createProfileStore(fake.db);

  assert.deepEqual(await store.setUsername("user_1", "Acme"), {
    status: "taken",
  });
  assert.equal(fake.users[0]?.username, null);
});

test("a handle claimed between the check and the write is still taken", async () => {
  // The check found it free; the primary key is what refuses the write.
  const fake = createFakeEmailDb({
    users: [user()],
    racingTeam: { handle: "contested", organizationId: "org_race" },
  });
  const store = createProfileStore(fake.db);

  assert.deepEqual(await store.setUsername("user_1", "contested"), {
    status: "taken",
  });
});

test("a failed write that is not a collision is not reported as taken", async () => {
  const fake = createFakeEmailDb({ users: [user()] });
  const failing = new Proxy(fake.db, {
    get(target, property, receiver) {
      if (property === "update") {
        return () => {
          throw new Error("connection lost");
        };
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
  const store = createProfileStore(failing);

  await assert.rejects(store.setUsername("user_1", "anything"), {
    message: "connection lost",
  });
});

test("re-claiming your own handle with different casing is a rename", async () => {
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
  // The account-create hook depends on this: the account row has no email.
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

test("a suggestion steps around a team's handle too", async () => {
  // Otherwise a new account would be minted onto a team's handle, and the
  // database would refuse the signup.
  const fake = createFakeEmailDb({
    teams: [{ handle: "dana", organizationId: "org_dana" }],
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
  // "jo@example.com" must not yield a handle below the minimum length.
  const fake = createFakeEmailDb();
  const store = createProfileStore(fake.db);

  const suggested = await store.suggest("jo@example.test");

  assert.equal(suggested, "jo-user");
  assert.ok(suggested.length >= 3);
});

test("a generated handle passes the store's own validation", async () => {
  // A later rename to the generated value must not be rejected.
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
  // Counting upward has to terminate.
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

test("a local part of only hyphens still yields a valid handle", async () => {
  // The stem trims to empty. Pins the hand-rolled `trimHyphens`, which
  // replaces a regex CodeQL flags as polynomial ReDoS.
  const fake = createFakeEmailDb({ users: [] });
  const store = createProfileStore(fake.db);

  const suggested = await store.suggest(`${"-".repeat(200)}@example.test`);

  assert.equal(suggested, "-user");
  assert.ok(suggested.length >= 3);
});

test("surrounding hyphens are trimmed but inner ones are kept", async () => {
  const fake = createFakeEmailDb({ users: [] });
  const store = createProfileStore(fake.db);

  assert.equal(
    await store.suggest("--dana--rivers--@example.test"),
    "dana--rivers",
  );
});

test("image reads the picture the account shows now", async () => {
  const picture = `/api/avatars/user/user_1/${"b".repeat(64)}.webp`;
  const fake = createFakeEmailDb({
    users: [user({ image: picture }), user({ id: "user_2" })],
  });
  const store = createProfileStore(fake.db);

  assert.equal(await store.image("user_1"), picture);
  // No picture reads as null — the identicon — not as undefined.
  assert.equal(await store.image("user_2"), null);
  assert.equal(await store.image("user_nobody"), null);
});
