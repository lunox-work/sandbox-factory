/**
 * One POST to a webhook endpoint, over `node:http(s)` rather than `fetch`
 * so the socket resolves through the SSRF guard (`ssrf.ts`): the address
 * checked is the address connected to. Redirects are not followed (Node's
 * client never does); the answer is the status alone, and the body is
 * discarded unread. Bounded by `timeoutMs` from the first byte sent.
 */

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

import {
  guardedLookup,
  isForbiddenAddress,
  WebhookAddressRefused,
} from "./ssrf.js";

export interface WebhookRequest {
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly timeoutMs: number;
  /** Loopback is allowed: a development endpoint on localhost. */
  readonly allowLoopback: boolean;
}

export type WebhookTransport = (
  request: WebhookRequest,
) => Promise<{ readonly status: number }>;

export function nodeTransport(
  lookup: typeof guardedLookup = guardedLookup,
): WebhookTransport {
  return (request) =>
    new Promise((resolve, reject) => {
      const literal = request.url.hostname.replace(/^\[|\]$/g, "");
      if (
        isIP(literal) !== 0 &&
        isForbiddenAddress(literal, request.allowLoopback)
      ) {
        reject(
          new WebhookAddressRefused(
            "A webhook may not be sent to a private or reserved address.",
          ),
        );
        return;
      }
      const send =
        request.url.protocol === "https:" ? httpsRequest : httpRequest;
      const outgoing = send(
        request.url,
        {
          method: "POST",
          headers: {
            ...request.headers,
            "content-length": String(Buffer.byteLength(request.body)),
          },
          lookup: lookup(request.allowLoopback) as never,
          signal: AbortSignal.timeout(request.timeoutMs),
        },
        (response) => {
          resolve({ status: response.statusCode ?? 0 });
          // The body says nothing the status does not; drop it.
          response.destroy();
        },
      );
      outgoing.on("error", (error) => {
        reject(
          error.name === "AbortError" || error.name === "TimeoutError"
            ? new Error(`No answer within ${request.timeoutMs / 1000} s.`)
            : error,
        );
      });
      outgoing.end(request.body);
    });
}
