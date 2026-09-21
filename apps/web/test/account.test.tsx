/**
 * Tests for the account settings page.
 *
 * Three bugs shipped here past a green `npm run verify`: an empty handle
 * field, a provider row that said "linked" with no address, and an unlink
 * button that sent the wrong id and 400'd.
 *
 * The server is faked at the `fetch` and auth-client boundary, so these assert
 * what a person sees given a server response.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const listAccounts = vi.fn();
const acceptInvitation = vi.fn();
const rejectInvitation = vi.fn();
const unlinkAccount = vi.fn();
const linkSocial = vi.fn();

vi.mock("../src/auth", () => ({
  authClient: {
    listAccounts: () => listAccounts(),
    unlinkAccount: (input: { accountId: string }) => unlinkAccount(input),
    linkSocial: (input: unknown) => linkSocial(input),
    organization: {
      acceptInvitation: (input: unknown) => acceptInvitation(input),
      rejectInvitation: (input: unknown) => rejectInvitation(input),
    },
  },
  PROVIDERS: [
    { id: "google", label: "Continue with Google" },
    { id: "github", label: "Continue with GitHub" },
  ],
  // The page reads the picture from the session, as the rail does. These tests
  // are about the handle and the providers, so it stands in as signed in with
  // no picture — the case that falls through to the generated one.
  useSession: () => ({
    data: { user: { id: "user_1", image: null, name: "charlie ang" } },
  }),
}));

const { Account } = await import("../src/Account");

/** Every request the page made, so a test can assert what it asked for. */
const calls: string[] = [];

/**
 * Clicks a value open and hands back its input.
 *
 * The three names on these screens read as text until asked: a test that
 * queries the input straight away finds nothing, because at rest there is no
 * input to find.
 */
async function openField(label: string): Promise<HTMLInputElement> {
  fireEvent.click(
    await screen.findByRole("button", { name: `Edit ${label.toLowerCase()}` }),
  );
  return (await screen.findByLabelText(label)) as HTMLInputElement;
}

function serverWith(options: {
  emails?: Array<{
    id: string;
    email: string;
    providers: string[];
    isPrimary: boolean;
  }>;
  username?: string | null;
  invitations?: Array<{
    id: string;
    organization: { id: string; name: string; slug: string };
    role: string;
    expiresAt: string;
  }>;
}) {
  const emails = options.emails ?? [];
  const invitations = options.invitations ?? [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string }) => {
      calls.push(`${init?.method ?? "GET"} ${String(url)}`);
      if (String(url).includes("/api/v1/me/emails")) {
        return new Response(JSON.stringify({ emails }));
      }
      if (String(url).includes("/api/v1/me/invitations")) {
        return new Response(JSON.stringify({ invitations }));
      }
      if (String(url).includes("/api/v1/me/name")) {
        const body = JSON.parse(
          (init as { body?: string } | undefined)?.body ?? "{}",
        ) as { name?: string };
        const name = (body.name ?? "").trim();
        return name === ""
          ? new Response(JSON.stringify({ error: "Name cannot be empty." }), {
              status: 400,
            })
          : new Response(JSON.stringify({ name }));
      }
      if (String(url).endsWith("/api/v1/me")) {
        return new Response(
          JSON.stringify({
            user: {
              id: "user_1",
              email: "dana@example.test",
              name: "Dana",
              username: options.username ?? "dana",
            },
          }),
        );
      }
      return new Response("{}", { status: 404 });
    }),
  );
}

beforeEach(() => {
  calls.length = 0;
  vi.clearAllMocks();
  listAccounts.mockResolvedValue({ data: [] });
  acceptInvitation.mockResolvedValue({ data: {}, error: null });
  rejectInvitation.mockResolvedValue({ data: {}, error: null });
});

