import assert from "node:assert/strict";
import { test } from "node:test";

import { createContributorStore } from "../src/contributors.js";
import type { ContributorInviteRow } from "../src/schema.js";
import { createFakeDb, createSequencedFakeDb } from "./fake-db.js";

const now = new Date("2026-11-15T00:00:00Z");
const later = new Date("2026-11-29T00:00:00Z");
const inviteRow = (
  overrides: Partial<ContributorInviteRow> = {},
): ContributorInviteRow => ({
  id: "cin_1",
  organizationId: "org_1",
  sandboxVersionId: "sbv_1",
  createdBy: "user_owner",
  emailHint: "grace@example.test",
  label: "Grace",
  tokenSha256: "a".repeat(64),
  expiresAt: later,
  maxClaims: 1,
  claims: 0,
  revokedAt: null,
  claimedBy: null,
  claimedAt: null,
  createdAt: now,
  ...overrides,
});
const joined = (overrides: Partial<ContributorInviteRow> = {}) => ({
  invite: inviteRow(overrides),
  createdByName: "Ada Lovelace",
});
const assignmentRow = (overrides: Record<string, unknown> = {}) => ({
  id: "cas_1",
  organizationId: "org_1",
  sandboxVersionId: "sbv_1",
  userId: "user_c",
  userName: "Grace Hopper",
  userEmail: "grace@example.test",
  inviteId: "cin_1",
  createdAt: now,
  revokedAt: null,
  ...overrides,
});
const duplicate = () =>
  Object.assign(new Error("duplicate"), { code: "23505" });

test("an invite is made only for the owner's version, its hash kept and never the secret", async () => {
  const fake = createSequencedFakeDb([[{ id: "sbv_1" }], [], [joined()]]);
  const store = createContributorStore(fake.db);
  const invite = await store.createInvite("org_1", {
    sandboxVersionId: "sbv_1",
    createdBy: "user_owner",
    emailHint: "grace@example.test",
    label: "Grace",
    tokenSha256: "a".repeat(64),
    expiresAt: later,
    maxClaims: 1,
  });
  assert.deepEqual(invite?.createdBy, {
    id: "user_owner",
    name: "Ada Lovelace",
  });
  assert.equal(invite?.organizationId, "org_1");
  assert.equal(fake.calls[0]?.filtered, true);
  assert.equal(fake.calls[1]?.kind, "insert");
  assert.match(String(fake.calls[1]?.values?.["id"]), /^cin_/);
  assert.equal(fake.calls[1]?.values?.["organizationId"], "org_1");
  assert.equal(fake.calls[1]?.values?.["tokenSha256"], "a".repeat(64));
  assert.equal("token" in (fake.calls[1]?.values ?? {}), false);
  // Another workspace's version, or none: nothing is made.
  const missing = createSequencedFakeDb([[]]);
  assert.equal(
    await createContributorStore(missing.db).createInvite("org_2", {
      sandboxVersionId: "sbv_1",
      createdBy: "user_owner",
      emailHint: null,
      label: null,
      tokenSha256: "b".repeat(64),
      expiresAt: later,
      maxClaims: 1,
    }),
    null,
  );
  assert.equal(missing.calls.length, 1);
  await assert.rejects(
    createContributorStore(
      createSequencedFakeDb([[{ id: "sbv_1" }], [], []]).db,
    ).createInvite("org_1", {
      sandboxVersionId: "sbv_1",
      createdBy: "user_owner",
      emailHint: null,
      label: null,
      tokenSha256: "c".repeat(64),
      expiresAt: later,
      maxClaims: 1,
    }),
    /no row/,
  );
});

test("invites and assignments are listed and revoked under their owner", async () => {
  const invites = createFakeDb([
    joined(),
    {
      invite: inviteRow({ id: "cin_2", createdBy: null }),
      createdByName: null,
    },
  ]);
  const listed = await createContributorStore(invites.db).listInvites(
    "org_1",
    "sbv_1",
  );
  assert.deepEqual(
    listed.map((invite) => [invite.id, invite.createdBy?.id ?? null]),
    [
      ["cin_1", "user_owner"],
      ["cin_2", null],
    ],
  );
  assert.equal(invites.calls[0]?.filtered, true);
  assert.equal(invites.calls[0]?.ordered, true);

  const revoked = createSequencedFakeDb([
    [{ id: "cin_1" }],
    [joined({ revokedAt: now })],
  ]);
  const invite = await createContributorStore(revoked.db).revokeInvite(
    "org_1",
    "cin_1",
    now,
  );
  assert.equal(invite?.revokedAt, now);
  assert.equal(revoked.calls[0]?.kind, "update");
  assert.equal(revoked.calls[0]?.filtered, true);
  assert.equal(
    await createContributorStore(createSequencedFakeDb([[]]).db).revokeInvite(
      "org_2",
      "cin_1",
      now,
    ),
    null,
  );

  const assignments = createFakeDb([assignmentRow()]);
  const people = await createContributorStore(assignments.db).listAssignments(
    "org_1",
    "sbv_1",
  );
  assert.deepEqual(people[0]?.user, {
    id: "user_c",
    name: "Grace Hopper",
    email: "grace@example.test",
  });
  assert.equal(assignments.calls[0]?.filtered, true);

  const ended = createSequencedFakeDb([
    [{ id: "cas_1" }],
    [assignmentRow({ revokedAt: now })],
  ]);
  assert.equal(
    (
      await createContributorStore(ended.db).revokeAssignment(
        "org_1",
        "cas_1",
        now,
      )
    )?.revokedAt,
    now,
  );
  assert.equal(
    await createContributorStore(
      createSequencedFakeDb([[]]).db,
    ).revokeAssignment("org_2", "cas_1", now),
    null,
  );
});

