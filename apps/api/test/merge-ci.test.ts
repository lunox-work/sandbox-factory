import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  MergeCiRead,
  MergeEnded,
  StoredSubmissionMerge,
} from "@sandbox-factory/db";
import {
  GithubAuthError,
  type CheckRunSummary,
  type CommitStatusSummary,
  type MergeOutcome,
  type PullRequestRead,
} from "@sandbox-factory/github";

import type { MergeBackTarget } from "../src/github/merge-back.js";
import {
  CI_FOLLOW_MS,
  CI_GRACE_MS,
  CI_RECHECK_MS,
  MergeCiTracker,
} from "../src/github/merge-ci.js";

const OPENED = new Date("2026-11-15T00:00:00.000Z");

const opened = (
  overrides: Partial<StoredSubmissionMerge> = {},
): StoredSubmissionMerge => ({
  id: "smg_1",
  submissionId: "sbm_1",
  repositoryFullName: "acme/shop",
  branch: "lunox/sbm_1",
  commitSha: "beef",
  pullRequestNumber: 7,
  pullRequestUrl: "https://github.com/acme/shop/pull/7",
  openedBy: "user_1",
  createdAt: OPENED.toISOString(),
  repoId: "ghr_1",
  mergeWhen: "ci_passes",
  pullRequestState: "open",
  ciState: "pending",
  ciSummary: null,
  ciHeadSha: "beef",
  ciCheckedAt: null,
  mergedCommitSha: null,
  mergedAt: null,
  mergeError: null,
  ...overrides,
});

/** The merge store's rules for followed rows: writes only while open. */
function memoryMerges(rows: StoredSubmissionMerge[]) {
  const byId = new Map(rows.map((row) => [row.submissionId, row]));
  const writes: unknown[] = [];
  return {
    byId,
    writes,
    store: {
      get: async (_owner: string, id: string) => byId.get(id) ?? null,
      openForRepo: async (_owner: string, repoId: string) =>
        [...byId.values()].filter(
          (row) => row.repoId === repoId && row.pullRequestState === "open",
        ),
      dueForCi: async (readBefore: Date, openedSince: Date, limit: number) =>
        [...byId.values()]
          .filter(
            (row) =>
              row.pullRequestState === "open" &&
              row.repoId !== null &&
              new Date(row.createdAt) >= openedSince &&
              (row.ciCheckedAt === null ||
                new Date(row.ciCheckedAt) < readBefore),
          )
          .slice(0, limit)
          .map((merge) => ({ organizationId: "org_1", merge })),
      recordCi: async (_owner: string, id: string, read: MergeCiRead) => {
        const row = byId.get(id);
        if (row === undefined || row.pullRequestState !== "open") return null;
        writes.push({ ci: read });
        const next = {
          ...row,
          ciState: read.ciState,
          ciSummary: read.ciSummary,
          ciHeadSha: read.ciHeadSha,
          ciCheckedAt: read.ciCheckedAt.toISOString(),
          ...(read.mergeError === undefined
            ? {}
            : { mergeError: read.mergeError }),
        };
        byId.set(id, next);
        return next;
      },
      recordPullRequest: async (
        _owner: string,
        id: string,
        ended: MergeEnded,
      ) => {
        const row = byId.get(id);
        if (row === undefined || row.pullRequestState !== "open") return null;
        writes.push({ ended });
        const next = {
          ...row,
          pullRequestState: ended.pullRequestState,
          mergedCommitSha: ended.mergedCommitSha,
          mergedAt: ended.mergedAt?.toISOString() ?? null,
          ciCheckedAt: ended.checkedAt.toISOString(),
        };
        byId.set(id, next);
        return next;
      },
    },
  };
}

