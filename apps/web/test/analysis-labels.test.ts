import { expect, test } from "vitest";

import { runDuration } from "../src/features/analysis/labels";

const run = (seconds: number) =>
  ({
    startedAt: "2026-10-01T00:00:00.000Z",
    finishedAt: new Date(
      Date.parse("2026-10-01T00:00:00.000Z") + seconds * 1000,
    ).toISOString(),
  }) as Parameters<typeof runDuration>[0];

test("a run's duration reads at a glance, however long it took", () => {
  expect(runDuration(run(42))).toBe("42s");
  // Was "1834s".
  expect(runDuration(run(1834))).toBe("30m 34s");
  expect(runDuration(run(3 * 3600 + 125))).toBe("3h 2m");
  expect(
    runDuration({ startedAt: null, finishedAt: null } as Parameters<
      typeof runDuration
    >[0]),
  ).toBeNull();
});
