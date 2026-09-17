/**
 * HTTP routes, built by a factory that takes its dependencies so tests run
 * against an in-memory store without binding a port.
 *
 * Domain errors become status codes in one place, `errorHandler`. `auth` is
 * optional only for tests: without it every `/api/*` route answers 503, so
 * omitting it in `server.ts` cannot ship an open API.
 */

import {
  createTodoSchema,
  unknownBuildInfo,
  updateTodoSchema,
  type BuildInfoDto,
} from "@sandbox-factory/shared";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ErrorHandler } from "hono";
import { InvalidTitleError } from "sandbox-factory";

import type { EmailStore, UserProfileStore } from "@sandbox-factory/db";

import type { Auth } from "./auth.js";
import { NotFoundError, type TodoStore } from "./store.js";

export interface AppOptions {
  store: TodoStore;
  corsOrigins: readonly string[];
  /** Omit only in tests. Without it no data route is mounted. */
  auth?: Auth | undefined;
  /**
   * Proven-email store. Optional so tests need no database; the email routes
   * are not mounted without it.
   */
  emails?: EmailStore | undefined;
  /** Username reads and writes. Optional for the same reason as `emails`. */
  profiles?: UserProfileStore | undefined;
  /**
   * Shared secret the CDN sends on every origin request. Set where the task is
   * internet-reachable with nothing upstream to filter (the CloudFront-to-
   * Fargate deploy in `infra/`): this header is all that separates a CDN
   * request from a stranger who resolved the origin. Undefined installs no
   * check.
   */
  originVerify?: string | undefined;

  /** The build record to report. Defaults to the unknown record. */
  buildInfo?: BuildInfoDto | undefined;
}

/** What the session middleware puts on the context for the routes behind it. */
export interface AuthVariables {
  user: { id: string; email: string; name: string };
  sessionId: string;
}

/** Shared by the app, the error handler and the factory's return type. */
type AppEnv = { Variables: AuthVariables };

