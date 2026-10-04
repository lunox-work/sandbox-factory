import assert from "node:assert/strict";
import { test } from "node:test";

import { getTableConfig } from "drizzle-orm/pg-core";
import type { BountyContent } from "sandbox-factory";

import { jiraIssue, bounty, type BountyRow } from "../src/schema.js";
import {
  createBountyStore,
  followsJira,
  insertBounty,
  jiraContentChange,
} from "../src/bounties.js";
import { createFakeDb, createSequencedFakeDb } from "./fake-db.js";

function bountyRow(overrides: Partial<BountyRow> = {}): BountyRow {
  return {
    id: "bty_1",
    organizationId: "org_1",
    number: 7,
    title: "Invitations are not sent",
    description: "Steps",
    issueType: "Bug",
    priority: "High",
    labels: ["email"],
    components: [],
    inputTruncated: false,
    origin: "manual",
    repoId: null,
    createdBy: "user_1",
    revision: 1,
    createdAt: new Date("2026-10-01T00:00:00Z"),
    updatedAt: new Date("2026-10-01T00:00:00Z"),
    ...overrides,
  };
}

/** A bounty read with no Jira issue: every link column null. */
const unlinked = {
  issueId: null,
  boardId: null,
  externalId: null,
  jiraKey: null,
  removedAt: null,
  connectionId: null,
  siteUrl: null,
};

const linked = {
  issueId: "jri_1",
  boardId: "jrb_1",
  externalId: "10001",
  jiraKey: "APP-3",
  removedAt: null,
  connectionId: "jrc_1",
  siteUrl: "https://acme.atlassian.net",
};

const newBounty = {
  title: "Invitations are not sent",
  description: "Steps",
  issueType: "Bug",
  priority: "High",
  labels: ["email"],
  repoId: null,
};

test("creates a bounty written here as the organization's next number", async () => {
  const fake = createFakeDb([bountyRow()]);
  const result = await createBountyStore(fake.db).create(
    "org_1",
    "user_1",
    newBounty,
  );
  assert.ok(result.ok);
  assert.equal(result.bounty.key, "B-7");
  assert.equal(result.bounty.jira, null);
  const values = fake.calls[0]?.values;
  assert.match(String(values?.["id"]), /^bty_/);
  assert.equal(values?.["organizationId"], "org_1");
  assert.equal(values?.["origin"], "manual");
  assert.equal(values?.["createdBy"], "user_1");
  // Read in the insert itself, so the count is never read and then raced.
  assert.equal(typeof values?.["number"], "object");
});

test("refuses a repository the organization does not have", async () => {
  const fake = createFakeDb([]);
  assert.deepEqual(
    await createBountyStore(fake.db).create("org_1", "user_1", {
      ...newBounty,
      repoId: "ghr_other",
    }),
    { ok: false, reason: "repo-not-found" },
  );
  assert.equal(fake.calls.filter(({ kind }) => kind === "insert").length, 0);
});

test("names a repository the organization has", async () => {
  const fake = createSequencedFakeDb([
    [{ id: "ghr_1" }],
    [bountyRow({ repoId: "ghr_1" })],
  ]);
  const result = await createBountyStore(fake.db).create("org_1", "user_1", {
    ...newBounty,
    repoId: "ghr_1",
  });
  assert.ok(result.ok);
  assert.equal(result.bounty.repoId, "ghr_1");
  assert.equal(fake.calls[0]?.filtered, true);
});

test("a number taken by a concurrent bounty is retried", async () => {
  const taken = Object.assign(new Error("duplicate"), { code: "23505" });
  const fake = createSequencedFakeDb([taken, taken, [bountyRow()]]);
  const created = await insertBounty(fake.db, "org_1", {
    title: "t",
    origin: "manual",
  });
  assert.equal(created.id, "bty_1");
  assert.equal(fake.calls.length, 3);
});

test("gives up on the number after a bound, and passes other errors on", async () => {
  const taken = Object.assign(new Error("duplicate"), { code: "23505" });
  await assert.rejects(
    insertBounty(createFakeDb([]).db, "org_1", { title: "t" }),
    /no row/,
  );
  await assert.rejects(
    insertBounty(createSequencedFakeDb(Array(8).fill(taken)).db, "org_1", {
      title: "t",
    }),
    /duplicate/,
  );
  const broken = new Error("connection lost");
  const fake = createSequencedFakeDb([broken]);
  await assert.rejects(insertBounty(fake.db, "org_1", { title: "t" }), broken);
  assert.equal(fake.calls.length, 1);
});

