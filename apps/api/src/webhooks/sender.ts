/**
 * The webhook sender: a background loop in the API process, beside the
 * watchdogs, that sends what is due.
 *
 * Each pass claims up to `batch` due deliveries across workspaces (leased,
 * so another API process skips them), sends them at once, and writes each
 * outcome. It runs every `intervalMs` and at once when something is
 * enqueued (`kick`).
 *
 * - **Retries:** a failed attempt is tried again after the next of
 *   `WEBHOOK_RETRY_DELAYS_MS` (1 min to 12 h; eight attempts over about
 *   23 h), then given up. Only a 2xx is a success; a 3xx is a failure,
 *   since redirects are not followed.
 * - **Disable:** `WEBHOOK_DISABLE_AFTER` failed attempts in a row on one
 *   endpoint, across its deliveries, disable it with the reason; its
 *   pending deliveries wait until a person enables it again.
 * - **Every attempt re-checks the URL** (`ssrf.ts`), and the socket
 *   resolves through the guard.
 */

import type { ClaimedWebhookDelivery, WebhookStore } from "@sandbox-factory/db";

import {
  EVENT_ID_HEADER,
  EVENT_TYPE_HEADER,
  SIGNATURE_HEADER,
  signatureHeader,
} from "./signature.js";
import { checkWebhookUrl, type UrlPolicy } from "./ssrf.js";
import type { WebhookTransport } from "./transport.js";

export const WEBHOOK_TIMEOUT_MS = 10_000;
/** Delays after the first seven failed attempts; the eighth gives up. */
export const WEBHOOK_RETRY_DELAYS_MS: readonly number[] = [
  60_000,
  5 * 60_000,
  30 * 60_000,
  60 * 60_000,
  3 * 60 * 60_000,
  6 * 60 * 60_000,
  12 * 60 * 60_000,
];
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_RETRY_DELAYS_MS.length + 1;
export const WEBHOOK_DISABLE_AFTER = 20;
/** How long a claimed delivery is held before another process may take it. */
const LEASE_MS = 60_000;
const POLL_MS = 5_000;
const BATCH = 10;
/** An error written on a delivery is cut to this. */
const ERROR_CHARS = 300;

/** When attempt `attempt` (1-based) failing at `at` is tried again, or null. */
export function nextAttemptAt(attempt: number, at: Date): Date | null {
  const delay = WEBHOOK_RETRY_DELAYS_MS[attempt - 1];
  return delay === undefined ? null : new Date(at.getTime() + delay);
}

export interface WebhookSenderOptions {
  readonly store: Pick<WebhookStore, "claimDue" | "recordAttempt">;
  readonly transport: WebhookTransport;
  readonly policy: UrlPolicy;
  readonly now?: () => Date;
  readonly intervalMs?: number;
  readonly batch?: number;
  readonly setInterval?: typeof globalThis.setInterval;
  readonly clearInterval?: typeof globalThis.clearInterval;
  readonly onError?: (code: string) => void;
}

export class WebhookSender {
  readonly #options: WebhookSenderOptions;
  #timer: ReturnType<typeof setInterval> | undefined;
  #running: Promise<void> | undefined;
  #again = false;

  constructor(options: WebhookSenderOptions) {
    this.#options = options;
  }

  start(): void {
    if (this.#timer !== undefined) return;
    this.kick();
    this.#timer = (this.#options.setInterval ?? setInterval)(
      () => this.kick(),
      this.#options.intervalMs ?? POLL_MS,
    );
  }

  /** Stops the loop; resolves once the pass in hand is written. */
  async stop(): Promise<void> {
    if (this.#timer !== undefined) {
      (this.#options.clearInterval ?? clearInterval)(this.#timer);
      this.#timer = undefined;
    }
    await this.#running;
  }

  /** Runs a pass now, or right after the one running. */
  kick(): void {
    if (this.#running !== undefined) {
      this.#again = true;
      return;
    }
    this.#running = this.drain()
      .then(() => undefined)
      .catch(() => this.#options.onError?.("webhook_sender_failed"))
      .finally(() => {
        this.#running = undefined;
        if (this.#again) {
          this.#again = false;
          this.kick();
        }
      });
  }

  /** Sends what is due, batch after batch, until a batch comes back short. */
  async drain(): Promise<number> {
    const batch = this.#options.batch ?? BATCH;
    let sent = 0;
    for (;;) {
      const at = this.#now();
      const claimed = await this.#options.store.claimDue(
        at,
        new Date(at.getTime() + LEASE_MS),
        batch,
      );
      await Promise.all(claimed.map((delivery) => this.deliver(delivery)));
      sent += claimed.length;
      if (claimed.length < batch) return sent;
    }
  }

  /** One attempt at one delivery, and its outcome written. */
  async deliver(delivery: ClaimedWebhookDelivery): Promise<void> {
    const body = JSON.stringify(delivery.payload);
    const sentAt = this.#now();
    let statusCode: number | null = null;
    let error: string | null = null;
    const verdict = checkWebhookUrl(delivery.url, this.#options.policy);
    if (!verdict.ok) error = verdict.reason;
    else {
      try {
        const timestamp = Math.floor(sentAt.getTime() / 1000);
        const { status } = await this.#options.transport({
          url: verdict.url,
          allowLoopback: verdict.allowLoopback,
          timeoutMs: WEBHOOK_TIMEOUT_MS,
          body,
          headers: {
            "content-type": "application/json",
            "user-agent": "Lunox-Webhooks/1",
            [SIGNATURE_HEADER]: signatureHeader(
              delivery.secret,
              timestamp,
              body,
            ),
            [EVENT_ID_HEADER]: delivery.eventId,
            [EVENT_TYPE_HEADER]: delivery.type,
          },
        });
        statusCode = status;
        if (status < 200 || status >= 300)
          error =
            status >= 300 && status < 400
              ? `HTTP ${status}; redirects are not followed.`
              : `HTTP ${status}`;
      } catch (thrown) {
        error = (
          thrown instanceof Error ? thrown.message : "The request failed."
        ).slice(0, ERROR_CHARS);
      }
    }
    const at = this.#now();
    const ok = error === null;
    const { disabled } = await this.#options.store.recordAttempt(
      delivery,
      {
        at,
        ok,
        statusCode,
        error,
        nextAttemptAt: ok ? null : nextAttemptAt(delivery.attemptCount + 1, at),
      },
      WEBHOOK_DISABLE_AFTER,
      `${WEBHOOK_DISABLE_AFTER} failed attempts in a row; the last: ${error ?? ""}`,
    );
    if (disabled) this.#options.onError?.("webhook_endpoint_disabled");
  }

  #now(): Date {
    return (this.#options.now ?? (() => new Date()))();
  }
}
