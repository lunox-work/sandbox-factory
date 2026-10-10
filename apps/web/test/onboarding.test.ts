/**
 * The rules home is built on, without rendering it: which stage a workspace
 * is in, what its checklist asks next, and the arithmetic of the two free
 * insights — a backlog scan and a repository x-ray.
 */

import { resolveCategories } from "sandbox-factory";
import { expect, test } from "vitest";

import {
  candidatesIn,
  fitModules,
  openingCategory,
  scanSummary,
  testShare,
} from "../src/features/onboarding/insights";
import {
  areaDescription,
  newBountyUrl,
  prefillFromSearch,
} from "../src/features/onboarding/prefill";
import {
  setupComplete,
  setupStage,
  setupSteps,
  type SetupFacts,
} from "../src/features/onboarding/setup";

function facts(overrides: {
  jira?: Partial<SetupFacts["jira"]>;
  github?: Partial<SetupFacts["github"]>;
  proposals?: number;
  bounties?: number;
}): SetupFacts {
  return {
    jira: {
      available: true,
      connected: 0,
      broken: 0,
      boards: 0,
      ...overrides.jira,
    },
    github: {
      available: true,
      connected: 0,
      repositories: 0,
      ...overrides.github,
    },
    proposals: overrides.proposals ?? 0,
    bounties: overrides.bounties ?? 0,
    canManage: true,
  };
}

test("the stage is what is connected", () => {
  expect(setupStage(facts({}))).toBe("barebone");
  expect(setupStage(facts({ jira: { connected: 1 } }))).toBe("jira");
  // An account with nothing picked from it is GitHub already: home is where
  // the first repository is picked.
  expect(setupStage(facts({ github: { connected: 1 } }))).toBe("github");
  expect(
    setupStage(facts({ jira: { connected: 1 }, github: { repositories: 1 } })),
  ).toBe("both");
  // A site that needs reconnecting reads nothing, so it is not Jira.
  expect(setupStage(facts({ jira: { broken: 1 } }))).toBe("barebone");
});

test("the checklist asks for one step at a time, in the stage's order", () => {
  const current = (value: SetupFacts) =>
    setupSteps(value).find((step) => step.current)?.id;
  expect(setupSteps(facts({})).map(({ id }) => id)).toEqual([
    "jira",
    "github",
    "size",
  ]);
  expect(current(facts({}))).toBe("jira");
  expect(current(facts({ jira: { connected: 1 } }))).toBe("github");
  // Code first: a bounty can be written now, so sizing comes before Jira.
  expect(
    setupSteps(facts({ github: { repositories: 1 } })).map(({ id }) => id),
  ).toEqual(["github", "size", "jira"]);
  expect(current(facts({ github: { repositories: 1 } }))).toBe("size");
  // An account alone is not a repository: the step is not done.
  expect(current(facts({ github: { connected: 1 } }))).toBe("github");
});

test("a tool the server lacks is not a step, and every step done is complete", () => {
  expect(
    setupSteps(facts({ jira: { available: false } })).map(({ id }) => id),
  ).toEqual(["github", "size"]);
  const done = facts({
    jira: { connected: 1 },
    github: { repositories: 1 },
    proposals: 1,
  });
  expect(setupComplete(done)).toBe(true);
  expect(setupSteps(done).some(({ current }) => current)).toBe(false);
  expect(setupComplete(facts({ jira: { connected: 1 }, proposals: 1 }))).toBe(
    false,
  );
});

function issue(id: string, categories: string[]) {
  return {
    id,
    key: `K-${id}`,
    summary: id,
    status: "To Do",
    statusCategory: "new" as const,
    assignee: null,
    priority: null,
    issueType: "Task",
    labels: [],
    projectKey: null,
    parentKey: null,
    created: null,
    updated: null,
    dueDate: null,
    url: null,
    categories: categories.map((category) => ({
      id: category,
      label: category,
      reason: "",
    })),
  };
}

function preview(overrides: Record<string, unknown> = {}) {
  return {
    boardId: "b",
    jql: "",
    categories: resolveCategories(),
    issues: [
      issue("1", ["left-behind"]),
      issue("2", ["left-behind", "paper-cuts"]),
      issue("3", ["paper-cuts"]),
      issue("4", ["paper-cuts"]),
    ],
    matched: {},
    unmatched: 10,
    candidatesScanned: 20,
    skippedLive: 3,
    scanLimitReached: false,
    ticketCapReached: false,
    ...overrides,
  };
}

test("a scan counts each fitting ticket once, proposed ones included", () => {
  expect(scanSummary(preview())).toEqual({
    fitting: 7,
    scanned: 20,
    candidates: 4,
    proposed: 3,
    partial: false,
  });
  expect(scanSummary(preview({ ticketCapReached: true })).partial).toBe(true);
  // The oldest-first fallback carries no category: nothing fits.
  expect(
    scanSummary(preview({ issues: [issue("9", [])], skippedLive: 0 })),
  ).toMatchObject({ fitting: 0, candidates: 0 });
});

test("a scan opens on the category with the most left to size", () => {
  expect(openingCategory(preview())).toBe("paper-cuts");
  expect(candidatesIn(preview(), "left-behind").map(({ id }) => id)).toEqual([
    "1",
    "2",
  ]);
  expect(openingCategory(preview({ issues: [] }))).toBeNull();
  // A category the board turned off is not opened on, whatever it holds.
  const off = resolveCategories({ "paper-cuts": { enabled: false } });
  expect(openingCategory(preview({ categories: off }))).toBe("left-behind");
});

function module(path: string, files: number, testFiles: number) {
  return { path, files, bytes: 1, testFiles, extensions: {} };
}

test("a first bounty fits tested, contained product code", () => {
  const facts = {
    version: 1 as const,
    fileCount: 400,
    totalBytes: 1,
    truncated: false,
    testFiles: 60,
    modules: [
      module(".", 20, 0),
      module("docs", 50, 0),
      module(".github", 5, 0),
      module("apps/huge", 900, 200),
      module("packages/tiny", 2, 1),
      module("packages/untested", 30, 0),
      module("packages/big", 200, 40),
      module("packages/billing", 40, 12),
    ],
    extensions: {},
    lockfiles: [],
    migrationDirectories: [],
    infraDirectories: [],
  };
  expect(fitModules(facts).map(({ path }) => path)).toEqual([
    "packages/billing",
    "packages/big",
    "packages/untested",
  ]);
  expect(fitModules(facts)[0]?.reasons).toEqual(["has its own tests", "small"]);
  expect(fitModules(facts, 1)).toHaveLength(1);
  expect(testShare(facts)).toBe(15);
  expect(testShare({ ...facts, fileCount: 0 })).toBe(0);
});

test("a bounty started from the x-ray carries its module and repository in the address", () => {
  expect(newBountyUrl()).toBe("/bounties/new");
  const url = newBountyUrl({
    area: "packages/billing",
    repository: "acme/app",
  });
  expect(url).toBe("/bounties/new?area=packages%2Fbilling&in=acme%2Fapp");
  expect(prefillFromSearch(url.slice(url.indexOf("?")))).toEqual({
    area: "packages/billing",
    repository: "acme/app",
  });
  expect(prefillFromSearch("?area=x")).toEqual({ area: "x" });
  // An address from when a bounty named its repository names none now.
  expect(prefillFromSearch("?repo=ghr_1")).toBeNull();
  expect(areaDescription({ area: "packages/billing" })).toBe(
    "In `packages/billing`, ",
  );
  expect(
    areaDescription({ area: "packages/billing", repository: "acme/app" }),
  ).toBe("In `packages/billing` of `acme/app`, ");
});
