/**
 * A workspace's webhooks, behind the membership guard, owners and admins
 * only (a token reaches them through the public registry: reads with
 * `workspace:read`, writes with `webhooks:write`):
 *
 * - `GET .../webhooks`, `GET .../webhooks/:id`: endpoints, never a secret.
 * - `POST .../webhooks`: makes one; answers its signing secret, once.
 * - `PATCH .../webhooks/:id`: URL, description, event types, enabled.
 * - `DELETE .../webhooks/:id`: it and its deliveries.
 * - `POST .../webhooks/:id/rotate-secret`: a new secret, once; the old one
 *   stops signing at once.
 * - `GET .../webhooks/:id/deliveries`: newest first, cursor-paged.
 * - `POST .../webhooks/:id/deliveries/:deliveryId/redeliver`: due again
 *   now, with its attempts counted afresh.
 * - `POST .../webhooks/:id/ping`: a `ping` event to this endpoint alone.
 *
 * A URL is checked when it is set and again on every attempt (`ssrf.ts`).
 */

import {
  deliveryState,
  type StoredWebhookDelivery,
  type StoredWebhookEndpoint,
  type WebhookStore,
} from "@sandbox-factory/db";
import {
  createWebhookSchema,
  updateWebhookSchema,
  WEBHOOK_PING,
  webhookDeliveryDtoSchema,
  webhookDeliveryListSchema,
  webhookEndpointDtoSchema,
  webhookEndpointListSchema,
  webhookEndpointResponseSchema,
  webhookSecretResponseSchema,
  type WebhookDeliveryDto,
  type WebhookEndpointDto,
} from "@sandbox-factory/shared";
import type { Context, Hono } from "hono";

import { isAtLeastAdmin } from "../access.js";
import { noteAuditResource } from "../audit/trail.js";
import type { AuthVariables } from "../http-context.js";
import { boundedLimit, rowCursor } from "../paging.js";
import { eventId, eventPayload } from "./emitter.js";
import { generateWebhookSecret } from "./signature.js";
import { checkWebhookUrl, type UrlPolicy } from "./ssrf.js";

export interface WebhookRouteOptions {
  readonly webhooks: WebhookStore;
  readonly policy: UrlPolicy;
  /** A delivery was made due: the sender should look now. */
  readonly onEnqueued?: (() => void) | undefined;
  readonly now?: (() => Date) | undefined;
  readonly generate?: (() => string) | undefined;
}

type Env = { Variables: AuthVariables };

export function toEndpointDto(
  endpoint: StoredWebhookEndpoint,
): WebhookEndpointDto {
  return webhookEndpointDtoSchema.parse({
    id: endpoint.id,
    url: endpoint.url,
    description: endpoint.description,
    eventTypes: endpoint.eventTypes,
    enabled: endpoint.enabled,
    disabledReason: endpoint.disabledReason,
    disabledAt: endpoint.disabledAt?.toISOString() ?? null,
    consecutiveFailures: endpoint.consecutiveFailures,
    createdBy: endpoint.createdBy,
    createdAt: endpoint.createdAt.toISOString(),
    updatedAt: endpoint.updatedAt.toISOString(),
  });
}

export function toDeliveryDto(
  delivery: StoredWebhookDelivery,
): WebhookDeliveryDto {
  return webhookDeliveryDtoSchema.parse({
    id: delivery.id,
    endpointId: delivery.endpointId,
    eventId: delivery.eventId,
    type: delivery.type,
    state: deliveryState(delivery),
    payload: delivery.payload,
    attemptCount: delivery.attemptCount,
    nextAttemptAt: delivery.nextAttemptAt?.toISOString() ?? null,
    lastStatusCode: delivery.lastStatusCode,
    lastError: delivery.lastError,
    deliveredAt: delivery.deliveredAt?.toISOString() ?? null,
    createdAt: delivery.createdAt.toISOString(),
  });
}

const NOT_FOUND = { error: "Not found" } as const;