test("reads a bounty with its Jira issue, named by the issue's key", async () => {
  const fake = createFakeDb([
    { row: bountyRow({ origin: "jira" }), ...linked },
  ]);
  const bounty = await createBountyStore(fake.db).get("org_1", "bty_1");
  assert.equal(bounty?.key, "APP-3");
  assert.deepEqual(bounty?.jira, {
    issueId: "jri_1",
    boardId: "jrb_1",
    connectionId: "jrc_1",
    externalId: "10001",
    key: "APP-3",
    siteUrl: "https://acme.atlassian.net",
    removedAt: null,
  });
  assert.equal(fake.calls[0]?.filtered, true);
  assert.equal(bounty === null ? null : followsJira(bounty), true);
});

test("a bounty whose issue has gone is its own again", async () => {
  const fake = createFakeDb([
    {
      row: bountyRow({ origin: "jira" }),
      ...linked,
      removedAt: new Date("2026-10-02T00:00:00Z"),
    },
  ]);
  const bounty = await createBountyStore(fake.db).get("org_1", "bty_1");
  assert.equal(bounty?.jira?.removedAt, "2026-10-02T00:00:00.000Z");
  assert.equal(bounty === null ? null : followsJira(bounty), false);
});

test("a bounty reads and lists with its sandbox, and the repository it is cut from", async () => {
  const bare = {
    sandboxId: "sbx_1",
    sandboxStatus: "draft",
    sandboxVersionId: null,
    sandboxSourceRepoId: null,
  };
  const read = await createBountyStore(
    createFakeDb([{ row: bountyRow(), ...unlinked, ...bare }]).db,
  ).get("org_1", "bty_1");
  // Made without a repository: the panel offers to link one.
  assert.deepEqual(read?.sandbox, {
    id: "sbx_1",
    status: "draft",
    currentVersionId: null,
    sourceRepoId: null,
  });
  const {
    description: _d,
    components: _c,
    inputTruncated: _t,
    ...listed
  } = bountyRow();
  const rows = await createBountyStore(
    createFakeDb([
      {
        ...listed,
        ...unlinked,
        ...bare,
        sandboxStatus: "published",
        sandboxVersionId: "sbv_1",
        sandboxSourceRepoId: "ghr_1",
        proposalId: null,
        proposalStatus: null,
        proposalComplexity: null,
        proposalAmountMinor: null,
        proposalCurrency: null,
      },
    ]).db,
  ).list("org_1");
  assert.deepEqual(rows[0]?.sandbox, {
    id: "sbx_1",
    status: "published",
    currentVersionId: "sbv_1",
    sourceRepoId: "ghr_1",
  });
  const none = await createBountyStore(
    createFakeDb([
      {
        row: bountyRow(),
        ...unlinked,
        sandboxId: null,
        sandboxStatus: null,
        sandboxVersionId: null,
        sandboxSourceRepoId: null,
      },
    ]).db,
  ).get("org_1", "bty_1");
  assert.equal(none?.sandbox, null);
});

test("a missing bounty reads as null", async () => {
  assert.equal(
    await createBountyStore(createFakeDb([]).db).get("org_1", "bty_x"),
    null,
  );
});

test("lists bounties newest first, a page at a time, with their live proposal", async () => {
  const base = {
    id: "bty_1",
    organizationId: "org_1",
    number: 7,
    title: "Invitations are not sent",
    issueType: "Bug",
    priority: null,
    labels: [],
    origin: "manual",
    repoId: null,
    revision: 1,
    createdAt: new Date("2026-10-01T00:00:00Z"),
    updatedAt: new Date("2026-10-01T00:00:00Z"),
  };
  const fake = createFakeDb([
    {
      ...base,
      ...unlinked,
      proposalId: "bpr_1",
      proposalStatus: "approved",
      proposalComplexity: "M",
      proposalAmountMinor: 10_500,
      proposalCurrency: "USD",
    },
    {
      ...base,
      id: "bty_2",
      number: 8,
      ...linked,
      proposalId: null,
      proposalStatus: null,
      proposalComplexity: null,
      proposalAmountMinor: null,
      proposalCurrency: null,
    },
  ]);
  const listed = await createBountyStore(fake.db).list("org_1", {
    cursor: { createdAt: "2026-10-02T00:00:00Z", id: "bty_9" },
    limit: 500,
  });
  assert.deepEqual(listed[0]?.proposal, {
    id: "bpr_1",
    status: "approved",
    complexity: "M",
    amountMinor: 10_500,
    currency: "USD",
  });
  assert.equal(listed[0]?.key, "B-7");
  assert.equal(listed[1]?.proposal, null);
  assert.equal(listed[1]?.key, "APP-3");
  assert.equal(fake.calls[0]?.ordered, true);
  assert.equal(fake.calls[0]?.limited, 50);
  assert.equal(fake.calls[0]?.filtered, true);
  assert.deepEqual(
    await createBountyStore(createFakeDb([]).db).list("org_1"),
    [],
  );
});

