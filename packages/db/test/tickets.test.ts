import assert from "node:assert/strict";
import { test } from "node:test";

import type { TicketContent } from "sandbox-factory";

import type { TicketRow } from "../src/schema.js";
import {
  createTicketStore,
  followsJira,
  insertTicket,
  jiraContentChange,
} from "../src/tickets.js";
import { createFakeDb, createSequencedFakeDb } from "./fake-db.js";

function ticketRow(overrides: Partial<TicketRow> = {}): TicketRow {
  return {
    id: "tkt_1",
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

/** A ticket read with no Jira issue: every link column null. */
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

const newTicket = {
  title: "Invitations are not sent",
  description: "Steps",
  issueType: "Bug",
  priority: "High",
  labels: ["email"],
  repoId: null,
};

test("creates a ticket written here as the organization's next number", async () => {
  const fake = createFakeDb([ticketRow()]);
  const result = await createTicketStore(fake.db).create(
    "org_1",
    "user_1",
    newTicket,
  );
  assert.ok(result.ok);
  assert.equal(result.ticket.key, "T-7");
  assert.equal(result.ticket.jira, null);
  const values = fake.calls[0]?.values;
  assert.match(String(values?.["id"]), /^tkt_/);
  assert.equal(values?.["organizationId"], "org_1");
  assert.equal(values?.["origin"], "manual");
  assert.equal(values?.["createdBy"], "user_1");
  // Read in the insert itself, so the count is never read and then raced.
  assert.equal(typeof values?.["number"], "object");
});

test("refuses a repository the organization does not have", async () => {
  const fake = createFakeDb([]);
  assert.deepEqual(
    await createTicketStore(fake.db).create("org_1", "user_1", {
      ...newTicket,
      repoId: "ghr_other",
    }),
    { ok: false, reason: "repo-not-found" },
  );
  assert.equal(fake.calls.filter(({ kind }) => kind === "insert").length, 0);
});

test("names a repository the organization has", async () => {
  const fake = createSequencedFakeDb([
    [{ id: "ghr_1" }],
    [ticketRow({ repoId: "ghr_1" })],
  ]);
  const result = await createTicketStore(fake.db).create("org_1", "user_1", {
    ...newTicket,
    repoId: "ghr_1",
  });
  assert.ok(result.ok);
  assert.equal(result.ticket.repoId, "ghr_1");
  assert.equal(fake.calls[0]?.filtered, true);
});

test("a number taken by a concurrent ticket is retried", async () => {
  const taken = Object.assign(new Error("duplicate"), { code: "23505" });
  const fake = createSequencedFakeDb([taken, taken, [ticketRow()]]);
  const created = await insertTicket(fake.db, "org_1", {
    title: "t",
    origin: "manual",
  });
  assert.equal(created.id, "tkt_1");
  assert.equal(fake.calls.length, 3);
});

test("gives up on the number after a bound, and passes other errors on", async () => {
  const taken = Object.assign(new Error("duplicate"), { code: "23505" });
  await assert.rejects(
    insertTicket(createFakeDb([]).db, "org_1", { title: "t" }),
    /no row/,
  );
  await assert.rejects(
    insertTicket(createSequencedFakeDb(Array(8).fill(taken)).db, "org_1", {
      title: "t",
    }),
    /duplicate/,
  );
  const broken = new Error("connection lost");
  const fake = createSequencedFakeDb([broken]);
  await assert.rejects(insertTicket(fake.db, "org_1", { title: "t" }), broken);
  assert.equal(fake.calls.length, 1);
});

test("reads a ticket with its Jira issue, named by the issue's key", async () => {
  const fake = createFakeDb([
    { row: ticketRow({ origin: "jira" }), ...linked },
  ]);
  const ticket = await createTicketStore(fake.db).get("org_1", "tkt_1");
  assert.equal(ticket?.key, "APP-3");
  assert.deepEqual(ticket?.jira, {
    issueId: "jri_1",
    boardId: "jrb_1",
    connectionId: "jrc_1",
    externalId: "10001",
    key: "APP-3",
    siteUrl: "https://acme.atlassian.net",
    removedAt: null,
  });
  assert.equal(fake.calls[0]?.filtered, true);
  assert.equal(ticket === null ? null : followsJira(ticket), true);
});

test("a ticket whose issue has gone is its own again", async () => {
  const fake = createFakeDb([
    {
      row: ticketRow({ origin: "jira" }),
      ...linked,
      removedAt: new Date("2026-10-02T00:00:00Z"),
    },
  ]);
  const ticket = await createTicketStore(fake.db).get("org_1", "tkt_1");
  assert.equal(ticket?.jira?.removedAt, "2026-10-02T00:00:00.000Z");
  assert.equal(ticket === null ? null : followsJira(ticket), false);
});

test("a missing ticket reads as null", async () => {
  assert.equal(
    await createTicketStore(createFakeDb([]).db).get("org_1", "tkt_x"),
    null,
  );
});

test("lists tickets newest first, a page at a time, with their live proposal", async () => {
  const base = {
    id: "tkt_1",
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
      id: "tkt_2",
      number: 8,
      ...linked,
      proposalId: null,
      proposalStatus: null,
      proposalComplexity: null,
      proposalAmountMinor: null,
      proposalCurrency: null,
    },
  ]);
  const listed = await createTicketStore(fake.db).list("org_1", {
    cursor: { createdAt: "2026-10-02T00:00:00Z", id: "tkt_9" },
    limit: 500,
  });
  assert.deepEqual(listed[0]?.proposal, {
    id: "bpr_1",
    status: "approved",
    complexity: "M",
    amountMinor: 10_500,
    currency: "USD",
  });
  assert.equal(listed[0]?.key, "T-7");
  assert.equal(listed[1]?.proposal, null);
  assert.equal(listed[1]?.key, "APP-3");
  assert.equal(fake.calls[0]?.ordered, true);
  assert.equal(fake.calls[0]?.limited, 50);
  assert.equal(fake.calls[0]?.filtered, true);
  assert.deepEqual(
    await createTicketStore(createFakeDb([]).db).list("org_1"),
    [],
  );
});

