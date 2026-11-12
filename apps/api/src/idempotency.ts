/**
 * `Idempotency-Key` on the public routes that create something: a script
 * or an agent that retries a create after a lost answer gets the first
 * answer back, not a second bounty, run or token.
 *
 * - **Where:** POST routes the registry marks `idempotent`, and a device
 *   sign-in's `POST .../tokens/cli`, for a machine credential (`token`,
 *   `oauth`, `device`). A session's requests are the web app's and are
 *   never replayed. Without the header nothing changes.
 * - **Keyed** by workspace, route pattern and key, for 24 hours
 *   (`IDEMPOTENCY_TTL_MS`). The request's path and body are hashed: the
 *   same key with a different request is 422 `idempotency_key_reused`; a
 *   retry while the first still runs is 409 `idempotency_key_in_use`.
 * - **Kept:** a 2xx or 4xx answer (but 429), replayed with its status and
 *   body and `Idempotent-Replayed: true`. A 5xx or 429 lets the key go, so
 *   the retry runs again. The body is stored encrypted: a CLI token's
 *   mint answers its secret.
 *
 * Mounted behind the membership guard, so the workspace is the path's.
 */

import { createHash } from "node:crypto";

import type { IdempotencyStore } from "@sandbox-factory/db";
import type { MiddlewareHandler } from "hono";

import { answeringRoute } from "./credentials.js";
import type { AuthVariables } from "./http-context.js";
import { PUBLIC_ROUTES } from "./public-api/registry.js";

type Env = { Variables: AuthVariables };

export const IDEMPOTENCY_HEADER = "Idempotency-Key";
/** A claim that never answered for this long is taken to have died. */
const ABANDONED_MS = 5 * 60_000;

/** `METHOD pattern` of every route a key applies to. */
export const IDEMPOTENT_ROUTES: ReadonlySet<string> = new Set([
  ...PUBLIC_ROUTES.filter((route) => route.idempotent === true).map(
    (route) => `${route.method} ${route.path}`,
  ),
  "POST /api/v1/orgs/:orgId/tokens/cli",
]);

const KEY_PATTERN = /^[\x21-\x7e]{1,255}$/;

export function idempotency(options: {
  readonly store: IdempotencyStore;
  readonly now?: (() => Date) | undefined;
}): MiddlewareHandler<Env> {
  const now = options.now ?? (() => new Date());
  return async (c, next) => {
    const key = c.req.header(IDEMPOTENCY_HEADER);
    const via = c.get("principal").via;
    const route = answeringRoute(c);
    const name = route === undefined ? "" : `${route.method} ${route.path}`;
    if (key === undefined || via === "session" || !IDEMPOTENT_ROUTES.has(name))
      return next();
    if (!KEY_PATTERN.test(key))
      return c.json(
        {
          error:
            "An Idempotency-Key is 1 to 255 printable characters, no spaces.",
          code: "invalid_idempotency_key",
        },
        400,
      );
    const claim = {
      organizationId: c.get("member").organizationId,
      route: name,
      key,
    };
    const body = await c.req.text();
    const requestHash = createHash("sha256")
      .update(`${c.req.path}\n${body}`, "utf8")
      .digest("hex");
    const at = now();
    const held = await options.store.begin(
      claim,
      requestHash,
      at,
      new Date(at.getTime() - ABANDONED_MS),
    );
    if (held.state !== "claimed" && held.requestHash !== requestHash)
      return c.json(
        {
          error:
            "This Idempotency-Key was used for a different request. Use a new key for a new request.",
          code: "idempotency_key_reused",
        },
        422,
      );
    if (held.state === "running")
      return c.json(
        {
          error: "A request with this Idempotency-Key is still running.",
          code: "idempotency_key_in_use",
        },
        409,
      );
    if (held.state === "answered") {
      c.header("Idempotent-Replayed", "true");
      if (held.body === "") return c.body(null, held.status as 200);
      c.header("Content-Type", "application/json");
      return c.body(held.body, held.status as 200);
    }

    await next();
    const status = c.res.status;
    try {
      if (status >= 500 || status === 429) await options.store.release(claim);
      else
        await options.store.complete(claim, status, await c.res.clone().text());
    } catch (error) {
      console.error(
        "idempotency_record_failed",
        error instanceof Error ? error.name : "non-Error value thrown",
      );
    }
  };
}
