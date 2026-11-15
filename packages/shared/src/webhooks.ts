/**
 * Webhooks out: the endpoints a workspace registers, the deliveries made to
 * them, and the event every delivery's body is.
 *
 * An event says what changed, never what it now is: `data` holds ids and
 * states only, and the receiver reads the rest through the API with its own
 * credential, as a page following the change channel does. Each delivery is
 * signed: `Lunox-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of
 * "<t>.<body>" under the endpoint's secret>`, with `Lunox-Event-Id`.
 */

import { z } from "zod";

import { MERGE_CI_STATES, MERGE_WHEN } from "./sandbox.js";

/** The events an endpoint may take; `ping` is sent on request only. */
export const WEBHOOK_EVENT_TYPES = [
  "run.finished",
  "proposal.priced",
  "sandbox.build.finished",
  "sandbox.published",
  "writeback.failed",
  "submission.graded",
  "submission.merge_opened",
  "submission.ci",
  "submission.merged",
] as const;

export const WEBHOOK_PING = "ping";

/** The prefix on every signing secret, so a leaked one is findable. */
export const WEBHOOK_SECRET_PREFIX = "whsec_";

export const webhookEventTypeSchema = z.enum(WEBHOOK_EVENT_TYPES);

const eventTypesSchema = z
  .array(webhookEventTypeSchema)
  .min(1)
  .max(WEBHOOK_EVENT_TYPES.length)
  .refine((types) => new Set(types).size === types.length, {
    message: "Name each event type once.",
  });

/** https; http is accepted only to localhost outside production. */
const urlSchema = z.url({ protocol: /^https?$/ }).max(2048);

/** Body for `POST /api/v1/orgs/:orgId/webhooks`. */
export const createWebhookSchema = z.strictObject({
  url: urlSchema,
  description: z.string().trim().max(200).default(""),
  eventTypes: eventTypesSchema,
});

/** Body for `PATCH .../webhooks/:id`; at least one field. */
export const updateWebhookSchema = z
  .strictObject({
    url: urlSchema.optional(),
    description: z.string().trim().max(200).optional(),
    eventTypes: eventTypesSchema.optional(),
    /** True also clears an automatic disable. */
    enabled: z.boolean().optional(),
  })
  .refine(
    (change) => Object.values(change).some((value) => value !== undefined),
    "Nothing to change.",
  );

/** An endpoint as listed: never its secret. */
export const webhookEndpointDtoSchema = z.object({
  id: z.string().min(1),
  url: z.url(),
  description: z.string(),
  eventTypes: z.array(webhookEventTypeSchema),
  enabled: z.boolean(),
  /** Why it was disabled automatically; null when it was not. */
  disabledReason: z.string().nullable(),
  disabledAt: z.iso.datetime().nullable(),
  /** Failed attempts since the last success. */
  consecutiveFailures: z.number().int().min(0),
  createdBy: z.object({ id: z.string().min(1), name: z.string() }).nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const webhookEndpointListSchema = z.object({
  endpoints: z.array(webhookEndpointDtoSchema),
});

export const webhookEndpointResponseSchema = z.object({
  endpoint: webhookEndpointDtoSchema,
});

/** The one kind of response that carries the signing secret: create and rotate. */
export const webhookSecretResponseSchema = z.object({
  endpoint: webhookEndpointDtoSchema,
  secret: z.string().startsWith(WEBHOOK_SECRET_PREFIX),
});

/** What every delivery's body is. */
export const webhookEventSchema = z.object({
  id: z.string().min(1),
  type: z.union([webhookEventTypeSchema, z.literal(WEBHOOK_PING)]),
  createdAt: z.iso.datetime(),
  organizationId: z.string().min(1),
  /** Resource ids and states; read the rest through the API. */
  data: z.record(z.string(), z.unknown()),
});

export const webhookDeliveryDtoSchema = z.object({
  id: z.string().min(1),
  endpointId: z.string().min(1),
  eventId: z.string().min(1),
  type: z.string().min(1),
  /** `pending` while an attempt is due, `failed` once retries ran out. */
  state: z.enum(["pending", "delivered", "failed"]),
  payload: webhookEventSchema,
  attemptCount: z.number().int().min(0),
  nextAttemptAt: z.iso.datetime().nullable(),
  lastStatusCode: z.number().int().nullable(),
  lastError: z.string().nullable(),
  deliveredAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});

export const webhookDeliveryListSchema = z.object({
  deliveries: z.array(webhookDeliveryDtoSchema),
  nextCursor: z.string().nullable(),
});

export const webhookDeliveryResponseSchema = z.object({
  delivery: webhookDeliveryDtoSchema,
});

const countsSchema = z.object({
  passed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
const pullRequestSchema = {
  submissionId: z.string().min(1),
  sandboxVersionId: z.string().min(1),
  pullRequestNumber: z.number().int().positive(),
  pullRequestUrl: z.string().min(1),
};

/**
 * `submission.graded`: a grading run ended with a verdict or an error.
 * Counts only, never a hidden test's name or a scenario key.
 */
export const submissionGradedDataSchema = z.strictObject({
  submissionId: z.string().min(1),
  sandboxVersionId: z.string().min(1),
  runId: z.string().min(1),
  status: z.enum(["passed", "failed", "errored"]),
  verdict: z.enum(["passed", "overfit", "incomplete", "refused"]).nullable(),
  public: countsSchema.nullable(),
  hidden: countsSchema.nullable(),
  carryBack: z.enum(["failed"]).nullable(),
});
/** `submission.merge_opened`: its merge-back pull request was opened. */
export const submissionMergeOpenedDataSchema = z.strictObject({
  ...pullRequestSchema,
  when: z.enum(MERGE_WHEN),
});
/** `submission.ci`: the pull request's CI state changed (or its head did). */
export const submissionCiDataSchema = z.strictObject({
  ...pullRequestSchema,
  state: z.enum(MERGE_CI_STATES),
  headSha: z.string().nullable(),
  total: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
});
/** `submission.merged`: merged by the platform (`ci_passes`) or on GitHub. */
export const submissionMergedDataSchema = z.strictObject({
  ...pullRequestSchema,
  mergedCommitSha: z.string().nullable(),
  by: z.enum(["platform", "github"]),
});

/** The `data` each event type is checked against before it is enqueued. */
export const WEBHOOK_EVENT_DATA_SCHEMAS = {
  "submission.graded": submissionGradedDataSchema,
  "submission.merge_opened": submissionMergeOpenedDataSchema,
  "submission.ci": submissionCiDataSchema,
  "submission.merged": submissionMergedDataSchema,
} as const;
export type SubmissionEventType = keyof typeof WEBHOOK_EVENT_DATA_SCHEMAS;
export type SubmissionEventData<T extends SubmissionEventType> = z.infer<
  (typeof WEBHOOK_EVENT_DATA_SCHEMAS)[T]
>;

export type WebhookEventType = z.infer<typeof webhookEventTypeSchema>;
export type WebhookEvent = z.infer<typeof webhookEventSchema>;
export type WebhookEndpointDto = z.infer<typeof webhookEndpointDtoSchema>;
export type WebhookDeliveryDto = z.infer<typeof webhookDeliveryDtoSchema>;
export type CreateWebhookInput = z.infer<typeof createWebhookSchema>;
export type UpdateWebhookInput = z.infer<typeof updateWebhookSchema>;