test("a change is made against the revision the editor saw", async () => {
  const fake = createSequencedFakeDb([
    [{ row: ticketRow({ revision: 2 }), ...unlinked }],
    [ticketRow({ title: "Fixed title", revision: 3 })],
  ]);
  const result = await createTicketStore(fake.db).update("org_1", "tkt_1", 2, {
    title: "Fixed title",
    priority: null,
    labels: [],
    description: "More",
    issueType: "Task",
  });
  assert.ok(result.ok);
  assert.equal(result.ticket.title, "Fixed title");
  const values = fake.calls[1]?.values;
  assert.equal(values?.["revision"], 3);
  assert.equal(values?.["priority"], null);
  assert.equal(values?.["description"], "More");
  assert.equal("repoId" in (values ?? {}), false);
});

test("a stale or missing ticket is not changed", async () => {
  const store = (responses: unknown[][]) =>
    createTicketStore(createSequencedFakeDb(responses).db);
  assert.deepEqual(
    await store([[]]).update("org_1", "tkt_x", 1, { title: "t" }),
    { ok: false, reason: "not-found" },
  );
  const stale = await store([
    [{ row: ticketRow({ revision: 4 }), ...unlinked }],
  ]).update("org_1", "tkt_1", 3, { title: "t" });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.reason, "changed");
  // Changed between the read and the write.
  const raced = await store([
    [{ row: ticketRow(), ...unlinked }],
    [],
    [{ row: ticketRow({ revision: 2 }), ...unlinked }],
  ]).update("org_1", "tkt_1", 1, { title: "t" });
  assert.equal(raced.ok, false);
  if (!raced.ok) assert.equal(raced.reason, "changed");
  // And deleted between them.
  assert.deepEqual(
    await store([[{ row: ticketRow(), ...unlinked }], [], []]).update(
      "org_1",
      "tkt_1",
      1,
      { title: "t" },
    ),
    { ok: false, reason: "not-found" },
  );
});

