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
    runs: { queueState: async () => ({ queued: true, freshWorker: false }) },
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