/** GitHub's side of `acme/shop`'s pull request #7, and the merge-back target over it. */
function github(
  start: {
    pull?: Partial<PullRequestRead>;
    runs?: CheckRunSummary[];
    statuses?: CommitStatusSummary[];
    merge?: MergeOutcome | Error;
    ciReader?: "ok" | "none" | "revoked" | "down";
    target?: "ok" | "gone";
  } = {},
) {
  const state = {
    pull: {
      number: 7,
      url: "https://github.com/acme/shop/pull/7",
      title: "Fix it",
      state: "open",
      merged: false,
      mergeCommitSha: null,
      headSha: "beef",
      mergeable: true,
      ...start.pull,
    } as PullRequestRead,
    runs: start.runs ?? [],
    statuses: start.statuses ?? [],
    merge: start.merge ?? ({ merged: true, sha: "landed" } as MergeOutcome),
    ciReader: start.ciReader ?? "ok",
    target: start.target ?? "ok",
    merged: [] as { number: number; sha: string; title: string }[],
    reads: [] as string[],
  };
  const target = (): MergeBackTarget => ({
    fullName: "acme/shop",
    defaultBranch: "main",
    missingPermissions: [],
    acceptUrl: "https://github.com/organizations/acme/settings/installations/9",
    ciMissingPermissions:
      state.ciReader === "none" ? ["checks:read", "statuses:read"] : [],
    ciReader:
      state.ciReader === "none"
        ? null
        : {
            checkRuns: async (_fullName: string, sha: string) => {
              state.reads.push(`runs ${sha}`);
              if (state.ciReader === "revoked")
                throw new GithubAuthError(403, "refused");
              if (state.ciReader === "down") throw new Error("down");
              return state.runs;
            },
            statuses: async (_fullName: string, sha: string) => {
              state.reads.push(`statuses ${sha}`);
              return state.statuses;
            },
          },
    writer: {
      open: async () => {
        throw new Error("not opened here");
      },
      getPullRequest: async () => ({ ...state.pull }),
      merge: async (_fullName, number, input) => {
        if (state.merge instanceof Error) throw state.merge;
        if (state.merge.merged)
          state.merged.push({ number, sha: input.sha, title: input.title });
        return state.merge;
      },
    },
  });
  return {
    state,
    targets: {
      target: async (_owner: string, repoId: string) =>
        state.target === "gone" || repoId !== "ghr_1" ? null : target(),
    },
  };
}

const passing: CheckRunSummary[] = [
  { name: "build", status: "completed", conclusion: "success", url: "u" },
];

function tracker(
  rows: StoredSubmissionMerge[],
  hub: ReturnType<typeof github>,
  now = new Date(OPENED.getTime() + 60_000),
) {
  const merges = memoryMerges(rows);
  const events: unknown[][] = [];
  const errors: string[] = [];
  let clock = now;
  const made = new MergeCiTracker({
    merges: merges.store,
    targets: hub.targets,
    submissions: {
      get: async (_owner: string, id: string) =>
        id === "sbm_gone" ? null : ({ id, sandboxVersionId: "sbv_1" } as never),
    },
    emit: (...event) => {
      events.push(event);
    },
    now: () => clock,
    onError: (code, detail) => errors.push(`${code} ${detail ?? ""}`),
  });
  return {
    tracker: made,
    merges,
    events,
    errors,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
  };
}

test("CI passing on a pull request opened to merge when CI passes merges it, squashed at the head read, and says so once", async () => {
  const hub = github({ runs: passing });
  const t = tracker([opened()], hub);
  assert.equal(await t.tracker.refresh("org_1", "sbm_1"), "merged");
  assert.deepEqual(hub.state.merged, [
    { number: 7, sha: "beef", title: "Fix it" },
  ]);
  const row = t.merges.byId.get("sbm_1");
  assert.equal(row?.pullRequestState, "merged");
  assert.equal(row?.mergedCommitSha, "landed");
  assert.equal(row?.ciState, "passing");
  assert.deepEqual(row?.ciSummary, {
    total: 1,
    passed: 1,
    failed: 0,
    pending: 0,
    failing: [],
    detailsUrl: "u",
  });
  assert.deepEqual(
    t.events.map((event) => event.slice(1, 3)),
    [
      ["submission.ci", "sbm_1:beef:passing"],
      ["submission.merged", "sbm_1:merged"],
    ],
  );
  assert.deepEqual(t.events[1]?.[3], {
    submissionId: "sbm_1",
    sandboxVersionId: "sbv_1",
    pullRequestNumber: 7,
    pullRequestUrl: "https://github.com/acme/shop/pull/7",
    mergedCommitSha: "landed",
    by: "platform",
  });
  assert.deepEqual(t.events[0]?.[3], {
    submissionId: "sbm_1",
    sandboxVersionId: "sbv_1",
    pullRequestNumber: 7,
    pullRequestUrl: "https://github.com/acme/shop/pull/7",
    state: "passing",
    headSha: "beef",
    total: 1,
    passed: 1,
    failed: 0,
    pending: 0,
  });
  // Read again: no longer followed, nothing merged twice.
  assert.equal(await t.tracker.refresh("org_1", "sbm_1"), "untracked");
  assert.equal(hub.state.merged.length, 1);
  assert.equal(t.events.length, 2);
});

