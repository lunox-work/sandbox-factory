/**
 * Tests for the account settings page.
 *
 * These exist because three bugs shipped past a green `npm run verify`: an
 * empty handle field, a provider row that said "linked" with no address, and
 * an unlink button that sent the wrong id and 400'd. All three were in this
 * component, which had no tests at all — the workspace's `test` script was a
 * placeholder that always passed.
 *
 * The server is faked at the `fetch` and auth-client boundary rather than
 * mocking the component's internals, so these assert what a person actually
 * sees given a server response.
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

/** A signed-in user with both providers linked to one shared address. */
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
    // The bug: the row rendered "linked" with no address, so there was no way
    // to tell which account was attached.
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

    render(<Account onClose={() => {}} />);

    await waitFor(() => {
      // Once on the provider row, once in the address list below it.
      expect(screen.getAllByText("dana@example.test").length).toBeGreaterThan(
        0,
      );
    });
  });

  test("shows the same address on both providers when both proved it", async () => {
    // One inbox registered at Google and GitHub is the normal case. Showing it
    // only on the first is what made GitHub look unlinked.
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

    render(<Account onClose={() => {}} />);

    await waitFor(() => {
      // One entry, however many providers proved it — the address is one
      // thing, listed once, with its providers named beside it.
      expect(screen.getAllByText("dana@example.test")).toHaveLength(1);
    });
    // Each provider gets its own line under the address rather than being
    // run together inline.
    expect(screen.getByText("google")).toBeDefined();
    expect(screen.getByText("github")).toBeDefined();
    // And exactly one "primary" badge, however many providers proved it.
    expect(screen.getAllByText("primary")).toHaveLength(1);
  });
});

test("does not show an address for a provider that is not linked", async () => {
  // Exactly what a stale proof looked like: Google unlinked, so its row
  // offers "Link" — but it still displayed the address it used to prove.
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

  render(<Account onClose={() => {}} />);

  await waitFor(() => {
    expect(screen.getByText(/not connected/)).toBeDefined();
  });
  // Only GitHub is linked, so the address must appear exactly once.
  // Only GitHub is linked, so the address shows on that one provider row
  // and once in the address list below — never on the unlinked Google row.
  expect(screen.getAllByText("dana@example.test")).toHaveLength(1);
});

describe("unlinking", () => {
  test("sends Better Auth's row id, not the provider's account id", async () => {
    // The bug that produced a 400: `unlinkAccount` matches on the row id, and
    // the provider's own id (a GitHub numeric id) never matches it.
    const user = (await import("@testing-library/user-event")).default;
    listAccounts.mockResolvedValue({
      data: [
        { id: "row_1", providerId: "google", accountId: "google-123" },
        { id: "row_2", providerId: "github", accountId: "329221745" },
      ],
    });
    unlinkAccount.mockResolvedValue({ error: null });
    // The Disconnect control lives on the provider line under an address, so
    // there has to be an address for it to hang off.
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

    render(<Account onClose={() => {}} />);

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
    // "You can't unlink your last account" is something the person can act on;
    // a generic failure is not.
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

    render(<Account onClose={() => {}} />);

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
    // The handle is generated at signup, so an empty field means something
    // failed — it is never the correct state for an existing account.
    listAccounts.mockResolvedValue({ data: [] });
    serverWith({ emails: [], username: "rivers-dana" });

    render(<Account onClose={() => {}} />);

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

    render(<Account onClose={() => {}} />);

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

    render(<Account onClose={() => {}} />);

    const promote = await screen.findByRole("button", {
      name: "Make primary",
    });
    await user.click(promote);

    await waitFor(() => {
      expect(calls).toContain("POST /api/v1/me/emails/email_2/primary");
    });
  });

  test("the primary address offers no actions", async () => {
    // It cannot be removed while `user.email` points at it, and promoting it
    // again is a no-op — so exactly one of each button, for the other address.
    listAccounts.mockResolvedValue({ data: [] });
    serverWith({ emails: twoAddresses });

    render(<Account onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("first@example.test")).toBeDefined();
    });
    expect(
      screen.getAllByRole("button", { name: "Make primary" }),
    ).toHaveLength(1);
    // No "remove address" action anywhere: an address exists because a
    // connected account proves it, so deleting the row while that account
    // stays connected would just be undone by the next sign-in.
    expect(screen.queryByRole("button", { name: /^Remove / })).toBeNull();
  });

  test("offers no way to delete an address directly", async () => {
    // Releasing an address is done by disconnecting the account that proves
    // it, not by deleting the row — otherwise the next sign-in re-proves it
    // and nothing has changed.
    listAccounts.mockResolvedValue({ data: [] });
    serverWith({ emails: twoAddresses });

    render(<Account onClose={() => {}} />);

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
        // The refusal under test. Checked first so it wins over the list route
        // below, which the same URL would otherwise match.
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

    render(<Account onClose={() => {}} />);

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
