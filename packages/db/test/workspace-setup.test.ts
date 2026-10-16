import assert from "node:assert/strict";
import test from "node:test";

import { createWorkspaceSetupStore } from "../src/workspace-setup.js";
import { createFakeDb } from "./fake-db.js";

test("each workspace's setup is counted in one query", async () => {
  const fake = createFakeDb([
    {
      id: "org_1",
      jiraConnected: 1,
      jiraBroken: 0,
      jiraBoards: 2,
      githubConnected: 1,
      githubRepositories: 3,
      proposals: 4,
      bounties: 7,
      members: 3,
    },
    {
      id: "org_2",
      jiraConnected: 0,
      jiraBroken: 1,
      jiraBoards: 0,
      githubConnected: 0,
      githubRepositories: 0,
      proposals: 0,
      bounties: 0,
      members: 1,
    },
  ]);
  const counts = await createWorkspaceSetupStore(fake.db).forOrganizations([
    "org_1",
    "org_2",
  ]);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0]?.filtered, true);
  assert.deepEqual(counts.get("org_1"), {
    jiraConnected: 1,
    jiraBroken: 0,
    jiraBoards: 2,
    githubConnected: 1,
    githubRepositories: 3,
    proposals: 4,
    bounties: 7,
    members: 3,
  });
  assert.equal(counts.get("org_2")?.bounties, 0);
  assert.equal(counts.get("org_2")?.members, 1);
  assert.equal(counts.get("org_2")?.jiraBroken, 1);
});

test("no workspaces is answered without a query", async () => {
  const fake = createFakeDb([]);
  const counts = await createWorkspaceSetupStore(fake.db).forOrganizations([]);
  assert.equal(counts.size, 0);
  assert.equal(fake.calls.length, 0);
});

test("bounties are counted in full, and only for the ids asked", async () => {
  const counted = (bounties: number) => ({
    jiraConnected: 0,
    jiraBroken: 0,
    jiraBoards: 0,
    githubConnected: 0,
    githubRepositories: 0,
    proposals: 0,
    bounties,
    members: 1,
  });
  const fake = createFakeDb([
    { id: "org_1", ...counted(5) },
    { id: "org_2", ...counted(0) },
  ]);
  const counts = await createWorkspaceSetupStore(fake.db).forOrganizations([
    "org_1",
    "org_2",
  ]);
  assert.equal(counts.get("org_1")?.bounties, 5);
  assert.equal(counts.get("org_2")?.bounties, 0);
  assert.equal(counts.has("org_3"), false);
  assert.equal(fake.calls[0]?.filtered, true);
});
