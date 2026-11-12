import assert from "node:assert/strict";
import { test } from "node:test";

import { auditListResponseSchema } from "../src/index.js";

test("an audit page parses, and refuses a read as an entry", () => {
  const entry = {
    id: "aud_1",
    via: "token",
    credentialId: "tok_1",
    client: null,
    user: { id: "user_1", name: "Ada Lovelace" },
    method: "POST",
    route: "/api/v1/orgs/:orgId/bounties",
    resourceId: null,
    status: 201,
    requestId: "req_1",
    at: "2026-11-12T00:00:00.000Z",
  };
  assert.equal(
    auditListResponseSchema.parse({ entries: [entry], nextCursor: null })
      .entries[0]?.via,
    "token",
  );
  assert.equal(
    auditListResponseSchema.safeParse({
      entries: [{ ...entry, method: "GET" }],
      nextCursor: null,
    }).success,
    false,
  );
});
