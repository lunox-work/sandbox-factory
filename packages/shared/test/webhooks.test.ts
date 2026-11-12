import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createWebhookSchema,
  updateWebhookSchema,
  webhookEventSchema,
} from "../src/index.js";

test("an endpoint names an http(s) URL and each event type once", () => {
  const parsed = createWebhookSchema.parse({
    url: "https://hooks.example.test/lunox",
    eventTypes: ["run.finished", "proposal.priced"],
  });
  assert.equal(parsed.description, "");
  for (const body of [
    { url: "ftp://hooks.example.test", eventTypes: ["run.finished"] },
    { url: "https://hooks.example.test", eventTypes: [] },
    {
      url: "https://hooks.example.test",
      eventTypes: ["run.finished", "run.finished"],
    },
    { url: "https://hooks.example.test", eventTypes: ["ping"] },
  ])
    assert.equal(createWebhookSchema.safeParse(body).success, false);
});

test("a change names something, and an event carries ids and states", () => {
  assert.equal(updateWebhookSchema.safeParse({}).success, false);
  assert.equal(updateWebhookSchema.safeParse({ enabled: true }).success, true);
  assert.equal(
    webhookEventSchema.safeParse({
      id: "evt_1",
      type: "ping",
      createdAt: "2026-11-12T00:00:00.000Z",
      organizationId: "org_1",
      data: {},
    }).success,
    true,
  );
});
