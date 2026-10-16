import type { AnalysisRunDto } from "@sandbox-factory/shared";
import { CONTEXT_BUILDERS } from "sandbox-factory";
import { expect, test } from "vitest";

import {
  builderNames,
  runDuration,
  runLabel,
} from "../src/features/analysis/labels";

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

test("every builder has a name, and its runs read by it", () => {
  expect(CONTEXT_BUILDERS.map((builder) => builderNames[builder])).toEqual([
    "Graphify",
    "Abstractions",
    "Data model",
    "Documents",
    "Brief",
  ]);
  for (const builder of ["documents", "brief"] as const)
    expect(
      runLabel({
        tool: builder,
        params: { deadlineMinutes: 30, builder },
      } as AnalysisRunDto),
    ).toBe(builderNames[builder]);
});

test("a sandbox's preparation is told apart from a person's fake data", () => {
  const fixtures = {
    deadlineMinutes: 30,
    agent: "fixtures",
    proposalId: "bpr_1",
    specRevision: 1,
    specHash: "h",
    sliceRunId: "arn_slice",
  } as const;
  expect(
    runLabel({ tool: "fixtures", params: fixtures } as AnalysisRunDto),
  ).toBe("Fake data");
  expect(
    runLabel({
      tool: "fixtures",
      params: {
        ...fixtures,
        pseudonyms: { vocabulary: ["acme"], title: "T", summary: "S" },
      },
    } as AnalysisRunDto),
  ).toBe("Sandbox preparation");
});
