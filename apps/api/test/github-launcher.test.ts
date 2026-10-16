import assert from "node:assert/strict";
import { test } from "node:test";

import { WorkerLauncher } from "../src/github/launcher.js";

/**
 * The launcher's backoff. The happy paths (coalescing, a fresh worker, an
 * empty queue, local mode) are in `analysis.test.ts`; this is what happens
 * when ECS keeps refusing.
 */

const config = {
  taskDefinition: "worker",
  cluster: "cluster",
  subnets: ["subnet"],
  securityGroup: "egress",
};

test("a launch ECS refuses still holds off the next one for thirty seconds", async () => {
  let now = new Date("2026-10-01T00:00:00.000Z");
  let attempts = 0;
  let refuse: "throw" | "failures" = "throw";
  const launcher = new WorkerLauncher({
    runs: {
      queueState: async () => ({
        queued: true,
        freshWorker: false,
        workers: 0,
        short: false,
      }),
    },
    config,
    now: () => now,
    launch: async () => {
      attempts += 1;
      if (refuse === "throw") throw new Error("ThrottlingException");
      return { $metadata: {}, failures: [{ reason: "RESOURCE:CPU" }] };
    },
  });

  await assert.rejects(launcher.ensureWorker(), /ThrottlingException/);
  // Every later call inside the window asks ECS nothing.
  await launcher.ensureWorker();
  now = new Date(now.getTime() + 29_000);
  await launcher.ensureWorker();
  assert.equal(attempts, 1);

  refuse = "failures";
  now = new Date(now.getTime() + 2_000);
  await assert.rejects(launcher.ensureWorker(), /could not be launched/);
  await launcher.ensureWorker();
  assert.equal(attempts, 2);
});

test("a worker is added beside live ones while the queue is short of slots, up to the cap", async () => {
  let now = new Date("2026-10-01T00:00:00.000Z");
  let state = { queued: true, freshWorker: true, workers: 1, short: false };
  let launches = 0;
  const launcher = new WorkerLauncher({
    runs: { queueState: async () => state },
    config: { ...config, maxWorkers: 2 },
    now: () => now,
    launch: async () => {
      launches += 1;
      return { $metadata: {}, tasks: [{}] };
    },
  });
  // Live workers with slots to spare need no other.
  await launcher.ensureWorker();
  assert.equal(launches, 0);
  state = { ...state, short: true };
  await launcher.ensureWorker();
  assert.equal(launches, 1);
  // The new task is not connected yet, so the queue still looks short:
  // nothing more for two minutes.
  now = new Date(now.getTime() + 60_000);
  await launcher.ensureWorker();
  assert.equal(launches, 1);
  now = new Date(now.getTime() + 61_000);
  state = { ...state, workers: 2 };
  // At the cap, however short.
  await launcher.ensureWorker();
  assert.equal(launches, 1);
  state = { ...state, workers: 1 };
  await launcher.ensureWorker();
  assert.equal(launches, 2);
});
