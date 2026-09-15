/**
 * HTTP routes.
 *
 * The app is built by a factory that takes its store, so tests can exercise
 * every route against an in-memory store without binding a port.
 *
 * Domain errors are translated to status codes in exactly one place (the
 * `onError` handler): an unknown id is 404, an unusable title is 400. Routes
 * themselves stay free of error plumbing.
 */

import { createTodoSchema, updateTodoSchema } from "@sandbox-factory/shared";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { InvalidTitleError } from "sandbox-factory";

import { NotFoundError, type TodoStore } from "./store.js";

export interface AppOptions {
  store: TodoStore;
  corsOrigins: readonly string[];
}

export function createApp({ store, corsOrigins }: AppOptions): Hono {
  const app = new Hono();

  app.use(
    "/api/*",
    cors({
      origin: [...corsOrigins],
      credentials: true,
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    }),
  );

  // Unauthenticated: used by containers and uptime checks.
  app.get("/health", (c) => c.json({ status: "ok" }));

  app.get("/api/v1/todos", async (c) => {
    return c.json({ todos: await store.list() });
  });

  app.get("/api/v1/todos/:id", async (c) => {
    const todo = await store.get(c.req.param("id"));
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
    return c.json(await store.create(parsed.data.title), 201);
  });

  app.patch("/api/v1/todos/:id", async (c) => {
    const parsed = updateTodoSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json({ error: firstIssue(parsed.error) }, 400);
    }
    return c.json(await store.update(c.req.param("id"), parsed.data));
  });

  app.delete("/api/v1/todos/:id", async (c) => {
    await store.remove(c.req.param("id"));
    // 204: the caller already knows the id it deleted, so there is nothing
    // useful to return.
    return c.body(null, 204);
  });

  app.notFound((c) => c.json({ error: "Not found." }, 404));

  app.onError((error, c) => {
    if (error instanceof NotFoundError) {
      return c.json({ error: error.message }, 404);
    }
    if (error instanceof InvalidTitleError) {
      return c.json({ error: error.message }, 400);
    }
    // Unexpected: log it, but do not leak internals to the caller.
    console.error(error);
    return c.json({ error: "Internal server error." }, 500);
  });

  return app;
}

function firstIssue(error: { issues: readonly { message: string }[] }): string {
  return error.issues[0]?.message ?? "Invalid request body.";
}
