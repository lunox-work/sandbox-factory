import assert from "node:assert/strict";
import { test } from "node:test";

import {
  all,
  any,
  blocksAtLeast,
  bug,
  carriedAtLeast,
  CATEGORIES,
  classify,
  commentsAtLeast,
  createClassifier,
  deadlineWithin,
  evaluate,
  factsFor,
  openAtLeast,
  priorityAtMost,
  resolveCategories,
  signal,
  silent,
  unassigned,
  type Category,
  type IssueFacts,
  type SelectionIssue,
} from "../src/index.js";

const NOW = new Date("2026-09-30T12:00:00Z");

function ticket(overrides: Partial<SelectionIssue> = {}): SelectionIssue {
  return {
    assignee: null,
    priority: "High",
    issueType: "Story",
    created: "2026-09-29T00:00:00Z",
    updated: "2026-09-29T00:00:00Z",
    dueDate: null,
    sprint: null,
    closedSprints: [],
    votes: null,
    watchers: null,
    links: [],
    releases: [],
    ...overrides,
  };
}

/** A ticket nothing should select: new, owned, important, in a sprint. */
function plainFacts(overrides: Partial<IssueFacts> = {}): IssueFacts {
  return {
    ageDays: 1,
    daysSinceUpdate: 1,
    assigned: true,
    inSprint: true,
    closedSprintCount: 0,
    carriedSince: null,
    votes: 0,
    watchers: 0,
    duplicateLinks: 0,
    blocksOpenCount: 0,
    commentCount: null,
    priorityName: "High",
    priorityRank: "high",
    isBug: false,
    dueInDays: null,
    release: null,
    ...overrides,
  };
}

function ids(facts: IssueFacts, config = {}): string[] {
  return classify(facts, config).map(({ id }) => id);
}

function reasonFor(facts: IssueFacts, id: string): string | undefined {
  return classify(facts).find((match) => match.id === id)?.reason;
}

/* -------------------------------------------------------------------------- */
/* Facts                                                                      */
/* -------------------------------------------------------------------------- */

test("a ticket with nothing on it yields zeros and nulls, not a throw", () => {
  const facts = factsFor(
    ticket({ created: null, updated: null, priority: null }),
    NOW,
  );
  assert.deepEqual(facts, {
    ageDays: 0,
    daysSinceUpdate: 0,
    assigned: false,
    inSprint: false,
    closedSprintCount: 0,
    carriedSince: null,
    votes: 0,
    watchers: 0,
    duplicateLinks: 0,
    blocksOpenCount: 0,
    commentCount: null,
    priorityName: null,
    priorityRank: "none",
    isBug: false,
    dueInDays: null,
    release: null,
  });
});

test("age and quiet are whole days, and never negative", () => {
  const facts = factsFor(
    ticket({
      created: "2025-08-14T12:00:00Z",
      updated: "2026-09-20T13:00:00Z",
    }),
    NOW,
  );
  assert.equal(facts.ageDays, 412);
  assert.equal(facts.daysSinceUpdate, 9);

  const future = factsFor(ticket({ created: "2027-01-01T00:00:00Z" }), NOW);
  assert.equal(future.ageDays, 0);
  assert.equal(factsFor(ticket({ created: "not a date" }), NOW).ageDays, 0);
});

test("priority is ranked by name, and an unknown name is not low", () => {
  const rank = (priority: string | null) =>
    factsFor(ticket({ priority }), NOW).priorityRank;
  assert.equal(rank("Low"), "low");
  assert.equal(rank(" LOWEST "), "low");
  assert.equal(rank("Minor"), "low");
  assert.equal(rank("Trivial"), "low");
  assert.equal(rank("Medium"), "medium");
  assert.equal(rank("Normal"), "medium");
  assert.equal(rank("Critical"), "high");
  assert.equal(rank("P3"), "high");
  assert.equal(rank(null), "none");
  assert.equal(rank("  "), "none");
  assert.equal(
    factsFor(ticket({ priority: " Low " }), NOW).priorityName,
    "Low",
  );
  assert.equal(factsFor(ticket({ priority: " " }), NOW).priorityName, null);
});

