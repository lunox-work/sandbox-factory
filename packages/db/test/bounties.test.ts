import assert from "node:assert/strict";
import { test } from "node:test";

import { and } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import type { BountyContent } from "sandbox-factory";

import {
  jiraIssue,
  bounty,
  bountyVersion,
  type BountyRow,
} from "../src/schema.js";
import {
  createBountyStore,
  listFilters,
  followsJira,
  insertBounty,
  jiraContentChange,
} from "../src/bounties.js";
import { createFakeDb, createSequencedFakeDb } from "./fake-db.js";

function bountyRow(overrides: Partial<BountyRow> = {}): BountyRow {
  return {
    id: "bty_1",
    organizationId: "org_1",
    title: "Invitations are not sent",
    description: "Steps",
    components: [],
    inputTruncated: false,
    origin: "manual",
    repoId: null,
    stack: [],
    categories: [],
    createdBy: "user_1",
    revision: 1,
    version: 1,
    approvedVersion: null,
    approvedBy: null,
    approvedAt: null,
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
  repoId: null,
  stack: ["PostgreSQL"],
};

test("creates a bounty written here, with no Jira issue", async () => {
  const fake = createFakeDb([bountyRow()]);
  const result = await createBountyStore(fake.db).create(
    "org_1",
    "user_1",
    newBounty,
  );
  assert.ok(result.ok);
  assert.equal(result.bounty.jira, null);
  // Named by nothing but its id: no count of the organization's bounties.
  assert.equal("key" in result.bounty, false);
  assert.equal("number" in result.bounty, false);
  const values = fake.calls[0]?.values;
  assert.match(String(values?.["id"]), /^bty_/);
  assert.equal(values?.["organizationId"], "org_1");
  assert.equal(values?.["origin"], "manual");
  assert.equal(values?.["createdBy"], "user_1");
  assert.deepEqual(values?.["stack"], ["PostgreSQL"]);
  assert.equal("number" in (values ?? {}), false);
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

test("inserts a bounty once, and passes a failure on", async () => {
  const fake = createFakeDb([bountyRow()]);
  const created = await insertBounty(fake.db, "org_1", {
    title: "t",
    origin: "manual",
  });
  assert.equal(created.id, "bty_1");
  // The bounty, then its overview as version 1, by whoever wrote it.
  assert.equal(fake.calls.length, 2);
  assert.deepEqual(fake.calls[1]?.values, {
    bountyId: "bty_1",
    version: 1,
    title: "Invitations are not sent",
    description: "Steps",
    createdBy: "user_1",
    createdAt: new Date("2026-10-01T00:00:00Z"),
  });
  await assert.rejects(
    insertBounty(createFakeDb([]).db, "org_1", { title: "t" }),
    /no row/,
  );
  const broken = new Error("connection lost");
  const failing = createSequencedFakeDb([broken]);
  await assert.rejects(
    insertBounty(failing.db, "org_1", { title: "t" }),
    broken,
  );
  assert.equal(failing.calls.length, 1);
});

test("reads a bounty with its Jira issue, and the issue's key", async () => {
  const fake = createFakeDb([
    { row: bountyRow({ origin: "jira" }), ...linked },
  ]);
  const bounty = await createBountyStore(fake.db).get("org_1", "bty_1");
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
    sandboxExpiresAt: null,
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
    expiresAt: null,
    sourceRepoId: null,
    build: null,
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
        sandboxExpiresAt: new Date("2026-10-13T00:00:00.000Z"),
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
    expiresAt: "2026-10-13T00:00:00.000Z",
    sourceRepoId: "ghr_1",
    build: null,
  });
  const none = await createBountyStore(
    createFakeDb([
      {
        row: bountyRow(),
        ...unlinked,
        sandboxId: null,
        sandboxStatus: null,
        sandboxVersionId: null,
        sandboxExpiresAt: null,
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
    title: "Invitations are not sent",
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
  assert.equal(listed[0]?.jira, null);
  assert.equal(listed[1]?.proposal, null);
  assert.equal(listed[1]?.jira?.key, "APP-3");
  assert.equal(fake.calls[0]?.ordered, true);
  assert.equal(fake.calls[0]?.limited, 50);
  assert.equal(fake.calls[0]?.filtered, true);
  assert.deepEqual(
    await createBountyStore(createFakeDb([]).db).list("org_1"),
    [],
  );
});

test("lists across the organizations it is given, and asks nothing of none", async () => {
  const fake = createFakeDb([
    {
      id: "bty_2",
      organizationId: "org_2",
      title: "Export the ledger",
      origin: "manual",
      repoId: null,
      revision: 1,
      createdAt: new Date("2026-10-02T00:00:00Z"),
      updatedAt: new Date("2026-10-02T00:00:00Z"),
      ...unlinked,
      proposalId: null,
      proposalStatus: null,
      proposalComplexity: null,
      proposalAmountMinor: null,
      proposalCurrency: null,
    },
  ]);
  const listed = await createBountyStore(fake.db).listAcross(
    ["org_1", "org_2"],
    { limit: 10 },
  );
  assert.deepEqual(
    listed.map(({ organizationId, title }) => [organizationId, title]),
    [["org_2", "Export the ledger"]],
  );
  assert.equal(fake.calls[0]?.filtered, true);
  assert.equal(fake.calls[0]?.limited, 10);

  const none = createFakeDb([]);
  assert.deepEqual(await createBountyStore(none.db).listAcross([]), []);
  assert.equal(none.calls.length, 0);
});

test("a list narrows to a board, a category, or the bounties in none", () => {
  const render = (options: Parameters<typeof listFilters>[0]) => {
    const where = and(...listFilters(options));
    return where === undefined ? null : new PgDialect().sqlToQuery(where);
  };
  assert.equal(render({}), null);
  const narrowed = render({ boardId: "jrb_1", category: "left-behind" });
  assert.match(narrowed?.sql ?? "", /"jira_issue"\."board_id" = \$1/);
  // Containment: an element with that id, whatever its label and reason.
  assert.match(narrowed?.sql ?? "", /"bounty"\."categories" @> \$2::jsonb/);
  assert.deepEqual(narrowed?.params, [
    "jrb_1",
    JSON.stringify([{ id: "left-behind" }]),
  ]);
  assert.match(
    render({ uncategorized: true })?.sql ?? "",
    /"bounty"\."categories" = '\[\]'::jsonb/,
  );
});

test("counts each category across the organizations given, and none of none", async () => {
  const fake = createSequencedFakeDb([
    [{ total: 4, uncategorized: 1 }],
    [
      { id: "left-behind", count: 2 },
      { id: "quietly-wanted", count: 2 },
      // A bounty in no category yields no element, and no id.
      { id: null, count: 1 },
    ],
  ]);
  assert.deepEqual(
    await createBountyStore(fake.db).categoryCounts(["org_1"], {
      boardId: "jrb_1",
    }),
    {
      total: 4,
      uncategorized: 1,
      categories: { "left-behind": 2, "quietly-wanted": 2 },
    },
  );
  assert.equal(fake.calls.length, 2);
  assert.ok(fake.calls.every(({ filtered }) => filtered === true));

  const none = createFakeDb([]);
  assert.deepEqual(await createBountyStore(none.db).categoryCounts([]), {
    total: 0,
    uncategorized: 0,
    categories: {},
  });
  assert.equal(none.calls.length, 0);
  // An answer with no totals row reads as nothing counted.
  assert.deepEqual(
    await createBountyStore(createFakeDb([]).db).categoryCounts(["org_1"]),
    { total: 0, uncategorized: 0, categories: {} },
  );
});

test("a scan's categories replace the bounty's, through its owner", async () => {
  const match = { id: "left-behind", label: "Left behind", reason: "Old" };
  const fake = createFakeDb([{ id: "bty_1" }]);
  assert.equal(
    await createBountyStore(fake.db).categorize("org_1", "bty_1", [match]),
    true,
  );
  assert.equal(fake.calls[0]?.kind, "update");
  assert.deepEqual(fake.calls[0]?.values, { categories: [match] });
  assert.equal(fake.calls[0]?.filtered, true);
  assert.equal(
    await createBountyStore(createFakeDb([]).db).categorize(
      "org_1",
      "bty_9",
      [],
    ),
    false,
  );
});

test("a change is made against the revision the editor saw", async () => {
  const fake = createSequencedFakeDb([
    [{ row: bountyRow({ revision: 2 }), ...unlinked }],
    [
      bountyRow({
        title: "Fixed title",
        description: "More",
        revision: 3,
        version: 2,
      }),
    ],
  ]);
  const result = await createBountyStore(fake.db).update(
    "org_1",
    "bty_1",
    2,
    { title: "Fixed title", description: "More" },
    "user_2",
  );
  assert.ok(result.ok);
  assert.equal(result.bounty.title, "Fixed title");
  assert.equal(result.bounty.version, 2);
  const values = fake.calls[1]?.values;
  assert.equal(values?.["revision"], 3);
  assert.equal(values?.["description"], "More");
  assert.equal("repoId" in (values ?? {}), false);
  // New words are the overview's next version, kept by whoever wrote them.
  assert.equal(values?.["version"], 2);
  assert.deepEqual(fake.calls[2]?.values, {
    bountyId: "bty_1",
    version: 2,
    title: "Fixed title",
    description: "More",
    createdBy: "user_2",
    createdAt: new Date("2026-10-01T00:00:00Z"),
  });

  // A stack is not what a proposal is sized from: no version moves.
  const restacked = createSequencedFakeDb([
    [{ row: bountyRow({ revision: 2 }), ...unlinked }],
    [bountyRow({ revision: 3, stack: ["Redis"] })],
  ]);
  const stacked = await createBountyStore(restacked.db).update(
    "org_1",
    "bty_1",
    2,
    { stack: ["Redis"] },
  );
  assert.ok(stacked.ok);
  assert.equal("version" in (restacked.calls[1]?.values ?? {}), false);
  assert.equal(restacked.calls.length, 2);
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
  // Still linked as it was read.
  assert.equal(result.bounty.jira?.key, "APP-3");
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

  // Its stack is the workspace's too, and an unchanged one writes nothing.
  const stacked = createSequencedFakeDb([
    [jiraRow],
    [bountyRow({ origin: "jira", stack: ["Redis"], revision: 2 })],
  ]);
  const added = await createBountyStore(stacked.db).update(
    "org_1",
    "bty_1",
    1,
    { stack: ["Redis"] },
  );
  assert.ok(added.ok);
  assert.deepEqual(stacked.calls[1]?.values?.["stack"], ["Redis"]);
  const same = createSequencedFakeDb([
    [{ ...jiraRow, row: bountyRow({ origin: "jira", stack: ["Redis"] }) }],
  ]);
  const kept = await createBountyStore(same.db).update("org_1", "bty_1", 1, {
    stack: ["Redis"],
  });
  assert.ok(kept.ok);
  assert.equal(same.calls.length, 1);
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
  components: [],
  inputTruncated: false,
};

test("a refresh writes Jira's text only when it differs", async () => {
  assert.equal(jiraContentChange(bountyRow(), jiraText), null);
  assert.deepEqual(
    jiraContentChange(bountyRow(), { ...jiraText, components: ["Mailer"] }),
    { ...jiraText, components: ["Mailer"] },
  );
  // An issue with no summary keeps the title the bounty has.
  assert.equal(
    jiraContentChange(bountyRow(), {
      ...jiraText,
      title: " ",
      description: "New steps",
    })?.title,
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
    [bountyRow({ revision: 5, version: 2 })],
    [bountyRow({ revision: 6, version: 3, description: "New steps" })],
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
  // New words are the overview's next version, which nobody here wrote.
  assert.equal(moved.calls[1]?.values?.["version"], 3);
  assert.equal(moved.calls[2]?.values?.["version"], 3);
  assert.equal(moved.calls[2]?.values?.["description"], "New steps");
  assert.equal(moved.calls[2]?.values?.["createdBy"], null);

  // Jira's components alone are not what a proposal is sized from.
  const regrouped = createSequencedFakeDb([
    [bountyRow({ revision: 5 })],
    [bountyRow({ revision: 6, components: ["Mailer"] })],
  ]);
  assert.equal(
    await createBountyStore(regrouped.db).refreshFromJira("org_1", "bty_1", {
      ...jiraText,
      components: ["Mailer"],
    }),
    true,
  );
  assert.equal("version" in (regrouped.calls[1]?.values ?? {}), false);
  assert.equal(regrouped.calls.length, 2);

  // Changed by someone else since it was read: left for the next read.
  const raced = createSequencedFakeDb([[bountyRow()], []]);
  assert.equal(
    await createBountyStore(raced.db).refreshFromJira("org_1", "bty_1", {
      ...jiraText,
      description: "New steps",
    }),
    false,
  );
  assert.equal(raced.calls.length, 2);

  assert.equal(
    await createBountyStore(createFakeDb([]).db).refreshFromJira(
      "org_1",
      "bty_x",
      jiraText,
    ),
    false,
  );
});

test("a bounty is named by its id alone, and its columns are checked", () => {
  const config = getTableConfig(bounty);
  // No per-organization count: nothing a person reads as `B-12`.
  assert.equal(
    config.columns.some(({ name }) => name === "number"),
    false,
  );
  assert.deepEqual(config.uniqueConstraints, []);
  assert.deepEqual(config.checks.map(({ name }) => name).sort(), [
    "bounty_approved_version_check",
    "bounty_origin_check",
    "bounty_revision_check",
    "bounty_title_check",
    "bounty_version_check",
  ]);
  // One row per version of a bounty's overview, which goes with it.
  const versions = getTableConfig(bountyVersion);
  assert.deepEqual(
    versions.primaryKeys[0]?.columns.map(({ name }) => name),
    ["bounty_id", "version"],
  );
  assert.equal(versions.foreignKeys[0]?.onDelete, "cascade");
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

test("an overview's versions are listed newest first, through its owner", async () => {
  const at = new Date("2026-10-02T00:00:00Z");
  const fake = createFakeDb([
    {
      version: {
        bountyId: "bty_1",
        version: 2,
        title: "Invitations are not sent",
        description: "More steps",
        createdBy: "user_1",
        createdAt: at,
      },
    },
  ]);
  assert.deepEqual(
    await createBountyStore(fake.db).versions("org_1", "bty_1"),
    [
      {
        version: 2,
        title: "Invitations are not sent",
        description: "More steps",
        createdBy: "user_1",
        createdAt: at.toISOString(),
      },
    ],
  );
  assert.equal(fake.calls[0]?.filtered, true);
  assert.equal(fake.calls[0]?.ordered, true);
  // Every bounty has a first version: none is another owner's, or none.
  assert.equal(
    await createBountyStore(createFakeDb([]).db).versions("org_2", "bty_1"),
    null,
  );
});

test("a sandbox reads with the version it is built as, and the bounty and context versions under it", async () => {
  const read = await createBountyStore(
    createFakeDb([
      {
        row: bountyRow(),
        ...unlinked,
        sandboxId: "sbx_1",
        sandboxStatus: "published",
        sandboxVersionId: "sbv_2",
        sandboxExpiresAt: null,
        sandboxSourceRepoId: null,
        buildVersionId: "sbv_2",
        buildVersion: 2,
        buildBountyVersion: 4,
        buildJiraContextVersion: 2,
        buildGithubContextVersion: null,
      },
    ]).db,
  ).get("org_1", "bty_1");
  assert.deepEqual(read?.sandbox?.build, {
    versionId: "sbv_2",
    version: 2,
    bountyVersion: 4,
    // And the context it was generated with.
    context: { jira: 2, github: null },
  });
});

test("an approved overview is held until it is unapproved", async () => {
  const at = new Date("2026-10-06T00:00:00Z");
  const approvedRow = bountyRow({
    revision: 3,
    version: 2,
    approvedVersion: 2,
    approvedBy: "user_1",
    approvedAt: at,
  });

  // Approved at the version it is at, by whoever approved it.
  const approving = createSequencedFakeDb([
    [{ row: bountyRow({ revision: 2, version: 2 }), ...unlinked }],
    [approvedRow],
  ]);
  const approved = await createBountyStore(approving.db).approve(
    "org_1",
    "bty_1",
    2,
    "user_1",
  );
  assert.ok(approved.ok);
  assert.deepEqual(approved.bounty.approval, {
    version: 2,
    approvedBy: "user_1",
    approvedAt: at.toISOString(),
  });
  const set = approving.calls[1]?.values;
  assert.equal(set?.["approvedVersion"], 2);
  assert.equal(set?.["approvedBy"], "user_1");
  assert.ok(set?.["approvedAt"] instanceof Date);
  assert.equal(set?.["revision"], 3);

  // Approved, nothing of it changes: not its text, repository or stack.
  for (const change of [{ title: "Other" }, { stack: ["Redis"] }]) {
    const held = createSequencedFakeDb([[{ row: approvedRow, ...unlinked }]]);
    const refused = await createBountyStore(held.db).update(
      "org_1",
      "bty_1",
      3,
      change,
    );
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.reason, "overview-approved");
    assert.equal(held.calls.length, 1);
  }
  // Asked again, it already stands: no change, no write.
  const again = createSequencedFakeDb([[{ row: approvedRow, ...unlinked }]]);
  assert.ok(
    (await createBountyStore(again.db).approve("org_1", "bty_1", 3, "user_2"))
      .ok,
  );
  assert.equal(again.calls.length, 1);

  // Unapproved, it is open again.
  const unapproving = createSequencedFakeDb([
    [{ row: approvedRow, ...unlinked }],
    [bountyRow({ revision: 4, version: 2 })],
  ]);
  const opened = await createBountyStore(unapproving.db).unapprove(
    "org_1",
    "bty_1",
    3,
  );
  assert.ok(opened.ok);
  assert.equal(opened.bounty.approval, null);
  assert.deepEqual(
    {
      version: unapproving.calls[1]?.values?.["approvedVersion"],
      by: unapproving.calls[1]?.values?.["approvedBy"],
      at: unapproving.calls[1]?.values?.["approvedAt"],
    },
    { version: null, by: null, at: null },
  );

  // A version Jira wrote since is not the one approved: open to change.
  const moved = bountyRow({
    revision: 5,
    version: 3,
    approvedVersion: 2,
    approvedBy: "user_1",
    approvedAt: at,
  });
  const reopened = createSequencedFakeDb([
    [{ row: moved, ...unlinked }],
    [bountyRow({ revision: 6, version: 3, stack: ["Redis"] })],
  ]);
  assert.ok(
    (
      await createBountyStore(reopened.db).update("org_1", "bty_1", 5, {
        stack: ["Redis"],
      })
    ).ok,
  );
});

test("a decision on the overview is made against the revision seen", async () => {
  const missing = createSequencedFakeDb([[]]);
  assert.deepEqual(
    await createBountyStore(missing.db).approve("org_1", "bty_x", 1, "user_1"),
    { ok: false, reason: "not-found" },
  );
  const stale = await createBountyStore(
    createSequencedFakeDb([[{ row: bountyRow({ revision: 2 }), ...unlinked }]])
      .db,
  ).approve("org_1", "bty_1", 1, "user_1");
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.reason, "changed");
  // Lost to a write between the read and its own.
  const raced = await createBountyStore(
    createSequencedFakeDb([
      [{ row: bountyRow(), ...unlinked }],
      [],
      [{ row: bountyRow({ revision: 2 }), ...unlinked }],
    ]).db,
  ).approve("org_1", "bty_1", 1, "user_1");
  assert.equal(raced.ok, false);
  if (!raced.ok) assert.equal(raced.reason, "changed");
  const gone = await createBountyStore(
    createSequencedFakeDb([[{ row: bountyRow(), ...unlinked }], [], []]).db,
  ).approve("org_1", "bty_1", 1, "user_1");
  assert.deepEqual(gone, { ok: false, reason: "not-found" });
});