describe("addresses and connected accounts", () => {
  test("lists the address a provider proved", async () => {
    // The bug: the row rendered "linked" with no address.
    listAccounts.mockResolvedValue({
      data: [{ id: "row_1", providerId: "google", accountId: "google-123" }],
    });
    serverWith({
      emails: [
        {
          id: "email_1",
          email: "dana@example.test",
          providers: ["google"],
          isPrimary: true,
        },
      ],
    });

    render(<Account />);

    await waitFor(() => {
      expect(screen.getAllByText("dana@example.test").length).toBeGreaterThan(
        0,
      );
    });
  });

  test("shows the same address on both providers when both proved it", async () => {
    // One inbox at both Google and GitHub is the normal case. Showing it only
    // on the first made GitHub look unlinked.
    listAccounts.mockResolvedValue({
      data: [
        { id: "row_1", providerId: "google", accountId: "google-123" },
        { id: "row_2", providerId: "github", accountId: "329221745" },
      ],
    });
    serverWith({
      emails: [
        {
          id: "email_1",
          email: "dana@example.test",
          providers: ["google", "github"],
          isPrimary: true,
        },
      ],
    });

    render(<Account />);

    await waitFor(() => {
      // One entry, however many providers proved it.
      expect(screen.getAllByText("dana@example.test")).toHaveLength(1);
    });
    // Each provider gets its own line under the address.
    expect(screen.getByText("google")).toBeDefined();
    expect(screen.getByText("github")).toBeDefined();
    // And exactly one primary badge, however many providers proved it.
    expect(screen.getAllByText("Primary")).toHaveLength(1);
  });
});

test("does not show an address for a provider that is not linked", async () => {
  // A stale proof: Google is unlinked but once still displayed the address it
  // used to prove.
  listAccounts.mockResolvedValue({
    data: [{ id: "row_2", providerId: "github", accountId: "329221745" }],
  });
  serverWith({
    emails: [
      {
        id: "email_1",
        email: "dana@example.test",
        // The stale claim: Google is named here but is no longer linked.
        providers: ["google", "github"],
        isPrimary: true,
      },
    ],
  });

  render(<Account />);

  /*
   * An unlinked provider is offered in the "Connect another account" section
   * rather than listed against the address it used to prove.
   *
   * The wait is on the settled count, not on the card title. Until
   * `listAccounts` resolves nothing is known to be linked, so the card renders
   * with a row for every provider and narrows to Google once the answer
   * arrives. The title is there in both states, so waiting on it can hand back
   * a page mid-load with two Connect buttons and an ambiguous query.
   */
  await waitFor(() => {
    expect(screen.getAllByRole("button", { name: /Connect/ })).toHaveLength(1);
  });
  expect(screen.getByText(/Connecting an account adds/)).toBeDefined();
  // Only GitHub is linked, so the address appears once and never on the
  // unlinked Google row.
  expect(screen.getAllByText("dana@example.test")).toHaveLength(1);
});

describe("unlinking", () => {
  test("sends Better Auth's row id, not the provider's account id", async () => {
    // The bug that 400'd: `unlinkAccount` matches on the row id, never the
    // provider's own id.
    const user = (await import("@testing-library/user-event")).default;
    listAccounts.mockResolvedValue({
      data: [
        { id: "row_1", providerId: "google", accountId: "google-123" },
        { id: "row_2", providerId: "github", accountId: "329221745" },
      ],
    });
    unlinkAccount.mockResolvedValue({ error: null });
    // Disconnect lives on the provider line under an address, so one must
    // exist.
    serverWith({
      emails: [
        {
          id: "email_1",
          email: "dana@example.test",
          providers: ["github"],
          isPrimary: true,
        },
      ],
    });

    render(<Account />);

    await user.click(await screen.findByRole("button", { name: "Disconnect" }));

    await waitFor(() => {
      expect(unlinkAccount).toHaveBeenCalledWith({ accountId: "row_2" });
    });
    // The provider's id must never be what gets sent.
    expect(unlinkAccount).not.toHaveBeenCalledWith({
      accountId: "329221745",
    });
  });

  test("surfaces the server's reason when unlinking is refused", async () => {
    // "You can't unlink your last account" is something a person can act on.
    const user = (await import("@testing-library/user-event")).default;
    listAccounts.mockResolvedValue({
      data: [
        { id: "row_1", providerId: "google", accountId: "google-123" },
        { id: "row_2", providerId: "github", accountId: "329221745" },
      ],
    });
    unlinkAccount.mockResolvedValue({
      error: { message: "You can't unlink your last account" },
    });
    serverWith({
      emails: [
        {
          id: "email_1",
          email: "dana@example.test",
          providers: ["github"],
          isPrimary: true,
        },
      ],
    });

    render(<Account />);

    await user.click(await screen.findByRole("button", { name: "Disconnect" }));

    await waitFor(() => {
      expect(
        screen.getByText("You can't unlink your last account"),
      ).toBeDefined();
    });
  });
});

