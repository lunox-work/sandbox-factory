import assert from "node:assert/strict";
import { test } from "node:test";

import { createOrganizationStore } from "../src/organizations.js";
import {
  createFakeOrganizationDb,
  type InvitationRowLite,
  type MemberRowLite,
} from "./fake-organization-db.js";

/**
 * The organization store's reads. The plugin owns every write, so what is
 * tested here is scoping and shaping: which rows a query asks for, and that a
 * caller never receives another organization's.
 */

const acme = { id: "org_1", name: "Acme", slug: "acme", kind: "team" };
const globex = { id: "org_2", name: "Globex", slug: "globex", kind: "team" };

/** What `acme` looks like once the store has narrowed `kind`. */
const acmeSummary = {
  id: "org_1",
  name: "Acme",
  slug: "acme",
  kind: "team" as const,
  // No picture: the identicon.
  image: null,
};

function member(over: Partial<MemberRowLite> = {}): MemberRowLite {
  return {
    id: "mem_1",
    organizationId: acme.id,
    userId: "user_1",
    role: "owner",
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    ...over,
  };
}

function invitation(over: Partial<InvitationRowLite> = {}): InvitationRowLite {
  return {
    id: "inv_1",
    organizationId: acme.id,
    email: "dana@example.test",
    role: "member",
    status: "pending",
    inviterId: "user_1",
    // Well ahead of any test's clock.
    expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    createdAt: new Date("2026-09-10T00:00:00.000Z"),
    ...over,
  };
}

// ---- memberships ----------------------------------------------------------

test("listForUser returns only the organizations the user is in", () => {
  // The switcher reads this: another client's organization appearing here
  // would be a cross-tenant leak on the first page load.
  const fake = createFakeOrganizationDb({
    organizations: [acme, globex],
    members: [
      member(),
      member({ id: "mem_2", organizationId: globex.id, userId: "user_2" }),
    ],
  });

  return createOrganizationStore(fake.db)
    .listForUser("user_1")
    .then((found) => {
      assert.deepEqual(found, [{ ...acmeSummary, role: "owner" }]);
    });
});

test("listForUser carries the role held in each organization", async () => {
  const fake = createFakeOrganizationDb({
    organizations: [acme, globex],
    members: [
      member({ role: "owner" }),
      member({
        id: "mem_2",
        organizationId: globex.id,
        role: "member",
        createdAt: new Date("2026-09-02T00:00:00.000Z"),
      }),
    ],
  });

  const found = await createOrganizationStore(fake.db).listForUser("user_1");

  assert.deepEqual(
    found.map((entry) => [entry.slug, entry.role]),
    [
      ["acme", "owner"],
      ["globex", "member"],
    ],
  );
});

test("memberships are listed oldest first", async () => {
  // A stable order: a role change must not reshuffle the switcher.
  const fake = createFakeOrganizationDb({
    organizations: [acme, globex],
    members: [
      member({
        id: "mem_2",
        organizationId: globex.id,
        createdAt: new Date("2026-09-05T00:00:00.000Z"),
      }),
      member({ createdAt: new Date("2026-09-01T00:00:00.000Z") }),
    ],
  });

  const found = await createOrganizationStore(fake.db).listForUser("user_1");

  assert.deepEqual(
    found.map((entry) => entry.slug),
    ["acme", "globex"],
  );
});

test("a user in no organization gets an empty list, not an error", async () => {
  const fake = createFakeOrganizationDb({ organizations: [acme] });

  assert.deepEqual(
    await createOrganizationStore(fake.db).listForUser("user_nobody"),
    [],
  );
});

// ---- the membership check -------------------------------------------------

test("roleOf answers with the caller's role in that organization", async () => {
  const fake = createFakeOrganizationDb({
    organizations: [acme],
    members: [member({ role: "admin" })],
  });

  assert.equal(
    await createOrganizationStore(fake.db).roleOf("user_1", "org_1"),
    "admin",
  );
});

test("roleOf is undefined for a non-member", async () => {
  // This is what the route turns into a 404: a non-member must not learn
  // whether the organization exists.
  const fake = createFakeOrganizationDb({
    organizations: [acme],
    members: [member()],
  });

  assert.equal(
    await createOrganizationStore(fake.db).roleOf("user_2", "org_1"),
    undefined,
  );
});

