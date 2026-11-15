import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CARRY_LINE_UP_REASON,
  CARVEOUT_STRANDED_NAME_REASON,
  NEW_FILE_ON_REPOSITORY_PATH_REASON,
  carryLimitOf,
  reverseSubmission,
} from "../src/index.js";

test("a new file at a path the repository holds outside the slice is the carry's limit, under the platform's reason", () => {
  // carveout refuses it as not lining up: no lines here, some there.
  const carried = reverseSubmission({
    submitted: [{ path: "src/helper.ts", text: "export const h = 1;\n" }],
    publicText: () => null,
    repositoryText: (path) =>
      path === "src/helper.ts" ? "export const other = 2;\n" : null,
    rules: [],
    renames: [],
    harness: [],
  });
  assert.deepEqual(carried.refused, [
    { path: "src/helper.ts", reason: CARRY_LINE_UP_REASON },
  ]);
  const split = carryLimitOf(carried.refused, () => true);
  assert.deepEqual(split, {
    limits: [
      { path: "src/helper.ts", reason: NEW_FILE_ON_REPOSITORY_PATH_REASON },
    ],
    contributor: [],
  });
  // A file the version has that does not line up is not relabelled.
  assert.deepEqual(carryLimitOf(carried.refused, () => false).contributor, [
    { path: "src/helper.ts", reason: CARRY_LINE_UP_REASON },
  ]);
});

test("carveout's stranded-name refusal (carveout 0.5.0) is the carry's limit; the rest are the contributor's", () => {
  const split = carryLimitOf(
    [
      { path: "src/a.ts", reason: CARVEOUT_STRANDED_NAME_REASON },
      {
        path: "src/b.ts",
        reason:
          "An added line imports ../tests/public/helpers.js, part of the sandbox's harness, which the repository does not have.",
      },
    ],
    () => false,
  );
  assert.deepEqual(
    split.limits.map((refusal) => refusal.path),
    ["src/a.ts"],
  );
  assert.deepEqual(
    split.contributor.map((refusal) => refusal.path),
    ["src/b.ts"],
  );
});
