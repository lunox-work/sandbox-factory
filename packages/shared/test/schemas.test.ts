import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createTodoSchema,
  handleSchema,
  inviteMemberSchema,
  membershipSchema,
  todoSchema,
  updateTodoSchema,
} from "../src/index.js";

const valid = {
  id: "todo_1",
  title: "write tests",
  done: false,
  createdAt: "2026-09-16T00:00:00.000Z",
};

test("todoSchema accepts a well-formed todo", () => {
  assert.deepEqual(todoSchema.parse(valid), valid);
});

test("todoSchema rejects a non-boolean done", () => {
  assert.equal(todoSchema.safeParse({ ...valid, done: "yes" }).success, false);
});

test("todoSchema rejects a non-ISO createdAt", () => {
  assert.equal(
    todoSchema.safeParse({ ...valid, createdAt: "yesterday" }).success,
    false,
  );
});

test("createTodoSchema trims the title", () => {
  assert.deepEqual(createTodoSchema.parse({ title: "  buy milk  " }), {
    title: "buy milk",
  });
});

test("createTodoSchema rejects empty and whitespace-only titles", () => {
  for (const title of ["", "   "]) {
    assert.equal(createTodoSchema.safeParse({ title }).success, false);
  }
});

test("createTodoSchema rejects an overlong title", () => {
  assert.equal(
    createTodoSchema.safeParse({ title: "x".repeat(201) }).success,
    false,
  );
});

test("updateTodoSchema accepts either field alone, or both", () => {
  assert.ok(updateTodoSchema.safeParse({ done: true }).success);
  assert.ok(updateTodoSchema.safeParse({ title: "renamed" }).success);
  assert.ok(
    updateTodoSchema.safeParse({ title: "renamed", done: true }).success,
  );
});

test("updateTodoSchema rejects an empty body", () => {
  const result = updateTodoSchema.safeParse({});
  assert.equal(result.success, false);
  if (!result.success) {
    assert.match(result.error.issues[0]?.message ?? "", /Provide a title/);
  }
});

test("updateTodoSchema rejects an invalid title", () => {
  assert.equal(updateTodoSchema.safeParse({ title: "   " }).success, false);
});

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
