/**
 * How long a workspace's waits usually take, for the clock a page shows
 * beside a stage: "usually 3 min" from what it has measured, not a guess
 * written into the page. The workspace's own samples of the last 30 days.
 */

import type { Hono } from "hono";

import type { FlowWaitStore } from "@sandbox-factory/db";
import {
  FLOW_NAME_PATTERN,
  flowTypicalResponseSchema,
} from "@sandbox-factory/shared";

import type { AuthVariables } from "./http-context.js";

/** How far back a typical wait is read. */
export const FLOW_TYPICAL_DAYS = 30;
/** The most flows one read may ask for. */
export const FLOW_TYPICAL_MAX = 20;

export interface FlowRouteOptions {
  readonly waits: Pick<FlowWaitStore, "typical">;
  readonly now?: () => Date;
}

export function mountFlowRoutes<Env extends { Variables: AuthVariables }>(
  app: Hono<Env>,
  options: FlowRouteOptions,
): void {
  const now = options.now ?? (() => new Date());
  app.get("/api/v1/orgs/:orgId/flows/typical", async (c) => {
    const flows = [...new Set(c.req.queries("flow") ?? [])];
    if (
      flows.length > FLOW_TYPICAL_MAX ||
      flows.some((flow) => !FLOW_NAME_PATTERN.test(flow))
    )
      return c.json({ error: "Invalid flows." }, 400);
    const since = new Date(
      now().getTime() - FLOW_TYPICAL_DAYS * 24 * 60 * 60_000,
    );
    const typical = await options.waits.typical(
      c.get("member").organizationId,
      flows,
      since,
    );
    // A minute's staleness is nothing beside a median of thirty days.
    c.header("Cache-Control", "private, max-age=60");
    return c.json(
      flowTypicalResponseSchema.parse({ flows: Object.fromEntries(typical) }),
    );
  });
}