test("failing CI is recorded and told, and never merged", async () => {
  const hub = github({
    runs: [
      ...passing,
      { name: "e2e", status: "completed", conclusion: "failure", url: "e" },
    ],
  });
  const t = tracker([opened()], hub);
  assert.equal(await t.tracker.refresh("org_1", "sbm_1"), "read");
  assert.deepEqual(hub.state.merged, []);
  const row = t.merges.byId.get("sbm_1");
  assert.equal(row?.ciState, "failing");
  assert.equal(row?.pullRequestState, "open");
  assert.deepEqual(row?.ciSummary?.failing, ["e2e"]);
  assert.equal(row?.ciSummary?.detailsUrl, "e");
  assert.deepEqual(
    t.events.map((event) => event[2]),
    ["sbm_1:beef:failing"],
  );
  // The same state read again tells nobody again.
  await t.tracker.refresh("org_1", "sbm_1");
  assert.equal(t.events.length, 1);
  // A new head (a push) is told even in the same state.
  hub.state.pull = { ...hub.state.pull, headSha: "cafe" };
  await t.tracker.refresh("org_1", "sbm_1");
  assert.deepEqual(
    t.events.map((event) => event[2]),
    ["sbm_1:beef:failing", "sbm_1:cafe:failing"],
  );
  assert.deepEqual(hub.state.reads.slice(-2), ["runs cafe", "statuses cafe"]);
});

test("pending, none and unknown CI never merge; one opened alone is read but never merged", async () => {
  const pending = github({
    runs: [
      { name: "build", status: "in_progress", conclusion: null, url: null },
    ],
  });
  const p = tracker([opened()], pending);
  assert.equal(await p.tracker.refresh("org_1", "sbm_1"), "read");
  assert.equal(p.merges.byId.get("sbm_1")?.ciState, "pending");
  // Pending to pending on the same head: nothing to tell.
  assert.deepEqual(p.events, []);

  // No checks at all: pending until the grace period, then none.
  const quiet = github();
  const q = tracker([opened()], quiet);
  await q.tracker.refresh("org_1", "sbm_1");
  assert.equal(q.merges.byId.get("sbm_1")?.ciState, "pending");
  q.advance(CI_GRACE_MS);
  await q.tracker.refresh("org_1", "sbm_1");
  assert.equal(q.merges.byId.get("sbm_1")?.ciState, "none");
  assert.deepEqual(quiet.state.merged, []);

  // Without checks/statuses read: unknown, and no CI call at all.
  const blind = github({ ciReader: "none", runs: passing });
  const b = tracker([opened()], blind);
  assert.equal(await b.tracker.refresh("org_1", "sbm_1"), "read");
  assert.equal(b.merges.byId.get("sbm_1")?.ciState, "unknown");
  assert.equal(b.merges.byId.get("sbm_1")?.ciSummary, null);
  assert.deepEqual(blind.state.reads, []);
  assert.deepEqual(blind.state.merged, []);
  // Revoked since the stored copy: unknown as well.
  const revoked = github({ ciReader: "revoked", runs: passing });
  const r = tracker([opened()], revoked);
  await r.tracker.refresh("org_1", "sbm_1");
  assert.equal(r.merges.byId.get("sbm_1")?.ciState, "unknown");
  assert.deepEqual(revoked.state.merged, []);

  // Opened alone: CI is read back, the merge is left to people.
  const alone = github({ runs: passing });
  const a = tracker([opened({ mergeWhen: "open" })], alone);
  assert.equal(await a.tracker.refresh("org_1", "sbm_1"), "read");
  assert.equal(a.merges.byId.get("sbm_1")?.ciState, "passing");
  assert.deepEqual(alone.state.merged, []);
});

