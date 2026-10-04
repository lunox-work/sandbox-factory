import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHeldRoles, rankAtLeast } from "../src/roles.js";

test("held roles use the strongest recognized role and unknown roles grant nothing", () => {
  assert.deepEqual(parseHeldRoles(" member, admin , unknown"), [
    "member",
    "admin",
  ]);
  for (const role of ["", "unknown", "constructor", "OWNER"])
    assert.equal(rankAtLeast(role, "member"), false);
  assert.equal(rankAtLeast("member", "admin"), false);
  assert.equal(rankAtLeast("member, admin", "admin"), true);
  assert.equal(rankAtLeast("admin", "owner"), false);
  assert.equal(rankAtLeast(" member, owner ", "owner"), true);
});
