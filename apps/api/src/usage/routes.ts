/**
 * `GET /api/v1/orgs/:orgId/usage?days=30`: the runs the workspace started
 * in the last `days` days (1 to 90), counted by family, kind and state from
 * the run tables; the model tokens and evaluator seconds its runs spent
 * this calendar month (UTC) from the two ledgers, each against the monthly
 * limit new runs are refused at (`quota.ts`); and the month's grading
 * attempts and uploads. Any member reads it; a token needs
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
  /** `MONTHLY_EVALUATOR_SECONDS_PER_ORG`: what `evaluatorSeconds.limit` reports. */
  readonly monthlyEvaluatorSeconds: number;
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
    const [runs, tokens, evaluator, counts] = await Promise.all([
      options.usage.runCounts(owner, from),
      options.usage.modelTokens(owner, month.from),
      options.usage.evaluator(owner, month.from),
      options.usage.submissionsAndUploads(owner, month.from),
    ]);
    const used = totalTokens(tokens);
    const monthWindow = {
      from: month.from.toISOString(),
      resetsAt: month.resetsAt.toISOString(),
    };
    return c.json(
      usageResponseSchema.parse({
        window: {
          from: from.toISOString(),
          to: to.toISOString(),
          days: query.data.days,
        },
        runs,
        modelTokens: {
          ...monthWindow,
          used,
          limit: options.monthlyTokenLimit,
          remaining: Math.max(0, options.monthlyTokenLimit - used),
          ...tokens,
        },
        evaluatorSeconds: {
          ...monthWindow,
          used: evaluator.seconds,
          limit: options.monthlyEvaluatorSeconds,
          remaining: Math.max(
            0,
            options.monthlyEvaluatorSeconds - evaluator.seconds,
          ),
          jobs: evaluator.jobs,
          byKind: evaluator.byKind,
        },
        thisMonth: {
          gradingAttempts: counts.gradingAttempts,
          contributorGradingAttempts: counts.contributorGradingAttempts,
          uploads: counts.uploads,
        },
      }),
    );
  });
}