test("roleOf does not leak a role across organizations", async () => {
  // Owner of Acme, nothing in Globex. Matching on user alone would make them
  // an owner everywhere.
  const fake = createFakeOrganizationDb({
    organizations: [acme, globex],
    members: [member({ role: "owner" })],
  });

  assert.equal(
    await createOrganizationStore(fake.db).roleOf("user_1", "org_2"),
    undefined,
  );
});

// ---- handles --------------------------------------------------------------

test("findBySlug looks a handle up case-insensitively", async () => {
  // Handles are stored lowercase, so a URL typed in another case must still
  // resolve rather than 404.
  const fake = createFakeOrganizationDb({ organizations: [acme] });

  const found = await createOrganizationStore(fake.db).findBySlug("  ACME  ");

  assert.equal(found?.id, "org_1");
});

test("findBySlug is undefined for a handle nobody holds", async () => {
  const fake = createFakeOrganizationDb({ organizations: [acme] });

  assert.equal(
    await createOrganizationStore(fake.db).findBySlug("nobody"),
    undefined,
  );
});

test("slugOwner names the organization holding a handle", async () => {
  const fake = createFakeOrganizationDb({ organizations: [acme] });

  assert.equal(
    await createOrganizationStore(fake.db).slugOwner("acme"),
    "org_1",
  );
});

test("slugOwner ignores the organization being renamed", async () => {
  // Re-saving your own handle in different casing is a rename, not a
  // collision — the same rule `setUsername` applies to a user.
  const fake = createFakeOrganizationDb({ organizations: [acme] });

  assert.equal(
    await createOrganizationStore(fake.db).slugOwner("ACME", "org_1"),
    undefined,
  );
});

test("slugOwner names a user holding a handle", async () => {
  // One namespace: a team cannot take a handle a person holds.
  const fake = createFakeOrganizationDb({ users: [person("user_1", "dana")] });

  assert.equal(
    await createOrganizationStore(fake.db).slugOwner("Dana"),
    "user_1",
  );
});

test("slugOwner answers for a personal organization with its owner", async () => {
  // Its handle is its owner's username, not a claim of its own.
  const fake = createFakeOrganizationDb({
    users: [person("user_1", "dana")],
    organizations: [
      {
        id: "org_personal",
        name: "Dana",
        slug: "dana",
        kind: "personal",
        personalUserId: "user_1",
      },
    ],
  });

  assert.equal(
    await createOrganizationStore(fake.db).slugOwner("dana", "org_personal"),
    "user_1",
  );
});

test("slugOwner still refuses a handle another organization holds", async () => {
  const fake = createFakeOrganizationDb({ organizations: [acme, globex] });

  assert.equal(
    await createOrganizationStore(fake.db).slugOwner("acme", "org_2"),
    "org_1",
  );
});

test("get reads one organization by its permanent id", async () => {
  const fake = createFakeOrganizationDb({ organizations: [acme] });

  assert.deepEqual(
    await createOrganizationStore(fake.db).get("org_1"),
    acmeSummary,
  );
});

test("get is undefined for an unknown id", async () => {
  const fake = createFakeOrganizationDb({ organizations: [acme] });

  assert.equal(await createOrganizationStore(fake.db).get("org_9"), undefined);
});

// ---- members --------------------------------------------------------------

test("listMembers joins the handle each member is known by", async () => {
  const fake = createFakeOrganizationDb({
    organizations: [acme],
    members: [member()],
    users: [
      { id: "user_1", name: "Dana", username: "dana", image: null },
      { id: "user_2", name: "Sam", username: "sam", image: null },
    ],
  });

  const found = await createOrganizationStore(fake.db).listMembers("org_1");

  assert.deepEqual(found, [
    {
      id: "mem_1",
      userId: "user_1",
      role: "owner",
      name: "Dana",
      username: "dana",
      image: null,
    },
  ]);
});

test("listMembers returns only that organization's members", async () => {
  const fake = createFakeOrganizationDb({
    organizations: [acme, globex],
    members: [
      member(),
      member({ id: "mem_2", organizationId: globex.id, userId: "user_2" }),
    ],
    users: [
      { id: "user_1", name: "Dana", username: "dana", image: null },
      { id: "user_2", name: "Sam", username: "sam", image: null },
    ],
  });

  const found = await createOrganizationStore(fake.db).listMembers("org_1");

  assert.deepEqual(
    found.map((entry) => entry.userId),
    ["user_1"],
  );
});

