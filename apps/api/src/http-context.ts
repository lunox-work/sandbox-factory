import type { Principal } from "./principal.js";

/** What the credential middleware puts on the context for the routes behind it. */
export interface AuthVariables {
  /** `principal.user`, kept as its own key for the routes that read it. */
  user: { id: string; email: string; name: string };
  /** `principal.credentialId`: a session's id, or an API token's. */
  sessionId: string;
  /** Who is asking and with which credential; see `principal.ts`. */
  principal: Principal;
  /**
   * The caller's standing in the organization named by the path, set by
   * `requireMembership` on `/api/v1/orgs/:orgId/*`. Absent elsewhere.
   */
  member: { organizationId: string; role: string };
  /** Hono's `requestId`: the caller's `X-Request-Id`, or one made up. */
  requestId: string;
  /** A create's new id, for its audit entry (`audit/trail.ts`). */
  auditResourceId: string;
}
