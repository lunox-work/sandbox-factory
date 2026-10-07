/**
 * Home over a workspace's board: what it shows when the boards cannot be
 * read, and that a GitHub flow landing here is still reported.
 */

import { render, screen } from "./render";
import { userEvent } from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";

import { HomeBoard } from "../src/HomeBoard";

/** What the boards list answers; null is a server error. */
let boards: unknown[] | null = null;

beforeEach(() => {
  boards = null;
  window.history.replaceState(null, "", "/");
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (/\/orgs\/org_1\/jira\/boards(\?|$)/.test(url))
        return Promise.resolve(
          boards === null
            ? Response.json({ error: "boom" }, { status: 500 })
            : Response.json({ boards }),
        );
      return Promise.resolve(Response.json({}, { status: 404 }));
    }),
  );
});

function show() {
  return render(
    <HomeBoard
      userId="user_1"
      name="Ada Example"
      organizationId="org_1"
      organizationSlug="acme"
      role="owner"
      onBoardName={vi.fn()}
      onOpenBoard={vi.fn()}
      fallback={<p>No board yet</p>}
    />,
  );
}

test("boards that cannot be read say so, with a retry, not that there are none", async () => {
  show();
  expect(
    await screen.findByText("Could not load this workspace’s boards."),
  ).toBeTruthy();
  expect(screen.queryByText("No board yet")).toBeNull();
  boards = [];
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("No board yet")).toBeTruthy();
});

test("a GitHub flow that lands on home is reported over the board", async () => {
  window.history.replaceState(null, "", "/?github=state");
  boards = [
    {
      id: "jrb_1",
      connectionId: "jrc_1",
      externalId: "42",
      name: "Backlog",
      boardType: "scrum",
      projectKey: "APP",
      selection: { unassignedOnly: false, categories: {} },
      sourceRepoId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ];
  show();
  expect(await screen.findByTestId("github-outcome")).toBeTruthy();
});

test("a GitHub flow that lands on a home with no board is reported over the fallback", async () => {
  window.history.replaceState(null, "", "/?github=state");
  boards = [];
  show();
  expect(await screen.findByText("No board yet")).toBeTruthy();
  expect(screen.getByTestId("github-outcome")).toBeTruthy();
});
