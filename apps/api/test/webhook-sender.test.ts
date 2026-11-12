import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  AnalysisRunStore,
  BountyRunStore,
  ClaimedWebhookDelivery,
  SandboxStore,
  StoredAnalysisRun,
  StoredBountyRun,
  StoredWebhookDelivery,
  WebhookAttempt,
  WebhookEvent,
} from "@sandbox-factory/db";

import { eventId, WebhookEmitter } from "../src/webhooks/emitter.js";
import {
  nextAttemptAt,
  WEBHOOK_DISABLE_AFTER,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_RETRY_DELAYS_MS,
  WebhookSender,
} from "../src/webhooks/sender.js";
import { verifySignature } from "../src/webhooks/signature.js";
import type { WebhookRequest } from "../src/webhooks/transport.js";

/**
 * The sender's attempts, retries and disabling, and the emitter that turns
 * run changes and settled work into events.
 */

const NOW = new Date("2026-11-12T00:00:00.000Z");

function claimed(
  overrides: Partial<ClaimedWebhookDelivery> = {},
): ClaimedWebhookDelivery {
  return {
    id: "whd_1",
    organizationId: "org_1",
    endpointId: "whk_1",
    eventId: "evt_1",
    type: "run.finished",
    payload: { id: "evt_1", type: "run.finished" },
    attemptCount: 0,
    nextAttemptAt: NOW,
    lastStatusCode: null,
    lastError: null,
    deliveredAt: null,
    createdAt: NOW,
    url: "https://hooks.example.test/lunox",
    secret: "whsec_test",
    ...overrides,
  };
}

function sender(
  answer: (request: WebhookRequest) => Promise<{ status: number }>,
  options: { disable?: boolean; queue?: ClaimedWebhookDelivery[][] } = {},
) {
  const attempts: Array<{
    id: string;
    attempt: WebhookAttempt;
    reason: string;
  }> = [];
  const requests: WebhookRequest[] = [];
  const errors: string[] = [];
  const queue = options.queue ?? [];
  const instance = new WebhookSender({
    store: {
      claimDue: () => Promise.resolve(queue.shift() ?? []),
      recordAttempt: (delivery, attempt, _limit, reason) => {
        attempts.push({ id: delivery.id, attempt, reason });
        return Promise.resolve({ disabled: options.disable ?? false });
      },
    },
    transport: (request) => {
      requests.push(request);
      return answer(request);
    },
    policy: { allowLocalHttp: false },
    now: () => NOW,
    batch: 2,
    onError: (code) => errors.push(code),
  });
  return { instance, attempts, requests, errors };
}

test("eight attempts over about a day, then it gives up", () => {
  assert.equal(WEBHOOK_MAX_ATTEMPTS, 8);
  const total = WEBHOOK_RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0);
  assert.ok(total > 20 * 3_600_000 && total < 26 * 3_600_000, String(total));
  assert.equal(
    nextAttemptAt(1, NOW)?.toISOString(),
    "2026-11-12T00:01:00.000Z",
  );
  assert.equal(
    nextAttemptAt(7, NOW)?.toISOString(),
    "2026-11-12T12:00:00.000Z",
  );
  assert.equal(nextAttemptAt(8, NOW), null);
});

test("a delivery is signed, identified, and a 2xx is delivered", async () => {
  const { instance, attempts, requests } = sender(() =>
    Promise.resolve({ status: 204 }),
  );
  await instance.deliver(claimed());
  const [request] = requests;
  assert.ok(request);
  assert.equal(request.timeoutMs, 10_000);
  assert.equal(request.allowLoopback, false);
  assert.equal(request.headers["Lunox-Event-Id"], "evt_1");
  assert.equal(request.headers["Lunox-Event-Type"], "run.finished");
  assert.equal(
    verifySignature(
      "whsec_test",
      request.headers["Lunox-Signature"] ?? "",
      request.body,
      Math.floor(NOW.getTime() / 1000),
    ),
    true,
  );
  assert.deepEqual(JSON.parse(request.body), {
    id: "evt_1",
    type: "run.finished",
  });
  assert.deepEqual(attempts[0]?.attempt, {
    at: NOW,
    ok: true,
    statusCode: 204,
    error: null,
    nextAttemptAt: null,
  });
});

