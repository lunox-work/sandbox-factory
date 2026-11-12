/**
 * `GET /api/v1/orgs/:orgId/usage?days=30`: the runs the workspace started
 * in the last `days` days (1 to 90), counted by family, kind and state from
 * the run tables, and the model tokens its runs spent this calendar month
 * (UTC) from the ledger, against the monthly limit new model runs are
 * refused at (`quota.ts`). Any member reads it; a token needs
 * `workspace:read`.
 */

import { quotaMonth, totalTokens, type UsageStore } from "@sandbox-factory/db";
import { usageQuerySchema, usageResponseSchema } from "@sandbox-factory/shared";
import type { Hono } from "hono";

import type { AuthVariables } from "../http-context.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface UsageRouteOptions {
  readonly usage: UsageStore;
  /** `MONTHLY_MODEL_TOKENS_PER_ORG`: what `modelTokens.limit` reports. */
  readonly monthlyTokenLimit: number;
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
    const owner = c.get("member").organizationId;
    const to = options.now?.() ?? new Date();
    const from = new Date(to.getTime() - query.data.days * DAY_MS);
    const month = quotaMonth(to);
    const [runs, tokens] = await Promise.all([
      options.usage.runCounts(owner, from),
      options.usage.modelTokens(owner, month.from),
    ]);
    const used = totalTokens(tokens);
    return c.json(
      usageResponseSchema.parse({
        window: {
          from: from.toISOString(),
          to: to.toISOString(),
          days: query.data.days,
        },
        runs,
        modelTokens: {
          from: month.from.toISOString(),
          resetsAt: month.resetsAt.toISOString(),
          used,
          limit: options.monthlyTokenLimit,
          remaining: Math.max(0, options.monthlyTokenLimit - used),
          ...tokens,
        },
      }),
    );
  });
}
