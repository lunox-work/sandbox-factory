import assert from "node:assert/strict";
import { test } from "node:test";

import {
  overviewApproved,
  overviewVersionOf,
  stageDrift,
} from "../src/stages.js";

test("nothing is behind while each step stands on the latest before it", () => {
  assert.deepEqual(
    stageDrift({
      overview: { version: 4 },
      bounty: { version: 2, overviewVersion: 4 },
      sandbox: { version: 3, bountyVersion: 2 },
    }),
    { bounty: null, sandbox: null },
  );
});

test("a proposal is behind once the overview moves past what it was sized from", () => {
  const drift = stageDrift({
    overview: { version: 4 },
    bounty: { version: 3, overviewVersion: 3 },
    sandbox: null,
  });
  assert.deepEqual(drift.bounty, { uses: 3, current: 4 });
  assert.equal(drift.sandbox, null);
});

test("a proposal sized from text no version said is behind, from an unknown version", () => {
  assert.deepEqual(
    stageDrift({
      overview: { version: 2 },
      bounty: { version: 0, overviewVersion: null },
      sandbox: null,
    }).bounty,
    { uses: null, current: 2 },
  );
});

test("a sandbox is behind once the bounty is approved as a later version", () => {
  assert.deepEqual(
    stageDrift({
      overview: { version: 1 },
      bounty: { version: 5, overviewVersion: 1 },
      sandbox: { version: 2, bountyVersion: 4 },
    }).sandbox,
    { uses: 4, current: 5 },
  );
  // Built before the record was kept: behind, from a version not known.
  assert.deepEqual(
    stageDrift({
      overview: { version: 1 },
      bounty: { version: 1, overviewVersion: 1 },
      sandbox: { version: 1, bountyVersion: null },
    }).sandbox,
    { uses: null, current: 1 },
  );
});

test("a bounty never approved, or gone, puts no sandbox behind", () => {
  const sandbox = { version: 1, bountyVersion: null };
  assert.equal(
    stageDrift({
      overview: { version: 1 },
      bounty: { version: 0, overviewVersion: 1 },
      sandbox,
    }).sandbox,
    null,
  );
  assert.equal(
    stageDrift({ overview: { version: 1 }, bounty: null, sandbox }).sandbox,
    null,
  );
});

test("an overview version is the latest whose text hashes the same", () => {
  const versions = [
    { version: 1, specHash: "a" },
    { version: 3, specHash: "a" },
    { version: 2, specHash: "b" },
  ];
  // Changed and changed back: the latest that says it.
  assert.equal(overviewVersionOf("a", versions), 3);
  assert.equal(overviewVersionOf("b", versions), 2);
  assert.equal(overviewVersionOf("c", versions), null);
});

test("an overview is approved only at the version that was approved", () => {
  assert.equal(overviewApproved({ version: 2, approval: null }), false);
  assert.equal(
    overviewApproved({ version: 2, approval: { version: 2 } }),
    true,
  );
  // Jira wrote a new version since: no longer the one approved.
  assert.equal(
    overviewApproved({ version: 3, approval: { version: 2 } }),
    false,
  );
});
