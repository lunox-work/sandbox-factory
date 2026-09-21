/**
 * Tests for the organization screens: the switcher in the rail, the create
 * form, and the settings page.
 *
 * The server is faked at the `fetch` and auth-client boundary, as in
 * `account.test.tsx`, so these assert what a person sees given a server
 * response.
 *
 * The properties that matter here are the ones the plan turns on: the id and
 * the handle are different things and both are shown; a rename goes through
 * the plugin with the organization named explicitly; and a control the server
 * would refuse is not offered.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";

const update = vi.fn();
const create = vi.fn();
const remove = vi.fn();
const leave = vi.fn();
const deleteOrg = vi.fn();
const setActive = vi.fn();

vi.mock("../src/auth", () => ({
  authClient: {
    organization: {
      update: (input: unknown) => update(input),
      create: (input: unknown) => create(input),
      removeMember: (input: unknown) => remove(input),
      leave: (input: unknown) => leave(input),
      delete: (input: unknown) => deleteOrg(input),
      setActive: (input: unknown) => setActive(input),
    },
  },
}));

const { CreateOrganization, Organization } =
  await import("../src/Organization");

const acme = {
  id: "org_1",
  name: "Acme",
  slug: "acme",
  kind: "team" as const,
  role: "owner",
};

/** Someone's own account: one member, and it cannot gain another. */
const personal = {
  id: "org_personal",
  name: "Dana",
  slug: "dana",
  kind: "personal" as const,
  role: "owner",
};

/** Every request the page made, so a test can assert what it asked for. */
const calls: string[] = [];

function serverWith(
  members: Array<{
    id: string;
    userId: string;
    role: string;
    name: string;
    username: string | null;
    image: string | null;
  }>,
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string }) => {
      calls.push(`${init?.method ?? "GET"} ${String(url)}`);
      if (String(url).includes("/members")) {
        return new Response(JSON.stringify({ members }));
      }
      if (String(url).includes("/invitations")) {
        return new Response(JSON.stringify({ invitation: { id: "inv_1" } }));
      }
      return new Response("{}", { status: 404 });
    }),
  );
}

const owner = {
  id: "mem_1",
  userId: "user_1",
  role: "owner",
  name: "Dana",
  username: "dana",
  image: null,
};

const plainMember = {
  id: "mem_2",
  userId: "user_2",
  role: "member",
  name: "Sam",
  username: "sam",
  image: null,
};

beforeEach(() => {
  calls.length = 0;
  update.mockReset().mockResolvedValue({ data: {}, error: null });
  create
    .mockReset()
    .mockResolvedValue({ data: { id: "org_new" }, error: null });
  remove.mockReset().mockResolvedValue({ data: {}, error: null });
  leave.mockReset().mockResolvedValue({ data: {}, error: null });
  deleteOrg.mockReset().mockResolvedValue({ data: {}, error: null });
  setActive.mockReset().mockResolvedValue({ data: {}, error: null });
  serverWith([owner]);
});

/**
 * Clicks a value open and hands back its input.
 *
 * The handle reads as text until asked, so a test that queries the input
 * straight away finds nothing — at rest there is no input to find.
 */
async function openField(label: string): Promise<HTMLInputElement> {
  fireEvent.click(
    await screen.findByRole("button", { name: `Edit ${label.toLowerCase()}` }),
  );
  return (await screen.findByLabelText(label)) as HTMLInputElement;
}

function showSettings(organization = acme) {
  return render(
    <Organization
      organization={organization}
      onChanged={vi.fn()}
      onLeft={vi.fn()}
    />,
  );
}

/**
 * Switches to one of the settings tabs and waits for its panel.
 *
 * A team's settings page is three tabs, and only the open one is mounted —
 * Radix drops the others from the DOM entirely — so a test about members or
 * about leaving has to open that tab before it can see anything. Overview is
 * open already and needs no call.
 */
async function openTab(name: "Members" | "Settings") {
  const tab = await screen.findByRole("tab", { name });
  // `mouseDown`, not `click`: Radix's tab trigger activates on the press,
  // and a bare `click` in jsdom leaves every tab inactive — which reads as an
  // empty page rather than as a click that did nothing.
  fireEvent.mouseDown(tab, { button: 0 });
  // Waited on *this* tab being selected, not on any `tabpanel`: the panel
  // that was already open matches too, so the looser wait returns before the
  // switch and hands the test the previous tab's markup.
  await waitFor(() => expect(tab.getAttribute("aria-selected")).toBe("true"));
}

