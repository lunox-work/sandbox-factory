/**
 * `GET /api/v1/orgs/:orgId/audit`: the workspace's audit log, newest
 * first, a page at a time (`limit`, `cursor` as `paging.ts` reads them).
 * Owners and admins, from a person's session: not in the public registry,
 * so no token reads what tokens did.
 */

import type { AuditEntry, AuditStore } from "@sandbox-factory/db";
import {
  auditListResponseSchema,
  type AuditEntryDto,
} from "@sandbox-factory/shared";
import type { Hono } from "hono";

import { isAtLeastAdmin } from "../access.js";
import type { AuthVariables } from "../http-context.js";
import { boundedLimit, rowCursor } from "../paging.js";

type Env = { Variables: AuthVariables };

function toDto(entry: AuditEntry): AuditEntryDto {
  return {
    id: entry.id,
    via: entry.via,
    credentialId: entry.credentialId,
    client: entry.client,
    user: entry.user,
    method: entry.method as AuditEntryDto["method"],
    route: entry.route,
    resourceId: entry.resourceId,
    status: entry.status,
    requestId: entry.requestId,
    at: entry.at.toISOString(),
  };
}

export function mountAuditRoutes(
  app: Hono<Env>,
  { audit }: { audit: Pick<AuditStore, "list"> },
): void {
  app.get("/api/v1/orgs/:orgId/audit", async (c) => {
    if (c.get("principal").via !== "session") {
      return c.json(
        {
          error: "The audit log is read from a signed-in session.",
          code: "session_required",
        },
        403,
      );
    }
    if (!isAtLeastAdmin(c.get("member").role)) {
      return c.json(
        { error: "Only owners and admins can read the audit log." },
        403,
      );
    }
    const limit = boundedLimit(c.req.query("limit"));
    const cursor = rowCursor(c.req.query("cursor"));
    if (cursor === null) return c.json({ error: "Invalid cursor." }, 400);
    const entries = await audit.list(c.get("member").organizationId, {
      limit,
      ...(cursor === undefined ? {} : { cursor }),
    });
    const last = entries.at(-1);
    return c.json(
      auditListResponseSchema.parse({
        entries: entries.map(toDto),
        nextCursor:
          entries.length === limit && last !== undefined
            ? `${last.at.toISOString()}|${last.id}`
            : null,
      }),
    );
  });
}
