import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import {
  generateWebhookSecret,
  signatureHeader,
  verifySignature,
} from "../src/webhooks/signature.js";
import {
  checkWebhookUrl,
  guardedLookup,
  isForbiddenAddress,
  isLocalOrigin,
  WebhookAddressRefused,
} from "../src/webhooks/ssrf.js";
import { nodeTransport } from "../src/webhooks/transport.js";

/**
 * How a delivery is signed, where one may be sent, and the transport that
 * connects only where the guard allows.
 */

const production = { allowLocalHttp: false };
const development = { allowLocalHttp: true };

test("a signature is HMAC-SHA256 over t.body, checked with a tolerance", () => {
  const secret = generateWebhookSecret();
  assert.match(secret, /^whsec_[0-9A-Za-z]{40}$/);
  const body = JSON.stringify({ id: "evt_1" });
  const header = signatureHeader(secret, 1_800_000_000, body);
  assert.match(header, /^t=1800000000,v1=[0-9a-f]{64}$/);
  // The value a receiver computes with any HMAC library.
  assert.equal(
    signatureHeader("whsec_k", 1, "{}"),
    "t=1,v1=3e55f0b5839e8ec0fb44b2f4f4153484f384cbc5344451738bfc77fe78d0d531",
  );
  assert.equal(verifySignature(secret, header, body, 1_800_000_100), true);
  assert.equal(
    verifySignature(secret, header, `${body} `, 1_800_000_100),
    false,
  );
  assert.equal(
    verifySignature("whsec_other", header, body, 1_800_000_100),
    false,
  );
  // Too old, or malformed.
  assert.equal(verifySignature(secret, header, body, 1_800_001_000), false);
  assert.equal(verifySignature(secret, "v1=abc", body, 1_800_000_000), false);
  assert.equal(
    verifySignature(secret, "t=1800000000,v1=zz", body, 1_800_000_000),
    false,
  );
});

test("only https, or http to localhost in development, and no credentials", () => {
  assert.equal(
    checkWebhookUrl("https://hooks.example.test/x", production).ok,
    true,
  );
  for (const url of [
    "http://hooks.example.test/x",
    "http://localhost:4000/x",
    "ftp://hooks.example.test/x",
    "https://user:pass@hooks.example.test/x",
    "not a url",
    "https://127.0.0.1/x",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/x",
    "https://[::ffff:10.0.0.1]/x",
    "https://0x7f.1/x",
  ]) {
    const verdict = checkWebhookUrl(url, production);
    assert.equal(verdict.ok, false, url);
  }
  const local = checkWebhookUrl("http://localhost:4000/x", development);
  assert.equal(local.ok && local.allowLoopback, true);
  assert.equal(
    checkWebhookUrl("http://127.0.0.1:4000/x", development).ok,
    true,
  );
  assert.equal(checkWebhookUrl("http://app.localhost/x", development).ok, true);
  const remote = checkWebhookUrl("http://hooks.example.test/x", development);
  assert.equal(remote.ok, false);
  assert.match(remote.ok ? "" : remote.reason, /http to localhost/);
  // Still no private network in development.
  assert.equal(checkWebhookUrl("http://10.0.0.1/x", development).ok, false);
  assert.equal(checkWebhookUrl("ftp://localhost/x", development).ok, false);
  assert.equal(isLocalOrigin("http://localhost:4000"), true);
  assert.equal(isLocalOrigin("https://api.lunox.work"), false);
  assert.equal(isLocalOrigin("::"), false);
});

test("private, loopback, link-local, CGNAT and metadata addresses are refused", () => {
  for (const address of [
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "127.0.0.1",
    "169.254.169.254",
    "100.64.0.1",
    "100.127.255.254",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "192.0.2.1",
    "::",
    "::1",
    "fe80::1",
    "fc00::1",
    "fd00:ec2::254",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "64:ff9b::a9fe:a9fe",
    "2002:7f00:1::",
    "2001:db8::1",
    "not-an-ip",
  ])
    assert.equal(isForbiddenAddress(address), true, address);
  for (const address of [
    "93.184.216.34",
    "172.32.0.1",
    "100.128.0.1",
    "2606:4700::1111",
    "::ffff:93.184.216.34",
    "64:ff9b::5db8:d822",
  ])
    assert.equal(isForbiddenAddress(address), false, address);
  assert.equal(isForbiddenAddress("127.0.0.1", true), false);
  assert.equal(isForbiddenAddress("::1", true), false);
  assert.equal(isForbiddenAddress("10.0.0.1", true), true);
});

