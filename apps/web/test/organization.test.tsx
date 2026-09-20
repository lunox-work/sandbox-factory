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

const acme = { id: "org_1", name: "Acme", slug: "acme", role: "owner" };

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

function showSettings(organization = acme) {
  return render(
    <Organization
      organization={organization}
      onChanged={vi.fn()}
      onLeft={vi.fn()}
    />,
  );
}

// ---- the two names --------------------------------------------------------

test("the settings page shows the handle and the permanent id", async () => {
  // The whole point of the pair: the id never changes, the handle may. A page
  // that showed only one of them would hide which is safe to store.
  showSettings();

  expect(
    ((await screen.findByLabelText("Organization handle")) as HTMLInputElement)
      .value,
  ).toBe("acme");
  expect(screen.getByText("org_1")).toBeDefined();
  expect(screen.getByText(/never changes/i)).toBeDefined();
});

test("renaming names the organization explicitly", async () => {
  // Never `session.activeOrganizationId`: one value is shared by every tab,
  // so a rename could otherwise land on the wrong organization.
  showSettings();

  const field = await screen.findByLabelText("Organization handle");
  fireEvent.change(field, { target: { value: "acme-robotics" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

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

  const field = await screen.findByLabelText("Organization handle");
  fireEvent.change(field, { target: { value: "not a handle" } });

  expect(
    (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

test("the server's reason for refusing a rename is shown", async () => {
  update.mockResolvedValue({
    data: null,
    error: { message: "That organization handle is taken." },
  });
  showSettings();

  const field = await screen.findByLabelText("Organization handle");
  fireEvent.change(field, { target: { value: "globex" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  expect(await screen.findByText(/handle is taken/i)).toBeDefined();
});

// ---- roles ----------------------------------------------------------------

test("a member cannot rename the organization", async () => {
  // The server refuses it too; this says so before the click.
  showSettings({ ...acme, role: "member" });

  expect(
    ((await screen.findByLabelText("Organization handle")) as HTMLInputElement)
      .disabled,
  ).toBe(true);
  expect(screen.getByText(/only an owner or an admin/i)).toBeDefined();
});

test("a member is not offered the invite form", async () => {
  showSettings({ ...acme, role: "member" });

  await screen.findByLabelText("Organization handle");
  expect(screen.queryByLabelText("Handle or email address")).toBeNull();
});

test("an admin can invite and rename", async () => {
  showSettings({ ...acme, role: "admin" });

  expect(
    ((await screen.findByLabelText("Organization handle")) as HTMLInputElement)
      .disabled,
  ).toBe(false);
  expect(screen.getByLabelText("Handle or email address")).toBeDefined();
});

test("only an owner is offered deletion", async () => {
  showSettings({ ...acme, role: "admin" });

  await screen.findByLabelText("Organization handle");
  expect(
    screen.queryByRole("button", { name: /delete organization/i }),
  ).toBeNull();
});

// ---- members --------------------------------------------------------------

test("members are listed with their handle and role", async () => {
  serverWith([owner, plainMember]);
  showSettings();

  expect(await screen.findByText("Dana")).toBeDefined();
  expect(screen.getByText("@sam")).toBeDefined();
  expect(screen.getByText("owner")).toBeDefined();
});

test("the last owner cannot be removed", async () => {
  // The plugin refuses it; disabling the control explains why in advance
  // rather than after a failed click.
  serverWith([owner, plainMember]);
  showSettings();

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

  expect(await screen.findByText(/waits on their account page/i)).toBeDefined();
});

// ---- leaving and deleting -------------------------------------------------

test("leaving names the organization", async () => {
  showSettings();

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

  fireEvent.click(
    await screen.findByRole("button", { name: /leave organization/i }),
  );

  expect(await screen.findByText(/only owner/i)).toBeDefined();
});

test("deleting asks for the handle to be typed", async () => {
  // It cannot be undone and takes every member's access with it, so one
  // click is not enough.
  showSettings();

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

test("the handle is proposed from the name", async () => {
  // Typing a name and then a handle twice is busywork; the proposal uses the
  // same normaliser the server applies.
  render(<CreateOrganization onCreated={vi.fn()} onCancel={vi.fn()} />);

  fireEvent.change(screen.getByLabelText("Organization name"), {
    target: { value: "Acme Robotics, Inc." },
  });

  expect(
    (screen.getByLabelText("Organization handle") as HTMLInputElement).value,
  ).toBe("acme-robotics-inc");
});

test("an edited handle stops following the name", async () => {
  render(<CreateOrganization onCreated={vi.fn()} onCancel={vi.fn()} />);

  fireEvent.change(screen.getByLabelText("Organization name"), {
    target: { value: "Acme" },
  });
  fireEvent.change(screen.getByLabelText("Organization handle"), {
    target: { value: "my-own" },
  });
  fireEvent.change(screen.getByLabelText("Organization name"), {
    target: { value: "Acme Robotics" },
  });

  expect(
    (screen.getByLabelText("Organization handle") as HTMLInputElement).value,
  ).toBe("my-own");
});

test("creating passes the name and the handle", async () => {
  const onCreated = vi.fn();
  render(<CreateOrganization onCreated={onCreated} onCancel={vi.fn()} />);

  fireEvent.change(screen.getByLabelText("Organization name"), {
    target: { value: "Acme" },
  });
  fireEvent.click(screen.getByRole("button", { name: /create organization/i }));

  await waitFor(() =>
    expect(create).toHaveBeenCalledWith({ name: "Acme", slug: "acme" }),
  );
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith("org_new"));
});

test("a name whose handle would be invalid cannot be submitted", async () => {
  render(<CreateOrganization onCreated={vi.fn()} onCancel={vi.fn()} />);

  fireEvent.change(screen.getByLabelText("Organization name"), {
    target: { value: "Acme" },
  });
  fireEvent.change(screen.getByLabelText("Organization handle"), {
    target: { value: "no" },
  });

  expect(
    (
      screen.getByRole("button", {
        name: /create organization/i,
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});

test("the server's reason for refusing a create is shown", async () => {
  create.mockResolvedValue({
    data: null,
    error: { message: "That organization handle is taken." },
  });
  render(<CreateOrganization onCreated={vi.fn()} onCancel={vi.fn()} />);

  fireEvent.change(screen.getByLabelText("Organization name"), {
    target: { value: "Acme" },
  });
  fireEvent.click(screen.getByRole("button", { name: /create organization/i }));

  expect(await screen.findByText(/handle is taken/i)).toBeDefined();
});
