import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bountyStatus,
  scopeApproved,
  scopeVersionOf,
  stageDrift,
} from "../src/stages.js";

test("nothing is behind while each step stands on the latest before it", () => {
  assert.deepEqual(
    stageDrift({
      scope: { version: 4 },
      price: { version: 2, scopeVersion: 4 },
      sandbox: { version: 3, priceVersion: 2 },
    }),
    { price: null, sandbox: null },
  );
});

test("a price is behind once the scope moves past what it was sized from", () => {
  const drift = stageDrift({
    scope: { version: 4 },
    price: { version: 3, scopeVersion: 3 },
    sandbox: null,
  });
  assert.deepEqual(drift.price, { uses: 3, current: 4 });
  assert.equal(drift.sandbox, null);
});

test("a price sized from text no version said is behind, from an unknown version", () => {
  assert.deepEqual(
    stageDrift({
      scope: { version: 2 },
      price: { version: 0, scopeVersion: null },
      sandbox: null,
    }).price,
    { uses: null, current: 2 },
  );
});

test("a sandbox is behind once the price is approved as a later version", () => {
  assert.deepEqual(
    stageDrift({
      scope: { version: 1 },
      price: { version: 5, scopeVersion: 1 },
      sandbox: { version: 2, priceVersion: 4 },
    }).sandbox,
    { uses: 4, current: 5 },
  );
  // Built before the record was kept: behind, from a version not known.
  assert.deepEqual(
    stageDrift({
      scope: { version: 1 },
      price: { version: 1, scopeVersion: 1 },
      sandbox: { version: 1, priceVersion: null },
    }).sandbox,
    { uses: null, current: 1 },
  );
});

test("a price never approved, or gone, puts no sandbox behind", () => {
  const sandbox = { version: 1, priceVersion: null };
  assert.equal(
    stageDrift({
      scope: { version: 1 },
      price: { version: 0, scopeVersion: 1 },
      sandbox,
    }).sandbox,
    null,
  );
  assert.equal(
    stageDrift({ scope: { version: 1 }, price: null, sandbox }).sandbox,
    null,
  );
});

test("a scope version is the latest whose text hashes the same", () => {
  const versions = [
    { version: 1, specHash: "a" },
    { version: 3, specHash: "a" },
    { version: 2, specHash: "b" },
  ];
  // Changed and changed back: the latest that says it.
  assert.equal(scopeVersionOf("a", versions), 3);
  assert.equal(scopeVersionOf("b", versions), 2);
  assert.equal(scopeVersionOf("c", versions), null);
});

test("a scope is approved only at the version that was approved", () => {
  assert.equal(scopeApproved({ version: 2, approval: null }), false);
  assert.equal(scopeApproved({ version: 2, approval: { version: 2 } }), true);
  // Jira wrote a new version since: no longer the one approved.
  assert.equal(scopeApproved({ version: 3, approval: { version: 2 } }), false);
});

test("a bounty's status is the last step it has done", () => {
  const now = new Date("2026-10-10T00:00:00Z");
  const base = {
    version: 2,
    approval: null,
    proposal: null,
    sandbox: null,
  };
  assert.equal(bountyStatus(base, now), "new");
  assert.equal(
    bountyStatus({ ...base, approval: { version: 2 } }, now),
    "scoped",
  );
  // A scope edited since its approval is not done.
  assert.equal(bountyStatus({ ...base, approval: { version: 1 } }, now), "new");
  // A price waiting on a decision is not done; an approved one is.
  assert.equal(
    bountyStatus(
      { ...base, approval: { version: 2 }, proposal: { status: "proposed" } },
      now,
    ),
    "scoped",
  );
  assert.equal(
    bountyStatus({ ...base, proposal: { status: "approved" } }, now),
    "priced",
  );
  // A draft sandbox is not done; a published one is, until it lapses.
  const priced = { ...base, proposal: { status: "approved" } };
  assert.equal(
    bountyStatus({ ...priced, sandbox: { status: "draft" } }, now),
    "priced",
  );
  assert.equal(
    bountyStatus(
      { ...priced, sandbox: { status: "published", expiresAt: null } },
      now,
    ),
    "live",
  );
  assert.equal(
    bountyStatus(
      {
        ...priced,
        sandbox: { status: "published", expiresAt: "2026-10-01T00:00:00Z" },
      },
      now,
    ),
    "priced",
  );
});