describe("username", () => {
  test("prefills the field with the current handle", async () => {
    // The handle is generated at signup, so an empty field is never correct.
    listAccounts.mockResolvedValue({ data: [] });
    serverWith({ emails: [], username: "rivers-dana" });

    render(<Account />);

    // Shown as text, prefixed; opening it seeds the input from the same value.
    expect(await screen.findByText("@rivers-dana")).toBeDefined();
    expect((await openField("Username")).value).toBe("rivers-dana");
  });
});

describe("email addresses", () => {
  const twoAddresses = [
    {
      id: "email_1",
      email: "first@example.test",
      providers: ["google"],
      isPrimary: true,
    },
    {
      id: "email_2",
      email: "second@example.test",
      providers: ["github"],
      isPrimary: false,
    },
  ];

  test("lists every proven address with its providers", async () => {
    listAccounts.mockResolvedValue({ data: [] });
    serverWith({ emails: twoAddresses });

    render(<Account />);

    await waitFor(() => {
      expect(screen.getByText("second@example.test")).toBeDefined();
    });
    // Providers are listed one per line beneath the address.
    expect(screen.getByText("google")).toBeDefined();
  });

  test("a non-primary address can be promoted", async () => {
    const user = (await import("@testing-library/user-event")).default;
    listAccounts.mockResolvedValue({ data: [] });
    serverWith({ emails: twoAddresses });

    render(<Account />);

    const promote = await screen.findByRole("button", {
      name: "Make primary",
    });
    await user.click(promote);

    await waitFor(() => {
      expect(calls).toContain("POST /api/v1/me/emails/email_2/primary");
    });
  });

  test("the primary address offers no actions", async () => {
    // Promoting the primary again is a no-op, so the only button is the other
    // address's.
    listAccounts.mockResolvedValue({ data: [] });
    serverWith({ emails: twoAddresses });

    render(<Account />);

    await waitFor(() => {
      expect(screen.getByText("first@example.test")).toBeDefined();
    });
    expect(
      screen.getAllByRole("button", { name: "Make primary" }),
    ).toHaveLength(1);
    // No "remove address" action; see the next test.
    expect(screen.queryByRole("button", { name: /^Remove / })).toBeNull();
  });

  test("offers no way to delete an address directly", async () => {
    // An address is released by disconnecting the account that proves it;
    // deleting the row would be undone by the next sign-in.
    listAccounts.mockResolvedValue({ data: [] });
    serverWith({ emails: twoAddresses });

    render(<Account />);

    await waitFor(() => {
      expect(screen.getByText("second@example.test")).toBeDefined();
    });
    expect(calls.some((call) => call.startsWith("DELETE"))).toBe(false);
    expect(screen.queryByRole("button", { name: /^Remove / })).toBeNull();
  });

  test("surfaces the server's reason when an action is refused", async () => {
    const user = (await import("@testing-library/user-event")).default;
    listAccounts.mockResolvedValue({ data: [] });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { method?: string }) => {
        // Checked first, or the list route below would match the same URL.
        if (init?.method === "POST") {
          return new Response(
            JSON.stringify({ error: "That address belongs to someone else." }),
            { status: 409, headers: { "content-type": "application/json" } },
          );
        }
        if (String(url).includes("/api/v1/me/emails")) {
          return new Response(JSON.stringify({ emails: twoAddresses }), {
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({
            user: { id: "user_1", email: "a@b.test", name: "A", username: "a" },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }),
    );

    render(<Account />);

    const promote = await screen.findByRole("button", {
      name: "Make primary",
    });
    await user.click(promote);

    await waitFor(() => {
      expect(
        screen.getByText("That address belongs to someone else."),
      ).toBeDefined();
    });
  });
});

/*
 * Regression guard for the section headings.
 *
 * `CardTitle` renders a plain `div`, so without an explicit role these read as
 * ordinary text and the page offers a screen reader nothing to navigate by
 * between the page title and the fields. Level two sits them under the
 * page's own `h1`.
 */
test("each account section is a level-two heading", async () => {
  listAccounts.mockResolvedValue({ data: [] });
  serverWith({ emails: [] });

  render(<Account />);

  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "Connected Accounts", level: 2 }),
    ).toBeDefined();
  });
  expect(
    screen.getByRole("heading", { name: "Profile", level: 2 }),
  ).toBeDefined();
  // The page's own title stays the only level one.
  expect(
    screen.getByRole("heading", { name: "Account", level: 1 }),
  ).toBeDefined();
});