test("sprint facts: current sprint, closed count, and when carrying began", () => {
  const facts = factsFor(
    ticket({
      sprint: { state: "future" },
      closedSprints: [
        { startDate: "2026-04-06T09:00:00Z", endDate: "2026-04-20T09:00:00Z" },
        { startDate: "2026-03-09T09:00:00Z", endDate: "2026-03-23T09:00:00Z" },
        { startDate: null, endDate: null },
      ],
    }),
    NOW,
  );
  assert.equal(facts.inSprint, true);
  assert.equal(facts.closedSprintCount, 3);
  assert.equal(facts.carriedSince, "March");

  // A sprint with no start falls back to its end; another year says so.
  const lastYear = factsFor(
    ticket({
      sprint: { state: "closed" },
      closedSprints: [{ startDate: null, endDate: "2025-11-03T09:00:00Z" }],
    }),
    NOW,
  );
  assert.equal(lastYear.inSprint, false);
  assert.equal(lastYear.carriedSince, "November 2025");
});

test("links: duplicates of this ticket, and open tickets it blocks", () => {
  const facts = factsFor(
    ticket({
      links: [
        // Two tickets were filed as duplicates of this one. Closed or not,
        // each is someone who wanted it.
        { type: "Duplicate", direction: "inward", statusCategory: "done" },
        { type: "Duplicate", direction: "inward", statusCategory: "new" },
        // This ticket being a duplicate of another is no demand for it.
        { type: "Duplicate", direction: "outward", statusCategory: "new" },
        { type: "Blocks", direction: "outward", statusCategory: "new" },
        { type: "Blocks", direction: "outward", statusCategory: "unknown" },
        { type: "Blocks", direction: "outward", statusCategory: "done" },
        { type: "Blocks", direction: "inward", statusCategory: "new" },
        { type: "Relates", direction: "outward", statusCategory: "new" },
      ],
    }),
    NOW,
  );
  assert.equal(facts.duplicateLinks, 2);
  assert.equal(facts.blocksOpenCount, 2);
});

test("a ticket that is itself a duplicate is not wanted for being one", () => {
  // Found on a real board: three copies of one ticket, each linked to the
  // original. Counting the link from either end offered all four.
  const copy = factsFor(
    ticket({
      priority: "Low",
      links: [
        { type: "Duplicate", direction: "outward", statusCategory: "new" },
      ],
    }),
    NOW,
  );
  assert.equal(copy.duplicateLinks, 0);
  assert.deepEqual(classify(copy), []);

  const original = factsFor(
    ticket({
      priority: "Low",
      links: [1, 2, 3].map(() => ({
        type: "Duplicate",
        direction: "inward" as const,
        statusCategory: "new",
      })),
    }),
    NOW,
  );
  assert.deepEqual(
    classify(original).map(({ id, reason }) => [id, reason]),
    [["quietly-wanted", "3 duplicates linked, priority Low"]],
  );
});

test("due date counts calendar days; release is the nearest one still ahead", () => {
  const facts = factsFor(
    ticket({
      dueDate: "2026-10-12",
      votes: 4,
      watchers: 9,
      commentCount: 7,
      issueType: " Bug ",
      assignee: "Ada Lovelace",
      releases: [
        { name: "1.9", releaseDate: "2026-09-01", released: false },
        { name: "2.0", releaseDate: "2026-10-05", released: true },
        { name: "2.2", releaseDate: "2026-11-20", released: false },
        { name: "2.1", releaseDate: "2026-10-10", released: false },
        { name: "3.0", releaseDate: null, released: false },
      ],
    }),
    NOW,
  );
  assert.equal(facts.dueInDays, 12);
  assert.deepEqual(facts.release, { name: "2.1", inDays: 10 });
  assert.equal(facts.votes, 4);
  assert.equal(facts.watchers, 9);
  assert.equal(facts.commentCount, 7);
  assert.equal(facts.isBug, true);
  assert.equal(facts.assigned, true);

  assert.equal(factsFor(ticket({ dueDate: "2026-09-28" }), NOW).dueInDays, -2);
});

/* -------------------------------------------------------------------------- */
/* Rules                                                                      */
/* -------------------------------------------------------------------------- */

