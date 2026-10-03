import assert from "node:assert/strict";
import { test } from "node:test";
import { JiraClient } from "../src/client.js";
import { JiraWriteClient } from "../src/write-client.js";
import {
  ApiTokenCredential,
  OAuthCredential,
  memoryTokenSource,
} from "../src/credentials.js";
import { withDeadline, abortableSleep, waitFor } from "../src/transport.js";
const credential = new ApiTokenCredential({
  siteUrl: "https://example.test",
  email: "test@example.test",
  apiToken: "test",
});
const never = () => new Promise<never>(() => {});

test("deadlines bound hanging headers and bodies and dispatch a write once", async () => {
  for (const fetch of [
    never,
    () => Promise.resolve(new Response(new ReadableStream({ start() {} }))),
  ]) {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return fetch();
    }) as typeof globalThis.fetch;
    const write = new JiraWriteClient({
      credential,
      fetch: fetchImpl,
      timeoutMs: 5,
    });
    await assert.rejects(write.addComment("1", {}), { name: "TimeoutError" });
    assert.equal(calls, 1);
    const read = new JiraClient({ credential, fetch: fetchImpl, timeoutMs: 5 });
    await assert.rejects(read.issue("1"), { name: "TimeoutError" });
    assert.equal(calls, 2);
  }
});

test("pre-aborted reads and writes do not dispatch; cancellation interrupts retry backoff", async () => {
  let calls = 0;
  const fetch = (async () => {
    calls++;
    return new Response("", { status: 429, headers: { "Retry-After": "30" } });
  }) as typeof globalThis.fetch;
  const aborted = AbortSignal.abort(new Error("stopped"));
  await assert.rejects(
    new JiraWriteClient({ credential, fetch }).addLabel("1", "x", aborted),
    /stopped/,
  );
  await assert.rejects(
    new JiraClient({ credential, fetch }).issue("1", aborted),
    /stopped/,
  );
  assert.equal(calls, 0);
  const controller = new AbortController();
  const request = new JiraClient({ credential, fetch }).issue(
    "1",
    controller.signal,
  );
  setTimeout(() => controller.abort(new Error("stop backoff")), 5);
  await assert.rejects(request, /stop backoff/);
  assert.equal(calls, 1);
  await assert.rejects(abortableSleep(1, aborted), /stopped/);
  assert.equal(await waitFor(Promise.resolve(3)), 3);
  assert.equal(await withDeadline(async () => 4), 4);
});

test("a refresh has its own deadline, clears for retry, and survives one cancelled waiter", async () => {
  const initial = {
    accessToken: "old",
    refreshToken: "refresh",
    expiresAt: "2020-01-01T00:00:00.000Z",
    scopes: [],
  };
  let calls = 0;
  const source = memoryTokenSource(initial);
  const fetch = (async () => {
    calls++;
    if (calls === 1) return never();
    return Response.json({
      access_token: "new",
      refresh_token: "rotated",
      expires_in: 3600,
    });
  }) as typeof globalThis.fetch;
  const oauth = new OAuthCredential({
    tokens: source,
    clientId: "test",
    clientSecret: "test",
    cloudId: "test",
    fetch,
    timeoutMs: 5,
  });
  await assert.rejects(oauth.authorize(), { name: "TimeoutError" });
  assert.equal(await oauth.authorize(), "Bearer new");
  assert.equal(calls, 2);
  let complete: ((response: Response) => void) | undefined;
  const shared = new OAuthCredential({
    tokens: memoryTokenSource(initial),
    clientId: "test",
    clientSecret: "test",
    cloudId: "test",
    fetch: (() =>
      new Promise<Response>((resolve) => {
        complete = resolve;
      })) as typeof globalThis.fetch,
  });
  const controller = new AbortController();
  const first = shared.authorize(controller.signal);
  const second = shared.authorize();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  controller.abort(new Error("cancel waiter"));
  await assert.rejects(first, /cancel waiter/);
  complete?.(
    Response.json({
      access_token: "shared",
      refresh_token: "rotated",
      expires_in: 3600,
    }),
  );
  assert.equal(await second, "Bearer shared");
  assert.equal(await shared.authorize(), "Bearer shared");
});

test("a hanging credential store is bounded before token dispatch", async () => {
  let calls = 0;
  const oauth = new OAuthCredential({
    tokens: { load: never, save: async () => {} },
    clientId: "test",
    clientSecret: "test",
    cloudId: "test",
    timeoutMs: 5,
    fetch: (async () => {
      calls++;
      return Response.json({});
    }) as typeof fetch,
  });
  await assert.rejects(oauth.authorize(), { name: "TimeoutError" });
  assert.equal(calls, 0);
});
