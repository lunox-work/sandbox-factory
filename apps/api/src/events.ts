/**
 * The push channel a page follows its runs by: one stream per workspace,
 * `GET /api/v1/orgs/:orgId/events`, saying which run or proposal changed
 * as the database announces it (`RUN_CHANGED_CHANNEL`). It says what
 * changed, never what it now is: the page reads that through the route it
 * already reads it by, which keeps every access rule where it was.
 *
 * One stream for the workspace rather than one per run, because a browser
 * opens six connections to an origin over HTTP/1.1, and a page following
 * a sandbox follows several runs at once.
 *
 * The API holds one `LISTEN` connection, whatever the number of pages; the
 * hub hands each change to the streams of its workspace. A change lost to
 * a reconnect is lost, so a page keeps a slow timer as well.
 */

import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";

import type { RunChange } from "@sandbox-factory/db";

import type { AuthVariables } from "./http-context.js";

export type ChangeListener = (change: RunChange) => void;

export interface RunChangeHub {
  publish(change: RunChange): void;
  /** Follows one workspace's changes; returns the function that stops. */
  subscribe(organizationId: string, listener: ChangeListener): () => void;
  /** Streams open now, for a test or a log. */
  size(): number;
}

export function createRunChangeHub(): RunChangeHub {
  const listeners = new Map<string, Set<ChangeListener>>();
  return {
    publish(change) {
      for (const listener of listeners.get(change.organizationId) ?? [])
        try {
          listener(change);
        } catch {
          // One stream's failure is its own.
        }
    },
    subscribe(organizationId, listener) {
      let set = listeners.get(organizationId);
      if (set === undefined) {
        set = new Set();
        listeners.set(organizationId, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(organizationId);
      };
    },
    size() {
      let count = 0;
      for (const set of listeners.values()) count += set.size;
      return count;
    },
  };
}

/**
 * How often an idle stream says it is alive. Under CloudFront's 30 s
 * origin read timeout and the load balancer's 60 s idle timeout, either of
 * which would otherwise close it.
 */
export const EVENTS_KEEPALIVE_MS = 15_000;
/** How long a browser waits before it opens a dropped stream again. */
export const EVENTS_RETRY_MS = 3_000;

export interface EventRouteOptions {
  readonly hub: Pick<RunChangeHub, "subscribe">;
  /**
   * Whether a member of `role` may hear of this change. A run whose
   * artifacts are a private sandbox is read by owners and admins only, so
   * the others are not told it moved. Absent, every change is told.
   */
  readonly visible?: (
    organizationId: string,
    role: string,
    change: RunChange,
  ) => Promise<boolean>;
  readonly keepaliveMs?: number;
}

type EventEnv = { Variables: AuthVariables };

export function mountEventRoutes<Env extends EventEnv>(
  app: Hono<Env>,
  options: EventRouteOptions,
): void {
  const keepaliveMs = options.keepaliveMs ?? EVENTS_KEEPALIVE_MS;
  app.get("/api/v1/orgs/:orgId/events", (c: Context<EventEnv>) => {
    const { organizationId, role } = c.get("member");
    // Through a proxy that buffers, as nginx does, a stream would arrive
    // all at once when it closed.
    c.header("X-Accel-Buffering", "no");
    return streamSSE(c, async (stream) => {
      // Changes are written in the order they arrived, one at a time.
      let writing: Promise<void> = Promise.resolve();
      const write = (send: () => Promise<void>) => {
        writing = writing.then(send).catch(() => {});
      };
      const unsubscribe = options.hub.subscribe(organizationId, (change) => {
        write(async () => {
          if (
            options.visible !== undefined &&
            !(await options.visible(organizationId, role, change))
          )
            return;
          await stream.writeSSE({
            event: "change",
            data: JSON.stringify({ kind: change.kind, id: change.id }),
          });
        });
      });
      const keepalive = setInterval(() => {
        write(() => stream.write(": keepalive\n\n").then(() => {}));
      }, keepaliveMs);
      await new Promise<void>((resolve) => {
        stream.onAbort(resolve);
        write(() =>
          stream.writeSSE({
            event: "ready",
            data: "{}",
            retry: EVENTS_RETRY_MS,
          }),
        );
      });
      clearInterval(keepalive);
      unsubscribe();
    });
  });
}
