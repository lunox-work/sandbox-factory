import assert from "node:assert/strict";
import { test } from "node:test";

import { getTableConfig } from "drizzle-orm/pg-core";

import { createAuditStore } from "../src/audit.js";
import { auditEntry, organization, user } from "../src/schema.js";
import { createFakeDb } from "./fake-db.js";

const at = new Date("2026-11-12T00:00:00.000Z");
const entry = {
  via: "token" as const,
  credentialId: "tok_1",
  client: null,
  userId: "user_1",
  method: "POST",
  route: "/api/v1/orgs/:orgId/bounties",
  resourceId: null,
  status: 201,
  requestId: "req_1",
};

test("an entry keeps no body or URL, and outlives its person", () => {
  const { columns, foreignKeys } = getTableConfig(auditEntry);
  assert.deepEqual(columns.map((column) => column.name).sort(), [
    "at",
    "client",
    "credential_id",
    "id",
    "method",
    "organization_id",
    "request_id",
    "resource_id",
    "route",
    "status",
    "user_id",
    "via",
  ]);
  const onDelete = (table: unknown) =>
    foreignKeys.find((key) => key.reference().foreignTable === table)?.onDelete;
  assert.equal(onDelete(organization), "cascade");
  assert.equal(onDelete(user), "set null");
});

test("record writes the entry under its workspace", async () => {
  const fake = createFakeDb([]);
  await createAuditStore(fake.db).record("org_1", entry);
  const insert = fake.calls[0];
  assert.equal(insert?.kind, "insert");
  assert.match(String(insert?.values?.["id"]), /^aud_/);
  assert.equal(insert?.values?.["organizationId"], "org_1");
  assert.equal(insert?.values?.["route"], entry.route);
});

test("list pages the workspace's entries newest first, with the person", async () => {
  const row = {
    id: "aud_1",
    organizationId: "org_1",
    via: "token",
    credentialId: "tok_1",
    client: null,
    userId: "user_1",
    userName: "Ada Lovelace",
    method: "POST",
    route: entry.route,
    resourceId: null,
    status: 201,
    requestId: "req_1",
    at,
  };
  const fake = createFakeDb([row, { ...row, id: "aud_0", userId: null }]);
  const listed = await createAuditStore(fake.db).list("org_1", {
    limit: 2,
    cursor: { createdAt: at.toISOString(), id: "aud_9" },
  });
  assert.deepEqual(listed[0]?.user, { id: "user_1", name: "Ada Lovelace" });
  assert.equal(listed[1]?.user, null);
  assert.equal("userId" in (listed[0] ?? {}), false);
  assert.equal(fake.calls[0]?.filtered, true);
  assert.equal(fake.calls[0]?.ordered, true);
  assert.equal(fake.calls[0]?.limited, 2);
  const first = createFakeDb([{ ...row, userName: null }]);
  assert.deepEqual(
    (await createAuditStore(first.db).list("org_1", { limit: 25 }))[0]?.user,
    { id: "user_1", name: "" },
  );
});

test("prune deletes what is older and says how many", async () => {
  const fake = createFakeDb([{ id: "aud_1" }, { id: "aud_2" }]);
  assert.equal(await createAuditStore(fake.db).prune(at), 2);
  assert.equal(fake.calls[0]?.kind, "delete");
  assert.equal(fake.calls[0]?.filtered, true);
});