export function mountWebhookRoutes(
  app: Hono<Env>,
  options: WebhookRouteOptions,
): void {
  const base = "/api/v1/orgs/:orgId/webhooks";
  const now = options.now ?? (() => new Date());
  const generate = options.generate ?? generateWebhookSecret;
  const store = options.webhooks;

  /** The owner, or a refusal for anyone short of admin. */
  function owner(c: Context<Env>): string | Response {
    const { organizationId, role } = c.get("member");
    return isAtLeastAdmin(role)
      ? organizationId
      : c.json({ error: "Only owners and admins can manage webhooks." }, 403);
  }

  function invalid(c: Context<Env>, error: string) {
    return c.json({ error, code: "invalid_webhook" }, 400);
  }

  /** The URL refused, or null when it may be a webhook's. */
  function refusedUrl(c: Context<Env>, url: string | undefined) {
    if (url === undefined) return null;
    const verdict = checkWebhookUrl(url, options.policy);
    return verdict.ok
      ? null
      : c.json({ error: verdict.reason, code: "url_refused" }, 400);
  }

  function withSecret(
    c: Context<Env>,
    endpoint: StoredWebhookEndpoint,
    secret: string,
    status: 200 | 201,
  ) {
    c.header("Cache-Control", "no-store");
    return c.json(
      webhookSecretResponseSchema.parse({
        endpoint: toEndpointDto(endpoint),
        secret,
      }),
      status,
    );
  }

  app.get(base, async (c) => {
    const organizationId = owner(c);
    if (typeof organizationId !== "string") return organizationId;
    const endpoints = await store.listEndpoints(organizationId);
    return c.json(
      webhookEndpointListSchema.parse({
        endpoints: endpoints.map(toEndpointDto),
      }),
    );
  });

  app.post(base, async (c) => {
    const organizationId = owner(c);
    if (typeof organizationId !== "string") return organizationId;
    const parsed = createWebhookSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      return invalid(c, parsed.error.issues[0]?.message ?? "Invalid webhook.");
    const refused = refusedUrl(c, parsed.data.url);
    if (refused !== null) return refused;
    const secret = generate();
    const endpoint = await store.createEndpoint(organizationId, {
      ...parsed.data,
      secret,
      createdBy: c.get("user").id,
    });
    noteAuditResource(c, endpoint.id);
    return withSecret(c, endpoint, secret, 201);
  });

  app.get(`${base}/:id`, async (c) => {
    const organizationId = owner(c);
    if (typeof organizationId !== "string") return organizationId;
    const endpoint = await store.getEndpoint(organizationId, c.req.param("id"));
    if (endpoint === null) return c.json(NOT_FOUND, 404);
    return c.json(
      webhookEndpointResponseSchema.parse({
        endpoint: toEndpointDto(endpoint),
      }),
    );
  });

  app.patch(`${base}/:id`, async (c) => {
    const organizationId = owner(c);
    if (typeof organizationId !== "string") return organizationId;
    const parsed = updateWebhookSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      return invalid(c, parsed.error.issues[0]?.message ?? "Invalid change.");
    const refused = refusedUrl(c, parsed.data.url);
    if (refused !== null) return refused;
    const endpoint = await store.updateEndpoint(
      organizationId,
      c.req.param("id"),
      parsed.data,
    );
    if (endpoint === null) return c.json(NOT_FOUND, 404);
    return c.json(
      webhookEndpointResponseSchema.parse({
        endpoint: toEndpointDto(endpoint),
      }),
    );
  });

  app.delete(`${base}/:id`, async (c) => {
    const organizationId = owner(c);
    if (typeof organizationId !== "string") return organizationId;
    const removed = await store.deleteEndpoint(
      organizationId,
      c.req.param("id"),
    );
    return removed ? c.body(null, 204) : c.json(NOT_FOUND, 404);
  });

  app.post(`${base}/:id/rotate-secret`, async (c) => {
    const organizationId = owner(c);
    if (typeof organizationId !== "string") return organizationId;
    const secret = generate();
    const endpoint = await store.rotateSecret(
      organizationId,
      c.req.param("id"),
      secret,
    );
    if (endpoint === null) return c.json(NOT_FOUND, 404);
    return withSecret(c, endpoint, secret, 200);
  });

  app.get(`${base}/:id/deliveries`, async (c) => {
    const organizationId = owner(c);
    if (typeof organizationId !== "string") return organizationId;
    const endpointId = c.req.param("id");
    const limit = boundedLimit(c.req.query("limit"));
    const cursor = rowCursor(c.req.query("cursor"));
    if (cursor === null) return c.json({ error: "Invalid cursor." }, 400);
    if ((await store.getEndpoint(organizationId, endpointId)) === null)
      return c.json(NOT_FOUND, 404);
    const deliveries = await store.listDeliveries(organizationId, endpointId, {
      limit,
      ...(cursor === undefined ? {} : { cursor }),
    });
    const last = deliveries.at(-1);
    return c.json(
      webhookDeliveryListSchema.parse({
        deliveries: deliveries.map(toDeliveryDto),
        nextCursor:
          deliveries.length === limit && last !== undefined
            ? `${last.createdAt.toISOString()}|${last.id}`
            : null,
      }),
    );
  });

  app.post(`${base}/:id/deliveries/:deliveryId/redeliver`, async (c) => {
    const organizationId = owner(c);
    if (typeof organizationId !== "string") return organizationId;
    const delivery = await store.redeliver(
      organizationId,
      c.req.param("id"),
      c.req.param("deliveryId"),
      now(),
    );
    if (delivery === null) return c.json(NOT_FOUND, 404);
    options.onEnqueued?.();
    return c.json({ delivery: toDeliveryDto(delivery) }, 202);
  });

  app.post(`${base}/:id/ping`, async (c) => {
    const organizationId = owner(c);
    if (typeof organizationId !== "string") return organizationId;
    const endpoint = await store.getEndpoint(organizationId, c.req.param("id"));
    if (endpoint === null) return c.json(NOT_FOUND, 404);
    if (!endpoint.enabled)
      return c.json(
        {
          error: "This endpoint is disabled. Enable it to send it a ping.",
          code: "endpoint_disabled",
        },
        409,
      );
    const at = now();
    const id = eventId(
      organizationId,
      WEBHOOK_PING,
      `${endpoint.id}:${crypto.randomUUID()}`,
    );
    const [delivery] = await store.enqueue(
      organizationId,
      {
        id,
        type: WEBHOOK_PING,
        payload: eventPayload(id, WEBHOOK_PING, organizationId, at, {
          endpointId: endpoint.id,
        }),
      },
      at,
      endpoint.id,
    );
    // Unreachable while the endpoint exists: its id is new every time.
    if (delivery === undefined) return c.json(NOT_FOUND, 404);
    options.onEnqueued?.();
    return c.json({ delivery: toDeliveryDto(delivery) }, 202);
  });
}
