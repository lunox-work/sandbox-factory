/**
 * The stage rules over their whole state space.
 *
 * A bounty's three steps have a handful of states each, so every
 * combination can be visited, and the laws `stages.ts` documents checked
 * on all of them rather than on chosen examples: the status is the
 * furthest step done, a step is held exactly while a step before it is
 * unapproved, the price's hold never reads the proposal, and a step is
 * behind exactly when the step before it has moved past what it used.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BOUNTY_STATUSES,
  bountyStatus,
  scopeApproved,
  scopeVersionOf,
  stageDrift,
  stepHeldBy,
  stepHeldReason,
  type SandboxStatus,
} from "../src/index.js";

const now = new Date("2026-10-16T12:00:00Z");
const past = "2026-10-16T11:59:59Z";
const future = "2026-10-16T12:00:01Z";

const versions = [1, 2, 3] as const;
const approvals = [null, ...versions.map((version) => ({ version }))];
const proposals = [
  null,
  { status: "proposed" },
  { status: "approved" },
  { status: "withdrawn" },
];
const sandboxes: readonly ({
  readonly status: SandboxStatus;
  readonly expiresAt?: string | null;
} | null)[] = [
  null,
  { status: "draft" },
  { status: "closed" },
  { status: "closed", expiresAt: future },
  { status: "published" },
  { status: "published", expiresAt: null },
  { status: "published", expiresAt: past },
  { status: "published", expiresAt: future },
];

const rank = (status: (typeof BOUNTY_STATUSES)[number]) =>
  BOUNTY_STATUSES.indexOf(status);

test("the status is the furthest step done, over every combination of steps", () => {
  let visited = 0;
  for (const version of versions)
    for (const approval of approvals)
      for (const proposal of proposals)
        for (const sandbox of sandboxes) {
          visited += 1;
          const bounty = { version, approval, proposal, sandbox };
          const scoped = approval !== null && approval.version === version;
          const priced = proposal?.status === "approved";
          const live =
            sandbox !== null &&
            sandbox.status === "published" &&
            (sandbox.expiresAt === undefined ||
              sandbox.expiresAt === null ||
              Date.parse(sandbox.expiresAt) > now.getTime());
          const status = bountyStatus(bounty, now);
          assert.equal(scopeApproved(bounty), scoped);
          // Each step's own flag places the status at least at its rank...
          if (scoped) assert.ok(rank(status) >= rank("scoped"));
          if (priced) assert.ok(rank(status) >= rank("priced"));
          if (live) assert.ok(rank(status) >= rank("live"));
          // ...and nothing else raises it: the status is exactly the max.
          assert.equal(
            rank(status),
            Math.max(
              rank("new"),
              scoped ? rank("scoped") : 0,
              priced ? rank("priced") : 0,
              live ? rank("live") : 0,
            ),
          );
          // The hold: a step waits on every step before it, and only those.
          assert.equal(
            stepHeldBy("price", bounty, proposal),
            scoped ? null : "scope",
          );
          assert.equal(
            stepHeldBy("sandbox", bounty, proposal),
            !scoped ? "scope" : priced ? null : "price",
          );
          // The price's hold never reads the proposal.
          for (const other of proposals)
            assert.equal(
              stepHeldBy("price", bounty, other),
              stepHeldBy("price", bounty, proposal),
            );
          // A sandbox held by the scope means the price is held by it too.
          if (stepHeldBy("sandbox", bounty, proposal) === "scope")
            assert.equal(stepHeldBy("price", bounty, proposal), "scope");
        }
  assert.equal(
    visited,
    versions.length * approvals.length * proposals.length * sandboxes.length,
  );
  for (const step of ["price", "sandbox"] as const)
    for (const heldBy of ["scope", "price"] as const)
      assert.match(stepHeldReason(step, heldBy), /^Approve the .+\.$/);
});

test("a step is behind exactly when the step before it moved past what it used", () => {
  const scopeVersions = [null, ...versions];
  const priceVersions = [0, 1, 2] as const;
  for (const scopeVersion of versions) {
    const scope = { version: scopeVersion };
    const prices = [
      null,
      ...priceVersions.flatMap((version) =>
        scopeVersions
          .filter((used) => used === null || used <= scopeVersion)
          .map((used) => ({ version, scopeVersion: used })),
      ),
    ];
    for (const price of prices) {
      const sandboxStages = [
        null,
        ...[null, 0, 1, 2].map((priceVersion) => ({
          version: 1,
          priceVersion,
        })),
      ];
      for (const sandbox of sandboxStages) {
        const drift = stageDrift({ scope, price, sandbox });
        const priceBehind =
          price !== null &&
          (price.scopeVersion === null || price.scopeVersion < scope.version);
        assert.equal(drift.price !== null, priceBehind);
        if (drift.price !== null && price !== null) {
          assert.equal(drift.price.uses, price.scopeVersion);
          assert.equal(drift.price.current, scope.version);
          assert.ok(
            drift.price.uses === null || drift.price.uses < drift.price.current,
          );
        }
        // A price never approved (version 0) or gone puts nothing behind.
        const sandboxBehind =
          sandbox !== null &&
          price !== null &&
          price.version > 0 &&
          (sandbox.priceVersion === null ||
            sandbox.priceVersion < price.version);
        assert.equal(drift.sandbox !== null, sandboxBehind);
        if (drift.sandbox !== null && sandbox !== null && price !== null) {
          assert.equal(drift.sandbox.uses, sandbox.priceVersion);
          assert.equal(drift.sandbox.current, price.version);
        }
      }
    }
  }
});

test("the scope version of a fingerprint is the latest that hashes to it, for every short history", () => {
  const hashes = ["h1", "h2"] as const;
  const entries = versions.flatMap((version) =>
    hashes.map((specHash) => ({ version, specHash })),
  );
  // Every list of up to three entries, repeats and orderings included.
  const histories: (typeof entries)[number][][] = [[]];
  for (let length = 1; length <= 3; length += 1) {
    const shorter = histories.filter((h) => h.length === length - 1);
    for (const history of shorter)
      for (const entry of entries) histories.push([...history, entry]);
  }
  for (const history of histories)
    for (const hash of [...hashes, "h3"]) {
      const matching = history
        .filter((entry) => entry.specHash === hash)
        .map((entry) => entry.version);
      assert.equal(
        scopeVersionOf(hash, history),
        matching.length === 0 ? null : Math.max(...matching),
      );
    }
});
