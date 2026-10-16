import assert from "node:assert/strict";
import { test } from "node:test";
import type { PendingCut, StoredSandbox } from "@sandbox-factory/db";

import { SandboxCutter } from "../src/sandbox/cutter.js";

const at = "2026-10-16T00:00:00.000Z";
const sandbox = { id: "sbx_1", organizationId: "org_1" } as StoredSandbox;

type Sliced = Awaited<
  ReturnType<ConstructorParameters<typeof SandboxCutter>[0]["slice"]>
>;
const pending = { ok: true, slice: {}, result: null, run: null } as Sliced;
const cut = { ok: true, slice: {}, result: {}, run: {} } as Sliced;
const refused = (code?: string) =>
  ({
    ok: false,
    body: code === undefined ? { error: "No." } : { error: "No.", code },
    reason: "conflict",
  }) as Sliced;

function harness(
  cuts: PendingCut[],
  answer: (sandboxId: string) => Sliced | Error,
  sandboxes: Record<string, StoredSandbox> = { sbx_1: sandbox },
) {
  const cleared: unknown[] = [];
  const sliced: unknown[] = [];
  const errors: string[] = [];
  const cutter = new SandboxCutter({
    sandboxes: {
      organizationsWithPendingCuts: async () => ["org_1"],
      pendingCuts: async () => cuts,
      get: async (_owner, id) => sandboxes[id] ?? null,
      clearCut: async (owner, sandboxId, requestedAt) => {
        cleared.push({ owner, sandboxId, requestedAt });
      },
    },
    slice: async (owner, actor, found) => {
      sliced.push({ owner, actor, sandboxId: found.id });
      const result = answer(found.id);
      if (result instanceof Error) throw result;
      return result;
    },
    now: () => new Date(at),
    onError: (code) => errors.push(code),
  });
  return { cutter, cleared, sliced, errors };
}

test("a request is made again as the person who asked, and kept while still pending", async () => {
  const h = harness(
    [{ sandboxId: "sbx_1", requestedBy: "user_1", requestedAt: at }],
    () => pending,
  );
  await h.cutter.sweep();
  assert.deepEqual(h.sliced, [
    { owner: "org_1", actor: "user_1", sandboxId: "sbx_1" },
  ]);
  assert.deepEqual(h.cleared, []);
});

test("a cut draft is left to the service to clear; the cap keeps the request for the next pass", async () => {
  for (const answer of [cut, refused("run_limit")]) {
    const h = harness(
      [{ sandboxId: "sbx_1", requestedBy: "user_1", requestedAt: at }],
      () => answer,
    );
    await h.cutter.sweep();
    assert.deepEqual(h.cleared, []);
  }
});

test("a refusal, a sandbox gone or a person gone clears the request as read", async () => {
  const h = harness(
    [
      { sandboxId: "sbx_1", requestedBy: "user_1", requestedAt: at },
      { sandboxId: "sbx_gone", requestedBy: "user_1", requestedAt: at },
      { sandboxId: "sbx_2", requestedBy: null, requestedAt: at },
      { sandboxId: "sbx_3", requestedBy: "user_1", requestedAt: at },
    ],
    (id) => (id === "sbx_1" ? refused("slice_failed") : refused()),
    {
      sbx_1: sandbox,
      sbx_2: { ...sandbox, id: "sbx_2" },
      sbx_3: { ...sandbox, id: "sbx_3" },
    },
  );
  await h.cutter.sweep();
  assert.deepEqual(
    h.cleared.map((item) => (item as { sandboxId: string }).sandboxId),
    ["sbx_1", "sbx_gone", "sbx_2", "sbx_3"],
  );
  assert.ok(
    h.cleared.every(
      (item) => (item as { requestedAt: string }).requestedAt === at,
    ),
  );
  // Nobody to act as: not sliced at all.
  assert.equal(h.sliced.length, 2);
});

test("one request's trouble is reported and the rest still move", async () => {
  const h = harness(
    [
      { sandboxId: "sbx_1", requestedBy: "user_1", requestedAt: at },
      { sandboxId: "sbx_2", requestedBy: "user_1", requestedAt: at },
    ],
    (id) => (id === "sbx_1" ? new Error("database blip") : refused("x")),
    { sbx_1: sandbox, sbx_2: { ...sandbox, id: "sbx_2" } },
  );
  await h.cutter.sweep();
  assert.deepEqual(h.errors, ["sandbox_cut_failed"]);
  assert.deepEqual(
    h.cleared.map((item) => (item as { sandboxId: string }).sandboxId),
    ["sbx_2"],
  );
});

test("a kick during a pass runs one more after it; a stopped cutter starts none", async () => {
  let passes = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const errors: string[] = [];
  const cutter = new SandboxCutter({
    sandboxes: {
      organizationsWithPendingCuts: async () => {
        passes++;
        if (passes === 1) await gate;
        if (passes === 3) throw new Error("unreachable database");
        return [];
      },
      pendingCuts: async () => [],
      get: async () => null,
      clearCut: async () => {},
    },
    slice: async () => pending,
    intervalMs: 60_000,
    onError: (code) => errors.push(code),
  });
  cutter.start();
  cutter.start();
  const first = cutter.sweep();
  cutter.kick();
  release();
  await first;
  assert.equal(passes, 2);
  cutter.kick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, ["sandbox_cut_sweep_failed"]);
  await cutter.stop();
  cutter.kick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(passes, 3);
});
