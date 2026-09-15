/**
 * Process entry point. Everything testable lives in routes.ts; this file only
 * wires config to a listening socket.
 */

import { serve } from "@hono/node-server";

import { parseEnv } from "./env.js";
import { createApp } from "./routes.js";
import { createInMemoryStore } from "./store.js";

const env = parseEnv();

const app = createApp({
  // Seeded so a fresh checkout shows something in the UI immediately.
  store: createInMemoryStore([
    {
      id: "todo_1",
      title: "Try checking this off",
      done: false,
      createdAt: new Date().toISOString(),
    },
  ]),
  corsOrigins: env.CORS_ORIGINS,
});

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`API listening on http://localhost:${info.port}`);
});
