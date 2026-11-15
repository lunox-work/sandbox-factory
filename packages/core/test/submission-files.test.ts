import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseSubmittedFiles,
  submissionErrorOf,
  submittedFilesText,
  SUBMISSION_ERRORS,
  SUBMISSION_VERDICTS,
} from "../src/index.js";

test("submitted files are stored canonically and read back", () => {
  const text = submittedFilesText([
    { path: "src/b.ts", text: "b" },
    { path: "src/a.ts", text: "a" },
  ]);
  assert.equal(
    text,
    '{"files":[{"path":"src/a.ts","text":"a"},{"path":"src/b.ts","text":"b"}]}',
  );
  assert.equal(
    text,
    submittedFilesText([
      { path: "src/a.ts", text: "a" },
      { path: "src/b.ts", text: "b" },
    ]),
  );
  assert.deepEqual(parseSubmittedFiles(text), [
    { path: "src/a.ts", text: "a" },
    { path: "src/b.ts", text: "b" },
  ]);
  for (const bad of [
    "not json",
    "null",
    '{"files":{}}',
    '{"files":[{"path":1}]}',
  ])
    assert.equal(parseSubmittedFiles(bad), null, bad);
  assert.deepEqual(SUBMISSION_VERDICTS, [
    "passed",
    "overfit",
    "incomplete",
    "refused",
  ]);
});

test("a grading run's failure is told as one fixed reason", () => {
  assert.equal(submissionErrorOf("tool_timeout"), "grading_timed_out");
  assert.equal(submissionErrorOf("worker_lost"), "grading_interrupted");
  for (const code of ["evaluation_failed", "tool_failed", null])
    assert.equal(submissionErrorOf(code), "grading_failed");
  assert.deepEqual([...SUBMISSION_ERRORS].sort(), [
    "grading_failed",
    "grading_interrupted",
    "grading_timed_out",
  ]);
});