test("GitHub refusing the merge (branch protection) is recorded and the pull request stays open; a later read merges it", async () => {
  const hub = github({
    runs: passing,
    merge: {
      merged: false,
      status: 405,
      reason: "At least 1 approving review is required.",
    },
  });
  const t = tracker([opened()], hub);
  assert.equal(await t.tracker.refresh("org_1", "sbm_1"), "merge-refused");
  const row = t.merges.byId.get("sbm_1");
  assert.equal(row?.pullRequestState, "open");
  assert.equal(row?.mergeError, "At least 1 approving review is required.");
  assert.equal(row?.ciState, "passing");
  assert.deepEqual(
    t.events.map((event) => event[1]),
    ["submission.ci"],
  );
  // Approved on GitHub: the next read merges.
  hub.state.merge = { merged: true, sha: "landed" };
  assert.equal(await t.tracker.refresh("org_1", "sbm_1"), "merged");
  assert.equal(t.merges.byId.get("sbm_1")?.pullRequestState, "merged");

  // Not mergeable: not even tried.
  const conflicted = github({ runs: passing, pull: { mergeable: false } });
  const c = tracker([opened()], conflicted);
  assert.equal(await c.tracker.refresh("org_1", "sbm_1"), "merge-refused");
  assert.match(
    c.merges.byId.get("sbm_1")?.mergeError ?? "",
    /does not merge cleanly/,
  );
  assert.deepEqual(conflicted.state.merged, []);
  // A token that may not merge: recorded the same way.
  const forbidden = github({
    runs: passing,
    merge: new GithubAuthError(403, "refused"),
  });
  const f = tracker([opened()], forbidden);
  assert.equal(await f.tracker.refresh("org_1", "sbm_1"), "merge-refused");
  assert.match(f.merges.byId.get("sbm_1")?.mergeError ?? "", /contents: write/);
  // Anything else is thrown for the caller to report.
  const down = github({ runs: passing, merge: new Error("down") });
  await assert.rejects(
    tracker([opened()], down).tracker.refresh("org_1", "sbm_1"),
    /down/,
  );
});

test("a pull request merged or closed on GitHub is recorded; merged is told once", async () => {
  const hub = github({
    pull: { state: "closed", merged: true, mergeCommitSha: "by-hand" },
  });
  const t = tracker([opened({ mergeWhen: "open" })], hub);
  assert.equal(await t.tracker.refresh("org_1", "sbm_1"), "merged");
  assert.equal(t.merges.byId.get("sbm_1")?.mergedCommitSha, "by-hand");
  assert.deepEqual(
    t.events.map((event) => [event[1], (event[3] as { by: string }).by]),
    [["submission.merged", "github"]],
  );
  const closed = github({ pull: { state: "closed" } });
  const c = tracker([opened()], closed);
  assert.equal(await c.tracker.refresh("org_1", "sbm_1"), "closed");
  assert.equal(c.merges.byId.get("sbm_1")?.pullRequestState, "closed");
  assert.equal(c.merges.byId.get("sbm_1")?.mergedAt, null);
  assert.deepEqual(c.events, []);
});

test("rows that are not followed, or whose repository is gone, are not read from GitHub", async () => {
  const hub = github({ runs: passing });
  const t = tracker(
    [
      opened({ submissionId: "sbm_old", repoId: null }),
      opened({ submissionId: "sbm_done", pullRequestState: "merged" }),
    ],
    hub,
  );
  assert.equal(await t.tracker.refresh("org_1", "sbm_none"), "untracked");
  assert.equal(await t.tracker.refresh("org_1", "sbm_old"), "untracked");
  assert.equal(await t.tracker.refresh("org_1", "sbm_done"), "untracked");
  const gone = github({ target: "gone" });
  const g = tracker([opened()], gone);
  assert.equal(await g.tracker.refresh("org_1", "sbm_1"), "unavailable");
  // Stamped, so the sweep moves on to others.
  assert.notEqual(g.merges.byId.get("sbm_1")?.ciCheckedAt, null);
  // A submission deleted meanwhile: its events are skipped, the row kept.
  const orphan = github({ runs: passing });
  const o = tracker([opened({ submissionId: "sbm_gone" })], orphan);
  assert.equal(await o.tracker.refresh("org_1", "sbm_gone"), "merged");
  assert.deepEqual(o.events, []);
});

