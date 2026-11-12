/**
 * Webhook endpoints and deliveries in memory, for the route tests: what the
 * store would hold, secrets as the cipher would hand them back.
 */

import type {
  StoredWebhookDelivery,
  StoredWebhookEndpoint,
  WebhookStore,
} from "@sandbox-factory/db";

import { ada } from "./token-fakes.js";

const NOW = new Date("2026-11-12T00:00:00.000Z");

export function memoryWebhooks(): WebhookStore & {
  endpoints: Array<StoredWebhookEndpoint & { secret: string }>;
  deliveries: StoredWebhookDelivery[];
} {
  const endpoints: Array<StoredWebhookEndpoint & { secret: string }> = [];
  const deliveries: StoredWebhookDelivery[] = [];
  const shown = ({
    secret: _secret,
    ...endpoint
  }: StoredWebhookEndpoint & { secret: string }) => endpoint;
  const find = (owner: string, id: string) =>
    endpoints.findIndex(
      (endpoint) => endpoint.organizationId === owner && endpoint.id === id,
    );
  const unused = () => Promise.reject(new Error("not used here"));
  return {
    endpoints,
    deliveries,
    createEndpoint(owner, input) {
      const endpoint = {
        id: `whk_${endpoints.length + 1}`,
        organizationId: owner,
        url: input.url,
        description: input.description,
        eventTypes: [...input.eventTypes],
        enabled: true,
        createdBy: { id: input.createdBy, name: ada.name },
        consecutiveFailures: 0,
        disabledReason: null,
        disabledAt: null,
        createdAt: NOW,
        updatedAt: NOW,
        secret: input.secret,
      };
      endpoints.push(endpoint);
      return Promise.resolve(shown(endpoint));
    },
    listEndpoints: (owner) =>
      Promise.resolve(
        endpoints
          .filter((endpoint) => endpoint.organizationId === owner)
          .map(shown),
      ),
    getEndpoint(owner, id) {
      const endpoint = endpoints[find(owner, id)];
      return Promise.resolve(endpoint === undefined ? null : shown(endpoint));
    },
    updateEndpoint(owner, id, change) {
      const index = find(owner, id);
      const endpoint = endpoints[index];
      if (endpoint === undefined) return Promise.resolve(null);
      const next = {
        ...endpoint,
        ...(change.url === undefined ? {} : { url: change.url }),
        ...(change.description === undefined
          ? {}
          : { description: change.description }),
        ...(change.eventTypes === undefined
          ? {}
          : { eventTypes: [...change.eventTypes] }),
        ...(change.enabled === undefined ? {} : { enabled: change.enabled }),
      };
      endpoints[index] = next;
      return Promise.resolve(shown(next));
    },
    deleteEndpoint(owner, id) {
      const index = find(owner, id);
      if (index === -1) return Promise.resolve(false);
      endpoints.splice(index, 1);
      return Promise.resolve(true);
    },
    rotateSecret(owner, id, secret) {
      const index = find(owner, id);
      const endpoint = endpoints[index];
      if (endpoint === undefined) return Promise.resolve(null);
      endpoints[index] = { ...endpoint, secret };
      return Promise.resolve(shown(endpoint));
    },
    enqueue(owner, event, at, only) {
      const made = endpoints
        .filter(
          (endpoint) =>
            endpoint.organizationId === owner &&
            (only === undefined
              ? endpoint.enabled && endpoint.eventTypes.includes(event.type)
              : endpoint.id === only),
        )
        .map((endpoint): StoredWebhookDelivery => ({
          id: `whd_${deliveries.length + 1}`,
          organizationId: owner,
          endpointId: endpoint.id,
          eventId: event.id,
          type: event.type,
          payload: event.payload,
          attemptCount: 0,
          nextAttemptAt: at,
          lastStatusCode: null,
          lastError: null,
          deliveredAt: null,
          createdAt: at,
        }));
      deliveries.push(...made);
      return Promise.resolve(made);
    },
    listDeliveries: (owner, endpointId, { limit }) =>
      Promise.resolve(
        deliveries
          .filter(
            (delivery) =>
              delivery.organizationId === owner &&
              delivery.endpointId === endpointId,
          )
          .slice(0, limit),
      ),
    redeliver(owner, endpointId, deliveryId, at) {
      const index = deliveries.findIndex(
        (delivery) =>
          delivery.organizationId === owner &&
          delivery.endpointId === endpointId &&
          delivery.id === deliveryId,
      );
      const delivery = deliveries[index];
      if (delivery === undefined) return Promise.resolve(null);
      const next = {
        ...delivery,
        attemptCount: 0,
        nextAttemptAt: at,
        deliveredAt: null,
      };
      deliveries[index] = next;
      return Promise.resolve(next);
    },
    claimDue: unused,
    recordAttempt: unused,
    pruneDeliveries: unused,
  };
}