test("a failure is tried again later; the last one gives up", async () => {
  const { instance, attempts } = sender(() => Promise.resolve({ status: 500 }));
  await instance.deliver(claimed({ attemptCount: 2 }));
  assert.equal(attempts[0]?.attempt.ok, false);
  assert.equal(attempts[0]?.attempt.error, "HTTP 500");
  assert.equal(
    attempts[0]?.attempt.nextAttemptAt?.toISOString(),
    "2026-11-12T00:30:00.000Z",
  );
  await instance.deliver(claimed({ attemptCount: 7 }));
  assert.equal(attempts[1]?.attempt.nextAttemptAt, null);
  assert.match(attempts[1]?.reason ?? "", /^20 failed attempts in a row/);
});

test("a redirect, a thrown error and a refused URL are failures", async () => {
  const redirect = sender(() => Promise.resolve({ status: 301 }));
  await redirect.instance.deliver(claimed());
  assert.match(
    redirect.attempts[0]?.attempt.error ?? "",
    /redirects are not followed/,
  );
  const thrown = sender(() => Promise.reject(new Error("ECONNREFUSED")));
  await thrown.instance.deliver(claimed());
  assert.equal(thrown.attempts[0]?.attempt.error, "ECONNREFUSED");
  assert.equal(thrown.attempts[0]?.attempt.statusCode, null);
  const odd = sender(() => Promise.reject("nope" as unknown as Error));
  await odd.instance.deliver(claimed());
  assert.equal(odd.attempts[0]?.attempt.error, "The request failed.");
  const refused = sender(() => Promise.resolve({ status: 200 }));
  await refused.instance.deliver(
    claimed({ url: "https://169.254.169.254/latest" }),
  );
  assert.equal(refused.requests.length, 0);
  assert.match(refused.attempts[0]?.attempt.error ?? "", /private or reserved/);
});

test("an attempt that disables its endpoint is reported", async () => {
  const { instance, errors } = sender(() => Promise.resolve({ status: 500 }), {
    disable: true,
  });
  await instance.deliver(claimed());
  assert.deepEqual(errors, ["webhook_endpoint_disabled"]);
  assert.equal(WEBHOOK_DISABLE_AFTER, 20);
});

test("drain sends batch after batch until one comes back short", async () => {
  const { instance, attempts } = sender(
    () => Promise.resolve({ status: 200 }),
    {
      queue: [
        [claimed({ id: "whd_1" }), claimed({ id: "whd_2" })],
        [claimed({ id: "whd_3" })],
      ],
    },
  );
  assert.equal(await instance.drain(), 3);
  assert.deepEqual(attempts.map(({ id }) => id).sort(), [
    "whd_1",
    "whd_2",
    "whd_3",
  ]);
});

test("start polls and kicks, a kick mid-pass runs again, stop waits", async () => {
  let ticks: (() => void) | undefined;
  let cleared = false;
  let claims = 0;
  const errors: string[] = [];
  const instance = new WebhookSender({
    store: {
      claimDue: () => {
        claims += 1;
        return claims === 3
          ? Promise.reject(new Error("offline"))
          : Promise.resolve([]);
      },
      recordAttempt: () => Promise.resolve({ disabled: false }),
    },
    transport: () => Promise.resolve({ status: 200 }),
    policy: { allowLocalHttp: false },
    setInterval: ((next: () => void) => {
      ticks = next;
      return 1;
    }) as unknown as typeof setInterval,
    clearInterval: (() => {
      cleared = true;
    }) as unknown as typeof clearInterval,
    onError: (code) => errors.push(code),
  });
  instance.start();
  instance.start();
  instance.kick();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(claims, 2);
  ticks?.();
  await new Promise((resolve) => setImmediate(resolve));
  await instance.stop();
  await instance.stop();
  assert.equal(cleared, true);
  assert.deepEqual(errors, ["webhook_sender_failed"]);
});

