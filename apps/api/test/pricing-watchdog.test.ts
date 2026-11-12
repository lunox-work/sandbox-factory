import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BountyWatchdog,
  RETENTION_INTERVAL_MS,
} from "../src/pricing/watchdog.js";

test("the watchdog fails expired work per organization", async () => {
  const calls: string[] = [];
  const watchdog = new BountyWatchdog({
    runs: {
      organizationsWithExpiredRuns: () => Promise.resolve(["org_1", "org_2"]),
      failExpired: (organizationId) => {
        calls.push(organizationId);
        return Promise.resolve(organizationId === "org_1" ? 2 : 1);
      },
    },
    now: () => new Date("2026-09-22T00:02:00Z"),
  });

  assert.equal(await watchdog.sweep(), 3);
  assert.deepEqual(calls, ["org_1", "org_2"]);
});

test("start sweeps immediately, observes failures, and stop clears its timer", async () => {
  let callback: (() => void) | undefined;
  let cleared = false;
  const errors: string[] = [];
  const watchdog = new BountyWatchdog({
    runs: {
      organizationsWithExpiredRuns: () => Promise.reject(new Error("offline")),
      failExpired: () => Promise.resolve(0),
    },
    setInterval: ((next: () => void) => {
      callback = next;
      return 7;
    }) as unknown as typeof setInterval,
    clearInterval: (() => {
      cleared = true;
    }) as unknown as typeof clearInterval,
    onError: (code) => errors.push(code),
  });

  watchdog.start();
  watchdog.start();
  await new Promise((resolve) => setImmediate(resolve));
  callback?.();
  await new Promise((resolve) => setImmediate(resolve));
  watchdog.stop();
  watchdog.stop();

  assert.deepEqual(errors, [
    "bounty_watchdog_failed",
    "bounty_watchdog_failed",
  ]);
  assert.equal(cleared, true);
});

test("retention passes run hourly beside the sweep, and a failure is reported", async () => {
  let now = new Date("2026-11-12T00:00:00Z");
  const ran: Date[] = [];
  const errors: string[] = [];
  const watchdog = new BountyWatchdog({
    runs: {
      organizationsWithExpiredRuns: () => Promise.resolve([]),
      failExpired: () => Promise.resolve(0),
    },
    retention: [
      (at) => {
        ran.push(at);
        return Promise.resolve(1);
      },
      () => Promise.reject(new Error("offline")),
    ],
    now: () => now,
    onError: (code) => errors.push(code),
  });
  await watchdog.sweep();
  now = new Date(now.getTime() + 30_000);
  await watchdog.sweep();
  now = new Date(now.getTime() + RETENTION_INTERVAL_MS);
  await watchdog.sweep();
  assert.equal(ran.length, 2);
  assert.deepEqual(errors, ["retention_pass_failed", "retention_pass_failed"]);
});
