/**
 * Tests for the organizations list page.
 *
 * The page the avatar menu's one "Organizations" item lands on. What matters
 * here is that it is honest about what you belong to — including when that is
 * nothing, or when the list could not be loaded — and that a row leads
 * somewhere.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import { Organizations } from "../src/Organizations";

const acme = {
  id: "org_1",
  name: "Acme",
  slug: "acme",
  role: "owner",
} as const;
const globex = {
  id: "org_2",
  name: "Globex",
  slug: "globex",
  role: "member",
} as const;

function show(props: Partial<Parameters<typeof Organizations>[0]> = {}): {
  onOpen: ReturnType<typeof vi.fn>;
  onCreate: ReturnType<typeof vi.fn>;
} {
  const onOpen = vi.fn();
  const onCreate = vi.fn();
  render(
    <Organizations
      organizations={[acme, globex]}
      loading={false}
      error={null}
      onOpen={onOpen}
      onCreate={onCreate}
      {...props}
    />,
  );
  return { onOpen, onCreate };
}

test("each organization is listed with its handle and your role", () => {
  // The three facts a row has to carry: what it is called, what a URL or an
  // invitation would name, and what you may do in it.
  show();

  expect(screen.getByText("Acme")).toBeTruthy();
  expect(screen.getByText("@acme")).toBeTruthy();
  expect(screen.getByText("owner")).toBeTruthy();
  expect(screen.getByText("Globex")).toBeTruthy();
  expect(screen.getByText("member")).toBeTruthy();
});

test("a row opens that organization, not another", () => {
  const { onOpen } = show();

  fireEvent.click(screen.getByRole("button", { name: /Globex/ }));

  expect(onOpen).toHaveBeenCalledWith(globex);
});

test("the whole row is the control, reachable by keyboard", () => {
  // A div with a click handler would look identical and be unreachable.
  show();

  const row = screen.getByRole("button", { name: /Acme/ });
  expect(row.tagName).toBe("BUTTON");
});

test("an empty list explains what an organization is for", () => {
  // Someone seeing this has never made one, so "no results" would not help.
  show({ organizations: [] });

  expect(screen.getByText(/not in an organization yet/i)).toBeTruthy();
  // Scoped to the card: the page subtitle also says "shared workspaces", and
  // the point here is that the *empty state* explains itself.
  expect(
    screen.getByText(/create one and you will be its owner/i),
  ).toBeTruthy();
});

test("the empty state offers a way to create one", () => {
  const { onCreate } = show({ organizations: [] });

  // Two create buttons exist on an empty page: the header's and the card's.
  // Either must work.
  for (const button of screen.getAllByRole("button", {
    name: /New organization/,
  })) {
    fireEvent.click(button);
  }

  expect(onCreate).toHaveBeenCalled();
});

test("loading says so rather than claiming you belong to none", () => {
  // The bug this guards: an empty list while the request is in flight reads
  // as "you have no organizations", which is a different and alarming claim.
  show({ organizations: [], loading: true });

  expect(screen.getByText("Loading…")).toBeTruthy();
  expect(screen.queryByText(/not in an organization yet/i)).toBeNull();
});

test("a failed load is reported, not shown as an empty list", () => {
  show({
    organizations: [],
    error: "Could not load your organizations.",
  });

  expect(screen.getByRole("alert").textContent).toMatch(/could not load/i);
});

test("creating is reachable even with a long list", () => {
  // In the header, not appended after the rows, so it does not drift off the
  // bottom of a long page.
  const { onCreate } = show();

  fireEvent.click(screen.getByRole("button", { name: /New organization/ }));

  expect(onCreate).toHaveBeenCalled();
});

test("the page does not offer to switch organization", () => {
  // Deliberately absent while nothing rendered belongs to an organization.
  // If this starts failing, the switch was added — make sure something on
  // screen actually changes when it is used.
  show();

  expect(screen.queryByText(/personal/i)).toBeNull();
  expect(screen.queryByRole("button", { name: /switch/i })).toBeNull();
});
