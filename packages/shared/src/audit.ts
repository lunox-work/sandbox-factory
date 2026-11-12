/**
 * The audit log as the API answers it: what machine credentials changed in
 * a workspace, and how its credentials and webhooks were managed. Never a
 * body, a secret or a query string; `route` is the pattern that answered.
 */

import { z } from "zod";

export const AUDIT_VIAS = ["session", "token", "oauth", "device"] as const;

export const auditEntryDtoSchema = z.object({
  id: z.string().min(1),
  /** Which kind of credential made the request. */
  via: z.enum(AUDIT_VIAS),
  /** The API token's, OAuth access token's or session's id. */
  credentialId: z.string().min(1),
  /** An OAuth token's client id, or a command-line client's name. */
  client: z.string().nullable(),
  /** Who it acted as; null once that person is gone. */
  user: z.object({ id: z.string().min(1), name: z.string() }).nullable(),
  method: z.enum(["POST", "PUT", "PATCH", "DELETE"]),
  /** The route's pattern, `/api/v1/orgs/:orgId/...`, never the URL. */
  route: z.string().min(1),
  /** The resource the path named, when it named one. */
  resourceId: z.string().nullable(),
  status: z.number().int(),
  requestId: z.string().min(1),
  at: z.iso.datetime(),
});

export const auditListResponseSchema = z.object({
  entries: z.array(auditEntryDtoSchema),
  /** Hand back as `cursor` for the next page; null on the last. */
  nextCursor: z.string().nullable(),
});

export type AuditEntryDto = z.infer<typeof auditEntryDtoSchema>;
export type AuditListResponse = z.infer<typeof auditListResponseSchema>;
