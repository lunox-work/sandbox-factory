import assert from "node:assert/strict";
import { test } from "node:test";
import type { EvaluationJob, EvaluationProvider } from "sandbox-factory";
import { limitJobs } from "../src/evaluation/limit.js";

function provider(fail: () => boolean = () => false) {
  let alive = 0;
  let most = 0;
  const inner: EvaluationProvider = {
    name: "fake",
    async create(spec) {
      if (fail()) throw new Error("provider down");
      alive += 1;
      most = Math.max(most, alive);
      const job: EvaluationJob = {
        id: spec.label,
        environment: {
          provider: "fake",
          environmentId: spec.label,
          templateDigest: "sha256:template",
        },
        stage: async () => {},
        exec: async () => ({
          exitCode: 0,
          timedOut: false,
          outputTruncated: false,
          stdout: "",
          stderr: "",
          durationMs: 1,
        }),
        read: async () => "kept",
        destroy: async () => {
          alive -= 1;
        },
      };
      return job;
    },
  };
  return { inner, most: () => most };
}
const signal = new AbortController().signal;

test("a worker runs at most its cap of evaluation jobs, the next once one is destroyed", async () => {
  const fake = provider();
  const limited = limitJobs(fake.inner, 2);
  assert.equal(limited.name, "fake");
  const first = await limited.create({ label: "a", signal });
  const second = await limited.create({ label: "b", signal });
  let thirdCreated = false;
  const third = limited
    .create({ label: "c", signal })
    .then((job) => ((thirdCreated = true), job));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(thirdCreated, false);
  // The job is the provider's, through the limit.
  await first.stage([]);
  assert.equal((await first.exec({ argv: ["npm"] } as never)).exitCode, 0);
  assert.equal(await first.read("package-lock.json"), "kept");
  await first.destroy();
  // Destroyed twice frees one slot, not two.
  await first.destroy();
  const created = await third;
  assert.equal(created.id, "c");
  assert.equal(fake.most(), 2);
  await second.destroy();
  await created.destroy();
});

test("a job waiting for a slot stops with its run, and a failed create frees its slot", async () => {
  let failing = false;
  const fake = provider(() => failing);
  const limited = limitJobs(fake.inner, 1);
  const held = await limited.create({ label: "a", signal });
  const stop = new AbortController();
  const waiting = limited.create({ label: "b", signal: stop.signal });
  stop.abort(new Error("stopped"));
  await assert.rejects(waiting, /stopped/);
  await assert.rejects(
    limited.create({ label: "c", signal: stop.signal }),
    /stopped/,
  );
  await held.destroy();
  failing = true;
  await assert.rejects(limited.create({ label: "d", signal }), /provider down/);
  failing = false;
  const next = await limited.create({ label: "e", signal });
  assert.equal(next.id, "e");
  await next.destroy();
});
