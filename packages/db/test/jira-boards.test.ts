import assert from "node:assert/strict";
import { test } from "node:test";

import { createJiraBoardStore } from "../src/jira-boards.js";
import type { JiraBoardRow } from "../src/schema.js";
import { createFakeDb } from "./fake-db.js";

function boardRow(overrides: Partial<JiraBoardRow> = {}): JiraBoardRow {
  return {
    id: "jrb_1",
    organizationId: "org_1",
    connectionId: "jrc_1",
    externalId: "42",
    name: "Acme board",
    boardType: "scrum",
    projectKey: "ACME",
    selection: { maxTickets: 10, excludeAssigned: true },
    createdAt: new Date("2026-09-21T00:00:00.000Z"),
    updatedAt: new Date("2026-09-21T00:00:00.000Z"),
    ...overrides,
  };
}

function store(rows: readonly unknown[]) {
  const fake = createFakeDb(rows);
  return { ...fake, store: createJiraBoardStore(fake.db) };
}

test("list is scoped to the organization", () => {
  const { store: boards, calls } = store([boardRow()]);

  return boards.list("org_1").then((listed) => {
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.name, "Acme board");
    assert.equal(calls[0]?.filtered, true);
  });
});

test("get scopes the read and returns null on a miss", async () => {
  const { store: boards, calls } = store([boardRow()]);
  await boards.get("org_1", "jrb_1");
  assert.equal(calls[0]?.filtered, true);

  const { store: empty } = store([]);
  assert.equal(await empty.get("org_2", "jrb_1"), null);
});

test("register generates a prefixed id and records the owner", async () => {
  const { store: boards, calls } = store([boardRow()]);

  await boards.register("org_1", {
    connectionId: "jrc_1",
    externalId: "42",
    name: "Acme board",
    boardType: "scrum",
    projectKey: "ACME",
  });

  const values = calls[0]?.values ?? {};
  assert.match(String(values["id"]), /^jrb_/);
  assert.equal(values["organizationId"], "org_1");
  assert.equal(values["externalId"], "42");
});

test("a board with no settings gets an empty object, not null", async () => {
  const { store: boards, calls } = store([boardRow()]);

  await boards.register("org_1", {
    connectionId: "jrc_1",
    externalId: "42",
    name: "B",
    boardType: "kanban",
  });

  assert.deepEqual((calls[0]?.values ?? {})["selection"], {});
});

test("sync leaves the settings of a board already registered alone", async () => {
  // The whole point of it being a separate method. Every board on a site is
  // re-read whenever the site's page opens, so this runs against boards
  // somebody has configured — and a sync that reset `selection` would quietly
  // undo their choices on every visit.
  const { store: boards, calls } = store([boardRow()]);

  await boards.sync("org_1", {
    connectionId: "jrc_1",
    externalId: "42",
    name: "Acme board, renamed",
    boardType: "scrum",
    projectKey: "ACME",
  });

  const conflict = calls[0]?.conflictSet ?? {};
  // Jira's own facts are refreshed.
  assert.equal(conflict["name"], "Acme board, renamed");
  assert.equal(conflict["projectKey"], "ACME");
  // Ours are not touched at all.
  assert.equal("selection" in conflict, false);
});

test("a board seen for the first time by sync still gets a row", async () => {
  const { store: boards, calls } = store([boardRow()]);

  await boards.sync("org_1", {
    connectionId: "jrc_1",
    externalId: "43",
    name: "New board",
    boardType: "kanban",
  });

  const values = calls[0]?.values ?? {};
  assert.match(String(values["id"]), /^jrb_/);
  assert.equal(values["organizationId"], "org_1");
  assert.equal(values["externalId"], "43");
  // Empty rather than absent, so the column is never null and the route's
  // schema fills in the defaults on read.
  assert.deepEqual(values["selection"], {});
});