describe("organization invitations", () => {
  const invitation = {
    id: "inv_1",
    organization: { id: "org_1", name: "Acme", slug: "acme" },
    role: "member",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };

  test("a pending invitation is shown with the organization and role", async () => {
    // Nothing is emailed, so this card *is* the delivery. If it does not
    // render, an invitation is unreachable.
    serverWith({ invitations: [invitation] });

    render(<Account />);

    expect(await screen.findByText("Acme")).toBeDefined();
    expect(screen.getByText(/as member/i)).toBeDefined();
  });

  test("no card at all when there is nothing pending", async () => {
    // An empty "Invitations" heading on every account page would be noise.
    serverWith({ invitations: [] });

    render(<Account />);

    await screen.findByText("Connected Accounts");
    expect(screen.queryByText("Invitations")).toBeNull();
  });

  test("accepting calls accept, not decline", async () => {
    serverWith({ invitations: [invitation] });
    render(<Account />);

    fireEvent.click(await screen.findByRole("button", { name: "Accept" }));

    await waitFor(() =>
      expect(acceptInvitation).toHaveBeenCalledWith({ invitationId: "inv_1" }),
    );
    expect(rejectInvitation).not.toHaveBeenCalled();
  });

  test("declining calls decline, not accept", async () => {
    // The pair that matters: one of these joining an organization the person
    // meant to refuse is silent and hard to undo.
    serverWith({ invitations: [invitation] });
    render(<Account />);

    fireEvent.click(await screen.findByRole("button", { name: "Decline" }));

    await waitFor(() =>
      expect(rejectInvitation).toHaveBeenCalledWith({ invitationId: "inv_1" }),
    );
    expect(acceptInvitation).not.toHaveBeenCalled();
  });

  test("accepting tells the app to reload its organizations", async () => {
    // Otherwise the switcher does not show what was just joined.
    const onJoined = vi.fn();
    serverWith({ invitations: [invitation] });
    render(<Account onJoined={onJoined} />);

    fireEvent.click(await screen.findByRole("button", { name: "Accept" }));

    await waitFor(() => expect(onJoined).toHaveBeenCalled());
  });

  test("declining does not claim you joined", async () => {
    const onJoined = vi.fn();
    serverWith({ invitations: [invitation] });
    render(<Account onJoined={onJoined} />);

    fireEvent.click(await screen.findByRole("button", { name: "Decline" }));

    await waitFor(() => expect(rejectInvitation).toHaveBeenCalled());
    expect(onJoined).not.toHaveBeenCalled();
  });

  test("the server's reason for refusing is shown", async () => {
    // An expired or already-answered invitation explains itself.
    acceptInvitation.mockResolvedValue({
      data: null,
      error: { message: "This invitation has expired." },
    });
    serverWith({ invitations: [invitation] });
    render(<Account />);

    fireEvent.click(await screen.findByRole("button", { name: "Accept" }));

    expect(await screen.findByText(/has expired/i)).toBeDefined();
  });
});

