import { generateKeyPairSync, type KeyObject } from "node:crypto";

/** One RSA key for the whole suite: generating one per test is slow. */
export const keys: { privateKey: KeyObject; publicKey: KeyObject } =
  generateKeyPairSync("rsa", { modulusLength: 2048 });

export interface Recorded {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
  /** What bounds the request; every call here must pass one. */
  readonly signal: AbortSignal | null;
}

/**
 * A `fetch` that answers from a list of handlers and records every request.
 * A request no handler claims fails the test loudly rather than hanging.
 */
export function fakeFetch(
  handler: (request: Recorded) => Response | Promise<Response>,
): typeof globalThis.fetch & { calls: Recorded[] } {
  const calls: Recorded[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as unknown)
        : undefined;
    const request: Recorded = {
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body,
      signal: init?.signal ?? null,
    };
    calls.push(request);
    return handler(request);
  }) as typeof globalThis.fetch & { calls: Recorded[] };
  impl.calls = calls;
  return impl;
}

export function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
