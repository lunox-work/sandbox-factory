import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createJiraBoardStore,
  mergePricing,
  mergeSelection,
} from "../src/jira-boards.js";
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
    selection: { ticketCap: 10, unassignedOnly: true },
    pricing: {},
    missingSince: null,
    sourceRepoId: null,
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

test("a board sync finds again is listed again", async () => {
  const { store: boards, calls } = store([
    boardRow({ missingSince: new Date("2026-09-30T00:00:00.000Z") }),
  ]);

  await boards.sync("org_1", {
    connectionId: "jrc_1",
    externalId: "42",
    name: "Acme board",
    boardType: "scrum",
  });

  assert.equal(calls[0]?.values?.["missingSince"], null);
  assert.equal(calls[0]?.conflictSet?.["missingSince"], null);
});

test("registering a board lists it again", async () => {
  const { store: boards, calls } = store([boardRow()]);

  await boards.register("org_1", {
    connectionId: "jrc_1",
    externalId: "42",
    name: "Acme board",
    boardType: "scrum",
  });

  assert.equal(calls[0]?.conflictSet?.["missingSince"], null);
});

test("markMissing hides the boards a sync did not see and returns their ids", async () => {
  const { store: boards, calls } = store([{ id: "jrb_1" }, { id: "jrb_2" }]);

  const hidden = await boards.markMissing("org_1", "jrc_1", ["42"]);

  assert.deepEqual(hidden, ["jrb_1", "jrb_2"]);
  const call = calls[0];
  assert.equal(call?.kind, "update");
  // Hidden, not deleted: the runs and proposals hang off the row.
  assert.equal(
    calls.some(({ kind }) => kind === "delete"),
    false,
  );
  assert.ok(call?.values?.["missingSince"] instanceof Date);
  assert.equal(call?.filtered, true);
});

test("markMissing reports nothing when every board was seen", async () => {
  const { store: boards } = store([]);
  assert.deepEqual(await boards.markMissing("org_1", "jrc_1", []), []);
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
  // The bug this prevents: editing `ticketCap` alone resetting
  // `unassignedOnly`, which would quietly change which tickets are priced.
  const { store: boards, calls } = store([
    boardRow({ selection: { ticketCap: 10, unassignedOnly: true } }),
  ]);

  await boards.update("org_1", "jrb_1", { selection: { ticketCap: 5 } });

  // calls[0] is the read; calls[1] is the write.
  const values = calls[1]?.values ?? {};
  assert.deepEqual(values["selection"], {
    ticketCap: 5,
    unassignedOnly: true,
  });
});

test("a null in an update removes the setting instead of storing a null", async () => {
  // A stored null would have to be explained by every later read. Removing
  // the key is what "back to the default" means.
  const { store: boards, calls } = store([
    boardRow({ selection: { ticketCap: 10, maxAgeDays: 90, minAgeDays: 7 } }),
  ]);

  await boards.update("org_1", "jrb_1", {
    selection: { ticketCap: null, maxAgeDays: null },
  });

  assert.deepEqual(calls[1]?.values?.["selection"], { minAgeDays: 7 });
});

test("category settings merge by category and by threshold", async () => {
  // Tuning one number must leave every other category, and every other
  // threshold of the same category, as it was.
  const { store: boards, calls } = store([
    boardRow({
      selection: {
        minAgeDays: 7,
        categories: {
          "left-behind": {
            enabled: true,
            thresholds: { minAgeDays: 200, minQuietDays: 60 },
          },
          "paper-cuts": { enabled: false },
        },
      },
    }),
  ]);

  await boards.update("org_1", "jrb_1", {
    selection: {
      categories: {
        "left-behind": { thresholds: { minAgeDays: 365 } },
        "quietly-wanted": { thresholds: { minWatchers: 2 } },
      },
    },
  });

  assert.deepEqual(calls[1]?.values?.["selection"], {
    minAgeDays: 7,
    categories: {
      "left-behind": {
        enabled: true,
        thresholds: { minAgeDays: 365, minQuietDays: 60 },
      },
      "paper-cuts": { enabled: false },
      "quietly-wanted": { thresholds: { minWatchers: 2 } },
    },
  });
});

test("clearing every override returns a category to its defaults", () => {
  const merged = mergeSelection(
    {
      categories: {
        "left-behind": { thresholds: { minAgeDays: 200, minQuietDays: 60 } },
        "paper-cuts": { enabled: false, thresholds: { minAgeDays: 30 } },
        "deadline-exposed": undefined,
      },
    },
    {
      categories: {
        // Both thresholds cleared and nothing else set: nothing is left.
        "left-behind": { thresholds: { minAgeDays: null, minQuietDays: null } },
        // One cleared; the switch stays.
        "paper-cuts": { thresholds: { minAgeDays: null, other: undefined } },
        "always-next-sprint": undefined,
        // An update that says nothing stores nothing.
        "holding-others-up": {},
      },
    },
  );

  assert.deepEqual(merged, {
    categories: { "paper-cuts": { enabled: false } },
  });
  // And an update that does not mention categories leaves them alone.
  assert.deepEqual(
    mergeSelection(
      { categories: { "paper-cuts": { enabled: false } } },
      {
        minAgeDays: 3,
        unassignedOnly: undefined,
      },
    ),
    { categories: { "paper-cuts": { enabled: false } }, minAgeDays: 3 },
  );
});