test("a Jira ticket's text is Jira's; its repository is the platform's", async () => {
  const jiraRow = { row: ticketRow({ origin: "jira" }), ...linked };
  const refused = await createTicketStore(
    createSequencedFakeDb([[jiraRow]]).db,
  ).update("org_1", "tkt_1", 1, { title: "Mine now" });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.reason, "jira-owned");

  const fake = createSequencedFakeDb([
    [jiraRow],
    [{ id: "ghr_1" }],
    [ticketRow({ origin: "jira", repoId: "ghr_1", revision: 2 })],
  ]);
  const result = await createTicketStore(fake.db).update("org_1", "tkt_1", 1, {
    repoId: "ghr_1",
  });
  assert.ok(result.ok);
  // Still named and linked as it was read.
  assert.equal(result.ticket.key, "APP-3");
  assert.equal(result.ticket.jira?.issueId, "jri_1");

  const unknownRepo = await createTicketStore(
    createSequencedFakeDb([[jiraRow], []]).db,
  ).update("org_1", "tkt_1", 1, { repoId: "ghr_other" });
  assert.deepEqual(unknownRepo, { ok: false, reason: "repo-not-found" });

  const cleared = createSequencedFakeDb([
    [jiraRow],
    [ticketRow({ origin: "jira", revision: 2 })],
  ]);
  const unset = await createTicketStore(cleared.db).update(
    "org_1",
    "tkt_1",
    1,
    { repoId: null },
  );
  assert.ok(unset.ok);
  assert.equal(cleared.calls[1]?.values?.["repoId"], null);
});

test("a ticket is removed only while nothing is built on it", async () => {
  const removed = createFakeDb([{ id: "tkt_1" }]);
  assert.equal(
    await createTicketStore(removed.db).remove("org_1", "tkt_1"),
    "removed",
  );
  assert.equal(removed.calls[0]?.kind, "delete");
  assert.equal(removed.calls[0]?.filtered, true);
  assert.equal(
    await createTicketStore(
      createSequencedFakeDb([[], [{ row: ticketRow(), ...unlinked }]]).db,
    ).remove("org_1", "tkt_1"),
    "in-use",
  );
  assert.equal(
    await createTicketStore(createSequencedFakeDb([[], []]).db).remove(
      "org_1",
      "tkt_x",
    ),
    "not-found",
  );
});

const jiraText: TicketContent = {
  title: "Invitations are not sent",
  description: "Steps",
  issueType: "Bug",
  priority: "High",
  labels: ["email"],
  components: [],
  inputTruncated: false,
};

test("a refresh writes Jira's text only when it differs", async () => {
  assert.equal(jiraContentChange(ticketRow(), jiraText), null);
  assert.deepEqual(
    jiraContentChange(ticketRow(), { ...jiraText, components: ["Mailer"] }),
    { ...jiraText, labels: ["email"], components: ["Mailer"] },
  );
  // An issue with no summary keeps the title the ticket has.
  assert.equal(
    jiraContentChange(ticketRow(), { ...jiraText, title: " ", labels: [] })
      ?.title,
    "Invitations are not sent",
  );
  assert.equal(
    jiraContentChange(ticketRow(), { ...jiraText, title: "x".repeat(300) })
      ?.title?.length,
    255,
  );

  const same = createFakeDb([ticketRow()]);
  assert.equal(
    await createTicketStore(same.db).refreshFromJira(
      "org_1",
      "tkt_1",
      jiraText,
    ),
    false,
  );
  assert.equal(same.calls.length, 1);

  const moved = createSequencedFakeDb([
    [ticketRow({ revision: 5 })],
    [{ id: "tkt_1" }],
  ]);
  assert.equal(
    await createTicketStore(moved.db).refreshFromJira("org_1", "tkt_1", {
      ...jiraText,
      description: "New steps",
    }),
    true,
  );
  assert.equal(moved.calls[1]?.values?.["revision"], 6);
  assert.equal(moved.calls[1]?.values?.["description"], "New steps");

  assert.equal(
    await createTicketStore(createFakeDb([]).db).refreshFromJira(
      "org_1",
      "tkt_x",
      jiraText,
    ),
    false,
  );
});
