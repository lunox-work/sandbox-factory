import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createModelUsageStore,
  MODEL_TOOLS,
  modelTokensSince,
  NO_MODEL_TOKENS,
  quotaExceeded,
  quotaMonth,
  totalTokens,
} from "../src/model-usage.js";
import { createUsageStore } from "../src/usage.js";
import { createFakeDb } from "./fake-db.js";

/**
 * The ledger the monthly model-token quota counts, and the rule a store
 * admits a new model run by. The stores' own refusals are tested beside
 * them, in `analysis-runs.test.ts` and `bounty-runs.test.ts`.
 */

const turn = {
  runFamily: "analysis" as const,
  runId: "arn_1",
  kind: "scope",
  model: "claude-test",
  inputTokens: 120,
  outputTokens: 30,
  cacheReadTokens: 4_000,
  cacheWriteTokens: 500,
};

test("a reply's tokens are one ledger row against the workspace and the run", async () => {
  const fake = createFakeDb([]);
  await createModelUsageStore(fake.db).record("org_1", turn);
  assert.equal(fake.calls.length, 1);
  const values = fake.calls[0]?.values ?? {};
  assert.equal(fake.calls[0]?.kind, "insert");
  assert.match(String(values["id"]), /^mtk_/);
  assert.deepEqual(
    { ...values, id: undefined },
    { ...turn, organizationId: "org_1", id: undefined },
  );
});

test("a reply that reported no tokens writes nothing", async () => {
  const fake = createFakeDb([]);
  await createModelUsageStore(fake.db).record("org_1", {
    ...turn,
    ...NO_MODEL_TOKENS,
  });
  assert.equal(fake.calls.length, 0);
});

test("every kind of token counts toward the total", () => {
  assert.equal(totalTokens(turn), 120 + 30 + 4_000 + 500);
  assert.equal(totalTokens(NO_MODEL_TOKENS), 0);
});

test("the quota's month is the UTC calendar month, and resets at the next", () => {
  assert.deepEqual(quotaMonth(new Date("2026-11-12T08:30:00.000Z")), {
    from: new Date("2026-11-01T00:00:00.000Z"),
    resetsAt: new Date("2026-12-01T00:00:00.000Z"),
  });
  // The last instant of a month is still in it; the next is the new month.
  assert.deepEqual(quotaMonth(new Date("2026-11-30T23:59:59.999Z")), {
    from: new Date("2026-11-01T00:00:00.000Z"),
    resetsAt: new Date("2026-12-01T00:00:00.000Z"),
  });
  assert.deepEqual(quotaMonth(new Date("2026-12-01T00:00:00.000Z")), {
    from: new Date("2026-12-01T00:00:00.000Z"),
    resetsAt: new Date("2027-01-01T00:00:00.000Z"),
  });
  // December rolls into January of the next year.
  assert.deepEqual(quotaMonth(new Date("2026-12-31T23:00:00.000Z")), {
    from: new Date("2026-12-01T00:00:00.000Z"),
    resetsAt: new Date("2027-01-01T00:00:00.000Z"),
  });
  // A local evening that is already the 1st in UTC is the new month.
  assert.deepEqual(quotaMonth(new Date("2026-10-31T20:00:00.000-08:00")), {
    from: new Date("2026-11-01T00:00:00.000Z"),
    resetsAt: new Date("2026-12-01T00:00:00.000Z"),
  });
});

test("tokens since a date are summed for the workspace, zero with no rows", async () => {
  const summed = createFakeDb([
    {
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
    },
  ]);
  assert.deepEqual(
    await modelTokensSince(summed.db, "org_1", new Date("2026-11-01")),
    {
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
    },
  );
  assert.equal(summed.calls[0]?.filtered, true);
  assert.deepEqual(
    await modelTokensSince(createFakeDb([]).db, "org_1", new Date()),
    NO_MODEL_TOKENS,
  );
});

test("the usage store reports the ledger's tokens", async () => {
  const fake = createFakeDb([{ ...NO_MODEL_TOKENS, outputTokens: 9 }]);
  assert.deepEqual(
    await createUsageStore(fake.db).modelTokens("org_1", new Date()),
    { ...NO_MODEL_TOKENS, outputTokens: 9 },
  );
});

const spent = (total: number) => [{ ...NO_MODEL_TOKENS, inputTokens: total }];
const november = () => new Date("2026-11-12T08:30:00.000Z");

test("a month under its limit admits; one at or over it is refused until it resets", async () => {
  const quota = { monthlyLimit: 1_000, now: november };
  assert.equal(
    await quotaExceeded(createFakeDb(spent(999)).db, "org_1", quota),
    null,
  );
  for (const used of [1_000, 1_250])
    assert.deepEqual(
      await quotaExceeded(createFakeDb(spent(used)).db, "org_1", quota),
      {
        ok: false,
        reason: "quota_exceeded",
        used,
        limit: 1_000,
        resetsAt: new Date("2026-12-01T00:00:00.000Z"),
      },
    );
});

test("only the tools that may call a model are held to the quota", () => {
  assert.deepEqual([...MODEL_TOOLS].sort(), [
    "fixtures",
    "sandbox_build",
    "sandbox_starter",
    "scope",
  ]);
});