test("the socket's lookup refuses a host with any private address", async () => {
  const resolver =
    (addresses: Array<{ address: string; family: number }>, error?: Error) =>
    (
      _host: string,
      _options: { all: true },
      callback: (
        error: NodeJS.ErrnoException | null,
        addresses: Array<{ address: string; family: number }>,
      ) => void,
    ) =>
      callback(error ?? null, addresses);
  const run = (
    lookup: ReturnType<typeof guardedLookup>,
    options: { all?: boolean } | undefined,
  ) =>
    new Promise<{ error: Error | null; address: unknown; family?: number }>(
      (resolve) =>
        lookup("hooks.example.test", options, (error, address, family) =>
          resolve({ error, address, family }),
        ),
    );
  const publicOnly = guardedLookup(
    false,
    resolver([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:4700::1111", family: 6 },
    ]),
  );
  assert.deepEqual(await run(publicOnly, undefined), {
    error: null,
    address: "93.184.216.34",
    family: 4,
  });
  assert.equal(
    ((await run(publicOnly, { all: true })).address as unknown[]).length,
    2,
  );
  const rebinding = guardedLookup(
    false,
    resolver([
      { address: "93.184.216.34", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ]),
  );
  const refused = await run(rebinding, { all: true });
  assert.ok(refused.error instanceof WebhookAddressRefused);
  const empty = await run(guardedLookup(false, resolver([])), undefined);
  assert.match(empty.error?.message ?? "", /no address/);
  const failing = await run(
    guardedLookup(false, resolver([], new Error("ENOTFOUND"))),
    undefined,
  );
  assert.equal(failing.error?.message, "ENOTFOUND");
});

test("the transport posts once, follows no redirect, and refuses a private literal", async () => {
  const seen: Array<{ headers: Record<string, unknown>; body: string }> = [];
  let status = 200;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      seen.push({ headers: request.headers, body });
      response.writeHead(status, { location: "https://elsewhere.test/" });
      response.end("ignored");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const transport = nodeTransport();
  try {
    const sent = await transport({
      url: new URL(`http://127.0.0.1:${port}/hook`),
      headers: {
        "content-type": "application/json",
        "Lunox-Event-Id": "evt_1",
      },
      body: '{"id":"evt_1"}',
      timeoutMs: 2_000,
      allowLoopback: true,
    });
    assert.equal(sent.status, 200);
    assert.equal(seen[0]?.body, '{"id":"evt_1"}');
    assert.equal(seen[0]?.headers["lunox-event-id"], "evt_1");
    status = 302;
    const redirected = await transport({
      url: new URL(`http://localhost:${port}/hook`),
      headers: {},
      body: "{}",
      timeoutMs: 2_000,
      allowLoopback: true,
    });
    assert.equal(redirected.status, 302);
    assert.equal(seen.length, 2);
    await assert.rejects(
      transport({
        url: new URL(`http://127.0.0.1:${port}/hook`),
        headers: {},
        body: "{}",
        timeoutMs: 2_000,
        allowLoopback: false,
      }),
      WebhookAddressRefused,
    );
    // localhost resolves to loopback, which production refuses at connect.
    await assert.rejects(
      transport({
        url: new URL(`http://localhost:${port}/hook`),
        headers: {},
        body: "{}",
        timeoutMs: 2_000,
        allowLoopback: false,
      }),
      WebhookAddressRefused,
    );
    assert.equal(seen.length, 2);
  } finally {
    server.close();
  }
});

test("the transport gives up after its timeout", async () => {
  const server = createServer(() => {
    // Never answers.
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await assert.rejects(
      nodeTransport()({
        url: new URL(`http://127.0.0.1:${port}/hook`),
        headers: {},
        body: "{}",
        timeoutMs: 50,
        allowLoopback: true,
      }),
      /No answer within/,
    );
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
