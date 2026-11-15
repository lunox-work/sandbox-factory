import assert from "node:assert/strict";
import { test } from "node:test";

import {
  describeSubmission,
  isSettled,
  previewLines,
  statusOf,
} from "../src/status.js";
import { submission } from "./fixtures.js";

test("the status bar says grading, the verdict with its scenario keys, or Grade again", () => {
  assert.deepEqual(statusOf(submission({ status: "queued" })), {
    text: "$(sync~spin) Lunox: grading…",
    tooltip: "Submission sbm_1: grading…",
    command: "refreshStatus",
  });
  assert.equal(isSettled(submission({ status: "running" })), false);
  const passed = submission({
    status: "passed",
    verdict: "passed",
    public: { passed: 4, total: 4 },
    hidden: { passed: 3, total: 3 },
  });
  assert.equal(statusOf(passed).text, "$(pass) Lunox: passed");
  assert.equal(statusOf(passed).command, "showSubmission");
  assert.equal(
    describeSubmission(passed),
    "Submission sbm_1: passed (public 4/4 · hidden 3/3).",
  );
  const overfit = submission({
    status: "failed",
    verdict: "overfit",
    failedScenarios: ["s3", "s5"],
    retryOf: "sbm_0",
  });
  assert.equal(statusOf(overfit).text, "$(warning) Lunox: overfit: s3, s5");
  assert.match(describeSubmission(overfit), /^Retry sbm_1: overfit.*s3, s5\.$/);
  assert.equal(
    statusOf({ ...overfit, failedScenarios: [] }).text,
    "$(warning) Lunox: overfit: hidden tests",
  );
  assert.match(
    describeSubmission({ ...overfit, failedScenarios: [] }),
    /fail for a scenario/,
  );
  const incomplete = submission({ status: "failed", verdict: "incomplete" });
  assert.equal(statusOf(incomplete).text, "$(warning) Lunox: incomplete");
  assert.match(describeSubmission(incomplete), /a public test fails/);
  const refused = submission({
    status: "failed",
    verdict: "refused",
    refused: [{ path: "package.json", reason: "Not a task file." }],
  });
  assert.equal(statusOf(refused).text, "$(circle-slash) Lunox: refused");
  assert.match(
    describeSubmission(refused),
    /package\.json \(Not a task file\.\)/,
  );
  const errored = submission({
    status: "errored",
    errorCode: "grading_timed_out",
  });
  assert.deepEqual(
    [statusOf(errored).text, statusOf(errored).command],
    ["$(error) Lunox: errored — Grade again", "gradeAgain"],
  );
  assert.match(
    describeSubmission(errored),
    /\(grading_timed_out\).*spends no retry/,
  );
  assert.doesNotMatch(
    describeSubmission(submission({ status: "errored" })),
    /\(/,
  );
  const odd = submission({ status: "failed", verdict: null });
  assert.equal(statusOf(odd).text, "$(info) Lunox: failed");
  assert.equal(describeSubmission(odd), "Submission sbm_1: failed.");
});

test("the preview lists what is submitted, left out and refused", () => {
  assert.deepEqual(
    previewLines({
      files: [
        { path: "src/fees.ts", change: "changed" },
        { path: "src/min.ts", change: "added" },
      ],
      ignored: [".vscode/settings.json"],
      skipped: 2,
      missing: ["sandbox.env"],
      refused: [{ path: "package.json", reason: "Revert it." }],
    }),
    [
      "To be submitted (2):",
      "  changed: src/fees.ts",
      "  added: src/min.ts",
      "Left out, never submitted (1):",
      "  .vscode/settings.json",
      "Skipped unread: 2 build output file(s).",
      "Not in the folder, the version's text stands: sandbox.env",
      "Refused (1): fix these first.",
      "  package.json: Revert it.",
    ],
  );
  assert.deepEqual(
    previewLines({
      files: [],
      ignored: [],
      skipped: 0,
      missing: [],
      refused: [],
    }),
    ["Nothing to submit: no task file differs from the version."],
  );
});
