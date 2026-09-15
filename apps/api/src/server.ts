/**
 * Process entry point. Everything testable lives in routes.ts; this file only
 * wires config to a listening socket.
 */

import { serve } from "@hono/node-server";
import { createConnection, createPostgresStore } from "@sandbox-factory/db";

import { parseEnv } from "./env.js";
import { createApp } from "./routes.js";

const env = parseEnv();

const connection = createConnection({ url: env.DATABASE_URL });

const app = createApp({
  store: createPostgresStore(connection.db),
  corsOrigins: env.CORS_ORIGINS,
});

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`API listening on http://localhost:${info.port}`);
});

// Drain the pool on shutdown. Without this the process hangs on SIGTERM with
// connections still open, and the container takes the full stop timeout to die.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      void connection.close().then(() => process.exit(0));
    });
  });
}
