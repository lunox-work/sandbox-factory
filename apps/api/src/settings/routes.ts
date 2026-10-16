/**
 * A workspace's settings. Any member reads them; owners and admins change
 * them, as they do the rest of what the workspace spends.
 *
 * - `GET .../settings` answers every setting, defaults included.
 * - `PATCH .../settings` changes those named and answers them all.
 */

import type { WorkspaceSettingsStore } from "@sandbox-factory/db";
import {
  updateWorkspaceSettingsSchema,
  workspaceSettingsSchema,
} from "@sandbox-factory/shared";
import type { Hono } from "hono";

import { isAtLeastAdmin } from "../access.js";
import type { AuthVariables } from "../http-context.js";

export interface SettingsRouteOptions {
  readonly settings: WorkspaceSettingsStore;
  /** Called after a change, so what it turns on starts without a timer. */
  readonly onChanged?: (organizationId: string) => void;
}

export function mountSettingsRoutes(
  app: Hono<{ Variables: AuthVariables }>,
  options: SettingsRouteOptions,
): void {
  const path = "/api/v1/orgs/:orgId/settings";

  app.get(path, async (c) =>
    c.json(
      workspaceSettingsSchema.parse(
        await options.settings.get(c.get("member").organizationId),
      ),
    ),
  );

  app.patch(path, async (c) => {
    if (!isAtLeastAdmin(c.get("member").role))
      return c.json(
        {
          error: "Only owners and admins can change the workspace's settings.",
        },
        403,
      );
    const body = updateWorkspaceSettingsSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!body.success) return c.json({ error: "Invalid settings." }, 400);
    const owner = c.get("member").organizationId;
    const change =
      body.data.prepareSandboxes === undefined
        ? {}
        : { prepareSandboxes: body.data.prepareSandboxes };
    const updated = await options.settings.update(
      owner,
      change,
      c.get("user").id,
    );
    options.onChanged?.(owner);
    return c.json(workspaceSettingsSchema.parse(updated));
  });
}
