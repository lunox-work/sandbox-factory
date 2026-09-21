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
import { isPlainLeftClick } from "../src/routes";

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

/** Whoever is looking at the list. Only the personal row draws on it. */
const VIEWER = { id: "user_1", image: null } as const;

/**
 * The faces generated for `user_1` and for `org_2`, as `Identicon` draws them.
 * Pinned from `packages/shared`'s golden vectors: a row wearing the wrong one
 * is the failure worth catching, and any seed at all renders *a* grid.
 */
const USER_1_D =
  "M1 0h1v1h-1zM3 0h1v1h-1zM1 1h1v1h-1zM3 1h1v1h-1zM1 2h1v1h-1z" +
  "M3 2h1v1h-1zM0 3h1v1h-1zM1 3h1v1h-1zM2 3h1v1h-1zM3 3h1v1h-1z" +
  "M4 3h1v1h-1zM0 4h1v1h-1zM2 4h1v1h-1zM4 4h1v1h-1z";

function show(props: Partial<Parameters<typeof Organizations>[0]> = {}): {
  onOpen: ReturnType<typeof vi.fn>;
  onCreate: ReturnType<typeof vi.fn>;
} {
  const onOpen = vi.fn();
  const onCreate = vi.fn();
  render(
    <Organizations
      organizations={[acme, globex]}
      viewer={VIEWER}
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

  fireEvent.click(screen.getByRole("link", { name: /Globex/ }));

  expect(onOpen).toHaveBeenCalledWith(globex);
});

test("a modified row click is left to the browser", () => {
  expect(
    isPlainLeftClick({
      defaultPrevented: false,
      button: 0,
      metaKey: false,
      ctrlKey: true,
      shiftKey: false,
      altKey: false,
    }),
  ).toBe(false);
});

test("the whole row is the control, reachable by keyboard", () => {
  // A div with a click handler would look identical and be unreachable.
  show();

  const row = screen.getByRole("link", { name: /Acme/ });
  expect(row.tagName).toBe("A");
  expect(row.getAttribute("href")).toBe("/o/acme/settings");
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
  for (const button of screen.getAllByRole("link", {
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

  fireEvent.click(screen.getByRole("link", { name: /New organization/ }));

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

test("the personal row wears the person's own face, not the organization's", () => {
  /*
   * The row says it is theirs rather than shared, so it shows them. Seeding it
   * from the personal organization's own id would put a second, differently
   * shaped face for the same person on the same screen as the rail's, which
   * reads as two accounts.
   */
  const personal = {
    id: "org_personal",
    name: "Alice Ang",
    slug: "alice",
    role: "owner",
    kind: "personal",
  } as const;
  const { container } = render(
    <Organizations
      organizations={[personal]}
      viewer={VIEWER}
      loading={false}
      error={null}
      onOpen={vi.fn()}
      onCreate={vi.fn()}
    />,
  );

  // Scoped to the avatar: the page's own lucide icons are paths too, and the
  // "New organization" button's is the first in the container.
  const avatar = container.querySelector('[data-slot="avatar"]');
  expect(avatar?.querySelector("path")?.getAttribute("d")).toBe(USER_1_D);

  // Round, like the rail's: it is a person.
  expect(avatar?.className).toContain("rounded-full");
  expect(avatar?.className).not.toContain("rounded-lg");
});

test("a team row is a rounded square seeded by the organization", () => {
  const { container } = render(
    <Organizations
      organizations={[globex]}
      viewer={VIEWER}
      loading={false}
      error={null}
      onOpen={vi.fn()}
      onCreate={vi.fn()}
    />,
  );

  // Not the viewer's face: a team is not a person.
  const avatar = container.querySelector('[data-slot="avatar"]');
  expect(avatar?.querySelector("path")?.getAttribute("d")).not.toBe(USER_1_D);
  expect(avatar?.className).toContain("rounded-lg");
});

test("two people looking at the same team see the same team face", () => {
  // The face is a function of the organization's id and nothing else, so it
  // does not depend on who is looking.
  const { container: first, unmount } = render(
    <Organizations
      organizations={[globex]}
      viewer={{ id: "user_1", image: null }}
      loading={false}
      error={null}
      onOpen={vi.fn()}
      onCreate={vi.fn()}
    />,
  );
  const seen = first
    .querySelector('[data-slot="avatar"]')
    ?.querySelector("path")
    ?.getAttribute("d");
  unmount();

  const { container: second } = render(
    <Organizations
      organizations={[globex]}
      viewer={{ id: "user_99", image: null }}
      loading={false}
      error={null}
      onOpen={vi.fn()}
      onCreate={vi.fn()}
    />,
  );

  expect(
    second
      .querySelector('[data-slot="avatar"]')
      ?.querySelector("path")
      ?.getAttribute("d"),
  ).toBe(seen);
});
