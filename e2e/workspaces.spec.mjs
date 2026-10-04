import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { baseURL, sessionCookie } from "./settings.mjs";

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

test("signed-out visitors see sign-in and cannot read workspace bounties", async ({
  page,
}) => {
  await page.goto("/o/alpha/bounties");
  await expect(
    page.getByRole("button", { name: "Continue with Google" }),
  ).toBeVisible();
  await expect(page.getByText("Alpha private bounty")).toHaveCount(0);
  const response = await page.request.get("/api/v1/orgs/org_alpha/bounties");
  expect(response.status()).toBe(401);
});

test("a bounty created in the browser survives a document reload", async ({
  page,
  context,
}) => {
  await signIn(context);
  await page.goto("/o/alpha/bounties");
  await page.getByRole("button", { name: "New bounty", exact: true }).click();
  const form = page.getByRole("dialog", { name: "New bounty", exact: true });
  await form
    .getByLabel("Title", { exact: true })
    .fill("Keep the accepted bounty after reload");
  await form
    .getByLabel("Description", { exact: true })
    .fill(
      "The saved title and description remain visible after reopening the page.",
    );
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/orgs/org_alpha/bounties") &&
      response.request().method() === "POST",
  );
  await form
    .getByRole("button", { name: "Create bounty", exact: true })
    .click();
  expect((await saved).status()).toBe(201);
  await expect(page).toHaveURL(/\/o\/alpha\/bounties\?bounty=bty_/);
  await page.reload();
  await expect(page.getByRole("dialog")).toContainText(
    "Keep the accepted bounty after reload",
  );
  await expect(page.getByTestId("bounty-detail")).toContainText(
    "The saved title and description remain visible after reopening the page.",
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: /Keep the accepted bounty after reload/ }),
  ).toBeVisible();
});

test("workspace switching and browser history preserve owner isolation", async ({
  page,
  context,
}) => {
  await signIn(context);
  await page.goto("/o/alpha/bounties");
  await expect(
    page.getByText("Alpha private bounty", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Beta private bounty", { exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Switch workspace — Alpha", exact: true })
    .click();
  const switched = page.waitForResponse("**/api/auth/organization/set-active");
  await page.getByRole("menuitem", { name: "Beta", exact: true }).click();
  expect((await switched).status()).toBe(200);
  await expect(page).toHaveURL("/o/beta/bounties");
  await expect(
    page.getByText("Beta private bounty", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Alpha private bounty", { exact: true }),
  ).toHaveCount(0);

  // The session preference remains Beta. The URL must win after Back + reload.
  await page.goBack();
  await page.reload();
  await expect(page).toHaveURL("/o/alpha/bounties");
  await expect(
    page.getByText("Alpha private bounty", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Beta private bounty", { exact: true }),
  ).toHaveCount(0);
  const forbidden = await page.request.get("/api/v1/orgs/org_hidden/bounties");
  expect(forbidden.status()).toBe(404);
  const wrongOwner = await page.request.get(
    "/api/v1/orgs/org_beta/bounties/bty_1",
  );
  expect(wrongOwner.status()).toBe(404);
  await page.goto("/o/hidden/bounties");
  await expect(
    page.getByRole("heading", { name: "Workspace unavailable" }),
  ).toBeVisible();
  await expect(
    page.getByText("Alpha private bounty", { exact: true }),
  ).toHaveCount(0);
});