test("all needs every rule; any reports each rule that held", () => {
  const yes = signal(
    "yes",
    () => true,
    () => "yes",
  );
  const also = signal(
    "also",
    () => true,
    () => "also",
  );
  const no = signal(
    "no",
    () => false,
    () => "no",
  );
  const facts = plainFacts();

  assert.deepEqual(evaluate(all(yes, also), facts), {
    matched: true,
    clauses: ["yes", "also"],
  });
  assert.deepEqual(evaluate(all(yes, no), facts), {
    matched: false,
    clauses: [],
  });
  assert.deepEqual(evaluate(any(no, yes, also), facts), {
    matched: true,
    clauses: ["yes", "also"],
  });
  assert.deepEqual(evaluate(any(no), facts), { matched: false, clauses: [] });
  assert.deepEqual(evaluate(all(silent(yes), any(no, also)), facts), {
    matched: true,
    clauses: ["also"],
  });
  assert.equal(silent(yes).id, "yes");
});

/* -------------------------------------------------------------------------- */
/* The six categories                                                         */
/* -------------------------------------------------------------------------- */

test("nothing selects an ordinary ticket", () => {
  assert.deepEqual(ids(plainFacts()), []);
});

test("left behind: old, quiet, unassigned, never in a sprint", () => {
  const facts = plainFacts({
    ageDays: 412,
    daysSinceUpdate: 200,
    assigned: false,
    inSprint: false,
  });
  assert.deepEqual(ids(facts), ["left-behind"]);
  assert.equal(
    reasonFor(facts, "left-behind"),
    "Open 412 days, never in a sprint, unassigned",
  );

  assert.deepEqual(ids({ ...facts, ageDays: 179 }), []);
  assert.deepEqual(ids({ ...facts, daysSinceUpdate: 89 }), []);
  assert.deepEqual(ids({ ...facts, assigned: true }), []);
  assert.deepEqual(ids({ ...facts, inSprint: true }), []);
  // Carried through a sprint once: it was planned, so it is not left behind.
  assert.deepEqual(ids({ ...facts, closedSprintCount: 1 }), []);
});

test("always next sprint: carried through two or more", () => {
  const facts = plainFacts({ closedSprintCount: 4, carriedSince: "March" });
  assert.deepEqual(ids(facts), ["always-next-sprint"]);
  assert.equal(
    reasonFor(facts, "always-next-sprint"),
    "Carried over 4 sprints since March",
  );
  assert.equal(
    reasonFor({ ...facts, carriedSince: null }, "always-next-sprint"),
    "Carried over 4 sprints",
  );
  assert.deepEqual(ids({ ...facts, closedSprintCount: 1 }), []);
  assert.equal(
    carriedAtLeast(1).describe({ ...facts, closedSprintCount: 1 }),
    "carried over 1 sprint since March",
  );
});

test("quietly wanted: demand on a low-priority ticket", () => {
  const facts = plainFacts({
    priorityName: "Low",
    priorityRank: "low",
    watchers: 9,
    duplicateLinks: 3,
  });
  assert.deepEqual(ids(facts), ["quietly-wanted"]);
  assert.equal(
    reasonFor(facts, "quietly-wanted"),
    "9 watchers, 3 duplicates linked, priority Low",
  );

  // Votes alone are enough; the singular reads correctly.
  assert.equal(
    reasonFor(
      { ...facts, watchers: 0, duplicateLinks: 1, votes: 3 },
      "quietly-wanted",
    ),
    "3 votes, 1 duplicate linked, priority Low",
  );
  // Comments count once something reads them.
  assert.equal(
    reasonFor(
      { ...facts, watchers: 0, duplicateLinks: 0, commentCount: 6 },
      "quietly-wanted",
    ),
    "6 comments, priority Low",
  );
  // The same demand on a ticket that is not low priority is not hidden.
  assert.deepEqual(
    ids({ ...facts, priorityName: "Medium", priorityRank: "medium" }),
    [],
  );
  assert.deepEqual(
    ids({ ...facts, priorityName: null, priorityRank: "none" }),
    [],
  );
  assert.deepEqual(ids({ ...facts, watchers: 4, duplicateLinks: 0 }), []);
});

