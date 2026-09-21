import assert from "node:assert/strict";
import { test } from "node:test";

import { ApiClient, ApiError } from "../src/index.js";

/**
 * A probe over the transport.
 *
 * `request` is protected, so the tests reach it the way a real feature will:
 * by subclassing. That keeps these tests pinned to the seam the extension and
 * the web app actually build on, rather than to a method that happens to
 * exist today.
 */
class ProbeClient extends ApiClient {
  get(path: string): Promise<unknown> {
    return this.request(path);
  }

  post(path: string, body: unknown): Promise<unknown> {
    return this.request(path, { method: "POST", body: JSON.stringify(body) });
  }

  del(path: string): Promise<unknown> {
    return this.request(path, { method: "DELETE" });
  }
}

/** A fetch stub that records what it was called with. */
function stubFetch(response: {
  status?: number;
  body?: unknown;
  text?: string;
}) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const status = response.status ?? 200;
    const body =
      response.text ??
      (response.body === undefined ? "" : JSON.stringify(response.body));
    // 204 and 205 must carry a null body, or the Response constructor throws.
    return new Response(status === 204 || status === 205 ? null : body, {
      status,
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

test("a parsed body is returned to the caller", async () => {
  const { fetch, calls } = stubFetch({ body: { ok: true } });
  const client = new ProbeClient({ baseUrl: "https://api.test", fetch });

  assert.deepEqual(await client.get("/api/v1/me"), { ok: true });
  assert.equal(calls[0]?.url, "https://api.test/api/v1/me");
});

test("a trailing slash on baseUrl does not produce a doubled slash", async () => {
  const { fetch, calls } = stubFetch({ body: {} });
  const client = new ProbeClient({ baseUrl: "https://api.test///", fetch });

  await client.get("/api/v1/me");
  assert.equal(calls[0]?.url, "https://api.test/api/v1/me");
});

test("a baseUrl of only slashes trims to empty", async () => {
  // Pins an edge case of the hand-rolled trim (see `trimTrailingSlashes`).
  const { fetch, calls } = stubFetch({ body: {} });
  const client = new ProbeClient({ baseUrl: "///", fetch });

  await client.get("/api/v1/me");
  assert.equal(calls[0]?.url, "/api/v1/me");
});

test("a long run of slashes mid-url is left alone and returns promptly", async () => {
  // The quadratic case for the old regex: a long run of slashes not at the
  // end, ~2.3s for 80k. The time bound is the assertion that matters.
  const { fetch, calls } = stubFetch({ body: {} });
  const inner = "/".repeat(80_000);

  // Start the timer before construction: the trim runs in the constructor.
  const started = Date.now();
  const client = new ProbeClient({
    baseUrl: `https://api.test${inner}x`,
    fetch,
  });

  await client.get("/api/v1/me");

  assert.ok(
    Date.now() - started < 1000,
    "trimming should not be quadratic in the length of a slash run",
  );
  assert.equal(calls[0]?.url, `https://api.test${inner}x/api/v1/me`);
});

test("the bearer token is attached when getToken returns one", async () => {
  const { fetch, calls } = stubFetch({ body: {} });
  const client = new ProbeClient({
    baseUrl: "https://api.test",
    fetch,
    getToken: () => Promise.resolve("tok_123"),
  });

  await client.get("/api/v1/me");
  assert.equal(
    new Headers(calls[0]?.init?.headers).get("Authorization"),
    "Bearer tok_123",
  );
});

test("no Authorization header is sent when signed out", async () => {
  const { fetch, calls } = stubFetch({ body: {} });
  const client = new ProbeClient({ baseUrl: "https://api.test", fetch });

  await client.get("/api/v1/me");
  assert.equal(new Headers(calls[0]?.init?.headers).get("Authorization"), null);
});

test("a body is sent as JSON with the matching content type", async () => {
  const { fetch, calls } = stubFetch({ body: {} });
  const client = new ProbeClient({ baseUrl: "https://api.test", fetch });

  await client.post("/api/v1/orgs", { name: "Acme" });

  assert.equal(calls[0]?.init?.method, "POST");
  assert.equal(calls[0]?.init?.body, JSON.stringify({ name: "Acme" }));
  assert.equal(
    new Headers(calls[0]?.init?.headers).get("Content-Type"),
    "application/json",
  );
});

test("no content type is set on a request without a body", async () => {
  // A GET with `Content-Type` makes some proxies expect one.
  const { fetch, calls } = stubFetch({ body: {} });
  const client = new ProbeClient({ baseUrl: "https://api.test", fetch });

  await client.get("/api/v1/me");
  assert.equal(new Headers(calls[0]?.init?.headers).get("Content-Type"), null);
});

test("an empty body resolves rather than failing to parse", async () => {
  // What a 204 looks like to a caller: no payload, no error.
  const { fetch } = stubFetch({ status: 204 });
  const client = new ProbeClient({ baseUrl: "https://api.test", fetch });

  assert.equal(await client.del("/api/v1/orgs/org_1"), undefined);
});

test("a 404 is flagged as not found", async () => {
  const { fetch } = stubFetch({
    status: 404,
    body: { error: "Not found." },
  });
  const client = new ProbeClient({ baseUrl: "https://api.test", fetch });

  await assert.rejects(client.del("/api/v1/orgs/nope"), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.ok(error.isNotFound);
    assert.equal(error.isUnauthorized, false);
    assert.match(error.message, /Not found/);
    return true;
  });
});

test("a 401 is flagged as unauthorized", async () => {
  const { fetch } = stubFetch({
    status: 401,
    body: { error: "Sign in first." },
  });
  const client = new ProbeClient({ baseUrl: "https://api.test", fetch });

  await assert.rejects(client.get("/api/v1/me"), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.ok(error.isUnauthorized);
    return true;
  });
});

test("a non-JSON body produces a readable error, not a parse crash", async () => {
  const { fetch } = stubFetch({ status: 502, text: "<html>gateway</html>" });
  const client = new ProbeClient({ baseUrl: "https://api.test", fetch });

  await assert.rejects(client.get("/api/v1/me"), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.match(error.message, /Expected JSON/);
    return true;
  });
});

test("an error body of the wrong shape still reports the status", async () => {
  // The error envelope is parsed, not assumed: a proxy's own JSON must not
  // become an unreadable message.
  const { fetch } = stubFetch({ status: 500, body: { unexpected: true } });
  const client = new ProbeClient({ baseUrl: "https://api.test", fetch });

  await assert.rejects(client.get("/api/v1/me"), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 500);
    assert.match(error.message, /HTTP 500/);
    return true;
  });
});

test("requests send cookies by default", async () => {
  const { fetch, calls } = stubFetch({ body: {} });
  const client = new ProbeClient({ baseUrl: "https://api.test", fetch });

  await client.get("/api/v1/me");

  // Not fetch's default "same-origin", which drops the session cookie
  // cross-origin in production.
  assert.equal(calls[0]?.init?.credentials, "include");
});

test("credentials can be overridden", async () => {
  const { fetch, calls } = stubFetch({ body: {} });
  const client = new ProbeClient({
    baseUrl: "https://api.test",
    fetch,
    credentials: "omit",
  });

  await client.get("/api/v1/me");

  assert.equal(calls[0]?.init?.credentials, "omit");
});