function analysisRun(overrides: Partial<StoredAnalysisRun>): StoredAnalysisRun {
  return {
    id: "arn_1",
    snapshotId: null,
    repoId: null,
    tool: "graphify",
    toolVersion: "1",
    params: {} as StoredAnalysisRun["params"],
    status: "succeeded",
    attempt: 1,
    maxAttempts: 3,
    errorCode: null,
    errorDetail: null,
    progress: null,
    previewFiles: null,
    startedAt: null,
    finishedAt: null,
    deadlineAt: null,
    createdAt: NOW.toISOString(),
    ...overrides,
  };
}

function emitter(
  options: {
    analysis?: StoredAnalysisRun | null;
    bounty?: Partial<StoredBountyRun> | null;
    failing?: boolean;
  } = {},
) {
  const events: Array<{ organizationId: string; event: WebhookEvent }> = [];
  const errors: string[] = [];
  let kicks = 0;
  const instance = new WebhookEmitter({
    store: {
      enqueue: (organizationId, event) => {
        if (options.failing === true) return Promise.reject(new Error("db"));
        events.push({ organizationId, event });
        return Promise.resolve([{} as StoredWebhookDelivery]);
      },
    },
    analysisRuns: {
      get: () => Promise.resolve(options.analysis ?? null),
    } as Pick<AnalysisRunStore, "get">,
    bountyRuns: {
      get: () =>
        Promise.resolve(
          options.bounty === null || options.bounty === undefined
            ? null
            : (options.bounty as StoredBountyRun),
        ),
    } as Pick<BountyRunStore, "get">,
    sandboxes: {
      getVersion: () =>
        Promise.resolve({
          version: { sandboxId: "sbx_1" },
        } as Awaited<ReturnType<SandboxStore["getVersion"]>>),
    },
    onEnqueued: () => {
      kicks += 1;
    },
    now: () => NOW,
    onError: (code) => errors.push(code),
  });
  return { instance, events, errors, kicks: () => kicks };
}

test("an event's id is stable for what it is about", () => {
  assert.equal(
    eventId("org_1", "run.finished", "analysis:arn_1"),
    eventId("org_1", "run.finished", "analysis:arn_1"),
  );
  assert.notEqual(
    eventId("org_1", "run.finished", "analysis:arn_1"),
    eventId("org_2", "run.finished", "analysis:arn_1"),
  );
  assert.match(eventId("org_1", "ping", "x"), /^evt_[0-9a-f]{32}$/);
});

test("an analysis run that ended is run.finished, ids and states only", async () => {
  const { instance, events, kicks } = emitter({
    analysis: analysisRun({ status: "failed", errorCode: "tool_failed" }),
  });
  await instance.onRunChange({
    organizationId: "org_1",
    kind: "analysis",
    id: "arn_1",
  });
  assert.equal(events.length, 1);
  const [{ event } = { event: undefined }] = events;
  assert.equal(event?.type, "run.finished");
  assert.equal(event?.id, eventId("org_1", "run.finished", "analysis:arn_1"));
  assert.deepEqual(event?.payload, {
    id: event?.id,
    type: "run.finished",
    createdAt: NOW.toISOString(),
    organizationId: "org_1",
    data: {
      run: {
        id: "arn_1",
        family: "analysis",
        kind: "graphify",
        status: "failed",
        errorCode: "tool_failed",
      },
    },
  });
  assert.equal(kicks(), 1);
});

