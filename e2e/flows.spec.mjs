import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { baseURL, sessionCookie } from "./settings.mjs";

/**
 * How fast the flows feel: a read that answers at once never flashes its
 * loading line, a page loads only the code it shows, and moving between
 * bounties keeps the workspace's push channel rather than opening another.
 */

async function signIn(context) {
  await context.addCookies([
    {
      name: sessionCookie,
      value: randomUUID(),
      url: baseURL,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
}

/**
 * Holds the bounty list's answer back by `ms`, and records, every frame and
 * on every change to the page, the most opaque the list's loading line has
 * been. Opacity rather than `toBeVisible`: the line is in the document
 * throughout, held transparent by its animation, and Playwright counts a
 * transparent element as visible.
 */
async function slowBountyList(page, ms) {
  await page.addInitScript(() => {
    const seen = { mounted: false, opacity: 0 };
    window.__loadingLine = seen;
    const sample = () => {
      for (const line of document.querySelectorAll('[role="status"]')) {
        if (!line.textContent?.includes("Loading bounties")) continue;
        seen.mounted = true;
        seen.opacity = Math.max(
          seen.opacity,
          Number(getComputedStyle(line).opacity),
        );
      }
    };
    new MutationObserver(sample).observe(document, {
      childList: true,
      subtree: true,
    });
    const frame = () => {
      sample();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  await page.route("**/api/v1/me/bounties**", async (route) => {
    const response = await route.fetch();
    await new Promise((resolve) => setTimeout(resolve, ms));
    await route.fulfill({ response });
  });
}

const loadingLine = (page) => page.evaluate(() => window.__loadingLine);

test("a bounty list that answers within 50ms never shows its loading line", async ({
  page,
  context,
}) => {
  await signIn(context);
  await slowBountyList(page, 50);
  await page.goto("/bounties");
  await expect(
    page.getByTestId("bounty-list").getByText("Alpha private bounty"),
  ).toBeVisible();
  const line = await loadingLine(page);
  // There, for a screen reader, but never drawn.
  expect(line.mounted).toBe(true);
  expect(line.opacity).toBe(0);
});

test("a bounty list slower than 600ms shows its loading line meanwhile", async ({
  page,
  context,
}) => {
  await signIn(context);
  await slowBountyList(page, 600);
  await page.goto("/bounties");
  await expect(
    page.getByTestId("bounty-list").getByText("Alpha private bounty"),
  ).toBeVisible();
  const line = await loadingLine(page);
  expect(line.mounted).toBe(true);
  expect(line.opacity).toBe(1);
});

test("the bounty list does not load the sandbox file viewer", async ({
  page,
  context,
}) => {
  // Its own chunk, named for its module, or this would pass by not finding it.
  const chunk = /^SandboxFiles-[\w-]+\.js$/;
  const assets = new URL("../apps/web/dist/assets/", import.meta.url);
  expect(readdirSync(assets).filter((name) => chunk.test(name))).toHaveLength(
    1,
  );
  const scripts = [];
  page.on("request", (request) => {
    const name = new URL(request.url()).pathname.split("/").pop() ?? "";
    if (name.endsWith(".js")) scripts.push(name);
  });
  await signIn(context);
  await page.goto("/bounties");
  await expect(
    page.getByTestId("bounty-list").getByText("Alpha private bounty"),
  ).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(scripts.length).toBeGreaterThan(0);
  expect(scripts.filter((name) => chunk.test(name))).toEqual([]);
});

/**
 * The fixture server mounts no event routes, so the push channel is stubbed
 * here: one `ready`, with a retry far longer than the test so the browser's
 * own reconnect cannot pass for a second opening. Each bounty is mid-sizing,
 * which is what a bounty's page follows the channel for.
 */
async function sizingEverything(page) {
  const opened = [];
  await page.route("**/api/v1/orgs/*/events", async (route) => {
    opened.push(route.request().url());
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: "retry: 600000\nevent: ready\ndata: {}\n\n",
    });
  });
  const run = (organizationId, bountyId) => ({
    id: `brn_${bountyId}`,
    organizationId,
    boardId: null,
    bountyId,
    kind: "bounty",
    sourceProposalId: null,
    sourceRevision: null,
    respec: null,
    requestId: randomUUID(),
    status: "running",
    selection: {},
    rateCard: {
      currency: "USD",
      xsMinor: 100,
      sMinor: 100,
      mMinor: 200,
      lMinor: 300,
      xlMinor: 400,
      revision: 1,
    },
    requestedModel: "test-model",
    promptVersion: "v1",
    planned: [],
    outcomes: [],
    candidatesScanned: 0,
    skippedLive: 0,
    scanLimitReached: false,
    fatalErrorCode: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    deadlineAt: null,
    finishedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    progress: null,
  });
  await page.route("**/api/v1/orgs/*/bounties/*/sizing", (route) => {
    const [, organizationId, bountyId] =
      /\/orgs\/([^/]+)\/bounties\/([^/]+)\/sizing/.exec(
        route.request().url(),
      ) ?? [];
    return route.fulfill({ json: { run: run(organizationId, bountyId) } });
  });
  await page.route("**/api/v1/orgs/*/runs/*", (route) => {
    const [, organizationId, runId] =
      /\/orgs\/([^/]+)\/runs\/brn_([^/?]+)/.exec(route.request().url()) ?? [];
    return route.fulfill({ json: { run: run(organizationId, runId) } });
  });
  return opened;
}

test("moving between two bounties of a workspace opens its push channel once", async ({
  page,
  context,
}) => {
  await signIn(context);
  // A second bounty in Alpha, beside the fixture's own.
  const created = await page.request.post("/api/v1/orgs/org_alpha/bounties", {
    data: {
      title: "Alpha second bounty",
      description: "Another bounty in the same workspace.",
    },
  });
  expect(created.status()).toBe(201);
  const opened = await sizingEverything(page);
  await page.goto("/bounties/alpha/bty_1");
  await expect(
    page.getByRole("heading", { level: 1, name: "Alpha private bounty" }),
  ).toBeVisible();
  await expect.poll(() => opened.length).toBe(1);
  // Back to the list and on to the other one, without reloading the page.
  await page
    .getByRole("navigation", { name: "Breadcrumb" })
    .getByRole("link", { name: "Bounties", exact: true })
    .click();
  await page
    .getByTestId("bounty-list")
    .getByRole("link", { name: /Alpha second bounty/ })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("link", { name: "Open as page", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Alpha second bounty" }),
  ).toBeVisible();
  // Long enough for a second opening to have been requested, were there one.
  await page.waitForTimeout(500);
  expect(opened).toHaveLength(1);
});