test("an invite is found by its hash, and a person's live assignments by them", async () => {
  const found = createFakeDb([joined()]);
  const invite = await createContributorStore(found.db).findInvite(
    "a".repeat(64),
  );
  assert.equal(invite?.id, "cin_1");
  assert.equal(found.calls[0]?.filtered, true);
  assert.equal(
    await createContributorStore(createFakeDb([]).db).findInvite("x"),
    null,
  );
  const mine = createFakeDb([assignmentRow()]);
  const store = createContributorStore(mine.db);
  assert.equal((await store.assignmentFor("user_c", "sbv_1"))?.id, "cas_1");
  assert.deepEqual(
    (await store.assignmentsOf("user_c")).map((a) => a.id),
    ["cas_1"],
  );
  assert.equal(
    mine.calls.every((call) => call.filtered === true),
    true,
  );
  assert.equal(
    await createContributorStore(createFakeDb([]).db).assignmentFor(
      "user_x",
      "sbv_1",
    ),
    null,
  );
});

test("a claim makes one assignment under the invite's lock, and counts it", async () => {
  const fake = createSequencedFakeDb([
    [inviteRow()],
    [],
    [],
    [],
    [assignmentRow()],
  ]);
  const claimed = await createContributorStore(fake.db).claim(
    "org_1",
    "cin_1",
    "user_c",
    now,
  );
  assert.deepEqual(claimed.ok && [claimed.created, claimed.assignment.id], [
    true,
    "cas_1",
  ]);
  assert.equal(fake.calls[0]?.lock, "update");
  assert.equal(fake.calls[2]?.kind, "insert");
  assert.match(String(fake.calls[2]?.values?.["id"]), /^cas_/);
  assert.equal(fake.calls[2]?.values?.["userId"], "user_c");
  assert.equal(fake.calls[2]?.values?.["inviteId"], "cin_1");
  assert.equal(fake.calls[3]?.kind, "update");

  // Already theirs: answered as it stands, the invite not spent again.
  const held = createSequencedFakeDb([
    [inviteRow({ claims: 1 })],
    [{ id: "cas_1" }],
    [assignmentRow()],
  ]);
  const again = await createContributorStore(held.db).claim(
    "org_1",
    "cin_1",
    "user_c",
    now,
  );
  assert.deepEqual(again.ok && again.created, false);
  assert.equal(
    held.calls.some((call) => call.kind !== "select"),
    false,
  );

  const outcome = async (
    responses: readonly (readonly unknown[] | Error)[],
  ) => {
    const result = await createContributorStore(
      createSequencedFakeDb(responses).db,
    ).claim("org_1", "cin_1", "user_c", now);
    return result.ok ? "ok" : result.reason;
  };
  assert.equal(await outcome([[]]), "unavailable");
  assert.equal(
    await outcome([[inviteRow({ revokedAt: now })], []]),
    "unavailable",
  );
  assert.equal(
    await outcome([[inviteRow({ expiresAt: now })], []]),
    "unavailable",
  );
  assert.equal(await outcome([[inviteRow({ claims: 1 })], []]), "unavailable");
  assert.equal(
    await outcome([[inviteRow()], [{ id: "cas_1" }], []]),
    "unavailable",
  );
  await assert.rejects(
    createContributorStore(
      createSequencedFakeDb([[inviteRow()], [], [], [], []]).db,
    ).claim("org_1", "cin_1", "user_c", now),
    /no row/,
  );
  // The same person twice at once: the loser finds the winner's.
  assert.equal(
    await outcome([
      [inviteRow()],
      [],
      duplicate(),
      [joined()],
      [{ id: "cas_1" }],
      [assignmentRow()],
    ]),
    "ok",
  );
  assert.equal(
    await outcome([[inviteRow()], [], duplicate(), []]),
    "unavailable",
  );
  assert.equal(
    await outcome([[inviteRow()], [], duplicate(), [joined()], []]),
    "unavailable",
  );
  await assert.rejects(
    createContributorStore(
      createSequencedFakeDb([[inviteRow()], [], new Error("down")]).db,
    ).claim("org_1", "cin_1", "user_c", now),
    /down/,
  );
});