// ---- the two names --------------------------------------------------------

test("the settings page shows the handle, and not the internal id", async () => {
  // The handle is the organization's public name and the field seeds from it.
  // The id is real but deliberately not surfaced here: it is an internal
  // identifier, and showing it taught nobody anything they could act on.
  showSettings();

  expect(await screen.findByText("acme")).toBeDefined();
  expect((await openField("Organization handle")).value).toBe("acme");
  expect(screen.queryByText("org_1")).toBeNull();
});

test("renaming names the organization explicitly", async () => {
  // Never `session.activeOrganizationId`: one value is shared by every tab,
  // so a rename could otherwise land on the wrong organization.
  showSettings();

  const field = await openField("Organization handle");
  fireEvent.change(field, { target: { value: "acme-robotics" } });
  fireEvent.click(
    screen.getByRole("button", { name: "Save organization handle" }),
  );

  await waitFor(() =>
    expect(update).toHaveBeenCalledWith({
      organizationId: "org_1",
      data: { slug: "acme-robotics" },
    }),
  );
});

test("a handle the rules refuse cannot be submitted", async () => {
  // Checked in the browser with the same core rules the server applies, so a
  // bad name costs no round trip.
  showSettings();

  const field = await openField("Organization handle");
  fireEvent.change(field, { target: { value: "not a handle" } });

  expect(
    (
      screen.getByRole("button", {
        name: "Save organization handle",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});

test("the server's reason for refusing a rename is shown", async () => {
  update.mockResolvedValue({
    data: null,
    error: { message: "That organization handle is taken." },
  });
  showSettings();

  const field = await openField("Organization handle");
  fireEvent.change(field, { target: { value: "globex" } });
  fireEvent.click(
    screen.getByRole("button", { name: "Save organization handle" }),
  );

  expect(await screen.findByText(/handle is taken/i)).toBeDefined();
});

// ---- roles ----------------------------------------------------------------

test("a member cannot rename the organization", async () => {
  // The server refuses it too; this says so before the click.
  showSettings({ ...acme, role: "member" });

  expect(await screen.findByText("acme")).toBeDefined();
  // No way in at all, rather than an input that refuses to take anything.
  expect(
    screen.queryByRole("button", { name: "Edit organization handle" }),
  ).toBeNull();
  expect(screen.getByText(/only an owner or an admin/i)).toBeDefined();
});

test("a member is not offered the invite form", async () => {
  showSettings({ ...acme, role: "member" });

  // In the Members tab, where the form would be: querying from the Overview
  // tab would pass because the panel is unmounted, not because the form is
  // withheld.
  await openTab("Members");
  expect(screen.getByText("Dana")).toBeDefined();
  expect(screen.queryByLabelText("Handle or email address")).toBeNull();
});

test("an admin can invite and rename", async () => {
  showSettings({ ...acme, role: "admin" });

  expect(
    await screen.findByRole("button", { name: "Edit organization handle" }),
  ).toBeDefined();
  await openTab("Members");
  expect(screen.getByLabelText("Handle or email address")).toBeDefined();
});

test("only an owner is offered deletion", async () => {
  showSettings({ ...acme, role: "admin" });

  // In the Settings tab, where it would be: see the invite-form test above.
  await openTab("Settings");
  expect(
    screen.getByRole("button", { name: /Leave organization/ }),
  ).toBeDefined();
  expect(
    screen.queryByRole("button", { name: /delete organization/i }),
  ).toBeNull();
});

// ---- members --------------------------------------------------------------

test("members are listed with their handle and role", async () => {
  serverWith([owner, plainMember]);
  showSettings();
  await openTab("Members");

  expect(await screen.findByText("Dana")).toBeDefined();
  expect(screen.getByText("@sam")).toBeDefined();
  expect(screen.getByText("owner")).toBeDefined();
});

test("the last owner cannot be removed", async () => {
  // The plugin refuses it; disabling the control explains why in advance
  // rather than after a failed click.
  serverWith([owner, plainMember]);
  showSettings();
  await openTab("Members");

  await screen.findByText("Dana");
  const removeOwner = screen.getAllByRole("button", {
    name: "Remove",
  })[0] as HTMLButtonElement;
  expect(removeOwner.disabled).toBe(true);
  expect(removeOwner.getAttribute("title")).toBe(
    "An organization must keep at least one owner.",
  );
});

test("an owner can be removed once there are two", async () => {
  serverWith([owner, { ...plainMember, role: "owner" }]);
  showSettings();
  await openTab("Members");

  await screen.findByText("Dana");
  for (const button of screen.getAllByRole("button", { name: "Remove" })) {
    expect((button as HTMLButtonElement).disabled).toBe(false);
  }
});

test("removing a member names the organization and the membership row", async () => {
  // `memberIdOrEmail` is the `member` row id, not the user id: passing the
  // wrong one 400s.
  serverWith([owner, plainMember]);
  showSettings();
  await openTab("Members");

  await screen.findByText("Sam");
  const buttons = screen.getAllByRole("button", { name: "Remove" });
  fireEvent.click(buttons[1] as HTMLElement);

  await waitFor(() =>
    expect(remove).toHaveBeenCalledWith({
      memberIdOrEmail: "mem_2",
      organizationId: "org_1",
    }),
  );
});

// ---- invitations ----------------------------------------------------------

test("inviting by handle posts a handle", async () => {
  showSettings();
  await openTab("Members");

  const field = await screen.findByLabelText("Handle or email address");
  fireEvent.change(field, { target: { value: "sam" } });
  fireEvent.click(screen.getByRole("button", { name: /invite/i }));

  await waitFor(() =>
    expect(calls).toContain("POST /api/v1/orgs/org_1/invitations"),
  );
  const body = JSON.parse(
    (vi.mocked(fetch).mock.calls.at(-1)?.[1] as { body: string }).body,
  ) as Record<string, string>;
  expect(body).toEqual({ handle: "sam" });
});

test("inviting by address posts an address", async () => {
  showSettings();
  await openTab("Members");

  const field = await screen.findByLabelText("Handle or email address");
  fireEvent.change(field, { target: { value: "sam@example.test" } });
  fireEvent.click(screen.getByRole("button", { name: /invite/i }));

  await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
  const body = JSON.parse(
    (vi.mocked(fetch).mock.calls.at(-1)?.[1] as { body: string }).body,
  ) as Record<string, string>;
  expect(body).toEqual({ email: "sam@example.test" });
});

test("the invite form says the invitation is not emailed", async () => {
  // A person who expects an email would otherwise wait for one that never
  // arrives.
  showSettings();
  await openTab("Members");

  expect(await screen.findByText(/waits on their account page/i)).toBeDefined();
});

// ---- leaving and deleting -------------------------------------------------

test("leaving names the organization", async () => {
  showSettings();
  await openTab("Settings");

  fireEvent.click(
    await screen.findByRole("button", { name: /leave organization/i }),
  );

  await waitFor(() =>
    expect(leave).toHaveBeenCalledWith({ organizationId: "org_1" }),
  );
});

test("the server's reason for refusing a leave is shown", async () => {
  leave.mockResolvedValue({
    data: null,
    error: { message: "You cannot leave as the only owner." },
  });
  showSettings();
  await openTab("Settings");

  fireEvent.click(
    await screen.findByRole("button", { name: /leave organization/i }),
  );

  expect(await screen.findByText(/only owner/i)).toBeDefined();
});

test("deleting asks for the handle to be typed", async () => {
  // It cannot be undone and takes every member's access with it, so one
  // click is not enough.
  showSettings();
  await openTab("Settings");

  fireEvent.click(
    await screen.findByRole("button", { name: /delete organization/i }),
  );

  const confirm = screen.getByRole("button", {
    name: "Delete",
  }) as HTMLButtonElement;
  expect(confirm.disabled).toBe(true);

  fireEvent.change(screen.getByLabelText(/type the handle/i), {
    target: { value: "acme" },
  });
  expect(confirm.disabled).toBe(false);

  fireEvent.click(confirm);
  await waitFor(() =>
    expect(deleteOrg).toHaveBeenCalledWith({ organizationId: "org_1" }),
  );
});

test("the wrong handle does not enable deletion", async () => {
  showSettings();
  await openTab("Settings");

  fireEvent.click(
    await screen.findByRole("button", { name: /delete organization/i }),
  );
  fireEvent.change(screen.getByLabelText(/type the handle/i), {
    target: { value: "acmee" },
  });

  expect(
    (screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(deleteOrg).not.toHaveBeenCalled();
});

// ---- creating -------------------------------------------------------------

test("only a name is asked for", async () => {
  // The handle is derived and editable later, so asking for it up front made
  // somebody decide something they had no basis to decide.
  render(<CreateOrganization onCreated={vi.fn()} onCancel={vi.fn()} />);

  expect(screen.getByLabelText("Organization name")).toBeDefined();
  expect(screen.queryByLabelText("Organization handle")).toBeNull();
});

test("creating derives the handle from the name", async () => {
  const onCreated = vi.fn();
  render(<CreateOrganization onCreated={onCreated} onCancel={vi.fn()} />);

  fireEvent.change(screen.getByLabelText("Organization name"), {
    target: { value: "Acme Robotics, Inc." },
  });
  fireEvent.click(screen.getByRole("button", { name: /create organization/i }));

  // The same normaliser the server applies, so the handle it stores is the
  // one that was sent.
  await waitFor(() =>
    expect(create).toHaveBeenCalledWith({
      name: "Acme Robotics, Inc.",
      slug: "acme-robotics-inc",
    }),
  );
});

test("creating hands back the id and the handle the server stored", async () => {
  // The caller navigates by the slug, and the server is what decides it.
  create.mockResolvedValue({
    data: { id: "org_new", slug: "acme-2" },
    error: null,
  });
  const onCreated = vi.fn();
  render(<CreateOrganization onCreated={onCreated} onCancel={vi.fn()} />);

  fireEvent.change(screen.getByLabelText("Organization name"), {
    target: { value: "Acme" },
  });
  fireEvent.click(screen.getByRole("button", { name: /create organization/i }));

  await waitFor(() =>
    expect(onCreated).toHaveBeenCalledWith("org_new", "acme-2"),
  );
});

test("a taken handle is retried with a suffix, not reported", async () => {
  /*
   * Nobody chose the handle, so a collision is not the person's problem to
   * solve — and with no handle field there is nothing they could do about it.
   */
  create
    .mockResolvedValueOnce({
      data: null,
      error: {
        code: "ORGANIZATION_SLUG_ALREADY_TAKEN",
        message: "That organization handle is taken.",
      },
    })
    .mockResolvedValueOnce({
      data: { id: "org_new", slug: "acme-2" },
      error: null,
    });
  const onCreated = vi.fn();
  render(<CreateOrganization onCreated={onCreated} onCancel={vi.fn()} />);

  fireEvent.change(screen.getByLabelText("Organization name"), {
    target: { value: "Acme" },
  });
  fireEvent.click(screen.getByRole("button", { name: /create organization/i }));

  await waitFor(() =>
    expect(onCreated).toHaveBeenCalledWith("org_new", "acme-2"),
  );
  expect(create).toHaveBeenNthCalledWith(1, { name: "Acme", slug: "acme" });
  expect(create).toHaveBeenNthCalledWith(2, { name: "Acme", slug: "acme-2" });
  // Nothing about a handle reaches the person.
  expect(screen.queryByText(/handle is taken/i)).toBeNull();
});

test("a name that normalises to nothing still yields a valid handle", async () => {
  // `toHandleStem` substitutes a stem rather than returning an empty string,
  // so a name of pure punctuation is still creatable.
  render(<CreateOrganization onCreated={vi.fn()} onCancel={vi.fn()} />);

  fireEvent.change(screen.getByLabelText("Organization name"), {
    target: { value: "!!!" },
  });

  expect(
    (
      screen.getByRole("button", {
        name: /create organization/i,
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
});

test("an empty name cannot be submitted", async () => {
  render(<CreateOrganization onCreated={vi.fn()} onCancel={vi.fn()} />);

  expect(
    (
      screen.getByRole("button", {
        name: /create organization/i,
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});

test("the server's reason for refusing a create is shown", async () => {
  // Something other than a taken handle: that one is retried rather than
  // reported, which the test above pins.
  create.mockResolvedValue({
    data: null,
    error: { message: "You already have too many organizations." },
  });
  render(<CreateOrganization onCreated={vi.fn()} onCancel={vi.fn()} />);

  fireEvent.change(screen.getByLabelText("Organization name"), {
    target: { value: "Acme" },
  });
  fireEvent.click(screen.getByRole("button", { name: /create organization/i }));

  expect(await screen.findByText(/too many organizations/i)).toBeDefined();
});

// ---- personal organizations -----------------------------------------------
//
// A personal organization has exactly one member and cannot gain another, so
// the sections about membership do not apply. The API refuses these writes —
// see `refusePersonal` in `apps/api/src/auth.ts` — and the page must not offer
// a control the server would reject.

test("a personal organization shows no members section", async () => {
  serverWith([
    {
      id: "mem_1",
      userId: "user_1",
      role: "owner",
      name: "Dana",
      username: "dana",
      image: null,
    },
  ]);

  render(
    <Organization
      organization={personal}
      onChanged={vi.fn()}
      onLeft={vi.fn()}
    />,
  );

  await waitFor(() => {
    expect(
      screen.getByRole("button", { name: "Edit organization handle" }),
    ).toBeTruthy();
  });
  expect(screen.queryByRole("heading", { name: "Members" })).toBeNull();
});

test("a personal organization offers no way to invite anyone", async () => {
  serverWith([]);

  render(
    <Organization
      organization={personal}
      onChanged={vi.fn()}
      onLeft={vi.fn()}
    />,
  );

  await waitFor(() => {
    expect(
      screen.getByRole("button", { name: "Edit organization handle" }),
    ).toBeTruthy();
  });
  expect(screen.queryByLabelText(/handle or email/i)).toBeNull();
});

test("a personal organization cannot be left or deleted", async () => {
  // It is minted at signup and removed with the account; leaving would strand
  // the person owning nothing.
  serverWith([]);

  render(
    <Organization
      organization={personal}
      onChanged={vi.fn()}
      onLeft={vi.fn()}
    />,
  );

  await waitFor(() => {
    expect(
      screen.getByRole("button", { name: "Edit organization handle" }),
    ).toBeTruthy();
  });
  expect(screen.queryByRole("heading", { name: "Leaving" })).toBeNull();
  expect(
    screen.queryByRole("button", { name: /Leave organization/ }),
  ).toBeNull();
});

test("a team organization still shows all three", async () => {
  // The guard must be specific: a team is the ordinary case behind it.
  serverWith([
    {
      id: "mem_1",
      userId: "user_1",
      role: "owner",
      name: "Dana",
      username: "dana",
      image: null,
    },
  ]);

  render(
    <Organization organization={acme} onChanged={vi.fn()} onLeft={vi.fn()} />,
  );

  // All three tabs are offered...
  expect(await screen.findByRole("tab", { name: "Overview" })).toBeTruthy();
  expect(screen.getByRole("tab", { name: "Members" })).toBeTruthy();
  expect(screen.getByRole("tab", { name: "Settings" })).toBeTruthy();

  // ...and each carries its section. Only the open tab is mounted, so this
  // has to walk them rather than query the page once.
  expect(screen.getByRole("heading", { name: "Handle" })).toBeTruthy();

  await openTab("Members");
  expect(screen.getByRole("heading", { name: "Members" })).toBeTruthy();

  await openTab("Settings");
  expect(screen.getByRole("heading", { name: "Leaving" })).toBeTruthy();
  expect(
    screen.getByRole("button", { name: /Leave organization/ }),
  ).toBeTruthy();
});

/**
 * The faces `user_1` and `user_2` generate, as `Identicon` draws them. Pinned
 * from `packages/shared`'s golden vectors.
 */
const USER_1_D =
  "M1 0h1v1h-1zM3 0h1v1h-1zM1 1h1v1h-1zM3 1h1v1h-1zM1 2h1v1h-1z" +
  "M3 2h1v1h-1zM0 3h1v1h-1zM1 3h1v1h-1zM2 3h1v1h-1zM3 3h1v1h-1z" +
  "M4 3h1v1h-1zM0 4h1v1h-1zM2 4h1v1h-1zM4 4h1v1h-1z";

/**
 * The faces in the member list, in order.
 *
 * Every avatar in the tree, which is exactly the member rows: the handle
 * form's own avatar sits in the Overview tab, and only the open tab is
 * mounted, so with Members open nothing else can match.
 */
function memberFaces(container: HTMLElement): Array<string | undefined> {
  return [...container.querySelectorAll('[data-slot="avatar"]')].map((avatar) =>
    avatar.querySelector("path")?.getAttribute("d"),
  );
}

test("a member row carries the face generated for that person", async () => {
  serverWith([owner, plainMember]);
  const { container } = showSettings();
  await openTab("Members");

  await waitFor(() => {
    expect(screen.getByText("Dana")).toBeTruthy();
  });

  const faces = memberFaces(container);

  // Dana is `user_1`, and two people do not share a face.
  expect(faces[0]).toBe(USER_1_D);
  expect(faces).toHaveLength(2);
  expect(new Set(faces).size).toBe(2);
});

test("a member's face follows the person, not the membership", async () => {
  /*
   * The row's key is the `member` row id, which differs per organization.
   * Seeding from it would give one person a different face in every
   * organization they belong to — the exact failure a generated avatar exists
   * to avoid.
   */
  serverWith([{ ...owner, id: "mem_somewhere_else" }]);
  const { container } = showSettings();
  await openTab("Members");

  await waitFor(() => {
    expect(screen.getByText("Dana")).toBeTruthy();
  });

  expect(memberFaces(container)[0]).toBe(USER_1_D);
});

test("clicking the organization picture says why it cannot be changed yet", async () => {
  showSettings();

  const picture = await screen.findByRole("button", {
    name: "Change organization picture",
  });
  fireEvent.click(picture);

  const notice = await screen.findByRole("status");
  expect(notice.textContent).toContain("coming soon");
  expect(notice.className).not.toContain("destructive");
});

// ---- the connections card -------------------------------------------------

/**
 * The card names every tool the organization can connect, including the two
 * that are not built yet.
 *
 * `onOpenJira` is what gates the whole card, so these pass it: without it the
 * component renders no connections at all, which is what the settings page
 * does when it has no router to open.
 */
function showConnections(connections: Array<{ healthy: boolean }> = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).includes("/jira/connections")) {
        return new Response(JSON.stringify({ connections }));
      }
      if (String(url).includes("/members")) {
        return new Response(JSON.stringify({ members: [owner] }));
      }
      return new Response("{}", { status: 404 });
    }),
  );
  return render(
    <Organization
      organization={acme}
      onChanged={vi.fn()}
      onLeft={vi.fn()}
      onOpenJira={vi.fn()}
    />,
  );
}

test("the connections card counts only healthy Jira connections", async () => {
  // An unhealthy connection is one the organization cannot actually read, so
  // counting it would overstate what is working.
  showConnections([{ healthy: true }, { healthy: true }, { healthy: false }]);

  expect(await screen.findByText("2 active connections")).toBeDefined();
});

test("the connections card is headed Connections, not Jira", async () => {
  // It names every tool now, so heading it after one of them would be wrong.
  showConnections();

  expect(
    await screen.findByRole("heading", { name: "Connections", level: 2 }),
  ).toBeDefined();
  expect(screen.queryByRole("heading", { name: "Jira" })).toBeNull();
});

test("GitHub and Slack are named but cannot be opened yet", async () => {
  // Named rather than left out: the card is about which tools this
  // organization connects, and "not yet" is still an answer.
  showConnections();

  for (const label of ["GitHub", "Slack"]) {
    const button = await screen.findByRole("button", {
      name: `Manage ${label} connections`,
    });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  }
  expect(screen.getAllByText("Coming soon")).toHaveLength(2);
});

test("the three tools are equal squares, not a stacked list", async () => {
  // One of them is built and two are not, which is a fact about today rather
  // than a ranking. Stacked rows made the first read as the heading of a list
  // the others belonged to.
  showConnections();

  await screen.findByRole("button", { name: "Manage Jira connections" });
  const tiles = ["Jira", "GitHub", "Slack"].map((label) =>
    screen.getByRole("button", { name: `Manage ${label} connections` }),
  );

  // Every tool is a square tile, and they share one grid container — which is
  // what makes them the same size as each other.
  expect(tiles.every((tile) => tile.className.includes("aspect-square"))).toBe(
    true,
  );
  const grid = tiles[0]?.parentElement;
  expect(grid?.className).toContain("grid");
  expect(tiles.every((tile) => tile.parentElement === grid)).toBe(true);
});

test("the whole tile is the target, not just the word Manage", async () => {
  // A word inside a large square is a target a person can miss while aiming
  // at the square they think they are pressing.
  const onOpenJira = vi.fn();
  serverWith([]);
  render(
    <Organization
      organization={{
        id: "org_1",
        name: "Acme",
        slug: "acme",
        kind: "team",
        role: "owner",
      }}
      onChanged={vi.fn()}
      onLeft={vi.fn()}
      onOpenJira={onOpenJira}
    />,
  );

  const tile = await screen.findByRole("button", {
    name: "Manage Jira connections",
  });
  // The tile itself is the button, so there is no second one nested inside —
  // a button within a button is invalid, and one of the two is dropped from
  // the accessibility tree.
  expect(tile.querySelector("button")).toBeNull();
  expect(tile.className).toContain("aspect-square");
  // And it lights up under the cursor, which is what says it is pressable.
  expect(tile.className).toContain("hover:bg-muted/50");

  fireEvent.click(tile);
  expect(onOpenJira).toHaveBeenCalledTimes(1);
});

test("the Jira row stays clickable", async () => {
  // The one real connection: everything else on the card is disabled, so a
  // regression that disabled this one too would look intentional.
  showConnections();

  const button = await screen.findByRole("button", {
    name: "Manage Jira connections",
  });
  expect((button as HTMLButtonElement).disabled).toBe(false);
});

test("one connection reads in the singular", async () => {
  // "1 active connections" is the kind of wrong that looks unfinished.
  showConnections([{ healthy: true }]);

  expect(await screen.findByText("1 active connection")).toBeDefined();
});

test("a personal organization is not split into tabs", async () => {
  // Two of the three tabs would be empty: a personal organization has no
  // members to list and cannot be left. It keeps the stacked layout, so the
  // handle and the connections are both on screen at once.
  serverWith([]);
  render(
    <Organization
      organization={personal}
      onChanged={vi.fn()}
      onLeft={vi.fn()}
      onOpenJira={vi.fn()}
    />,
  );

  await screen.findByRole("button", { name: "Edit organization handle" });
  expect(screen.queryByRole("tab")).toBeNull();
  expect(screen.getByRole("heading", { name: "Connections" })).toBeDefined();
});

// ---- the member count -----------------------------------------------------

test("the handle card says how many members there are", async () => {
  // The same line the account page carries under its handle, about the other
  // principal: a count that is the way to the list, not a statistic.
  serverWith([owner, plainMember]);
  showSettings();

  expect(await screen.findByText("2 members")).toBeDefined();
});

test("one member reads in the singular", async () => {
  serverWith([owner]);
  showSettings();

  expect(await screen.findByText("1 member")).toBeDefined();
});

test("no count is shown before the members arrive", async () => {
  // "0 members" is never true — an organization always has its owner — so a
  // count that has not loaded shows nothing rather than zero.
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        // Never settles, so the page stays in its loading state.
        new Promise(() => {
          /* pending */
        }),
    ),
  );
  showSettings();

  await screen.findByRole("button", { name: "Edit organization handle" });
  expect(screen.queryByText(/\d+ members?$/)).toBeNull();
});

test("the member count opens the Members tab", async () => {
  serverWith([owner, plainMember]);
  showSettings();

  fireEvent.click(await screen.findByText("2 members"));

  // The tab it names, now showing the list itself.
  await waitFor(() =>
    expect(
      screen
        .getByRole("tab", { name: "Members" })
        .getAttribute("aria-selected"),
    ).toBe("true"),
  );
  expect(screen.getByRole("heading", { name: "Members" })).toBeDefined();
});

test("a personal organization names itself instead of counting members", async () => {
  // It has exactly one member and cannot gain another, so "1 member" would
  // invite a question whose answer is "never".
  serverWith([owner]);
  render(
    <Organization
      organization={personal}
      onChanged={vi.fn()}
      onLeft={vi.fn()}
    />,
  );

  expect(await screen.findByText("Personal organization")).toBeDefined();
  expect(screen.queryByText(/\d+ members?$/)).toBeNull();
});
