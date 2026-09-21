import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ApiTokenCredential,
  JiraApiError,
  JiraWriteClient,
  JiraWriteResponseError,
} from "../src/index.js";

const credential = new ApiTokenCredential({
  siteUrl: "https://acme.atlassian.net",
  email: "user@example.test",
  apiToken: "token",
});

function client(responses: Response[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  let index = 0;
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return responses[index++] ?? new Response(null, { status: 500 });
  }) as typeof globalThis.fetch;
  return { calls, client: new JiraWriteClient({ credential, fetch }) };
}

test("addComment posts one ADF body and requires a comment id", async () => {
  const state = client([Response.json({ id: "10001" })]);
  const body = { version: 1, type: "doc", content: [] };
  assert.equal(await state.client.addComment("issue/1", body), "10001");
  assert.equal(state.calls.length, 1);
  assert.match(state.calls[0]!.url, /issue%2F1\/comment$/);
  assert.equal(state.calls[0]!.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(state.calls[0]!.init?.body)), { body });

  await assert.rejects(
    () => client([Response.json({})]).client.addComment("1", body),
    (error) =>
      error instanceof JiraWriteResponseError &&
      error.code === "comment_id_missing",
  );
});

test("addLabel uses Jira's additive update and preserves existing labels", async () => {
  const state = client([new Response(null, { status: 204 })]);
  await state.client.addLabel("1", "bounty");
  assert.equal(state.calls[0]!.init?.method, "PUT");
  assert.deepEqual(JSON.parse(String(state.calls[0]!.init?.body)), {
    update: { labels: [{ add: "bounty" }] },
  });
});

test("writes never retry a rejected or ambiguous response", async () => {
  const rejected = client([
    Response.json({ errorMessages: ["no"] }, { status: 500 }),
  ]);
  await assert.rejects(
    () => rejected.client.addComment("1", {}),
    (error) => error instanceof JiraApiError && error.status === 500,
  );
  assert.equal(rejected.calls.length, 1);

  const malformed = client([new Response("not json", { status: 200 })]);
  await assert.rejects(
    () => malformed.client.addComment("1", {}),
    (error) =>
      error instanceof JiraWriteResponseError &&
      error.code === "invalid_success",
  );
  assert.equal(malformed.calls.length, 1);
});
