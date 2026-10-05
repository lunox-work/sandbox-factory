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
  await page.goto("/bounties");
  await expect(
    page.getByRole("button", { name: "Continue with Google" }),
  ).toBeVisible();
  await expect(page.getByText("Alpha private bounty")).toHaveCount(0);
  for (const path of [
    "/api/v1/me/bounties",
    "/api/v1/orgs/org_alpha/bounties",
  ]) {
    const response = await page.request.get(path);
    expect(response.status()).toBe(401);
  }
});

test("a bounty created in the browser survives a document reload", async ({
  page,
  context,
}) => {
  await signIn(context);
  await page.goto("/bounties");
  await page.getByRole("link", { name: "New bounty", exact: true }).click();
  // A page of its own, not a panel over the list.
  await expect(page).toHaveURL("/bounties/new");
  const form = page.getByTestId("bounty-form");
  // The workspace in the rail, unless another is chosen.
  await expect(
    form.getByRole("combobox", { name: "Workspace", exact: true }),
  ).toHaveText("Alpha");
  await form
    .getByLabel("Title", { exact: true })
    .fill("Keep the accepted bounty after reload");
  await form
    .getByLabel("Description", { exact: true })
    .fill(
      "The saved title and description remain visible after reopening the page.",
    );
  // Picked from the catalog by a spelling of its own.
  await form.getByRole("combobox", { name: "Tech stack" }).fill("postgres");
  await form.getByRole("option", { name: "PostgreSQL", exact: true }).click();
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/orgs/org_alpha/bounties") &&
      response.request().method() === "POST",
  );
  await form
    .getByRole("button", { name: "Create bounty", exact: true })
    .click();
  expect((await saved).status()).toBe(201);
  await expect(page).toHaveURL(/\/bounties\?peek=alpha\/bty_\d+$/);
  await page.reload();
  await expect(page.getByRole("dialog")).toContainText(
    "Keep the accepted bounty after reload",
  );
  await expect(page.getByTestId("bounty-detail")).toContainText(
    "The saved title and description remain visible after reopening the page.",
  );
  await expect(
    page.getByTestId("bounty-detail").getByRole("list", { name: "Tech stack" }),
  ).toContainText("PostgreSQL");
  // Opened as a page of its own, whose trail leads back to the list.
  await page
    .getByRole("dialog")
    .getByRole("link", { name: "Open as page", exact: true })
    .click();
  await expect(page).toHaveURL(/\/bounties\/alpha\/bty_\d+$/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Keep the accepted bounty after reload",
    }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("bounty-detail")).toContainText(
    "The saved title and description remain visible after reopening the page.",
  );
  await page.goBack();
  await expect(page).toHaveURL(/\/bounties\?peek=alpha\/bty_\d+$/);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await expect(page).toHaveURL("/bounties");
  await expect(
    page.getByRole("link", { name: /Keep the accepted bounty after reload/ }),
  ).toBeVisible();
});

test("every workspace's bounties list together, and only those", async ({
  page,
  context,
}) => {
  await signIn(context);
  await page.goto("/bounties");
  const list = page.getByTestId("bounty-list");
  for (const name of ["Alpha", "Beta"]) {
    const row = list
      .getByRole("listitem")
      .filter({ hasText: `${name} private bounty` });
    await expect(row).toBeVisible();
    // Both are teams, so each row is tagged with its workspace.
    await expect(row.getByText(name, { exact: true })).toBeVisible();
  }
  await expect(page.getByText("Hidden private bounty")).toHaveCount(0);

  // Switching workspace leaves the page where it is: it is every one's.
  await page
    .getByRole("button", { name: "Switch workspace — Alpha", exact: true })
    .click();
  const switched = page.waitForResponse("**/api/auth/organization/set-active");
  await page.getByRole("option", { name: "Beta", exact: true }).click();
  expect((await switched).status()).toBe(200);
  await expect(page).toHaveURL("/bounties");
  await expect(
    page.getByText("Alpha private bounty", { exact: true }),
  ).toBeVisible();

  // An old per-workspace address lands on the same page.
  await page.goto("/o/alpha/bounties");
  await expect(page).toHaveURL("/bounties");

  const forbidden = await page.request.get("/api/v1/orgs/org_hidden/bounties");
  expect(forbidden.status()).toBe(404);
  const wrongOwner = await page.request.get(
    "/api/v1/orgs/org_beta/bounties/bty_1",
  );
  expect(wrongOwner.status()).toBe(404);
  // An address from before `?peek=`, rewritten, and a bounty's own page.
  for (const path of [
    "/bounties?workspace=hidden&bounty=bty_3",
    "/bounties/hidden/bty_3",
  ]) {
    await page.goto(path);
    await expect(
      page.getByText("This bounty is not in any of your workspaces."),
    ).toBeVisible();
    await expect(page.getByText("Hidden private bounty")).toHaveCount(0);
  }
});
