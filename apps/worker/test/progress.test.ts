import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ANALYSIS_PROGRESS_STEPS_MAX,
  ANALYSIS_PROGRESS_TEXT_MAX,
  type AnalysisProgress,
} from "sandbox-factory";
import { runAgent } from "../src/agent/loop.js";
import type { AgentModel, AgentTool, AgentTurn } from "../src/agent/loop.js";
import { progressRecorder } from "../src/progress.js";
import { describeCheck } from "../src/tools/scope.js";

const at = () => new Date("2026-10-09T00:00:00.000Z");

test("steps are written as they come, without queueing a write behind another", async () => {
  const written: AnalysisProgress[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started: () => void = () => {};
  const firstStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const recorder = progressRecorder(async (progress) => {
    written.push(progress);
    if (written.length === 1) {
      started();
      await gate;
    }
    return true;
  }, at);
  recorder.step("Read src/a.ts");
  await firstStarted;
  // Two more while the first write is out: one write carries both.
  recorder.step("Read src/b.ts");
  recorder.step("Read src/c.ts");
  release();
  await recorder.settled();

  assert.equal(written.length, 2);
  assert.deepEqual(
    written.map(({ count, steps }) => [count, steps.map(({ text }) => text)]),
    [
      [1, ["Read src/a.ts"]],
      [3, ["Read src/a.ts", "Read src/b.ts", "Read src/c.ts"]],
    ],
  );
  assert.equal(written[0]?.steps[0]?.at, "2026-10-09T00:00:00.000Z");
});

test("only the newest steps are kept, each on one bounded line", async () => {
  let last: AnalysisProgress | undefined;
  const recorder = progressRecorder(async (progress) => {
    last = progress;
    return true;
  }, at);
  for (let index = 0; index < ANALYSIS_PROGRESS_STEPS_MAX + 5; index += 1)
    recorder.step(`Step ${index}`);
  recorder.step(`Read ${"x".repeat(ANALYSIS_PROGRESS_TEXT_MAX)}`);
  recorder.step("  \n ");
  recorder.step("Searched for\n  “invite”");
  await recorder.settled();

  assert.equal(last?.count, ANALYSIS_PROGRESS_STEPS_MAX + 7);
  assert.equal(last?.steps.length, ANALYSIS_PROGRESS_STEPS_MAX);
  const long = last?.steps.at(-2)?.text ?? "";
  assert.equal(long.length, ANALYSIS_PROGRESS_TEXT_MAX);
  assert.ok(long.endsWith("…"));
  assert.equal(last?.steps.at(-1)?.text, "Searched for “invite”");
});

test("a write that fails or throws is let go, and the next step tries again", async () => {
  const tries: number[] = [];
  const recorder = progressRecorder((progress) => {
    tries.push(progress.count);
    if (progress.count === 1) throw new Error("database down");
    if (progress.count === 2) return Promise.reject(new Error("lost"));
    return Promise.resolve(true);
  });
  recorder.step("one");
  await recorder.settled();
  recorder.step("two");
  await recorder.settled();
  recorder.step("three");
  await recorder.settled();
  assert.deepEqual(tries, [1, 2, 3]);
  // Nothing out: settled at once.
  await recorder.settled();
});

const usage = {
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};
const turn = (content: unknown[], stopReason = "tool_use"): AgentTurn => ({
  content: content as AgentTurn["content"],
  stopReason,
  usage,
});
const call = (name: string, input: unknown, id: string): unknown => ({
  type: "tool_use",
  id,
  name,
  input,
});
function scripted(turns: AgentTurn[]): AgentModel {
  return {
    model: "test-model",
    async turn() {
      const next = turns.shift();
      if (next === undefined) throw new Error("script exhausted");
      return next;
    },
  };
}

test("the loop says what each call did, as its tool describes it", async () => {
  const read: AgentTool = {
    name: "read",
    description: "Read.",
    inputSchema: { properties: {}, required: [], additionalProperties: false },
    describe: (input, result) =>
      result.isError === true
        ? null
        : `Read ${(input as { path: string }).path}`,
    async run(input) {
      const { path } = input as { path: string };
      return path === "missing"
        ? { content: "No such file.", isError: true }
        : { content: "text" };
    },
  };
  const quiet: AgentTool = {
    name: "quiet",
    description: "Quiet.",
    inputSchema: { properties: {}, required: [], additionalProperties: false },
    async run() {
      return { content: "ok" };
    },
  };
  const submit: AgentTool = {
    name: "submit",
    description: "Submit.",
    inputSchema: { properties: {}, required: [], additionalProperties: false },
    describe: (_input, result) =>
      result.accepted === true ? "Submitted" : null,
    async run() {
      return { content: "Recorded.", accepted: true };
    },
  };
  const steps: string[] = [];
  await runAgent({
    model: scripted([
      turn([
        call("read", { path: "src/a.ts" }, "1"),
        call("read", { path: "missing" }, "2"),
        call("quiet", {}, "3"),
        call("nowhere", {}, "4"),
      ]),
      // Cut off mid-call: not described, whatever it says.
      turn([call("read", { path: "src/b.ts" }, "5")], "max_tokens"),
      turn([call("submit", {}, "6")]),
    ]),
    system: "system",
    prompt: "prompt",
    tools: [read, quiet, submit],
    submitTool: "submit",
    limits: { maxTurns: 10, maxTokens: 10_000 },
    signal: new AbortController().signal,
    log: () => {},
    step: (text) => steps.push(text),
  });
  assert.deepEqual(steps, ["Read src/a.ts", "Submitted"]);
});

test("a slice check reads as the slice it tried", () => {
  const report = (counts: Record<string, number>) => JSON.stringify({ counts });
  assert.equal(
    describeCheck(
      report({ includedFiles: 14, outboundModules: 3, blockers: 1 }),
    ),
    "Tried a slice: 14 files, 3 modules stubbed, 1 blocker",
  );
  assert.equal(
    describeCheck(
      report({ includedFiles: 1, outboundModules: 1, blockers: 2 }),
    ),
    "Tried a slice: 1 file, 1 module stubbed, 2 blockers",
  );
  assert.equal(
    describeCheck(
      report({ includedFiles: 2, outboundModules: 0, blockers: 0 }),
    ),
    "Tried a slice: 2 files",
  );
  assert.equal(describeCheck(report({})), null);
  assert.equal(describeCheck("not json"), null);
});