test("members are listed oldest first", async () => {
  const fake = createFakeOrganizationDb({
    organizations: [acme],
    members: [
      member({
        id: "mem_2",
        userId: "user_2",
        createdAt: new Date("2026-09-09T00:00:00.000Z"),
      }),
      member({ createdAt: new Date("2026-09-01T00:00:00.000Z") }),
    ],
    users: [
      { id: "user_1", name: "Dana", username: "dana", image: null },
      { id: "user_2", name: "Sam", username: "sam", image: null },
    ],
  });

  const found = await createOrganizationStore(fake.db).listMembers("org_1");

  assert.deepEqual(
    found.map((entry) => entry.userId),
    ["user_1", "user_2"],
  );
});

// ---- invitations ----------------------------------------------------------

test("pendingFor finds invitations addressed to the caller", async () => {
  const fake = createFakeOrganizationDb({
    organizations: [acme],
    invitations: [invitation()],
  });

  const found = await createOrganizationStore(fake.db).pendingFor(
    "dana@example.test",
  );

  assert.equal(found.length, 1);
  assert.equal(found[0]?.id, "inv_1");
  assert.deepEqual(found[0]?.organization, acmeSummary);
  assert.equal(found[0]?.role, "member");
});

test("pendingFor matches the address case-insensitively", async () => {
  // `user.email` is stored lowercase, but a caller may pass any casing.
  const fake = createFakeOrganizationDb({
    organizations: [acme],
    invitations: [invitation()],
  });

  const found = await createOrganizationStore(fake.db).pendingFor(
    "  Dana@Example.test ",
  );

  assert.equal(found.length, 1);
});

test("pendingFor shows nothing addressed to someone else", async () => {
  const fake = createFakeOrganizationDb({
    organizations: [acme],
    invitations: [invitation()],
  });

  assert.deepEqual(
    await createOrganizationStore(fake.db).pendingFor("sam@example.test"),
    [],
  );
});

test("pendingFor ignores invitations already answered", async () => {
  const fake = createFakeOrganizationDb({
    organizations: [acme],
    invitations: [
      invitation({ id: "inv_1", status: "accepted" }),
      invitation({ id: "inv_2", status: "rejected" }),
      invitation({ id: "inv_3", status: "canceled" }),
    ],
  });

  assert.deepEqual(
    await createOrganizationStore(fake.db).pendingFor("dana@example.test"),
    [],
  );
});

test("an expired invitation is hidden rather than offered", async () => {
  // Nothing sweeps the table, so an expired row stays `pending`. Offering an
  // accept that the plugin would refuse is worse than not offering it.
  const fake = createFakeOrganizationDb({
    organizations: [acme],
    invitations: [
      invitation({
        id: "inv_old",
        expiresAt: new Date("2020-01-01T00:00:00.000Z"),
      }),
      invitation({ id: "inv_live" }),
    ],
  });

  const found = await createOrganizationStore(fake.db).pendingFor(
    "dana@example.test",
  );

  assert.deepEqual(
    found.map((entry) => entry.id),
    ["inv_live"],
  );
});

test("invitations are listed newest first", async () => {
  const fake = createFakeOrganizationDb({
    organizations: [acme, globex],
    invitations: [
      invitation({
        id: "inv_older",
        createdAt: new Date("2026-09-01T00:00:00.000Z"),
      }),
      invitation({
        id: "inv_newer",
        organizationId: globex.id,
        createdAt: new Date("2026-09-12T00:00:00.000Z"),
      }),
    ],
  });

  const found = await createOrganizationStore(fake.db).pendingFor(
    "dana@example.test",
  );

  assert.deepEqual(
    found.map((entry) => entry.id),
    ["inv_newer", "inv_older"],
  );
});

// ---- updatedAt ------------------------------------------------------------

test("touch stamps the organization as updated", async () => {
  // The plugin declares no `updatedAt` on `organization`, so a rename would
  // otherwise leave the column at its creation value forever.
  const before = new Date("2026-09-01T00:00:00.000Z");
  const fake = createFakeOrganizationDb({
    organizations: [{ ...acme, updatedAt: before }],
  });

  await createOrganizationStore(fake.db).touch("org_1");

  assert.equal(fake.updates.length, 1);
  assert.equal(fake.updates[0]?.table, "organization");
  const stamped = fake.organizations[0]?.updatedAt;
  assert.ok(
    stamped !== undefined && stamped.getTime() > before.getTime(),
    "expected updatedAt to move forward",
  );
});