test("holding others up: blocks open work and nobody owns it", () => {
  const facts = plainFacts({ blocksOpenCount: 3, assigned: false });
  assert.deepEqual(ids(facts), ["holding-others-up"]);
  assert.equal(
    reasonFor(facts, "holding-others-up"),
    "Blocks 3 open tickets, unassigned",
  );
  assert.equal(
    blocksAtLeast(1).describe({ ...facts, blocksOpenCount: 1 }),
    "blocks 1 open ticket",
  );
  assert.deepEqual(ids({ ...facts, assigned: true }), []);
  assert.deepEqual(ids({ ...facts, blocksOpenCount: 0 }), []);
});

test("paper cuts: a low or medium bug that has been open a while", () => {
  const facts = plainFacts({
    isBug: true,
    priorityName: "Low",
    priorityRank: "low",
    ageDays: 180,
  });
  assert.deepEqual(ids(facts), ["paper-cuts"]);
  assert.equal(
    reasonFor(facts, "paper-cuts"),
    "Low-priority bug, open 180 days",
  );
  assert.equal(
    reasonFor(
      { ...facts, priorityName: "Medium", priorityRank: "medium" },
      "paper-cuts",
    ),
    "Medium-priority bug, open 180 days",
  );
  assert.deepEqual(
    ids({ ...facts, priorityName: "High", priorityRank: "high" }),
    [],
  );
  assert.deepEqual(ids({ ...facts, isBug: false }), []);
  assert.deepEqual(ids({ ...facts, ageDays: 89 }), []);
  assert.deepEqual(
    ids({ ...facts, priorityName: null, priorityRank: "none" }),
    [],
  );
});

test("deadline exposed: a date approaching with no owner and no sprint", () => {
  const facts = plainFacts({ dueInDays: 12, assigned: false, inSprint: false });
  assert.deepEqual(ids(facts), ["deadline-exposed"]);
  assert.equal(
    reasonFor(facts, "deadline-exposed"),
    "Due in 12 days, not in any sprint",
  );
  assert.equal(
    reasonFor({ ...facts, dueInDays: 0 }, "deadline-exposed"),
    "Due today, not in any sprint",
  );
  assert.equal(
    reasonFor({ ...facts, dueInDays: 1 }, "deadline-exposed"),
    "Due in 1 day, not in any sprint",
  );

  // A release counts, and the sooner of the two is the one named.
  const release = { name: "2.1", inDays: 10 };
  assert.equal(
    reasonFor({ ...facts, dueInDays: null, release }, "deadline-exposed"),
    "Release 2.1 in 10 days, not in any sprint",
  );
  assert.equal(
    reasonFor({ ...facts, release }, "deadline-exposed"),
    "Release 2.1 in 10 days, not in any sprint",
  );
  assert.equal(
    reasonFor(
      { ...facts, dueInDays: 3, release: { name: "2.1", inDays: 40 } },
      "deadline-exposed",
    ),
    "Due in 3 days, not in any sprint",
  );
  assert.equal(
    reasonFor(
      { ...facts, dueInDays: 5, release: { name: "2.1", inDays: 9 } },
      "deadline-exposed",
    ),
    "Due in 5 days, not in any sprint",
  );

  assert.deepEqual(ids({ ...facts, dueInDays: 31 }), []);
  // Overdue is not approaching.
  assert.deepEqual(ids({ ...facts, dueInDays: -1 }), []);
  assert.deepEqual(ids({ ...facts, assigned: true }), []);
  assert.deepEqual(ids({ ...facts, inSprint: true }), []);
});

test("a ticket in several categories reports every one, in registry order", () => {
  const facts = plainFacts({
    ageDays: 400,
    daysSinceUpdate: 300,
    assigned: false,
    inSprint: false,
    blocksOpenCount: 2,
    isBug: true,
    priorityName: "Minor",
    priorityRank: "low",
    watchers: 6,
    dueInDays: 4,
  });
  assert.deepEqual(ids(facts), [
    "left-behind",
    "quietly-wanted",
    "holding-others-up",
    "paper-cuts",
    "deadline-exposed",
  ]);
});

/* -------------------------------------------------------------------------- */
/* Settings                                                                   */
/* -------------------------------------------------------------------------- */

test("a board's thresholds override the defaults", () => {
  const facts = plainFacts({
    ageDays: 45,
    daysSinceUpdate: 45,
    assigned: false,
    inSprint: false,
  });
  assert.deepEqual(ids(facts), []);
  assert.deepEqual(
    ids(facts, {
      "left-behind": { thresholds: { minAgeDays: 30, minQuietDays: 30 } },
    }),
    ["left-behind"],
  );
});

