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

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { MembershipDto } from "@sandbox-factory/shared";
import { beforeEach, expect, test, vi } from "vitest";

import { EntityAvatar } from "../src/components/Avatar";

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
  role: "owner" as const,
};

/** Someone's own account: one member, and it cannot gain another. */
const personal = {
  id: "org_personal",
  name: "Dana",
  slug: "dana",
  kind: "personal" as const,
  role: "owner" as const,
};

/** Every request the page made, so a test can assert what it asked for. */
const calls: string[] = [];

/** What the avatar route answers with after a team upload. */
const TEAM_PICTURE =
  "/api/avatars/organization/org_1/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.webp";

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
      if (String(url).endsWith("/org_1/avatar")) {
        return new Response(
          JSON.stringify({
            image: init?.method === "DELETE" ? null : TEAM_PICTURE,
          }),
        );
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

function showSettings(organization: MembershipDto = acme) {
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
  expect((await openField("Workspace handle")).value).toBe("acme");
  expect(screen.queryByText("org_1")).toBeNull();
});

test("renaming names the organization explicitly", async () => {
  // Never `session.activeOrganizationId`: one value is shared by every tab,
  // so a rename could otherwise land on the wrong organization.
  showSettings();

  const field = await openField("Workspace handle");
  fireEvent.change(field, { target: { value: "acme-robotics" } });
  fireEvent.click(
    screen.getByRole("button", { name: "Save workspace handle" }),
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

  const field = await openField("Workspace handle");
  fireEvent.change(field, { target: { value: "not a handle" } });

  expect(
    (
      screen.getByRole("button", {
        name: "Save workspace handle",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});

test("the server's reason for refusing a rename is shown", async () => {
  update.mockResolvedValue({
    data: null,
    error: { message: "That workspace handle is taken." },
  });
  showSettings();

  const field = await openField("Workspace handle");
  fireEvent.change(field, { target: { value: "globex" } });
  fireEvent.click(
    screen.getByRole("button", { name: "Save workspace handle" }),
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
    screen.queryByRole("button", { name: "Edit workspace handle" }),
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
    await screen.findByRole("button", { name: "Edit workspace handle" }),
  ).toBeDefined();
  await openTab("Members");
  expect(screen.getByLabelText("Handle or email address")).toBeDefined();
});

test("only an owner is offered deletion", async () => {
  showSettings({ ...acme, role: "admin" });

  // In the Settings tab, where it would be: see the invite-form test above.
  await openTab("Settings");
  expect(screen.getByRole("button", { name: /Leave workspace/ })).toBeDefined();
  expect(
    screen.queryByRole("button", { name: /delete workspace/i }),
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
  // The plugin refuses it; the row states why without advertising a disabled
  // action that can never succeed.
  serverWith([owner, plainMember]);
  showSettings();
  await openTab("Members");

  await screen.findByText("Dana");
  expect(
    screen.getByLabelText(
      "This member is the only owner and cannot be removed",
    ),
  ).toBeDefined();
  // The ordinary member still has the one available Remove action.
  expect(screen.getAllByRole("button", { name: "Remove" })).toHaveLength(1);
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
  // Two clicks now: the row's button asks, the dialog's button acts.
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));

  const dialog = await screen.findByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));

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

test("a pasted @handle is posted as a handle", async () => {
  showSettings();
  await openTab("Members");

  const field = await screen.findByLabelText("Handle or email address");
  fireEvent.change(field, { target: { value: "@sam" } });
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

test("an incomplete email is explained before anything is sent", async () => {
  showSettings();
  await openTab("Members");
  const requestsBefore = calls.filter((call) =>
    call.includes("invitations"),
  ).length;

  const field = await screen.findByLabelText("Handle or email address");
  fireEvent.change(field, { target: { value: "sam@" } });
  fireEvent.click(screen.getByRole("button", { name: /invite/i }));

  expect((await screen.findByRole("alert")).textContent).toContain(
    "Enter a complete email address",
  );
  expect(calls.filter((call) => call.includes("invitations"))).toHaveLength(
    requestsBefore,
  );
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
    await screen.findByRole("button", { name: /leave workspace/i }),
  );
  const dialog = await screen.findByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Leave" }));

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
    await screen.findByRole("button", { name: /leave workspace/i }),
  );
  const dialog = await screen.findByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Leave" }));

  expect(await within(dialog).findByText(/only owner/i)).toBeDefined();
  expect(screen.getByRole("alertdialog")).toBeDefined();
});

test("deleting asks for the handle to be typed", async () => {
  // It cannot be undone and takes every member's access with it, so one
  // click is not enough.
  showSettings();
  await openTab("Settings");

  fireEvent.click(
    await screen.findByRole("button", { name: /delete workspace/i }),
  );

  const dialog = await screen.findByRole("alertdialog");
  const confirm = within(dialog).getByRole("button", {
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
    await screen.findByRole("button", { name: /delete workspace/i }),
  );
  const dialog = await screen.findByRole("alertdialog");
  fireEvent.change(screen.getByLabelText(/type the handle/i), {
    target: { value: "acmee" },
  });

  expect(
    (
      within(dialog).getByRole("button", {
        name: "Delete",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(deleteOrg).not.toHaveBeenCalled();
});

// ---- creating -------------------------------------------------------------

test("only a name is asked for", async () => {
  // The handle is derived and editable later, so asking for it up front made
  // somebody decide something they had no basis to decide.
  render(<CreateOrganization onCreated={vi.fn()} onCancel={vi.fn()} />);

  expect(screen.getByLabelText("Workspace name")).toBeDefined();
  expect(screen.queryByLabelText("Workspace handle")).toBeNull();
});

test("creating derives the handle from the name", async () => {
  const onCreated = vi.fn();
  render(<CreateOrganization onCreated={onCreated} onCancel={vi.fn()} />);

  fireEvent.change(screen.getByLabelText("Workspace name"), {
    target: { value: "Acme Robotics, Inc." },
  });
  fireEvent.click(screen.getByRole("button", { name: /create workspace/i }));

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

  fireEvent.change(screen.getByLabelText("Workspace name"), {
    target: { value: "Acme" },
  });
  fireEvent.click(screen.getByRole("button", { name: /create workspace/i }));

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
        message: "That workspace handle is taken.",
      },
    })
    .mockResolvedValueOnce({
      data: { id: "org_new", slug: "acme-2" },
      error: null,
    });
  const onCreated = vi.fn();
  render(<CreateOrganization onCreated={onCreated} onCancel={vi.fn()} />);

  fireEvent.change(screen.getByLabelText("Workspace name"), {
    target: { value: "Acme" },
  });
  fireEvent.click(screen.getByRole("button", { name: /create workspace/i }));

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

  fireEvent.change(screen.getByLabelText("Workspace name"), {
    target: { value: "!!!" },
  });

  expect(
    (
      screen.getByRole("button", {
        name: /create workspace/i,
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
});

test("an empty name cannot be submitted", async () => {
  render(<CreateOrganization onCreated={vi.fn()} onCancel={vi.fn()} />);

  expect(
    (
      screen.getByRole("button", {
        name: /create workspace/i,
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});

test("the server's reason for refusing a create is shown", async () => {
  // Something other than a taken handle: that one is retried rather than
  // reported, which the test above pins.
  create.mockResolvedValue({
    data: null,
    error: { message: "You already have too many workspaces." },
  });
  render(<CreateOrganization onCreated={vi.fn()} onCancel={vi.fn()} />);

  fireEvent.change(screen.getByLabelText("Workspace name"), {
    target: { value: "Acme" },
  });
  fireEvent.click(screen.getByRole("button", { name: /create workspace/i }));

  expect(await screen.findByText(/too many workspaces/i)).toBeDefined();
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

  // Loaded once the handle has rendered; a personal one has no pencil.
  await screen.findByText("The same as your username, and changed with it.");
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

  // Loaded once the handle has rendered; a personal one has no pencil.
  await screen.findByText("The same as your username, and changed with it.");
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

  // Loaded once the handle has rendered; a personal one has no pencil.
  await screen.findByText("The same as your username, and changed with it.");
  expect(screen.queryByRole("heading", { name: "Leaving" })).toBeNull();
  expect(screen.queryByRole("button", { name: /Leave workspace/ })).toBeNull();
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
  expect(screen.getByText("Bounty rate card")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Danger zone" })).toBeTruthy();
  expect(screen.getByRole("button", { name: /Leave workspace/ })).toBeTruthy();
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
function memberFaces(container: HTMLElement): Array<string | null | undefined> {
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

test("an owner can change a team's picture, and the app hears of it", async () => {
  const onPictureChanged = vi.fn();
  render(
    <Organization
      organization={acme}
      onChanged={vi.fn()}
      onLeft={vi.fn()}
      onPictureChanged={onPictureChanged}
    />,
  );
  await screen.findByRole("button", { name: "Change workspace picture" });

  fireEvent.change(screen.getByLabelText("Upload picture"), {
    target: {
      files: [new File([new Uint8Array(8)], "logo.png", { type: "image/png" })],
    },
  });

  await waitFor(() => expect(calls).toContain("PUT /api/v1/orgs/org_1/avatar"));
  // So the switcher and the list reload with the new picture.
  await waitFor(() => expect(onPictureChanged).toHaveBeenCalled());

  const trigger = screen.getByRole("button", {
    name: "Change workspace picture",
  });
  trigger.focus();
  await act(async () => {
    fireEvent.keyDown(trigger, { key: "Enter" });
  });
  expect((await screen.findByRole("menu")).textContent).toContain(
    "Remove picture",
  );
});

test("a team that already has a picture offers to remove it", async () => {
  showSettings({ ...acme, image: TEAM_PICTURE });
  const trigger = await screen.findByRole("button", {
    name: "Change workspace picture",
  });
  trigger.focus();
  await act(async () => {
    fireEvent.keyDown(trigger, { key: "Enter" });
  });
  const menu = await screen.findByRole("menu");

  await act(async () => {
    fireEvent.click(within(menu).getByText("Remove picture"));
  });

  await waitFor(() =>
    expect(calls).toContain("DELETE /api/v1/orgs/org_1/avatar"),
  );
});

test("a plain member sees the team's picture but cannot change it", async () => {
  showSettings({ ...acme, role: "member" });

  // The read-only face says who can change it.
  await waitFor(() =>
    expect(
      document.querySelector(
        '[title="Only an owner or an admin can change the workspace\u2019s picture."]',
      ),
    ).not.toBeNull(),
  );
  expect(
    screen.queryByRole("button", { name: "Change workspace picture" }),
  ).toBeNull();
});

test("a personal workspace points at the account page for its picture", async () => {
  render(
    <Organization
      organization={personal}
      onChanged={vi.fn()}
      onLeft={vi.fn()}
      viewer={{ id: "user_1", image: null }}
    />,
  );

  await screen.findByText("Personal workspace");
  expect(
    screen.queryByRole("button", { name: "Change workspace picture" }),
  ).toBeNull();
  expect(
    document.querySelector(
      '[title="Your personal workspace wears your picture. Change it in Account settings."]',
    ),
  ).not.toBeNull();
});

// ---- connections ----------------------------------------------------------

/**
 * The Connections section: a square tab per tool, and one card showing the
 * chosen one. Jira is managed in that card rather than on a page of its own.
 *
 * `onOpenBoard` is what gates the section, so these pass it: without it the
 * component renders no connections at all, which is what the settings page
 * does when it has no router to open a board with.
 */
function showConnections(
  connections: Array<{ healthy: boolean }> = [],
  path = "/o/acme/settings",
) {
  window.history.replaceState(null, "", path);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).includes("/jira/connections")) {
        return new Response(
          JSON.stringify({
            connections: connections.map((entry, index) => ({
              id: `jrc_${index + 1}`,
              cloudId: `cloud-${index + 1}`,
              siteUrl: `https://site-${index + 1}.atlassian.net`,
              siteName: `Site ${index + 1}`,
              email: null,
              scopes: [],
              resourceScopes: [],
              writeGranted: true,
              createdAt: "2026-09-21T00:00:00.000Z",
              ...entry,
            })),
          }),
        );
      }
      if (String(url).includes("/jira/boards")) {
        return new Response(JSON.stringify({ boards: [] }));
      }
      if (String(url).endsWith("/sync")) {
        return new Response(JSON.stringify({ added: [] }));
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
      onOpenBoard={vi.fn()}
    />,
  );
}

/** The column of square tabs, apart from the page's own tab row. */
function connectionTabs() {
  return screen.getByRole("tablist", { name: "Connections" });
}

async function openConnection(name: "Home" | "Jira" | "GitHub" | "Slack") {
  const tab = await within(connectionTabs()).findByRole("tab", { name });
  fireEvent.mouseDown(tab, { button: 0 });
  await waitFor(() => expect(tab.getAttribute("aria-selected")).toBe("true"));
}

test("Connections is a section of its own, headed as one", async () => {
  // It names every tool, so heading it after one of them would be wrong.
  showConnections();

  expect(
    await screen.findByRole("heading", { name: "Connections", level: 2 }),
  ).toBeDefined();
});

test("each tool is a square tab, under a Home tab that opens first", async () => {
  showConnections();

  await screen.findByRole("heading", { name: "Connections", level: 2 });
  const tabs = within(connectionTabs()).getAllByRole("tab");
  expect(tabs.map((tab) => tab.getAttribute("aria-label"))).toEqual([
    "Home",
    "Jira",
    "GitHub",
    "Slack",
  ]);
  // Squares: the mark alone, the name only as its label.
  for (const tab of tabs) {
    expect(tab.className).toContain("size-11");
    expect(tab.textContent).toBe("");
  }
  expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
  // Vertical, so the arrow keys move the way the column is drawn.
  expect(connectionTabs().getAttribute("aria-orientation")).toBe("vertical");
});

test("Home counts only healthy Jira connections", async () => {
  // An unhealthy connection is one the organization cannot actually read, so
  // counting it would overstate what is working — but it is still reported.
  showConnections([{ healthy: true }, { healthy: true }, { healthy: false }]);

  expect(
    await screen.findByText("2 active connections across 3 tools."),
  ).toBeDefined();
  expect(screen.getByText("1 needs reconnecting")).toBeDefined();
});

test("one connection reads in the singular", async () => {
  // "1 active connections" is the kind of wrong that looks unfinished.
  showConnections([{ healthy: true }]);

  expect(
    await screen.findByText("1 active connection across 3 tools."),
  ).toBeDefined();
  expect(screen.getByText("active site")).toBeDefined();
});

test("a tile on Home opens that tool's tab", async () => {
  // A count is only useful if it leads to the list it counts.
  showConnections([{ healthy: true }]);

  await screen.findByText("1 active connection across 3 tools.");
  fireEvent.click(screen.getByRole("button", { name: /^Jira/ }));

  await waitFor(() => {
    expect(
      within(connectionTabs())
        .getByRole("tab", { name: "Jira" })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });
  expect(await screen.findByText("Site 1")).toBeDefined();
});

test("the Jira tab manages sites in place, and says so in the URL", async () => {
  showConnections([{ healthy: true }]);

  await openConnection("Jira");

  expect(await screen.findByText("Site 1")).toBeDefined();
  expect(
    screen.getByRole("button", { name: "Connect another site" }),
  ).toBeDefined();
  expect(screen.getByRole("button", { name: "Site 1 options" })).toBeDefined();
  // So a reload, a shared link and the return from Atlassian open here.
  expect(window.location.search).toBe("?connection=jira");

  await openConnection("Home");
  expect(window.location.search).toBe("");
});

test("the tab named in the URL is the one that opens", async () => {
  showConnections([{ healthy: true }], "/o/acme/settings?connection=jira");

  expect(await screen.findByText("Site 1")).toBeDefined();
  expect(
    within(connectionTabs())
      .getByRole("tab", { name: "Jira" })
      .getAttribute("aria-selected"),
  ).toBe("true");
});

test("the return from Atlassian opens on the Jira tab and reports it", async () => {
  // The banner that explains the round trip is on the Jira tab, so an
  // outcome in the query opens it whatever else the query says.
  showConnections([{ healthy: true }], "/o/acme/settings?jira=connected");

  expect(await screen.findByText(/jira connected/i)).toBeDefined();
  expect(
    within(connectionTabs())
      .getByRole("tab", { name: "Jira" })
      .getAttribute("aria-selected"),
  ).toBe("true");
});

test("GitHub and Slack say they are coming soon, and offer nothing to press", async () => {
  // Named rather than left out: the rail is about which tools this
  // organization connects, and "not yet" is still an answer.
  showConnections();

  for (const name of ["GitHub", "Slack"] as const) {
    await openConnection(name);
    // Named by its square, which Radix wires up as the panel's label.
    const panel = screen.getByRole("tabpanel", { name });
    expect(within(panel).getByText("Coming soon")).toBeDefined();
    expect(within(panel).queryByRole("button")).toBeNull();
  }
});

test("without a router there is no connections section", async () => {
  // A board listed under Jira could not be opened, so none is listed.
  serverWith([owner]);
  render(
    <Organization organization={acme} onChanged={vi.fn()} onLeft={vi.fn()} />,
  );

  await screen.findByRole("button", { name: "Edit workspace handle" });
  expect(screen.queryByRole("heading", { name: "Connections" })).toBeNull();
  expect(calls.some((call) => call.includes("/jira/"))).toBe(false);
});

test("a personal organization has Overview and Settings, but no Members", async () => {
  // It has one member and cannot gain another, so a Members tab would always
  // be empty. Settings stays, because that is where the rate card is.
  serverWith([]);
  render(
    <Organization
      organization={personal}
      onChanged={vi.fn()}
      onLeft={vi.fn()}
      onOpenBoard={vi.fn()}
    />,
  );

  await screen.findByText("The same as your username, and changed with it.");
  // The page's own tab row; the Connections column is a tab list of its own.
  const [sections] = screen.getAllByRole("tablist");
  expect(
    within(sections!)
      .getAllByRole("tab")
      .map((tab) => tab.textContent),
  ).toEqual(["Overview", "Settings"]);
  // The handle and the connections share the overview, as on a team.
  expect(screen.getByRole("heading", { name: "Connections" })).toBeDefined();
  expect(screen.queryByText("Bounty rate card")).toBeNull();
});

test("a personal organization's rate card is under Settings, as on a team", async () => {
  serverWith([]);
  render(
    <Organization
      organization={personal}
      onChanged={vi.fn()}
      onLeft={vi.fn()}
    />,
  );

  await openTab("Settings");
  expect(screen.getByText("Bounty rate card")).toBeDefined();
  // Nothing to leave or delete: it goes with the account.
  expect(screen.queryByRole("heading", { name: "Danger zone" })).toBeNull();
});

test("a Members link opens a personal organization on its overview", async () => {
  // A `?tab=members` URL copied from a team's page names a tab this page
  // does not have.
  window.history.replaceState(null, "", "/o/dana?tab=members");
  serverWith([]);
  render(
    <Organization
      organization={personal}
      onChanged={vi.fn()}
      onLeft={vi.fn()}
    />,
  );

  const overview = await screen.findByRole("tab", { name: "Overview" });
  expect(overview.getAttribute("aria-selected")).toBe("true");
  window.history.replaceState(null, "", "/");
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

  await screen.findByRole("button", { name: "Edit workspace handle" });
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

  expect(await screen.findByText("Personal workspace")).toBeDefined();
  expect(screen.queryByText(/\d+ members?$/)).toBeNull();
});

test("a personal organization's handle is its username, not edited here", async () => {
  // One handle per person: it follows the username, which is changed on the
  // account page. An owner would otherwise see a pencil here.
  serverWith([owner]);
  render(
    <Organization
      organization={personal}
      onChanged={vi.fn()}
      onLeft={vi.fn()}
    />,
  );

  expect(
    await screen.findByText("The same as your username, and changed with it."),
  ).toBeDefined();
  expect(screen.queryByRole("button", { name: "Edit handle" })).toBeNull();
});

test("a personal organization wears its owner's picture", async () => {
  // The same face the account page shows, not a square identicon of its own.
  serverWith([owner]);
  const { container } = render(
    <Organization
      organization={personal}
      onChanged={vi.fn()}
      onLeft={vi.fn()}
      viewer={{ id: "user_1" }}
    />,
  );
  await screen.findByText("The same as your username, and changed with it.");

  // Round, and drawn from the user's id rather than the organization's.
  const avatar = container.querySelector('[data-slot="avatar"]');
  expect(avatar?.className).not.toContain("rounded-lg");
  const theirs = render(<EntityAvatar id="user_1" shape="circle" />);
  expect(avatar?.querySelector("path")?.getAttribute("d")).toBe(
    theirs.container.querySelector("path")?.getAttribute("d"),
  );
});

test("a team organization's handle is still edited here, under its own face", async () => {
  serverWith([owner]);
  const { container } = render(
    <Organization
      organization={acme}
      onChanged={vi.fn()}
      onLeft={vi.fn()}
      viewer={{ id: "user_1" }}
    />,
  );

  expect(
    await screen.findByRole("button", { name: "Edit workspace handle" }),
  ).toBeDefined();
  expect(container.querySelector('[data-slot="avatar"]')?.className).toContain(
    "rounded-lg",
  );
});

// ---- nothing irreversible happens on one click ----------------------------
//
// The property these three share: the button on the page asks, and only the
// button in the dialog acts. Removing, leaving and deleting each give away
// access to everything an organization owns, and the rows they are reached
// from are columns of similar names.

test("removing a member asks before it removes", async () => {
  serverWith([owner, plainMember]);
  showSettings();
  await openTab("Members");

  await screen.findByText("Sam");
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));

  expect(await screen.findByRole("alertdialog")).toBeDefined();
  expect(remove).not.toHaveBeenCalled();
});

test("cancelling the question removes nobody", async () => {
  serverWith([owner, plainMember]);
  showSettings();
  await openTab("Members");

  await screen.findByText("Sam");
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  const dialog = await screen.findByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

  await waitFor(() => {
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
  expect(remove).not.toHaveBeenCalled();
});

test("leaving asks before it leaves", async () => {
  showSettings();
  await openTab("Settings");

  fireEvent.click(
    await screen.findByRole("button", { name: /leave workspace/i }),
  );

  expect(await screen.findByRole("alertdialog")).toBeDefined();
  expect(leave).not.toHaveBeenCalled();
});

test("the question names what it is about", async () => {
  // A dialog that says "Are you sure?" over a page of similar rows is a
  // question nobody can answer. Each one names the thing.
  showSettings();
  await openTab("Settings");

  fireEvent.click(
    await screen.findByRole("button", { name: /delete workspace/i }),
  );

  const dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByText(/Delete Acme\?/)).toBeDefined();
});

// ---- the page says what it is doing ---------------------------------------

test("the members list says it is loading rather than looking empty", async () => {
  // It rendered an empty list until the request answered, so an organization
  // briefly looked as though it had no members — which it never can.
  let release: (value: unknown) => void = () => {};
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) =>
      String(input).includes("/members")
        ? pending.then(() => Response.json({ members: [owner] }))
        : Promise.resolve(Response.json({})),
    ),
  );

  showSettings();
  await openTab("Members");

  expect(await screen.findByRole("status")).toBeDefined();

  release(null);
  await waitFor(() => {
    expect(screen.getByText("Dana")).toBeTruthy();
  });
});

test("a members read that fails says so", async () => {
  // It ignored `!res.ok` entirely, so a 500 left an empty list and no reason.
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) =>
      Promise.resolve(
        String(input).includes("/members")
          ? Response.json({ error: "boom" }, { status: 500 })
          : Response.json({}),
      ),
    ),
  );

  showSettings();
  await openTab("Members");

  expect(
    await screen.findByText(/could not load this workspace/i),
  ).toBeDefined();
});

test("a long member name does not grow the row", async () => {
  serverWith([
    owner,
    {
      id: "mem_2",
      userId: "user_2",
      role: "member",
      name: "Grace Hopper With A Remarkably Long Display Name That Goes On",
      username: "grace",
      image: null,
    },
  ]);
  showSettings();
  await openTab("Members");

  const name = await screen.findByText(/Grace Hopper With A Remarkably/);
  // jsdom has no layout, so truncation is the class contract.
  expect(name.className).toContain("truncate");
});

// ---- creating: the name field, and the way back ---------------------------

test("the derived handle is not shown while typing", async () => {
  // The form says only what people will read. The handle is still derived
  // and sent, and can be changed on the settings page afterwards.
  render(<CreateOrganization onCreated={vi.fn()} onCancel={vi.fn()} />);

  fireEvent.change(screen.getByLabelText("Workspace name"), {
    target: { value: "Acme Robotics" },
  });

  expect(
    (screen.getByLabelText("Workspace name") as HTMLInputElement).value,
  ).toBe("Acme Robotics");
  expect(screen.queryByText(/@acme-robotics/)).toBeNull();
});

test("cancel sits beside create, on the right", () => {
  // Alone at the far left, the ghost button's padding set its label in from
  // the field above it.
  render(<CreateOrganization onCreated={vi.fn()} onCancel={vi.fn()} />);

  const cancel = screen.getByRole("button", { name: "Cancel" });
  const create = screen.getByRole("button", { name: "Create workspace" });
  expect(cancel.parentElement).toBe(create.parentElement);
  expect(cancel.parentElement?.className).toContain("justify-end");
  expect(cancel.nextElementSibling).toBe(create);
});

test("the name field takes the focus", () => {
  // It is the only field, and the page exists to fill it in.
  render(<CreateOrganization onCreated={vi.fn()} onCancel={vi.fn()} />);

  expect(document.activeElement).toBe(screen.getByLabelText("Workspace name"));
});
