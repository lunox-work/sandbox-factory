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

import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const listAccounts = vi.fn();
const unlinkAccount = vi.fn();
const linkSocial = vi.fn();

vi.mock("../src/auth", () => ({
  authClient: {
    listAccounts: () => listAccounts(),
    unlinkAccount: (input: { accountId: string }) => unlinkAccount(input),
    linkSocial: (input: unknown) => linkSocial(input),
  },
  PROVIDERS: [
    { id: "google", label: "Continue with Google" },
    { id: "github", label: "Continue with GitHub" },
  ],
}));

const { Account } = await import("../src/Account");

/** Every request the page made, so a test can assert what it asked for. */
const calls: string[] = [];

function serverWith(options: {
  emails?: Array<{
    id: string;
    email: string;
    providers: string[];
    isPrimary: boolean;
  }>;
  username?: string | null;
}) {
  const emails = options.emails ?? [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string }) => {
      calls.push(`${init?.method ?? "GET"} ${String(url)}`);
      if (String(url).includes("/api/v1/me/emails")) {
        return new Response(JSON.stringify({ emails }));
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
   * An unlinked provider is offered under "Connect another account" rather
   * than listed against the address it used to prove.
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
  expect(screen.getByText("Connect another account")).toBeDefined();
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

    await waitFor(() => {
      const field = screen.getByLabelText("Username") as HTMLInputElement;
      expect(field.value).toBe("rivers-dana");
    });
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
      screen.getByRole("heading", { name: "Email addresses", level: 2 }),
    ).toBeDefined();
  });
  expect(
    screen.getByRole("heading", { name: "Username", level: 2 }),
  ).toBeDefined();
  // The page's own title stays the only level one.
  expect(
    screen.getByRole("heading", { name: "Account", level: 1 }),
  ).toBeDefined();
});
