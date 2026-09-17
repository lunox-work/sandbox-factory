/**
 * HTTP routes.
 *
 * The app is built by a factory that takes its store, so tests can exercise
 * every route against an in-memory store without binding a port.
 *
 * Domain errors are translated to status codes in exactly one place (the
 * `onError` handler): an unknown id is 404, an unusable title is 400. Routes
 * themselves stay free of error plumbing.
 *
 * Auth is optional *to this factory* and required *in production*. `auth` is
 * an optional option so route tests can keep running without an OAuth client
 * or a database; `createApp` refuses to expose an unprotected todo route when
 * it is absent, so omitting it in `server.ts` cannot silently ship an open API.
 * See `requireSession` below for how that is enforced.
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
  /**
   * Omit only in tests. When omitted the todo routes are left unmounted
   * rather than left unauthenticated — an API with no auth configured serves
   * no data instead of serving everyone's.
   */
  auth?: Auth | undefined;
  /**
   * Proven-email store. Optional alongside `auth` so route tests can build an
   * app without a database; the account routes are simply not mounted when it
   * is absent.
   */
  emails?: EmailStore | undefined;
  /** Username reads and writes. Optional for the same reason as `emails`. */
  profiles?: UserProfileStore | undefined;
  /**
   * Shared secret the CDN sends on every origin request.
   *
   * Set only where the API is exposed directly to the internet with no load
   * balancer in front to filter on it — the CloudFront-to-Fargate deployment in
   * `infra/` is the case this exists for. There, the task's port is open
   * because CloudFront publishes no stable IP range to pin a security group to,
   * and this header is what separates a CDN request from a stranger who
   * resolved the origin record.
   *
   * Left undefined the check is not installed at all, which is correct for
   * local development and for any topology where something upstream already
   * enforces it.
   */
  originVerify?: string | undefined;

  /**
   * What this build reports about its own provenance.
   *
   * Passed in rather than read from the environment here, like every other
   * option on this factory: the routes stay testable without a build step, and
   * `server.ts` remains the one place that turns environment into config.
   *
   * Defaults to the unknown record so a test that does not care about versions
   * does not have to supply one.
   */
  buildInfo?: BuildInfoDto | undefined;
}

/** What the session middleware puts on the context for the routes behind it. */
export interface AuthVariables {
  user: { id: string; email: string; name: string };
  sessionId: string;
}

/**
 * The app's Hono environment. Named because it appears in three signatures —
 * the app, the error handler, and the factory's return type — and they have to
 * agree or the handlers stop being assignable.
 */
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

  // Origin verification, when configured. First in the chain deliberately: a
  // request that did not come through the CDN should not reach CORS, the auth
  // handler, or the database — it should cost one string comparison and stop.
  //
  // `/health` is exempt below so that container and uptime probes, which reach
  // the task directly rather than through the CDN, keep working.
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
      // `credentials: true` is what lets the browser send the session cookie.
      // It also means the origin list may not be "*" — the browser rejects
      // that combination — which is why CORS_ORIGINS is enumerated.
      origin: [...corsOrigins],
      credentials: true,
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    }),
  );

  // Unauthenticated: used by containers and uptime checks.
  //
  // Carries the version too, so a rollout can be watched from the same probe
  // that says whether the process is up — "healthy" and "healthy *and running
  // what I just deployed*" are different questions, and the second one is the
  // one being asked during a deploy.
  app.get("/health", (c) =>
    c.json({ status: "ok", version: buildInfo.version, sha: buildInfo.gitSha }),
  );

  /**
   * What this API was built from.
   *
   * Unauthenticated on purpose, and it is worth being deliberate about that:
   * it publishes a commit sha for a public repository, which is not a secret —
   * the same sha is on GitHub. It has to be reachable without a session
   * because the sign-in screen renders before there is one, and because
   * deploy tooling and provenance verification read it without credentials.
   *
   * The response is the build record verbatim, so the web app can compare it
   * field for field against its own without either side reshaping it.
   */
  app.get("/version", (c) => c.json(buildInfo));

  if (auth === undefined) {
    // No auth configured: serve health and version only — both are registered
    // above, so a misconfigured server can still say which build it is, which
    // is the first thing worth knowing about one. Returning 503 rather than 404
    // says "this server is misconfigured", not "you asked for the wrong URL".
    app.all("/api/*", (c) =>
      c.json({ error: "Authentication is not configured." }, 503),
    );
    app.notFound((c) => c.json({ error: "Not found." }, 404));
    app.onError(errorHandler);
    return app;
  }

  /**
   * Better Auth owns everything under /api/auth: the provider redirects, the
   * OAuth callbacks, session reads and sign-out. Mounted before the guard
   * below, because signing in obviously cannot require being signed in.
   *
   * `auth.handler` takes a web `Request` and returns a `Response`, which is
   * exactly Hono's own shape, so this needs no adapter.
   */
  app.all("/api/auth/*", (c) => auth.handler(c.req.raw));

  /**
   * Everything else under /api requires a session.
   *
   * The session is resolved from the request headers, which covers both the
   * cookie (web) and the Authorization header (extension, via the bearer
   * plugin) without this code needing to know which one it got.
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
   * Who am I?
   *
   * Returns both identifiers, and they are not interchangeable:
   *
   * - `id` is the account. It is generated once, never changes, and is what
   *   every other row in the database points at. Anything durable — a job, a
   *   contract, an audit entry — must reference this.
   * - `username` is the public handle. It is chosen, it is unique, and it can
   *   be changed at any time. Never store it as a foreign key: a rename would
   *   silently repoint whatever held it.
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
     * Claims or changes the handle.
     *
     * 409 for a taken name rather than 400: the request was well formed, the
     * name is simply someone else's — and the form wants to tell those two
     * cases apart.
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
    /**
     * The addresses this person has proven, and which provider vouched for
     * each. The settings page renders this directly.
     */
    app.get("/api/v1/me/emails", async (c) => {
      return c.json({ emails: await emails.list(c.get("user").id) });
    });

    /**
     * Promote an address to primary. This is also what changes the address
     * Better Auth itself reads, so the two cannot drift apart.
     */
    app.post("/api/v1/me/emails/:id/primary", async (c) => {
      const updated = await emails.setPrimary(
        c.get("user").id,
        c.req.param("id"),
      );
      if (updated === undefined) {
        // Scoped to the caller, so an id belonging to someone else is a 404
        // rather than a 403 — otherwise this endpoint confirms which ids exist.
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
   * Todos, scoped to the caller.
   *
   * Every one of these passes `c.get("user").id` into the store, and the store
   * makes it part of the query rather than a check around it. The session
   * middleware above establishes *who* is asking; this is what makes the
   * answer differ per asker. An id belonging to another user is a 404 here for
   * the same reason it is on the email routes — a 403 would confirm it exists.
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
    // The owner comes from the session, never from the body: a client-supplied
    // owner would let anyone write into someone else's list.
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
    // 204: the caller already knows the id it deleted, so there is nothing
    // useful to return.
    return c.body(null, 204);
  });

  app.notFound((c) => c.json({ error: "Not found." }, 404));

  app.onError(errorHandler);

  return app;
}

/**
 * Domain errors to status codes, in one place.
 *
 * Shared by both the configured and unconfigured apps so the two cannot
 * report the same failure differently.
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