test("a change is made against the revision the editor saw", async () => {
  const fake = createSequencedFakeDb([
    [{ row: bountyRow({ revision: 2 }), ...unlinked }],
    [bountyRow({ title: "Fixed title", revision: 3 })],
  ]);
  const result = await createBountyStore(fake.db).update("org_1", "bty_1", 2, {
    title: "Fixed title",
    priority: null,
    labels: [],
    description: "More",
    issueType: "Task",
  });
  assert.ok(result.ok);
  assert.equal(result.bounty.title, "Fixed title");
  const values = fake.calls[1]?.values;
  assert.equal(values?.["revision"], 3);
  assert.equal(values?.["priority"], null);
  assert.equal(values?.["description"], "More");
  assert.equal("repoId" in (values ?? {}), false);
});

test("a stale or missing bounty is not changed", async () => {
  const store = (responses: unknown[][]) =>
    createBountyStore(createSequencedFakeDb(responses).db);
  assert.deepEqual(
    await store([[]]).update("org_1", "bty_x", 1, { title: "t" }),
    { ok: false, reason: "not-found" },
  );
  const stale = await store([
    [{ row: bountyRow({ revision: 4 }), ...unlinked }],
  ]).update("org_1", "bty_1", 3, { title: "t" });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.reason, "changed");
  // Changed between the read and the write.
  const raced = await store([
    [{ row: bountyRow(), ...unlinked }],
    [],
    [{ row: bountyRow({ revision: 2 }), ...unlinked }],
  ]).update("org_1", "bty_1", 1, { title: "t" });
  assert.equal(raced.ok, false);
  if (!raced.ok) assert.equal(raced.reason, "changed");
  // And deleted between them.
  assert.deepEqual(
    await store([[{ row: bountyRow(), ...unlinked }], [], []]).update(
      "org_1",
      "bty_1",
      1,
      { title: "t" },
    ),
    { ok: false, reason: "not-found" },
  );
});

test("a Jira bounty's text is Jira's; its repository is the platform's", async () => {
  const jiraRow = { row: bountyRow({ origin: "jira" }), ...linked };
  const refused = await createBountyStore(
    createSequencedFakeDb([[jiraRow]]).db,
  ).update("org_1", "bty_1", 1, { title: "Mine now" });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.reason, "jira-owned");

  const fake = createSequencedFakeDb([
    [jiraRow],
    [{ id: "ghr_1" }],
    [bountyRow({ origin: "jira", repoId: "ghr_1", revision: 2 })],
  ]);
  const result = await createBountyStore(fake.db).update("org_1", "bty_1", 1, {
    repoId: "ghr_1",
  });
  assert.ok(result.ok);
  // Still named and linked as it was read.
  assert.equal(result.bounty.key, "APP-3");
  assert.equal(result.bounty.jira?.issueId, "jri_1");

  const unknownRepo = await createBountyStore(
    createSequencedFakeDb([[jiraRow], []]).db,
  ).update("org_1", "bty_1", 1, { repoId: "ghr_other" });
  assert.deepEqual(unknownRepo, { ok: false, reason: "repo-not-found" });

  const cleared = createSequencedFakeDb([
    [{ ...jiraRow, row: bountyRow({ origin: "jira", repoId: "ghr_1" }) }],
    [bountyRow({ origin: "jira", revision: 2 })],
  ]);
  const unset = await createBountyStore(cleared.db).update(
    "org_1",
    "bty_1",
    1,
    { repoId: null },
  );
  assert.ok(unset.ok);
  assert.equal(cleared.calls[1]?.values?.["repoId"], null);
});

test("a bounty is removed only while nothing is built on it", async () => {
  const removed = createSequencedFakeDb([[{ id: "bty_1" }], [{ id: "bty_1" }]]);
  assert.equal(
    await createBountyStore(removed.db).remove("org_1", "bty_1"),
    "removed",
  );
  // Locked before the check, so a proposal written meanwhile is waited for.
  assert.equal(removed.calls[0]?.kind, "select");
  assert.equal(removed.calls[0]?.lock, "update");
  assert.equal(removed.calls[0]?.filtered, true);
  assert.equal(removed.calls[1]?.kind, "delete");
  assert.equal(removed.calls[1]?.filtered, true);
  assert.equal(
    await createBountyStore(
      createSequencedFakeDb([[{ id: "bty_1" }], []]).db,
    ).remove("org_1", "bty_1"),
    "in-use",
  );
  const missing = createSequencedFakeDb([[]]);
  assert.equal(
    await createBountyStore(missing.db).remove("org_1", "bty_x"),
    "not-found",
  );
  assert.equal(
    missing.calls.some(({ kind }) => kind === "delete"),
    false,
  );
});