// ---- pictures ------------------------------------------------------------

const acmePicture = `/api/avatars/organization/org_1/${"a".repeat(64)}.webp`;

test("a summary carries the picture from the logo column as image", async () => {
  const fake = createFakeOrganizationDb({
    organizations: [{ ...acme, logo: acmePicture }],
    members: [member()],
  });
  const store = createOrganizationStore(fake.db);

  assert.equal((await store.get("org_1"))?.image, acmePicture);
  assert.equal((await store.listForUser("user_1"))[0]?.image, acmePicture);
});

test("setLogo writes the picture and stamps updatedAt with it", async () => {
  const before = new Date("2026-09-01T00:00:00.000Z");
  const fake = createFakeOrganizationDb({
    organizations: [{ ...acme, updatedAt: before }, globex],
  });

  await createOrganizationStore(fake.db).setLogo("org_1", acmePicture);

  assert.equal(fake.organizations[0]?.logo, acmePicture);
  assert.ok(
    (fake.organizations[0]?.updatedAt?.getTime() ?? 0) > before.getTime(),
    "expected updatedAt to move forward",
  );
  // Scoped to the one id: the other organization is untouched.
  assert.equal(fake.organizations[1]?.logo, undefined);
});

test("setLogo with null clears the picture", async () => {
  const fake = createFakeOrganizationDb({
    organizations: [{ ...acme, logo: acmePicture }],
  });

  await createOrganizationStore(fake.db).setLogo("org_1", null);

  assert.equal(fake.organizations[0]?.logo, null);
  assert.deepEqual(
    await createOrganizationStore(fake.db).get("org_1"),
    acmeSummary,
  );
});

// ---- inviting by handle ---------------------------------------------------

test("findUserByHandle resolves a handle to its primary address", async () => {
  // An invitation is addressed to an email, and Better Auth compares it to
  // the session's primary on accept — so this must return the primary.
  const fake = createFakeOrganizationDb({
    users: [
      {
        id: "user_1",
        name: "Dana",
        username: "dana",
        image: null,
        email: "dana@example.test",
      },
    ],
  });

  assert.deepEqual(
    await createOrganizationStore(fake.db).findUserByHandle("dana"),
    { id: "user_1", email: "dana@example.test" },
  );
});

test("findUserByHandle matches a handle case-insensitively", async () => {
  // Handles are stored lowercase; the inviter may type any casing.
  const fake = createFakeOrganizationDb({
    users: [
      {
        id: "user_1",
        name: "Dana",
        username: "dana",
        image: null,
        email: "dana@example.test",
      },
    ],
  });

  const found = await createOrganizationStore(fake.db).findUserByHandle(
    "  DANA ",
  );

  assert.equal(found?.id, "user_1");
});

test("findUserByHandle is undefined when nobody holds the handle", async () => {
  const fake = createFakeOrganizationDb({ users: [] });

  assert.equal(
    await createOrganizationStore(fake.db).findUserByHandle("ghost"),
    undefined,
  );
});

// ---- personal organizations -----------------------------------------------
//
// Every user gets one at signup, which is what lets everything ownable take a
// single non-null `organization_id` instead of a nullable user/organization
// pair. These pin the three things that invariant depends on: it is created,
// it carries the sole owner membership, and asking twice does not make two.

/** Someone who has signed up: a user row, with the username they hold. */
function person(id: string, username: string, name = username) {
  return { id, name, username, image: null };
}

test("createPersonal creates the organization and marks it personal", async () => {
  const fake = createFakeOrganizationDb({ users: [person("user_1", "dana")] });

  const created = await createOrganizationStore(fake.db).createPersonal({
    userId: "user_1",
    name: "Dana",
  });

  assert.equal(created.slug, "dana");
  assert.equal(created.kind, "personal");
  assert.equal(created.name, "Dana");
  // Named by the user it belongs to, so "find my personal organization" is a
  // foreign key rather than a handle lookup.
  assert.equal(fake.organizations[0]?.personalUserId, "user_1");
});

test("createPersonal makes the user its sole owner", async () => {
  // Without the membership the organization exists but `listForUser` cannot
  // see it, so the user would appear to be in none.
  const fake = createFakeOrganizationDb({ users: [person("user_1", "dana")] });

  await createOrganizationStore(fake.db).createPersonal({
    userId: "user_1",
    name: "Dana",
  });

  assert.equal(fake.members.length, 1);
  assert.equal(fake.members[0]?.userId, "user_1");
  assert.equal(fake.members[0]?.role, "owner");
});

