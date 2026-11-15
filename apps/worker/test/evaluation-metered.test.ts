import assert from "node:assert/strict";
import { test } from "node:test";

import type { NewEvaluatorUsage } from "@sandbox-factory/db";
import type { EvaluationJob, EvaluationProvider } from "sandbox-factory";

import {
  meteredEvaluation,
  meteredProvider,
} from "../src/evaluation/metered.js";
import { reportedBaselineOf } from "../src/tools/sandbox-build.js";

/**
 * Each evaluation job a run creates is written to the evaluator ledger,
 * against the claimed run's workspace and the run, with the seconds it was
 * alive, when it is torn down.
 */

const run = { organizationId: "org_1", id: "arn_1", tool: "sandbox_build" };
const signal = new AbortController().signal;

/** A provider whose jobs do nothing, and what was done to them. */
function fakeProvider(options: { destroyFails?: boolean } = {}) {
  const done: string[] = [];
  let jobs = 0;
  const provider: EvaluationProvider = {
    name: "fake",
    async create(spec) {
      jobs += 1;
      done.push(`create ${spec.label}`);
      const job: EvaluationJob = {
        id: `job_${jobs}`,
        environment: {
          provider: "fake-provider",
          environmentId: null,
          templateDigest: null,
        },
        stage: async () => void done.push("stage"),
        exec: async (command) => {
          done.push(`exec ${command.argv.join(" ")}`);
          return {
            exitCode: 0,
            timedOut: false,
            outputTruncated: false,
            stdout: "",
            stderr: "",
            durationMs: 1,
          };
        },
        read: async () => null,
        seal: async () => void done.push("seal"),
        egressCut: () => true,
        destroy: async () => {
          done.push("destroy");
          if (options.destroyFails === true) throw new Error("teardown");
        },
      };
      return job;
    },
  };
  return { provider, done };
}
function ledger(fails = false) {
  const rows: Array<{ organizationId: string; entry: NewEvaluatorUsage }> = [];
  return {
    rows,
    record: (organizationId: string, entry: NewEvaluatorUsage) => {
      if (fails) return Promise.reject(new Error("database down"));
      rows.push({ organizationId, entry });
      return Promise.resolve();
    },
  };
}

test("a job's life is one ledger row against the run, in whole seconds rounded up", async () => {
  const fake = fakeProvider();
  const rows = ledger();
  let clock = 1_000;
  const metered = meteredProvider(
    fake.provider,
    run,
    rows,
    () => {
      throw new Error("no error expected");
    },
    () => clock,
  );
  assert.equal(metered.name, "fake");
  const job = await metered.create({ label: "sbv_1", signal });
  assert.equal(job.egressCut?.(), true);
  await job.stage([{ path: "a.ts", text: "" }]);
  await job.exec({ argv: ["npm", "ci"], cwd: ".", timeoutMs: 1 } as never);
  await job.seal([]);
  assert.equal(await job.read("x"), null);
  clock += 2_500;
  await job.destroy();
  // Torn down twice, recorded once.
  await job.destroy();
  assert.deepEqual(rows.rows, [
    {
      organizationId: "org_1",
      entry: {
        runId: "arn_1",
        kind: "sandbox_build",
        provider: "fake-provider",
        seconds: 3,
      },
    },
  ]);
  assert.deepEqual(fake.done, [
    "create sbv_1",
    "stage",
    "exec npm ci",
    "seal",
    "destroy",
    "destroy",
  ]);
});

test("a job whose teardown fails is still recorded, and a failed write is told, not thrown", async () => {
  const rows = ledger();
  const failing = meteredProvider(
    fakeProvider({ destroyFails: true }).provider,
    run,
    rows,
    () => {},
  );
  const job = await failing.create({ label: "x", signal });
  await assert.rejects(job.destroy(), /teardown/);
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0]?.entry.seconds, 1);
  const errors: string[] = [];
  const unwritten = meteredProvider(
    fakeProvider().provider,
    run,
    ledger(true),
    (code) => errors.push(code),
  );
  await (await unwritten.create({ label: "x", signal })).destroy();
  assert.deepEqual(errors, ["evaluator_usage_record_failed"]);
  assert.equal(
    meteredEvaluation(null, run, rows, () => {}),
    null,
  );
});

test("every job of a baseline is metered through the run's provider", async () => {
  const fake = fakeProvider();
  const rows = ledger();
  const provider = meteredEvaluation(fake.provider, run, rows, () => {});
  assert.ok(provider !== null);
  await reportedBaselineOf(provider, {
    label: "sbv_1",
    files: [],
    acceptanceTests: [],
    blockers: [],
    signal,
    log: () => {},
    now: () => new Date("2026-11-15T00:00:00.000Z"),
    timing: undefined,
  });
  const created = fake.done.filter((line) => line.startsWith("create")).length;
  assert.ok(created >= 1);
  assert.equal(rows.rows.length, created);
  assert.ok(rows.rows.every((row) => row.entry.seconds >= 1));
});