export function createApp({
  store,
  corsOrigins,
  auth,
  emails,
  profiles,
  buildInfo = unknownBuildInfo,
  originVerify,
}: AppOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Must stay first: a request that bypassed the CDN should cost one string
  // comparison and never reach CORS, auth or the database. `/health` is exempt
  // because container and uptime probes reach the task directly.
  if (originVerify !== undefined) {
    app.use("*", async (c, next) => {
      if (c.req.path === "/health") return next();
      if (c.req.header("x-origin-verify") !== originVerify) {
        return c.json({ error: "Not found" }, 404);
      }
      return next();
    });
  }

  app.use(
    "/api/*",
    cors({
      // `credentials: true` lets the browser send the session cookie, and
      // browsers reject it with "*", so the origins are enumerated.
      origin: [...corsOrigins],
      credentials: true,
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    }),
  );

  // Unauthenticated, for containers and uptime checks. Carries the version so
  // the same probe can watch a rollout.
  app.get("/health", (c) =>
    c.json({ status: "ok", version: buildInfo.version, sha: buildInfo.gitSha }),
  );

  /**
   * The build record, verbatim. Unauthenticated on purpose: the sha of a public
   * repository is not a secret, and the sign-in screen, deploy tooling and
   * provenance checks all read it without a session. `imageDigest` is the only
   * field not supplied by the build; see image-digest.ts.
   */
  app.get("/version", (c) => c.json(buildInfo));

  if (auth === undefined) {
    // No auth configured: serve health and version only. 503 rather than 404
    // says "this server is misconfigured", not "wrong URL".
    app.all("/api/*", (c) =>
      c.json({ error: "Authentication is not configured." }, 503),
    );
    app.notFound((c) => c.json({ error: "Not found." }, 404));
    app.onError(errorHandler);
    return app;
  }

  /**
   * Better Auth owns everything under /api/auth: provider redirects, OAuth
   * callbacks, session reads and sign-out.
   */
  app.all("/api/auth/*", (c) => auth.handler(c.req.raw));

  /**
   * Everything under /api/v1 requires a session. Resolving it from the headers
   * covers both the cookie (web) and the bearer token (extension).
   */
  app.use("/api/v1/*", async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (session === null) {
      return c.json({ error: "Authentication required." }, 401);
    }
    c.set("user", {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
    });
    c.set("sessionId", session.session.id);
    await next();
    return;
  });

  /**
   * Who am I? `id` is the account: permanent, and what anything durable must
   * reference. `username` is the public handle: unique but renameable, so
   * never store it as a foreign key.
   */
  app.get("/api/v1/me", async (c) => {
    const user = c.get("user");
    const profile =
      profiles === undefined ? undefined : await profiles.get(user.id);
    return c.json({
      user: {
        ...user,
        username: profile?.username ?? null,
      },
    });
  });

  if (profiles !== undefined) {
    /** The handle, for the settings form to render. */
    app.get("/api/v1/me/username", async (c) => {
      const profile = await profiles.get(c.get("user").id);
      return c.json({ username: profile?.username ?? null });
    });

    /**
     * Claims or changes the handle. A taken name is 409, not 400, so the form
     * can tell it from a malformed one.
     */
    app.put("/api/v1/me/username", async (c) => {
      const body = (await c.req.json().catch(() => null)) as {
        username?: unknown;
      } | null;
      if (typeof body?.username !== "string") {
        return c.json({ error: "Provide a username." }, 400);
      }

      const result = await profiles.setUsername(
        c.get("user").id,
        body.username,
      );
      if (result.status === "invalid") {
        return c.json({ error: result.reason }, 400);
      }
      if (result.status === "taken") {
        return c.json({ error: "That username is taken." }, 409);
      }
      return c.json({
        username: result.username,
        displayUsername: result.displayUsername,
      });
    });
  }

  if (emails !== undefined) {
    /** The caller's proven addresses, and which provider vouched for each. */
    app.get("/api/v1/me/emails", async (c) => {
      return c.json({ emails: await emails.list(c.get("user").id) });
    });

    /**
     * Promote an address to primary. This also changes the address Better Auth
     * reads, so the two cannot drift apart.
     */
    app.post("/api/v1/me/emails/:id/primary", async (c) => {
      const updated = await emails.setPrimary(
        c.get("user").id,
        c.req.param("id"),
      );
      if (updated === undefined) {
        // Another user's id is a 404, not a 403, which would confirm it exists.
        throw new NotFoundError(c.req.param("id"));
      }
      return c.json(updated);
    });

    app.delete("/api/v1/me/emails/:id", async (c) => {
      const result = await emails.remove(c.get("user").id, c.req.param("id"));
      if (result === "not-found") {
        throw new NotFoundError(c.req.param("id"));
      }
      if (result === "is-primary") {
        return c.json(
          {
            error:
              "Cannot remove the primary address. Make another one primary first.",
          },
          409,
        );
      }
      return c.body(null, 204);
    });
  }

  /**
   * Todos, scoped to the caller: every route passes the session's user id to
   * the store, which makes it part of the query. Another user's id is a 404,
   * as on the email routes.
   */
  app.get("/api/v1/todos", async (c) => {
    return c.json({ todos: await store.list(c.get("user").id) });
  });

  app.get("/api/v1/todos/:id", async (c) => {
    const todo = await store.get(c.get("user").id, c.req.param("id"));
    if (todo === undefined) {
      throw new NotFoundError(c.req.param("id"));
    }
    return c.json(todo);
  });

  app.post("/api/v1/todos", async (c) => {
    const parsed = createTodoSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json({ error: firstIssue(parsed.error) }, 400);
    }
    // The owner comes from the session, never from the body.
    return c.json(await store.create(c.get("user").id, parsed.data.title), 201);
  });

  app.patch("/api/v1/todos/:id", async (c) => {
    const parsed = updateTodoSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json({ error: firstIssue(parsed.error) }, 400);
    }
    return c.json(
      await store.update(c.get("user").id, c.req.param("id"), parsed.data),
    );
  });

  app.delete("/api/v1/todos/:id", async (c) => {
    await store.remove(c.get("user").id, c.req.param("id"));
    return c.body(null, 204);
  });

  app.notFound((c) => c.json({ error: "Not found." }, 404));

  app.onError(errorHandler);

  return app;
}

/**
 * Domain errors to status codes. Shared by the configured and unconfigured
 * apps so they cannot report the same failure differently.
 */
const errorHandler: ErrorHandler<AppEnv> = (error, c) => {
  if (error instanceof NotFoundError) {
    return c.json({ error: error.message }, 404);
  }
  if (error instanceof InvalidTitleError) {
    return c.json({ error: error.message }, 400);
  }
  // Unexpected: log it, but do not leak internals to the caller.
  console.error(error);
  return c.json({ error: "Internal server error." }, 500);
};

function firstIssue(error: { issues: readonly { message: string }[] }): string {
  return error.issues[0]?.message ?? "Invalid request body.";
}
