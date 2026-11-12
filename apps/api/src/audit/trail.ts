/**
 * The audit trail: one entry per request that changed something, written
 * after it is answered.
 *
 * Recorded: every POST, PUT, PATCH and DELETE a machine credential makes
 * (`token`, `oauth`, `device`), refusals included, and a person's session
 * managing credentials or webhooks (`MANAGEMENT`). Each entry names the
 * credential, the person, the route's pattern (never the URL, so no query
 * string), the resource the path names, the status and the request id.
 * Never a body or a secret.
 *
 * Mounted on `/api/v1/*` before the credential guard, so it sees the
 * guard's refusals of a bound credential too (the guard sets the principal
 * before it refuses). A request with no credential the guard could read is
 * not recorded: there is no one to name. A failed write is logged, never
 * the request's failure.
 */

import type { AuditStore, AuditVia } from "@sandbox-factory/db";
import type { Context, MiddlewareHandler } from "hono";

import { answeringRoute } from "../credentials.js";
import type { AuthVariables } from "../http-context.js";
import type { Principal } from "../principal.js";

type Env = { Variables: AuthVariables };

const MUTATING: ReadonlySet<string> = new Set([
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

/** What a person's session does that is recorded too. */
const MANAGEMENT =
  /^\/api\/v1\/orgs\/:orgId\/(tokens|oauth\/grants|webhooks)(\/|$)/;

/**
 * The resource a request's path names: its last parameter other than the
 * organization, read by matching the pattern against the path, or what the
 * route noted with `noteAuditResource` (a create's new id).
 */
export function pathResource(pattern: string, path: string): string | null {
  const names = pattern.split("/");
  const values = path.split("/");
  let found: string | null = null;
  names.forEach((name, index) => {
    const value = values[index];
    if (name.startsWith(":") && name !== ":orgId" && value !== undefined)
      found = decodeURIComponent(value);
  });
  return found;
}

/**
 * Names the resource a create made, for its audit entry. Takes any
 * route's context: route modules type their own environment.
 */
export function noteAuditResource(c: Context, id: string): void {
  (c as Context<Env>).set("auditResourceId", id);
}

export function auditTrail(options: {
  readonly audit: Pick<AuditStore, "record">;
}): MiddlewareHandler<Env> {
  return async (c, next) => {
    await next();
    if (!MUTATING.has(c.req.method)) return;
    const principal = c.get("principal") as Principal | undefined;
    const route = answeringRoute(c);
    if (principal === undefined || route === undefined) return;
    if (principal.via === "session" && !MANAGEMENT.test(route.path)) return;
    const member = c.get("member") as AuthVariables["member"] | undefined;
    const organizationId =
      member?.organizationId ?? principal.organizationId ?? null;
    if (organizationId === null) return;
    const noted = c.get("auditResourceId") as string | undefined;
    try {
      await options.audit.record(organizationId, {
        via: principal.via satisfies AuditVia,
        credentialId: principal.credentialId,
        client: principal.client ?? null,
        userId: principal.user.id,
        method: c.req.method,
        route: route.path,
        resourceId: noted ?? pathResource(route.path, c.req.path),
        status: c.res.status,
        requestId: c.get("requestId"),
      });
    } catch (error) {
      console.error(
        "audit_record_failed",
        error instanceof Error ? error.name : "non-Error value thrown",
      );
    }
  };
}