test("a change to what the bounty already says writes nothing", async () => {
  const fake = createSequencedFakeDb([
    [{ row: bountyRow({ repoId: "ghr_1" }), ...unlinked }],
  ]);
  const result = await createBountyStore(fake.db).update("org_1", "bty_1", 1, {
    title: "Invitations are not sent",
    labels: ["email"],
    priority: "High",
    repoId: "ghr_1",
  });
  assert.ok(result.ok);
  assert.equal(result.bounty.revision, 1);
  assert.equal(fake.calls.length, 1);
});

test("a repository removed between the check and the write is not found", async () => {
  const gone = Object.assign(new Error("fk"), { code: "23503" });
  const created = await createBountyStore(
    createSequencedFakeDb([[{ id: "ghr_1" }], gone]).db,
  ).create("org_1", "user_1", { ...newBounty, repoId: "ghr_1" });
  assert.deepEqual(created, { ok: false, reason: "repo-not-found" });

  const updated = await createBountyStore(
    createSequencedFakeDb([
      [{ row: bountyRow(), ...unlinked }],
      [{ id: "ghr_1" }],
      gone,
    ]).db,
  ).update("org_1", "bty_1", 1, { repoId: "ghr_1" });
  assert.deepEqual(updated, { ok: false, reason: "repo-not-found" });

  // Any other failure is not a missing repository.
  const down = new Error("connection lost");
  await assert.rejects(
    createBountyStore(createSequencedFakeDb([down]).db).create(
      "org_1",
      "user_1",
      newBounty,
    ),
    /connection lost/,
  );
  await assert.rejects(
    createBountyStore(
      createSequencedFakeDb([[{ row: bountyRow(), ...unlinked }], down]).db,
    ).update("org_1", "bty_1", 1, { title: "t" }),
    /connection lost/,
  );
});

const jiraText: BountyContent = {
  title: "Invitations are not sent",
  description: "Steps",
  issueType: "Bug",
  priority: "High",
  labels: ["email"],
  components: [],
  inputTruncated: false,
};

test("a refresh writes Jira's text only when it differs", async () => {
  assert.equal(jiraContentChange(bountyRow(), jiraText), null);
  assert.deepEqual(
    jiraContentChange(bountyRow(), { ...jiraText, components: ["Mailer"] }),
    { ...jiraText, labels: ["email"], components: ["Mailer"] },
  );
  // An issue with no summary keeps the title the bounty has.
  assert.equal(
    jiraContentChange(bountyRow(), { ...jiraText, title: " ", labels: [] })
      ?.title,
    "Invitations are not sent",
  );
  assert.equal(
    jiraContentChange(bountyRow(), { ...jiraText, title: "x".repeat(300) })
      ?.title?.length,
    255,
  );

  const same = createFakeDb([bountyRow()]);
  assert.equal(
    await createBountyStore(same.db).refreshFromJira(
      "org_1",
      "bty_1",
      jiraText,
    ),
    false,
  );
  assert.equal(same.calls.length, 1);

  const moved = createSequencedFakeDb([
    [bountyRow({ revision: 5 })],
    [{ id: "bty_1" }],
  ]);
  assert.equal(
    await createBountyStore(moved.db).refreshFromJira("org_1", "bty_1", {
      ...jiraText,
      description: "New steps",
    }),
    true,
  );
  assert.equal(moved.calls[1]?.values?.["revision"], 6);
  assert.equal(moved.calls[1]?.values?.["description"], "New steps");

  assert.equal(
    await createBountyStore(createFakeDb([]).db).refreshFromJira(
      "org_1",
      "bty_x",
      jiraText,
    ),
    false,
  );
});

test("a bounty's number is its organization's, and its columns are checked", () => {
  const config = getTableConfig(bounty);
  assert.deepEqual(
    config.uniqueConstraints
      .find(({ name }) => name === "bounty_organization_number_unique")
      ?.columns.map(({ name }) => name),
    ["organization_id", "number"],
  );
  assert.deepEqual(config.checks.map(({ name }) => name).sort(), [
    "bounty_number_check",
    "bounty_origin_check",
    "bounty_revision_check",
    "bounty_title_check",
  ]);
  // Removing a repository clears the link; the bounty stays.
  const repo = config.foreignKeys.find(
    (key) => key.reference().columns[0]?.name === "repo_id",
  );
  assert.equal(repo?.onDelete, "set null");
  // One pointer per bounty.
  assert.deepEqual(
    getTableConfig(jiraIssue)
      .uniqueConstraints.find(({ name }) => name === "jira_issue_bounty_unique")
      ?.columns.map(({ name }) => name),
    ["bounty_id"],
  );
});