test("a disabled category never matches", () => {
  const facts = plainFacts({ closedSprintCount: 5 });
  assert.deepEqual(
    ids(facts, { "always-next-sprint": { enabled: false } }),
    [],
  );
  assert.deepEqual(ids(facts, { "always-next-sprint": { enabled: true } }), [
    "always-next-sprint",
  ]);
});

test("stale settings are ignored rather than breaking a rule", () => {
  const resolved = resolveCategories({
    "left-behind": {
      thresholds: {
        minAgeDays: 10,
        minQuietDays: null,
        retiredThreshold: 3,
        minimum: Number.NaN,
      },
    },
    "a-category-that-was-removed": { enabled: false },
    // Inherited names on the config object are not settings.
    constructor: { enabled: false },
  });

  assert.deepEqual(
    resolved.map(({ id }) => id),
    CATEGORIES.map(({ id }) => id),
  );
  const leftBehind = resolved[0];
  assert.deepEqual(leftBehind?.thresholds, {
    minAgeDays: 10,
    minQuietDays: 90,
  });
  assert.equal(
    resolved.every(({ enabled }) => enabled),
    true,
  );
});

test("resolving with no settings returns every default", () => {
  for (const [index, resolved] of resolveCategories().entries()) {
    const category = CATEGORIES[index];
    assert.equal(resolved.label, category?.label);
    assert.equal(resolved.why, category?.why);
    assert.deepEqual(resolved.thresholds, category?.defaults);
  }
});

test("every category has a unique kebab-case id and integer defaults", () => {
  const seen = new Set<string>();
  for (const category of CATEGORIES) {
    assert.match(category.id, /^[a-z]+(-[a-z]+)*$/);
    assert.equal(seen.has(category.id), false);
    seen.add(category.id);
    assert.notEqual(category.label, "");
    assert.notEqual(category.why, "");
    for (const value of Object.values(category.defaults)) {
      assert.equal(Number.isInteger(value) && value >= 0, true);
    }
  }
});

test("a category added to the list is classified with no other change", () => {
  const stale: Category = {
    id: "gone-quiet",
    label: "Gone quiet",
    why: "An example.",
    defaults: { minQuietDays: 30 },
    rule: (t) =>
      silent(
        signal(
          "quiet",
          (facts) => facts.daysSinceUpdate >= (t["minQuietDays"] ?? 0),
          () => "quiet",
        ),
      ),
  };
  const classifier = createClassifier(
    { "gone-quiet": { thresholds: { minQuietDays: 5 } } },
    [...CATEGORIES, stale],
  );
  // Every clause is silent, so the reason falls back to the label.
  assert.deepEqual(classifier(plainFacts({ daysSinceUpdate: 6 })), [
    { id: "gone-quiet", label: "Gone quiet", reason: "Gone quiet" },
  ]);
  assert.deepEqual(classifier(plainFacts({ daysSinceUpdate: 4 })), []);
});

/* -------------------------------------------------------------------------- */
/* Signals, where a category's own tests do not reach                         */
/* -------------------------------------------------------------------------- */

test("signals describe themselves without a category around them", () => {
  const facts = plainFacts({ ageDays: 1, assigned: false });
  assert.equal(openAtLeast(1).describe(facts), "open 1 day");
  assert.equal(unassigned.describe(facts), "unassigned");
  assert.equal(bug.describe({ ...facts, priorityName: null }), "bug");
  assert.equal(
    priorityAtMost("low").describe({ ...facts, priorityName: null }),
    "priority unset",
  );
  assert.equal(priorityAtMost("medium").id, "priority-at-most-medium");
  assert.equal(commentsAtLeast(1).test(facts), false);
  assert.equal(commentsAtLeast(1).describe(facts), "0 comments");
  assert.equal(
    commentsAtLeast(1).describe({ ...facts, commentCount: 1 }),
    "1 comment",
  );
  assert.equal(deadlineWithin(30).test(facts), false);
  assert.equal(deadlineWithin(30).describe(facts), "due today");
  assert.equal(
    deadlineWithin(30).describe({
      ...facts,
      release: { name: "2.1", inDays: 0 },
    }),
    "release 2.1 today",
  );
});