test("a delivery's branch, head or number picks the repository's followed rows", async () => {
  const t = tracker(
    [
      opened(),
      opened({
        submissionId: "sbm_2",
        branch: "lunox/sbm_2",
        pullRequestNumber: 8,
        ciHeadSha: "cafe",
      }),
      opened({ submissionId: "sbm_3", repoId: "ghr_other" }),
    ],
    github(),
  );
  assert.deepEqual(
    await t.tracker.matching("org_1", "ghr_1", { branches: ["lunox/sbm_1"] }),
    ["sbm_1"],
  );
  assert.deepEqual(
    await t.tracker.matching("org_1", "ghr_1", { shas: ["cafe"] }),
    ["sbm_2"],
  );
  assert.deepEqual(
    await t.tracker.matching("org_1", "ghr_1", { pullNumbers: [7, 8] }),
    ["sbm_1", "sbm_2"],
  );
  assert.deepEqual(
    await t.tracker.matching("org_1", "ghr_1", { branches: ["main"] }),
    [],
  );
  assert.deepEqual(await t.tracker.matching("org_1", "ghr_1", {}), []);
});

test("the sweep reads what was not read lately, reports a failure and stamps it so others are not starved", async () => {
  const hub = github({ runs: passing });
  const now = new Date(OPENED.getTime() + CI_GRACE_MS);
  const t = tracker(
    [
      opened({ mergeWhen: "open" }),
      opened({
        submissionId: "sbm_fresh",
        mergeWhen: "open",
        ciCheckedAt: new Date(now.getTime() - 1000).toISOString(),
      }),
      opened({
        submissionId: "sbm_stale",
        mergeWhen: "open",
        createdAt: new Date(now.getTime() - CI_FOLLOW_MS - 1).toISOString(),
      }),
    ],
    hub,
    now,
  );
  assert.deepEqual(await t.tracker.sweep(), { read: 1, failed: 0 });
  assert.equal(t.merges.byId.get("sbm_1")?.ciState, "passing");
  assert.equal(t.merges.byId.get("sbm_fresh")?.ciState, "pending");
  assert.equal(t.merges.byId.get("sbm_stale")?.ciState, "pending");
  // Read within the recheck window: left alone.
  assert.deepEqual(await t.tracker.sweep(), { read: 0, failed: 0 });
  t.advance(CI_RECHECK_MS + 1);
  assert.deepEqual(await t.tracker.sweep(), { read: 2, failed: 0 });

  const down = github({ ciReader: "down" });
  const d = tracker([opened()], down);
  assert.deepEqual(await d.tracker.sweep(), { read: 0, failed: 1 });
  assert.match(d.errors[0] ?? "", /^merge_ci_refresh_failed Error: down/);
  assert.notEqual(d.merges.byId.get("sbm_1")?.ciCheckedAt, null);
  // refreshAll reports rather than throws, and carries on.
  await d.tracker.refreshAll("org_1", ["sbm_1", "sbm_none"]);
  assert.equal(d.errors.length, 2);
});

test("without an emitter or a clock it still reads", async () => {
  const hub = github({ runs: passing });
  const merges = memoryMerges([opened()]);
  const bare = new MergeCiTracker({
    merges: merges.store,
    targets: hub.targets,
    submissions: { get: async () => null },
  });
  assert.equal(await bare.refresh("org_1", "sbm_1"), "merged");
  const failing = new MergeCiTracker({
    merges: memoryMerges([opened()]).store,
    targets: github({ ciReader: "down" }).targets,
    submissions: { get: async () => null },
  });
  // No onError: a failure is swallowed by refreshAll.
  await failing.refreshAll("org_1", ["sbm_1"]);
  const odd = new MergeCiTracker({
    merges: {
      ...memoryMerges([opened()]).store,
      get: async () => {
        throw "not an error";
      },
    },
    targets: hub.targets,
    submissions: { get: async () => null },
    onError: (_code, detail) => assert.equal(detail, "not an error"),
  });
  await odd.refreshAll("org_1", ["sbm_1"]);
});
