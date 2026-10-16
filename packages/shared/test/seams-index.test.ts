import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSeamsIndex, fileSeams } from "sandbox-factory";
import { seamsIndexSchema } from "../src/analysis.js";

test("the seams index the builder writes reads back as written", () => {
  const index = buildSeamsIndex({
    files: [
      fileSeams("src/db.ts", `import pg from "pg";\nprocess.env.DATABASE_URL;`),
      fileSeams("src/gone.ts", null),
    ],
    snapshotId: "rsn_1",
    commitSha: "c",
    graphRunId: "arn_graph",
    graphSha256: "s",
  });
  const json = JSON.parse(JSON.stringify(index)) as unknown;
  assert.deepEqual(seamsIndexSchema.parse(json), index);
  assert.equal(
    seamsIndexSchema.safeParse({ ...index, schemaVersion: 2 }).success,
    false,
  );
  assert.equal(
    seamsIndexSchema.safeParse({ ...index, files: -1 }).success,
    false,
  );
});