test("createPersonal returns the existing organization rather than a second", async () => {
  // The signup hook can run again for the same user — a retried signup — and
  // the unique constraint would raise rather than be caught here.
  const fake = createFakeOrganizationDb({
    users: [person("user_1", "dana")],
    organizations: [
      {
        id: "org_existing",
        name: "Dana",
        slug: "dana",
        kind: "personal",
        personalUserId: "user_1",
      },
    ],
  });

  const found = await createOrganizationStore(fake.db).createPersonal({
    userId: "user_1",
    name: "Dana",
  });

  assert.equal(found.id, "org_existing");
  assert.equal(fake.organizations.length, 1);
});

test("createPersonal takes the owner's username as its handle, unsuffixed", async () => {
  // A username is never a team's — the two share one namespace — so there is
  // nothing to step around, and the database accepts nothing else.
  const fake = createFakeOrganizationDb({
    users: [person("user_1", "Dana")],
    organizations: [
      { id: "org_team", name: "Dana Corp", slug: "dana-2", kind: "team" },
    ],
  });

  const created = await createOrganizationStore(fake.db).createPersonal({
    userId: "user_1",
    name: "Dana",
  });

  assert.equal(created.slug, "dana");
});

test("createPersonal refuses a user who does not exist", async () => {
  const fake = createFakeOrganizationDb({});

  await assert.rejects(
    createOrganizationStore(fake.db).createPersonal({
      userId: "user_gone",
      name: "Gone",
    }),
    /No user "user_gone"/,
  );
  assert.equal(fake.organizations.length, 0);
});

test("a personal organization is listed like any other", async () => {
  // Nothing below the API boundary branches on `kind`: the membership is what
  // grants access, whichever kind the organization is.
  const fake = createFakeOrganizationDb({ users: [person("user_1", "dana")] });
  const store = createOrganizationStore(fake.db);

  const created = await store.createPersonal({
    userId: "user_1",
    name: "Dana",
  });

  const listed = await store.listForUser("user_1");
  assert.deepEqual(listed, [{ ...created, role: "owner" }]);
  assert.equal(await store.roleOf("user_1", created.id), "owner");
});

// ---- renaming a personal organization -------------------------------------

/*
 * Its name is a copy of `user.name` taken at signup, and nothing else edits
 * it, so the rename route writes here too. What matters is the scope: this
 * must never be able to reach a team.
 */

test("renamePersonal renames the caller's personal organization", async () => {
  const fake = createFakeOrganizationDb({
    users: [person("user_1", "ada")],
  });
  const store = createOrganizationStore(fake.db);
  await store.createPersonal({
    userId: "user_1",
    name: "ada lovelace",
  });

  await store.renamePersonal("user_1", "Ada Lovelace");

  assert.equal(fake.organizations[0]?.name, "Ada Lovelace");
});

test("renamePersonal matches on the personal user, not the organization", async () => {
  /*
   * The scope that makes this safe to expose on a route taking only a name:
   * the row is found by `personal_user_id`, so a team the caller owns cannot
   * be renamed through it however the request is shaped.
   */
  const fake = createFakeOrganizationDb({
    users: [person("user_1", "dana"), person("user_2", "sam")],
  });
  const store = createOrganizationStore(fake.db);
  // Two people, each with their own. One renaming must not touch the other —
  // with a single row on the table, a rename scoped to nothing at all would
  // look exactly like a correct one.
  await store.createPersonal({
    userId: "user_1",
    name: "Dana",
  });
  await store.createPersonal({
    userId: "user_2",
    name: "Sam",
  });

  await store.renamePersonal("user_1", "Renamed");

  const byUser = new Map(
    fake.organizations.map((row) => [row.personalUserId, row.name]),
  );
  assert.equal(byUser.get("user_1"), "Renamed");
  assert.equal(byUser.get("user_2"), "Sam");

  assert.equal(fake.updates.length, 1);
  assert.equal(fake.updates[0]?.table, "organization");
  // Only the name: a rename must not disturb the handle, the kind, or the
  // link to the user the organization belongs to.
  assert.deepEqual(fake.updates[0]?.patch, { name: "Renamed" });
});
