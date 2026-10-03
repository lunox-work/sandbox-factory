/** What the session middleware puts on the context for the routes behind it. */
export interface AuthVariables {
  user: { id: string; email: string; name: string };
  sessionId: string;
  /**
   * The caller's standing in the organization named by the path, set by
   * `requireMembership` on `/api/v1/orgs/:orgId/*`. Absent elsewhere.
   */
  member: { organizationId: string; role: string };
}
