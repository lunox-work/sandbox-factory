import assert from "node:assert/strict";
import { test } from "node:test";

import {
  handleSchema,
  inviteMemberSchema,
  membershipSchema,
  organizationSummarySchema,
} from "../src/index.js";

// ---- handles and organizations --------------------------------------------

test("handleSchema stores the lowercase form of what was typed", () => {
  // A handler must never see the raw casing, or two spellings of one name
  // could reach the database.
  const result = handleSchema.safeParse("  FeverSoul  ");
  assert.equal(result.success, true);
  assert.equal(result.data, "feversoul");
});

test("handleSchema reports core's reason, not zod's default", () => {
  // The form shows this string verbatim, so it has to be the one core wrote.
  const result = handleSchema.safeParse("no");
  assert.equal(result.success, false);
  if (!result.success) {
    assert.match(
      result.error.issues[0]?.message ?? "",
      /between 3 and 30 characters/,
    );
  }
});

test("handleSchema rejects characters that would break a URL", () => {
  for (const candidate of ["has space", "has/slash", "has@at"]) {
    assert.equal(handleSchema.safeParse(candidate).success, false);
  }
});

test("inviteMemberSchema takes a handle or an address, never both", () => {
  assert.ok(inviteMemberSchema.safeParse({ handle: "dana" }).success);
  assert.ok(
    inviteMemberSchema.safeParse({ email: "dana@example.test" }).success,
  );
  assert.equal(
    inviteMemberSchema.safeParse({
      handle: "dana",
      email: "dana@example.test",
    }).success,
    false,
  );
  assert.equal(inviteMemberSchema.safeParse({}).success, false);
});

test("an invitation defaults to the member role", () => {
  // Inviting someone as an owner has to be deliberate.
  const result = inviteMemberSchema.safeParse({ handle: "dana" });
  assert.equal(result.success && result.data.role, "member");
});

test("inviteMemberSchema refuses a role outside the plugin's three", () => {
  assert.equal(
    inviteMemberSchema.safeParse({ handle: "dana", role: "superuser" }).success,
    false,
  );
});

test("membershipSchema keeps the id and the handle apart", () => {
  // The id is permanent and the slug is renameable; a surface that conflated
  // them would break on the first rename.
  const parsed = membershipSchema.parse({
    id: "org_1",
    name: "Acme",
    slug: "acme",
    role: "owner",
  });
  assert.equal(parsed.id, "org_1");
  assert.equal(parsed.slug, "acme");
});

test("organizationSummarySchema accepts a summary with no image", () => {
  // An API that predates uploads sends none; that is "no picture".
  const parsed = organizationSummarySchema.parse({
    id: "org_1",
    name: "Acme",
    slug: "acme",
  });
  assert.equal(parsed.image, undefined);
  assert.equal(
    organizationSummarySchema.parse({ ...parsed, image: null }).image,
    null,
  );
});

test("organizationSummarySchema keeps an uploaded picture's path", () => {
  const image = `/api/avatars/organization/org_1/${"c".repeat(64)}.webp`;
  assert.equal(
    organizationSummarySchema.parse({
      id: "org_1",
      name: "Acme",
      slug: "acme",
      image,
    }).image,
    image,
  );
});

test("organizationSummarySchema defaults kind to team", () => {
  // A response from an API that predates personal organizations carries no
  // `kind`, and it is a team — so parsing must not fail on the old shape.
  const parsed = organizationSummarySchema.parse({
    id: "org_1",
    name: "Acme",
    slug: "acme",
  });

  assert.equal(parsed.kind, "team");
});

test("organizationSummarySchema keeps a personal kind", () => {
  const parsed = organizationSummarySchema.parse({
    id: "org_1",
    name: "Dana",
    slug: "dana",
    kind: "personal",
  });

  assert.equal(parsed.kind, "personal");
});

test("organizationSummarySchema refuses a kind outside the two", () => {
  // The surfaces branch on this, so an unknown value must not reach them.
  assert.equal(
    organizationSummarySchema.safeParse({
      id: "org_1",
      name: "Acme",
      slug: "acme",
      kind: "enterprise",
    }).success,
    false,
  );
});