test("the page links to the organizations you belong to", async () => {
  const onOpenOrganizations = vi.fn();
  render(
    <Account organizationCount={3} onOpenOrganizations={onOpenOrganizations} />,
  );

  const link = await screen.findByRole("button", { name: "3 organizations" });
  fireEvent.click(link);

  expect(onOpenOrganizations).toHaveBeenCalledTimes(1);

  // The same mark the avatar menu's "Organizations" item carries, so the two
  // ways to this page read as one destination. Decorative — the button's own
  // text is its name, which is why the query above still finds it.
  expect(link.querySelector("svg.lucide-building-2")).not.toBeNull();
});

test("one organization is not 'organizations'", async () => {
  // Everybody has at least their personal one, so the singular is the case a
  // brand new account sees.
  render(<Account organizationCount={1} onOpenOrganizations={vi.fn()} />);

  expect(
    await screen.findByRole("button", { name: "1 organization" }),
  ).toBeTruthy();
});

test("the count is absent until it is known", async () => {
  /*
   * Undefined while the list loads, which is not the same as zero: rendering
   * the line early would flash "0 organizations" at somebody who has one.
   */
  render(<Account />);

  await screen.findByRole("button", { name: "Edit username" });
  expect(screen.queryByText(/organizations?$/)).toBeNull();
});

test("clicking your picture says why it cannot be changed yet", async () => {
  /*
   * The control used to be disabled, which swallowed the click entirely: the
   * page did nothing and the reason lived in a `title` that never appeared on
   * a touch screen or for a keyboard. The answer goes in the line that already
   * reports "Saved." after a rename.
   */
  render(<Account />);

  const picture = await screen.findByRole("button", {
    name: "Change your picture",
  });
  fireEvent.click(picture);

  const notice = await screen.findByRole("status");
  expect(notice.textContent).toContain("coming soon");
  // Not an error: nothing failed, this is not built yet.
  expect(notice.className).not.toContain("destructive");
});

// ---- the display name -----------------------------------------------------

test("the name field seeds from the session", async () => {
  // It is the session that carries the display name, so the field shows what
  // the rail and the menu already show.
  serverWith({});
  render(<Account />);

  // The value reads as text; opening it seeds the input from the same value.
  expect(await screen.findByText("charlie ang")).toBeDefined();
  expect((await openField("Name")).value).toBe("charlie ang");
});

test("saving the name sends it to the name route", async () => {
  serverWith({});
  render(<Account />);

  fireEvent.change(await openField("Name"), {
    target: { value: "Charlie Ang" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save name" }));

  await waitFor(() => expect(calls).toContain("PUT /api/v1/me/name"));
  const body = JSON.parse(
    (vi.mocked(fetch).mock.calls.at(-1)?.[1] as { body: string }).body,
  ) as Record<string, string>;
  expect(body).toEqual({ name: "Charlie Ang" });
});

test("an empty name is refused and says so", async () => {
  serverWith({});
  render(<Account />);

  const field = await openField("Name");
  fireEvent.change(field, { target: { value: "Dana" } });
  fireEvent.change(field, { target: { value: "   " } });

  // Nothing to save: the tick guards it before the round trip.
  expect(
    (
      screen.getByRole("button", { name: "Save name" }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});

test("the handle and the name save separately", async () => {
  // Two fields, two buttons: renaming yourself should not also rewrite the
  // handle somebody may have just typed, or the other way round.
  serverWith({});
  render(<Account />);

  fireEvent.change(await openField("Name"), {
    target: { value: "Charlie Ang" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save name" }));

  await waitFor(() => expect(calls).toContain("PUT /api/v1/me/name"));
  expect(calls).not.toContain("PUT /api/v1/me/username");
});
