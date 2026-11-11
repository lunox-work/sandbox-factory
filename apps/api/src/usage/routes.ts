/**
 * `GET /api/v1/orgs/:orgId/usage?days=30`: the runs the workspace started
 * in the last `days` days (1 to 90), counted by family, kind and state from
 * the run tables. Any member reads it; a token needs `workspace:read`.
 */

import type { UsageStore } from "@sandbox-factory/db";
import { usageQuerySchema, usageResponseSchema } from "@sandbox-factory/shared";
import type { Hono } from "hono";

import type { AuthVariables } from "../http-context.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface UsageRouteOptions {
  readonly usage: UsageStore;
  readonly now?: (() => Date) | undefined;
}

export function mountUsageRoutes(
  app: Hono<{ Variables: AuthVariables }>,
  options: UsageRouteOptions,
): void {
  app.get("/api/v1/orgs/:orgId/usage", async (c) => {
    const query = usageQuerySchema.safeParse(c.req.query());
    if (!query.success) {
      return c.json(
        { error: "Ask for between 1 and 90 days.", code: "invalid_window" },
        400,
      );
    }
    const to = options.now?.() ?? new Date();
    const from = new Date(to.getTime() - query.data.days * DAY_MS);
    const runs = await options.usage.runCounts(
      c.get("member").organizationId,
      from,
    );
    return c.json(
      usageResponseSchema.parse({
        window: {
          from: from.toISOString(),
          to: to.toISOString(),
          days: query.data.days,
        },
        runs,
      }),
    );
  });
}