test("an update with no selection leaves the settings as they were", async () => {
  const { store: boards, calls } = store([
    boardRow({ selection: { ticketCap: 7 } }),
  ]);

  await boards.update("org_1", "jrb_1", {});

  const values = calls[1]?.values ?? {};
  assert.deepEqual(values["selection"], { ticketCap: 7 });
});

test("an update writes nothing for a board the caller does not own", async () => {
  const { store: boards, calls } = store([]);

  const result = await boards.update("org_2", "jrb_1", {
    selection: { ticketCap: 3 },
  });

  assert.equal(result, null);
  // The read happened; no write followed.
  assert.equal(calls.filter((call) => call.kind === "update").length, 0);
});

test("the update is scoped to the owner as well as the id", async () => {
  // Belt and braces: the read already checked, but the write must not rely on
  // that having happened.
  const { store: boards, calls } = store([boardRow()]);

  await boards.update("org_1", "jrb_1", { selection: { ticketCap: 3 } });

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

test("a pricing update is merged setting by setting, and null clears", () => {
  const existing = {
    step: { pointsPerStep: 6, weightPoints: { light: 0, heavy: 5 } },
  };
  assert.deepEqual(
    mergePricing(existing, {
      step: { weightPoints: { heavy: null, moderate: 3 } },
    }),
    { step: { pointsPerStep: 6, weightPoints: { light: 0, moderate: 3 } } },
  );
  assert.deepEqual(mergePricing(existing, { step: { pointsPerStep: null } }), {
    step: { weightPoints: { light: 0, heavy: 5 } },
  });
  // Every override cleared leaves an empty step: every default.
  assert.deepEqual(
    mergePricing(
      { step: { pointsPerStep: 6 } },
      { step: { pointsPerStep: null, weightPoints: { light: undefined } } },
    ),
    { step: {} },
  );
  // No step in the update leaves the pricing as it was.
  assert.equal(mergePricing(existing, {}), existing);
  assert.deepEqual(mergePricing({}, { step: { pointsPerStep: 2 } }), {
    step: { pointsPerStep: 2 },
  });
});

test("an update stores merged pricing and leaves the selection alone", async () => {
  const { store: boards, calls } = store([
    boardRow({ pricing: { step: { pointsPerStep: 6 } } }),
  ]);
  const updated = await boards.update("org_1", "jrb_1", {
    pricing: { step: { weightPoints: { heavy: 8 } } },
  });
  const values = calls[1]?.values ?? {};
  assert.deepEqual(values["pricing"], {
    step: { pointsPerStep: 6, weightPoints: { heavy: 8 } },
  });
  assert.deepEqual(values["selection"], {
    ticketCap: 10,
    unassignedOnly: true,
  });
  // The board the store hands back carries its pricing.
  assert.deepEqual(updated?.pricing, { step: { pointsPerStep: 6 } });
});

test("a selection update leaves the pricing alone, and a null column reads as empty", async () => {
  const { store: boards, calls } = store([
    boardRow({ pricing: null as unknown as Record<string, never> }),
  ]);
  const updated = await boards.update("org_1", "jrb_1", {
    selection: { ticketCap: 3 },
  });
  assert.equal(calls[1]?.values?.["pricing"], null);
  assert.deepEqual(updated?.pricing, {});

  // A pricing update over a null column starts from no overrides.
  const fresh = store([
    boardRow({ pricing: null as unknown as Record<string, never> }),
  ]);
  await fresh.store.update("org_1", "jrb_1", {
    pricing: { step: { pointsPerStep: 2 } },
  });
  assert.deepEqual(fresh.calls[1]?.values?.["pricing"], {
    step: { pointsPerStep: 2 },
  });
});

test("an update can link a source repository, and the summary carries it", async () => {
  const { store: boards, calls } = store([boardRow({ sourceRepoId: "ghr_1" })]);

  const updated = await boards.update("org_1", "jrb_1", {
    sourceRepoId: "ghr_1",
  });

  assert.equal(updated?.sourceRepoId, "ghr_1");
  assert.equal(calls[1]?.values?.["sourceRepoId"], "ghr_1");
  assert.equal(calls[1]?.filtered, true);
});

test("null unlinks, and an update that does not name the repository leaves it", async () => {
  const unlink = store([boardRow()]);
  await unlink.store.update("org_1", "jrb_1", { sourceRepoId: null });
  assert.equal(unlink.calls[1]?.values?.["sourceRepoId"], null);

  const untouched = store([boardRow({ sourceRepoId: "ghr_1" })]);
  await untouched.store.update("org_1", "jrb_1", { pricing: {} });
  assert.equal("sourceRepoId" in (untouched.calls[1]?.values ?? {}), false);
});

test("a board row from before repository links reads as unlinked", async () => {
  const legacy: Record<string, unknown> = { ...boardRow() };
  delete legacy["sourceRepoId"];
  const { store: boards } = store([legacy]);
  assert.equal((await boards.get("org_1", "jrb_1"))?.sourceRepoId, null);
});