test("a sandbox build that ended is sandbox.build.finished too", async () => {
  const { instance, events } = emitter({
    analysis: analysisRun({
      tool: "sandbox_build",
      params: {
        sandboxVersionId: "sbv_1",
      } as unknown as StoredAnalysisRun["params"],
    }),
  });
  await instance.onRunChange({
    organizationId: "org_1",
    kind: "analysis",
    id: "arn_1",
  });
  assert.deepEqual(
    events.map(({ event }) => event.type),
    ["run.finished", "sandbox.build.finished"],
  );
  assert.deepEqual(events[1]?.event.payload["data"], {
    runId: "arn_1",
    sandboxId: "sbx_1",
    sandboxVersionId: "sbv_1",
    status: "succeeded",
  });
});

test("a run still going, a profile change or a missing run says nothing", async () => {
  const running = emitter({ analysis: analysisRun({ status: "running" }) });
  await running.instance.onRunChange({
    organizationId: "org_1",
    kind: "analysis",
    id: "arn_1",
  });
  await running.instance.onRunChange({
    organizationId: "org_1",
    kind: "profile",
    id: "bpr_1",
  });
  await running.instance.onRunChange({
    organizationId: "org_1",
    kind: "bounty",
    id: "brn_1",
  });
  assert.equal(running.events.length, 0);
});

test("a sizing run that ended is run.finished, each proposal it made priced", async () => {
  const { instance, events } = emitter({
    bounty: {
      id: "brn_1",
      kind: "bounty",
      status: "succeeded",
      bountyId: "bty_1",
      fatalErrorCode: null,
      outcomes: [
        {
          externalIssueId: "1",
          issueKey: null,
          bountyId: "bty_1",
          proposalId: "bpr_1",
          status: "proposed",
        },
        { externalIssueId: "2", issueKey: null, status: "failed" },
        { externalIssueId: "3", issueKey: null, status: "proposed" },
        {
          externalIssueId: "4",
          issueKey: null,
          proposalId: "bpr_2",
          status: "proposed",
        },
      ],
    },
  });
  await instance.onRunChange({
    organizationId: "org_1",
    kind: "bounty",
    id: "brn_1",
  });
  assert.deepEqual(
    events.map(({ event }) => event.type),
    ["run.finished", "proposal.priced", "proposal.priced"],
  );
  assert.deepEqual(events[1]?.event.payload["data"], {
    proposalId: "bpr_1",
    bountyId: "bty_1",
    runId: "brn_1",
    status: "proposed",
  });
  assert.equal(
    (events[2]?.event.payload["data"] as { bountyId: unknown }).bountyId,
    null,
  );
  const queued = emitter({ bounty: { id: "brn_2", status: "running" } });
  await queued.instance.onRunChange({
    organizationId: "org_1",
    kind: "bounty",
    id: "brn_2",
  });
  assert.equal(queued.events.length, 0);
});

test("a failed enqueue is reported, never thrown", async () => {
  const { instance, errors } = emitter({
    failing: true,
    analysis: analysisRun({}),
  });
  assert.equal(
    await instance.emit("org_1", "sandbox.published", "sbv_1", {}),
    0,
  );
  await instance.onRunChange({
    organizationId: "org_1",
    kind: "analysis",
    id: "arn_1",
  });
  assert.deepEqual(errors, ["webhook_emit_failed", "webhook_emit_failed"]);
  const broken = new WebhookEmitter({
    store: { enqueue: () => Promise.resolve([]) },
    analysisRuns: { get: () => Promise.reject(new Error("db")) },
    onError: (code) => errors.push(code),
  });
  await broken.onRunChange({
    organizationId: "org_1",
    kind: "analysis",
    id: "arn_1",
  });
  assert.equal(errors.at(-1), "webhook_run_change_failed");
  // Nothing owed: no kick.
  const quiet = new WebhookEmitter({
    store: { enqueue: () => Promise.resolve([]) },
  });
  assert.equal(await quiet.emit("org_1", "run.finished", "k", {}), 0);
});
