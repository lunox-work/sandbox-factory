/**
 * Home over a workspace's board: what it shows when the boards cannot be
 * read, and that home's own intro stays above whichever it shows.
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
      organizationId="org_1"
      intro={<p>Home intro</p>}
      organizationSlug="acme"
      role="owner"
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

test("the intro sits over the board, with the board it is showing", async () => {
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
  expect(await screen.findByText("Home intro")).toBeTruthy();
  expect(
    await screen.findByRole("button", { name: "Switch board — Backlog" }),
  ).toBeTruthy();
});

test("a failed board list keeps the intro above the error", async () => {
  show();
  expect(
    await screen.findByText("Could not load this workspace’s boards."),
  ).toBeTruthy();
  expect(screen.getByText("Home intro")).toBeTruthy();
});