test("sync refuses to report success when no row came back", async () => {
  const { store: boards } = store([]);

  await assert.rejects(
    () =>
      boards.sync("org_1", {
        connectionId: "jrc_1",
        externalId: "42",
        name: "B",
        boardType: "scrum",
      }),
    /Failed to record the Jira board/,
  );
});

test("a selection update is merged, not replaced", async () => {
  // The bug this prevents: editing `maxTickets` alone resetting
  // `excludeAssigned`, which would quietly start pricing assigned tickets.
  const { store: boards, calls } = store([
    boardRow({ selection: { maxTickets: 10, excludeAssigned: false } }),
  ]);

  await boards.update("org_1", "jrb_1", { selection: { maxTickets: 5 } });

  // calls[0] is the read; calls[1] is the write.
  const values = calls[1]?.values ?? {};
  assert.deepEqual(values["selection"], {
    maxTickets: 5,
    excludeAssigned: false,
  });
});

test("an update with no selection leaves the settings as they were", async () => {
  const { store: boards, calls } = store([
    boardRow({ selection: { maxTickets: 7 } }),
  ]);

  await boards.update("org_1", "jrb_1", {});

  const values = calls[1]?.values ?? {};
  assert.deepEqual(values["selection"], { maxTickets: 7 });
});

test("an update writes nothing for a board the caller does not own", async () => {
  const { store: boards, calls } = store([]);

  const result = await boards.update("org_2", "jrb_1", {
    selection: { maxTickets: 3 },
  });

  assert.equal(result, null);
  // The read happened; no write followed.
  assert.equal(calls.filter((call) => call.kind === "update").length, 0);
});

test("the update is scoped to the owner as well as the id", async () => {
  // Belt and braces: the read already checked, but the write must not rely on
  // that having happened.
  const { store: boards, calls } = store([boardRow()]);

  await boards.update("org_1", "jrb_1", { selection: { maxTickets: 3 } });

  assert.equal(calls[1]?.filtered, true);
});

test("remove reports whether anything went, scoped to the owner", async () => {
  const { store: boards, calls } = store([boardRow()]);
  assert.equal(await boards.remove("org_1", "jrb_1"), true);
  assert.equal(calls[0]?.filtered, true);

  const { store: empty } = store([]);
  assert.equal(await empty.remove("org_2", "jrb_1"), false);
});

test("forRun returns the board with the site it reads through", async () => {
  // A run needs both, and the join says the connection still exists rather
  // than assuming it.
  const { store: boards } = store([
    {
      jira_board: boardRow(),
      jira_connection: {
        id: "jrc_1",
        cloudId: "cloud-1",
        siteUrl: "https://acme.atlassian.net",
      },
    },
  ]);

  const found = await boards.forRun("org_1", "jrb_1");

  assert.equal(found?.board.name, "Acme board");
  assert.equal(found?.cloudId, "cloud-1");
  assert.equal(found?.siteUrl, "https://acme.atlassian.net");
});

test("forRun is scoped to the owner and misses cleanly", async () => {
  const { store: boards, calls } = store([]);

  assert.equal(await boards.forRun("org_2", "jrb_1"), null);
  assert.equal(calls[0]?.filtered, true);
});

test("an insert that returns no row fails loudly", async () => {
  // Unreachable while the statement has a RETURNING clause, but a summary
  // built from `undefined` would surface much later as a board that exists in
  // the UI and not in the database.
  const { store: boards } = store([]);

  await assert.rejects(
    () =>
      boards.register("org_1", {
        connectionId: "jrc_1",
        externalId: "42",
        name: "B",
        boardType: "scrum",
      }),
    /Failed to register the Jira board/,
  );
});

test("a null selection column reads as empty settings", async () => {
  // Defensive: the column is NOT NULL with a default, but a summary built
  // from null would throw on the first property read in a run.
  const { store: boards } = store([
    boardRow({ selection: null as unknown as Record<string, never> }),
  ]);

  const listed = await boards.list("org_1");

  assert.deepEqual(listed[0]?.selection, {});
});
